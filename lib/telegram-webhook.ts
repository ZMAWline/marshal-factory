import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import { jobs, telegramMessages, telegramPrompts, telegramUpdates, type JobRow, type TelegramMessageRow } from "@/db/schema";
import { follow, nextRequestId, runAction, type FollowOptions } from "@/lib/chat-actions";
import { attemptBranch } from "@/lib/factory";
import { inboxKind, type InboxAction } from "@/lib/inbox";
import type { InboxDeps, InboxOutcome } from "@/lib/inbox-actions";
import { createJob } from "@/lib/new-job";
import { displayName, repoName } from "@/lib/repo-name";
import type { Registry } from "@/lib/repositories";
import { notifyEvents, PENDING_LABELS, redact, type MessageFacts, type NotifyEvent } from "@/lib/slack";
import { titleFrom } from "@/lib/slack-new-job";
import { safeMessage, uuidFrom } from "@/lib/slack-request";
import { branchCosts } from "@/lib/spend";
import {
  confirmKeyboard,
  escapeHtml,
  eventKeyboard,
  parseCallbackData,
  renderTelegram,
  REPLY_ACTIONS,
  type TelegramClient,
} from "@/lib/telegram";

// Acting from Telegram: the webhook route (app/api/telegram/webhook) hands every update here. A
// button on an open factory message, a reply to one, or a reply to the prompt a button sent runs
// the same inbox action the panel runs (lib/inbox-actions.ts) as the owner, through what Slack's
// front door shares (lib/chat-actions.ts). `/job <what to build>` files a job through the panel's
// createJob. Only updates that carry TELEGRAM_WEBHOOK_SECRET in their header and come from the
// chat TELEGRAM_CHAT_ID names do anything; each update_id is taken once.

/** The header Telegram sends the secret_token that setWebhook was given in. */
export const SECRET_HEADER = "x-telegram-bot-api-secret-token";
/** Telegram redelivers an update for up to a day; a seen update_id is kept a while longer. */
export const UPDATE_RETENTION_MS = 7 * 24 * 3_600_000;

export const ALREADY_RESOLVED = "This is already resolved; nothing was done.";
export const UNKNOWN_BUTTON = "The factory doesn't know this button.";
export const USAGE = [
  "<b>/job</b> &lt;what to build&gt; files a new job; start with <code>repo:&lt;name&gt;</code> to pick the repository.",
  "Reply to a factory message to answer its question, request changes on its pull request or retry it with a note.",
].join("\n");

export type TelegramWebhookDeps = FollowOptions & {
  webhookSecret: string | undefined;
  /** The owner's chat: the only one whose updates act. */
  chatId: string | undefined;
  telegram: Pick<TelegramClient, "sendMessage" | "editMessageText" | "editMessageReplyMarkup" | "answerCallbackQuery"> | null;
  /** The inbox actions' deps, acting as the owner. */
  inbox: InboxDeps;
  panelUrl: string;
  secrets: readonly string[];
  /** Runs work after the answer; next/server's after in the route. */
  after: (task: () => Promise<void>) => void;
  now?: () => Date;
};

/** Constant-time, and the same time whatever the given header's length. */
export function verifySecret(expected: string | undefined, given: string | null) {
  if (!expected || given === null) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected), digest(given));
}

const chatSchema = z.object({ id: z.union([z.number(), z.string()]) });
const messageSchema = z.object({
  message_id: z.number(),
  chat: chatSchema,
  from: z.object({ id: z.number(), is_bot: z.boolean().optional() }).optional(),
  text: z.string().optional(),
  reply_to_message: z.object({ message_id: z.number() }).optional(),
});
const updateSchema = z.object({
  update_id: z.number().int(),
  message: messageSchema.optional(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().optional(),
      message: z.object({ message_id: z.number(), chat: chatSchema }).optional(),
    })
    .optional(),
});
type Message = z.infer<typeof messageSchema>;
type CallbackQuery = NonNullable<z.infer<typeof updateSchema>["callback_query"]>;

