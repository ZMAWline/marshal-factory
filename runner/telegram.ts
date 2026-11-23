import { createHash } from "node:crypto";
import { and, eq, gt, inArray, lt, or } from "drizzle-orm";
import { db } from "../db/client";
import { jobs, telegramMessages, type JobRow } from "../db/schema";
import { loadConfig } from "../lib/config";
import { attemptBranch } from "../lib/factory";
import { inQuietHours, parseNotificationConfig, readNotifications } from "../lib/notifications";
import { NOTIFY_WINDOW_MS, notifyEvents, panelUrl, redact, resolution, secretValues, TOGGLE_OF, URGENT, type MessageFacts } from "../lib/slack";
import { renderTelegram, TelegramApiError, telegramClient, TelegramRateLimited, type TelegramClient, type TelegramMessage } from "../lib/telegram";
import { branchCosts } from "../lib/spend";

// The Telegram notifier, the twin of runner/slack.ts: each pass diffs the notification events
// (lib/slack.ts) against the telegram_messages rows, resolves the messages whose event went away,
// edits the ones whose event changed and sends the new ones to TELEGRAM_CHAT_ID. Every step is keyed
// by the event id, so a re-tick, a restart or a second runner never sends an event twice. The
// notification settings' events and quiet hours apply as they do to Slack; its Slack target does
// not. A runner without TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID does nothing.

/** Most Telegram calls one pass makes; the rest wait for the next tick. */
export const MAX_CALLS_PER_PASS = 20;
/** A row still posting after this belongs to a runner that died mid-send; the event is sent again. */
export const POSTING_STALE_MS = 5 * 60_000;
/** Tries at recording a sent message's id before the row is left posting. */
const SAVE_ATTEMPTS = 3;

export type TelegramSetup = { client: TelegramClient; chatId: string; secrets: readonly string[] };

let cached: { key: string; client: TelegramClient } | undefined;

/** The Telegram client for this runner's env; one per token, so a pause for retry_after holds across passes. */
export function telegramFromEnv(env: Record<string, string | undefined> = process.env): TelegramSetup | null {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return null;
  const baseUrl = env.TELEGRAM_API_URL?.trim() || undefined;
  const key = createHash("sha256").update(`${token}\n${baseUrl ?? ""}`).digest("hex");
  if (cached?.key !== key) cached = { key, client: telegramClient({ token, baseUrl }) };
  return { client: cached.client, chatId, secrets: [token, ...secretValues(env)] };
}

const fingerprint = (message: TelegramMessage) => createHash("sha256").update(message.text).digest("hex").slice(0, 32);
const errorText = (error: unknown, secrets: readonly string[]) => redact(error instanceof Error ? error.message : String(error), secrets);

export type NotifyResult =
  | "disabled"
  | { posted: number; updated: number; resolved: number; held: number; errors?: string[]; rateLimitedUntil?: string; deferred?: true };