const ok = () => new Response(null, { status: 200 });

/** Every update Telegram sends. The secret is checked before the body is read; a foreign chat or a seen update is answered and ignored. */
export async function handleTelegramUpdate(request: Request, deps: TelegramWebhookDeps): Promise<Response> {
  if (!verifySecret(deps.webhookSecret, request.headers.get(SECRET_HEADER))) return new Response("invalid secret", { status: 401 });
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return ok();
  }
  const parsed = updateSchema.safeParse(raw);
  // Anything Telegram sends that isn't a message or a button is acked, so it isn't sent again.
  if (!parsed.success) return ok();
  const update = parsed.data;
  const chat = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
  if (!deps.chatId || chat === undefined || String(chat) !== deps.chatId) return ok();
  if (update.message?.from?.is_bot) return ok();
  if (!deps.telegram) {
    console.error("telegram: the panel has no TELEGRAM_BOT_TOKEN, so it can't act from Telegram");
    return ok();
  }
  const now = (deps.now ?? (() => new Date()))();
  const [fresh] = await deps.inbox.db
    .insert(telegramUpdates)
    .values({ update_id: update.update_id, received_at: now })
    .onConflictDoNothing()
    .returning({ id: telegramUpdates.update_id });
  if (!fresh) return ok();
  await deps.inbox.db.delete(telegramUpdates).where(lt(telegramUpdates.received_at, new Date(now.getTime() - UPDATE_RETENTION_MS)));

  const telegram = deps.telegram;
  const chatId = String(chat);
  deps.after(async () => {
    if (update.callback_query) return clicked(deps, telegram, update.callback_query);
    if (update.message) return messaged(deps, telegram, chatId, update.message);
  });
  return ok();
}

type Telegram = NonNullable<TelegramWebhookDeps["telegram"]>;
type Item = { row: TelegramMessageRow & { chat_id: string; message_id: number }; job: JobRow; event: NotifyEvent<JobRow> };

/** The open message and the event it is about, while that event is still open; null once it resolved or changed. */
async function openItem(deps: TelegramWebhookDeps, row: TelegramMessageRow | undefined): Promise<Item | null> {
  if (!row || row.state !== "open" || !row.chat_id || row.message_id === null) return null;
  const [job] = await deps.inbox.db.select().from(jobs).where(eq(jobs.id, row.job_id));
  const event = job ? notifyEvents([job]).find((e) => e.id === row.id && e.open) : undefined;
  return event ? { row: { ...row, chat_id: row.chat_id, message_id: row.message_id }, job: job!, event } : null;
}

const rowBy = async (deps: TelegramWebhookDeps, where: SQL | undefined) => (await deps.inbox.db.select().from(telegramMessages).where(where).limit(1))[0];

async function messageFacts(deps: TelegramWebhookDeps, job: JobRow): Promise<MessageFacts> {
  const branch = attemptBranch(job.key, job.attempt);
  const costs = await branchCosts(deps.inbox.db, [branch]);
  return { panelUrl: deps.panelUrl, spend: costs[branch] ?? null, secrets: deps.secrets };
}

/** What happened, for the owner: the first answer (the button's note, or a reply), and anything later. */
type Say = { result: (text: string) => Promise<void>; later: (text: string) => Promise<void> };

/**
 * Shows the pending state, runs the action and follows its intent. A refusal puts the buttons back
 * and says why; otherwise the notifier edits the message to its resolution.
 */
async function act(deps: TelegramWebhookDeps, telegram: Telegram, item: Item, action: InboxAction, text: string, say: Say) {
  const facts = await messageFacts(deps, item.job);
  const show = async (pending: string | null) => {
    try {
      await telegram.editMessageText(item.row.chat_id, item.row.message_id, renderTelegram(item.event, facts, null, pending));
    } catch (error) {
      console.error(`telegram: edit ${item.row.id} failed: ${safeMessage(deps.secrets, error)}`);
    }
  };
  await show(PENDING_LABELS[action]);
  let outcome: InboxOutcome;
  try {
    outcome = await runAction(deps.inbox, action, item.job, await nextRequestId(deps.inbox, "telegram", item.event.id, action), text);
  } catch (error) {
    outcome = { ok: false, message: safeMessage(deps.secrets, error) };
  }
  if (!outcome.ok) {
    await show(null);
    return say.result(outcome.message);
  }
  await say.result(outcome.message ?? PENDING_LABELS[action]);
  if (!outcome.intentId) return;
  let followed: InboxOutcome;
  try {
    followed = await follow(deps.inbox, outcome.intentId, deps);
  } catch (error) {
    followed = { ok: false, message: safeMessage(deps.secrets, error) };
  }
  if (!followed.ok) {
    await show(null);
    await say.later(followed.message);
  }
}

/** A plain-text note sent into the chat, as a reply when it answers a message. */
const note = (deps: TelegramWebhookDeps, telegram: Telegram, chatId: string, text: string, replyTo?: number) =>
  telegram.sendMessage(chatId, { text: escapeHtml(redact(text, deps.secrets)) }, replyTo === undefined ? {} : { replyTo }).then(() => undefined);

const PROMPTS: Partial<Record<InboxAction, { text: string; placeholder: string }>> = {
  answer: { text: "Reply to this message with your answer. It is posted on the issue and the job resumes.", placeholder: "Your answer" },
  request_changes: { text: "Reply to this message with what should change. The agent updates the same branch and pull request.", placeholder: "What should change" },
  follow_up: { text: "Reply to this message with what the fix should do. It is filed as a new issue the factory picks up.", placeholder: "What the fix should do" },
  retry: { text: "Reply to this message with a note for the next attempt. It goes into the attempt's first message and onto the issue.", placeholder: "Note for the next attempt" },
};

async function clicked(deps: TelegramWebhookDeps, telegram: Telegram, query: CallbackQuery) {
  const answer = (text: string) => telegram.answerCallbackQuery(query.id, redact(text, deps.secrets));
  try {
    const parsed = parseCallbackData(query.data ?? "");
    if (!parsed) return await answer(UNKNOWN_BUTTON);
    const item = await openItem(deps, await rowBy(deps, eq(telegramMessages.token, parsed.token)));
    if (!item) return await answer(ALREADY_RESOLVED);
    const { button } = parsed;
    switch (button.mode) {
      case "cancel":
        await telegram.editMessageReplyMarkup(item.row.chat_id, item.row.message_id, eventKeyboard(item.event.kind, item.event.id));
        return await answer("Cancelled.");
      case "ask":
        await telegram.editMessageReplyMarkup(item.row.chat_id, item.row.message_id, confirmKeyboard(item.event.id));
        return await answer("Tap Confirm to merge.");
      case "prompt": {
        const prompt = PROMPTS[button.action]!;
        const sent = await telegram.sendMessage(
          item.row.chat_id,
          { text: `<b>${escapeHtml(item.job.key)} · ${escapeHtml(button.label)}</b>\n${escapeHtml(prompt.text)}` },
          { replyTo: item.row.message_id, forceReply: prompt.placeholder },
        );
        await deps.inbox.db
          .insert(telegramPrompts)
          .values({ chat_id: sent.chatId, message_id: sent.messageId, event_id: item.event.id, action: button.action, created_at: (deps.now ?? (() => new Date()))() })
          .onConflictDoNothing();
        return await answer("Reply to the message below.");
      }
      case "now":
        return await act(deps, telegram, item, button.action, "", {
          result: answer,
          later: (text) => note(deps, telegram, item.row.chat_id, text, item.row.message_id),
        });
      default: {
        const never: never = button;
        throw new Error(`unknown button ${String(never)}`);
      }
    }
  } catch (error) {
    console.error(`telegram: button failed: ${safeMessage(deps.secrets, error)}`);
    await answer(safeMessage(deps.secrets, error)).catch(() => undefined);
  }
}