export async function notifyTelegram(telegram: TelegramSetup | null = telegramFromEnv(), now = new Date()): Promise<NotifyResult> {
  if (!telegram) return "disabled";
  const config = parseNotificationConfig((await readNotifications(db))?.config);
  await db.delete(telegramMessages).where(and(eq(telegramMessages.state, "posting"), lt(telegramMessages.created_at, new Date(now.getTime() - POSTING_STALE_MS))));

  // Recent jobs for new events, and every job with an open message, however old, to see if it resolved.
  const cutoff = new Date(now.getTime() - 2 * NOTIFY_WINDOW_MS);
  const openJobs = db.select({ id: telegramMessages.job_id }).from(telegramMessages).where(eq(telegramMessages.state, "open"));
  const loaded = await db.select().from(jobs).where(or(gt(jobs.updated_at, cutoff), gt(jobs.stage_at, cutoff), inArray(jobs.id, openJobs)));
  const events = notifyEvents(loaded);
  const eventOf = new Map(events.map((e) => [e.id, e]));
  const rows = await db
    .select()
    .from(telegramMessages)
    .where(events.length > 0 ? or(eq(telegramMessages.state, "open"), inArray(telegramMessages.id, [...eventOf.keys()])) : eq(telegramMessages.state, "open"));
  const rowOf = new Map(rows.map((r) => [r.id, r]));
  const jobOf = new Map(loaded.map((j) => [j.id, j]));

  const branchOf = (job: Pick<JobRow, "key" | "attempt">) => attemptBranch(job.key, job.attempt);
  const costs = await branchCosts(db, [...new Set([...events.map((e) => branchOf(e.job)), ...rows.flatMap((r) => (jobOf.has(r.job_id) ? [branchOf(jobOf.get(r.job_id)!)] : []))])], loadConfig().factory.pricing);
  const facts = (job: JobRow): MessageFacts => ({ panelUrl: panelUrl(), spend: costs[branchOf(job)] ?? null, secrets: telegram.secrets });

  const result = { posted: 0, updated: 0, resolved: 0, held: 0 };
  const errors: string[] = [];
  const failed = (what: string, error: unknown) => errors.push(`${what}: ${errorText(error, telegram.secrets)}`);
  let calls = 0;
  const budget = () => calls < MAX_CALLS_PER_PASS;

  try {
    // Resolutions first: a stale "needs you" is worse than a late new one.
    for (const row of rows) {
      if (!budget()) break;
      if (row.state !== "open" || eventOf.get(row.id)?.open) continue;
      const job = jobOf.get(row.job_id);
      const text = resolution(row.kind, job);
      const message = job ? renderTelegram({ kind: row.kind, job, reason: "" }, facts(job), text) : null;
      try {
        if (message && row.chat_id && row.message_id !== null) {
          calls++;
          await telegram.client.editMessageText(row.chat_id, row.message_id, message);
        }
        await db
          .update(telegramMessages)
          .set({ state: "resolved", resolution: text, resolved_at: now, updated_at: now, ...(message && { fingerprint: fingerprint(message) }) })
          .where(and(eq(telegramMessages.id, row.id), eq(telegramMessages.state, "open")));
        result.resolved++;
      } catch (error) {
        if (error instanceof TelegramRateLimited) throw error;
        failed(`resolve ${row.id}`, error);
      }
    }

    // Open events whose message changed, or came back after it was resolved (a merge GitHub refused).
    for (const event of events) {
      if (!budget()) break;
      const row = rowOf.get(event.id);
      if (!event.open || !row || row.state === "posting" || !row.chat_id || row.message_id === null) continue;
      const message = renderTelegram(event, facts(event.job));
      const print = fingerprint(message);
      if (row.state === "open" && row.fingerprint === print) continue;
      try {
        calls++;
        await telegram.client.editMessageText(row.chat_id, row.message_id, message);
        await db
          .update(telegramMessages)
          .set({ state: "open", fingerprint: print, resolution: null, resolved_at: null, updated_at: now })
          .where(eq(telegramMessages.id, event.id));
        result.updated++;
      } catch (error) {
        if (error instanceof TelegramRateLimited) throw error;
        failed(`update ${event.id}`, error);
      }
    }

    const quiet = inQuietHours(config.quietHours, now);
    for (const event of events) {
      if (rowOf.has(event.id) || !config.events[TOGGLE_OF[event.kind]]) continue;
      if (now.getTime() - event.at.getTime() > NOTIFY_WINDOW_MS) continue;
      if (quiet && !URGENT[event.kind]) {
        result.held++;
        continue;
      }
      if (!budget()) break;
      const [claimed] = await db
        .insert(telegramMessages)
        .values({ id: event.id, job_id: event.job.id, kind: event.kind, state: "posting", created_at: now, updated_at: now })
        .onConflictDoNothing()
        .returning({ id: telegramMessages.id });
      if (!claimed) continue;
      const message = renderTelegram(event, facts(event.job));
      let sent: { chatId: string; messageId: number };
      try {
        calls++;
        sent = await telegram.client.sendMessage(telegram.chatId, message);
      } catch (error) {
        await db.delete(telegramMessages).where(and(eq(telegramMessages.id, event.id), eq(telegramMessages.state, "posting")));
        if (error instanceof TelegramRateLimited) throw error;
        failed(`post ${event.id}`, error);
        // A bad chat id or a revoked token fails every send the same way; try again next pass.
        if (error instanceof TelegramApiError) break;
        continue;
      }
      result.posted++;
      const saved = {
        state: event.open ? ("open" as const) : ("resolved" as const),
        chat_id: sent.chatId,
        message_id: sent.messageId,
        fingerprint: fingerprint(message),
        resolution: event.open ? null : resolution(event.kind, event.job),
        resolved_at: event.open ? null : now,
        updated_at: now,
      };
      // The message is in Telegram, so the row stays. If every try fails it is left posting, and the
      // stale-posting cleanup sends it again after POSTING_STALE_MS: a rare duplicate, never a loss.
      for (let attempt = 1; ; attempt++) {
        try {
          await db.update(telegramMessages).set(saved).where(eq(telegramMessages.id, event.id));
          break;
        } catch (error) {
          if (attempt < SAVE_ATTEMPTS) continue;
          failed(`save ${event.id}`, error);
          break;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof TelegramRateLimited)) throw error;
    return { ...result, ...(errors.length > 0 && { errors }), rateLimitedUntil: new Date(error.until).toISOString() };
  }
  return { ...result, ...(errors.length > 0 && { errors }), ...(!budget() && { deferred: true as const }) };
}