const JOB_COMMAND = /^\/job(?:@\w+)?(?:\s+([\s\S]*))?$/i;
const REPO_PREFIX = /^repo:(\S+)\s*/i;

/** The enabled repo a `repo:<name>` names: its full name, its name or its display name, in any case. */
export function findRepo(registry: Registry, name: string) {
  const wanted = name.toLowerCase();
  return registry.find((r) => r.enabled && [r.repo, repoName(r.repo), displayName(r)].some((n) => n.toLowerCase() === wanted));
}

async function messaged(deps: TelegramWebhookDeps, telegram: Telegram, chatId: string, message: Message) {
  const reply = (text: string) => note(deps, telegram, chatId, text, message.message_id);
  try {
    const text = message.text?.trim() ?? "";
    const command = text.match(JOB_COMMAND);
    if (command) return await fileJob(deps, telegram, chatId, message, command[1]?.trim() ?? "");
    if (message.reply_to_message) {
      const target = message.reply_to_message.message_id;
      const [prompt] = await deps.inbox.db
        .select()
        .from(telegramPrompts)
        .where(and(eq(telegramPrompts.chat_id, chatId), eq(telegramPrompts.message_id, target)));
      const row = await rowBy(deps, prompt ? eq(telegramMessages.id, prompt.event_id) : and(eq(telegramMessages.chat_id, chatId), eq(telegramMessages.message_id, target)));
      if (prompt || row) {
        const item = await openItem(deps, row);
        if (!item) return await reply(ALREADY_RESOLVED);
        const kind = inboxKind(item.job);
        const action = prompt?.action ?? (kind ? REPLY_ACTIONS[kind] : undefined);
        if (!action) return await reply("Use the message's buttons for this one.");
        if (!text) return await reply("Reply with text.");
        return await act(deps, telegram, item, action, text, { result: reply, later: reply });
      }
    }
    // Anything else, /start and /help included, gets the usage.
    await telegram.sendMessage(chatId, { text: USAGE }, { replyTo: message.message_id });
  } catch (error) {
    console.error(`telegram: message failed: ${safeMessage(deps.secrets, error)}`);
    await reply(safeMessage(deps.secrets, error)).catch(() => undefined);
  }
}

/** `/job [repo:<name>] <what to build>`: the panel's New job, with the first line as the title. */
async function fileJob(deps: TelegramWebhookDeps, telegram: Telegram, chatId: string, message: Message, args: string) {
  const prefix = args.match(REPO_PREFIX);
  const body = (prefix ? args.slice(prefix[0].length) : args).trim();
  if (!body) return telegram.sendMessage(chatId, { text: USAGE }, { replyTo: message.message_id }).then(() => undefined);
  const reply = (text: string) => note(deps, telegram, chatId, text, message.message_id);
  let repo: string | undefined;
  if (prefix) {
    const found = findRepo(await deps.inbox.newJob.registry(), prefix[1]!);
    if (!found) return reply(`No enabled repository is named ${prefix[1]}.`);
    repo = found.repo;
  }
  const title = titleFrom(body);
  const filed = await createJob(deps.inbox.newJob, {
    title,
    description: body === title ? "" : body,
    requestId: uuidFrom(`telegram:new_job:${chatId}:${message.message_id}`),
    ...(repo && { repo }),
  });
  if (!filed.ok) return reply(filed.message);
  const link = /^https?:\/\//.test(filed.url) ? `<a href="${escapeHtml(filed.url)}">${escapeHtml(filed.identifier)}</a>` : escapeHtml(filed.identifier);
  await telegram.sendMessage(chatId, { text: `Filed ${link}. The factory picks it up as a new job.` }, { replyTo: message.message_id });
}
