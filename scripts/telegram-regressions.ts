import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import type { JobRow } from "../db/schema";

// Telegram notifications against a fake Telegram Bot API: no request leaves this machine.

const TOKEN = "123456789:AAregression-telegram-token-0123456789abc";
const CHAT = "-1001234567";

const { db } = await import("../db/client");
const { jobs, notificationSettings, telegramMessages } = await import("../db/schema");
const { linearJob } = await import("./fixtures");
const { notificationConfigSchema, NOTIFICATIONS_ID } = await import("../lib/notifications");
const { notifyEvents, redact } = await import("../lib/slack");
const { escapeHtml, renderTelegram, telegramClient, TelegramRateLimited } = await import("../lib/telegram");
const { notifyTelegram, POSTING_STALE_MS, telegramFromEnv } = await import("../runner/telegram");
const { serve } = await import("./serve");

// --- the fake Bot API
type Call = { method: string; token: string; params: Record<string, unknown>; at: number };
const calls: Call[] = [];
const forced: { method: string; status: number; body: object }[] = [];
let inFlight = 0;
let maxInFlight = 0;
let nextId = 1;
const server = await serve(0, async (request) => {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    const [, bot, method] = new URL(request.url).pathname.match(/^\/bot([^/]+)\/(.+)$/) ?? [];
    const params = JSON.parse((await request.text()) || "{}") as Record<string, unknown>;
    calls.push({ method: method ?? "", token: decodeURIComponent(bot ?? ""), params, at: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const force = forced.findIndex((f) => f.method === method);
    if (force >= 0) {
      const [f] = forced.splice(force, 1);
      return Response.json(f!.body, { status: f!.status });
    }
    if (decodeURIComponent(bot ?? "") !== TOKEN) return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
    switch (method) {
      case "sendMessage":
        if (params.chat_id === "-404") return Response.json({ ok: false, error_code: 400, description: "Bad Request: chat not found" }, { status: 400 });
        return Response.json({ ok: true, result: { message_id: nextId++, chat: { id: Number(params.chat_id) }, text: params.text } });
      case "editMessageText":
        return Response.json({ ok: true, result: { message_id: params.message_id, chat: { id: Number(params.chat_id) }, text: params.text } });
      default:
        return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
    }
  } finally {
    inFlight--;
  }
});
const baseUrl = `http://localhost:${server.port}`;
const fresh = (chatId = CHAT, token = TOKEN) => ({ client: telegramClient({ token, baseUrl, minGapMs: 0 }), chatId, secrets: [token] });
let telegram = fresh();

const prefix = `TGM${Date.now() % 1_000_000}`;
const key = (n: string) => `${prefix}-${n}`;
const textOf = (call: Call) => String(call.params.text ?? "");
const mine = (call: Call) => textOf(call).includes(prefix);
const since = (mark: number, method?: string) => calls.slice(mark).filter((c) => (!method || c.method === method) && mine(c));
const created: string[] = [];
const track = async (n: string, over: Partial<typeof jobs.$inferInsert>) => {
  const row = linearJob(`${prefix}-${n}`, key(n), { title: `Job ${n}`, url: `https://linear.app/x/issue/${key(n)}`, provider: "claudeAgent", ...over });
  await db.insert(jobs).values(row);
  created.push(row.id!);
  return row.id!;
};
const setJob = (id: string, set: Partial<typeof jobs.$inferInsert>) => db.update(jobs).set({ updated_at: new Date(), ...set }).where(eq(jobs.id, id as JobRow["id"]));
const rowsFor = (id: string) => db.select().from(telegramMessages).where(eq(telegramMessages.job_id, id as JobRow["id"]));
const writeConfig = (config: object) =>
  db
    .insert(notificationSettings)
    .values({ id: NOTIFICATIONS_ID, config: notificationConfigSchema.parse(config), updated_at: new Date(), updated_by: "owner@example.com" })
    .onConflictDoUpdate({ target: notificationSettings.id, set: { config: notificationConfigSchema.parse(config) } });
const pass = async () => {
  const result = await notifyTelegram(telegram);
  assert.notEqual(result, "disabled");
  return result as Exclude<typeof result, "disabled">;
};

try {
  // --- pure rules
  assert.equal(escapeHtml(`<a href="x">&</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  assert.equal(redact(`leaked ${TOKEN} here`), "leaked [redacted] here", "a bot token's shape is redacted with no list of secrets");
  const pureJob = {
    ...linearJob("pure", "PURE-1", { title: "Fix <the> & thing", url: "https://linear.app/x/issue/PURE-1", stage: "waiting", stage_at: new Date(0), question: `Use ${TOKEN} for <db>?`, provider: "codex" }),
    attempt: 1,
    pr_url: "https://github.com/o/r/pull/7?a=1&b=2",
  } as JobRow;
  const [pureEvent] = notifyEvents([pureJob]);
  const open = renderTelegram(pureEvent!, { panelUrl: "https://panel.test", spend: { usd: 1.234, known: true }, secrets: [TOKEN] }).text;
  assert.ok(!open.includes(TOKEN), "a token in a question never reaches Telegram");
  assert.match(open, /^❓ <b>PURE-1 · Fix &lt;the&gt; &amp; thing<\/b>\n<b>Question:<\/b> Use \[redacted\] for &lt;db&gt;\?\n/, "the job key, title and what it needs, escaped");
  assert.match(open, /\$1\.23/);
  assert.match(open, /<a href="https:\/\/panel\.test\/inbox\?job=PURE-1">Open in panel<\/a>/, "links to the job in the panel");
  assert.match(open, /<a href="https:\/\/github\.com\/o\/r\/pull\/7\?a=1&amp;b=2">Pull request<\/a>/, "and to the PR, its href escaped");
  assert.match(open, /<a href="https:\/\/linear\.app\/x\/issue\/PURE-1">Linear issue<\/a>/);
  const closed = renderTelegram(pureEvent!, { panelUrl: "https://panel.test", spend: null, secrets: [] }, "✅ Answered").text;
  assert.match(closed, /\n<b>✅ Answered<\/b> · Question\n/, "a resolved message says how it resolved");
  assert.doesNotMatch(renderTelegram({ ...pureEvent!, job: { ...pureJob, pr_url: null } }, { panelUrl: "https://panel.test", spend: null, secrets: [] }).text, /Pull request/, "no PR, no PR link");

  // --- off without a token or a chat id
  let mark = calls.length;
  assert.equal(telegramFromEnv({}), null);
  assert.equal(telegramFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN }), null, "no chat id, no notifier");
  assert.equal(telegramFromEnv({ TELEGRAM_CHAT_ID: CHAT }), null, "no token, no notifier");
  assert.equal(await notifyTelegram(telegramFromEnv({ TELEGRAM_CHAT_ID: CHAT })), "disabled");
  assert.equal(calls.length, mark, "nothing reached Telegram");
  const fromEnv = telegramFromEnv({ TELEGRAM_BOT_TOKEN: ` ${TOKEN} `, TELEGRAM_CHAT_ID: CHAT, TELEGRAM_API_URL: baseUrl, SLACK_BOT_TOKEN: "xoxb-other-secret-0000", PATH: "/bin" });
  assert.ok(fromEnv && fromEnv.chatId === CHAT);
  assert.ok(fromEnv.secrets.includes(TOKEN) && fromEnv.secrets.includes("xoxb-other-secret-0000") && !fromEnv.secrets.includes("/bin"), "the runner's secrets are kept out of messages");

  // The branch copies the dev database: send whatever its jobs already have, so only this script's jobs change below.
  await db.delete(notificationSettings);
  for (let i = 0; i < 40; i++) {
    const drained = await pass();
    if (drained.posted === 0 && !drained.deferred) break;
  }

  // --- a new needs-you event sends one message
  const a = await track("A", { stage: "waiting", stage_at: new Date(), question: "Postgres or SQLite?" });
  mark = calls.length;
  let result = await pass();
  const sends = since(mark, "sendMessage");
  assert.equal(sends.length, 1, "one message for the new question");
  assert.equal(sends[0]!.params.chat_id, CHAT);
  assert.equal(sends[0]!.params.parse_mode, "HTML");
  assert.equal(sends[0]!.token, TOKEN, "the token goes in the path");
  assert.match(textOf(sends[0]!), new RegExp(`❓ <b>${key("A")} · Job A</b>\\n<b>Question:</b> Postgres or SQLite\\?`));
  assert.match(textOf(sends[0]!), new RegExp(`/inbox\\?job=${key("A")}">Open in panel</a>`));
  let [row] = await rowsFor(a);
  assert.equal(row!.state, "open");
  assert.equal(row!.chat_id, CHAT);
  assert.equal(typeof row!.message_id, "number");
  assert.ok(result.posted >= 1);

  // --- a replay sends nothing: a re-tick and a restart
  mark = calls.length;
  await pass();
  telegram = fresh();
  await pass();
  assert.equal(since(mark).length, 0, "a re-tick and a restart send and edit nothing");

  // --- the question changes: the same message is edited
  await setJob(a, { question: "Postgres, SQLite or both?" });
  mark = calls.length;
  await pass();
  assert.deepEqual(since(mark).map((c) => [c.method, c.params.message_id]), [["editMessageText", row!.message_id]], "a changed question edits its message");

  // --- resolved: the same message is edited to say how
  await setJob(a, { stage: "implementing", stage_at: new Date(), answered_at: new Date(), question: null });
  mark = calls.length;
  await pass();
  const edits = since(mark, "editMessageText");
  assert.equal(edits.length, 1);
  assert.equal(edits[0]!.params.message_id, row!.message_id, "the question's own message");
  assert.equal(edits[0]!.params.chat_id, CHAT);
  assert.match(textOf(edits[0]!), /<b>✅ Answered<\/b> · Question/);
  assert.equal(since(mark, "sendMessage").length, 0, "no new message for the answer");
  [row] = await rowsFor(a);
  assert.equal(row!.state, "resolved");
  assert.equal(row!.resolution, "✅ Answered");
  mark = calls.length;
  await pass();
  assert.equal(since(mark).length, 0, "a resolved message is left alone");

  // --- a PR ready to review links the PR; turned off events send nothing
  await writeConfig({ events: { reviews: false } });
  const b = await track("B", { stage: "pr", stage_at: new Date(), pr_url: "https://github.com/o/r/pull/12", merge_decision: { outcome: "handover", reasons: ["Needs a look."], autonomy: "auto", evaluatedAt: new Date().toISOString(), headSha: "h", headSeenAt: null, stageEventId: null } });
  mark = calls.length;
  await pass();
  assert.equal(since(mark, "sendMessage").length, 0, "reviews are off in the notification settings");
  await writeConfig({});
  await pass();
  const review = since(mark, "sendMessage");
  assert.equal(review.length, 1, "and sent once they are on");
  assert.match(textOf(review[0]!), /^👀 <b>[^\n]*<\/b>\n<b>Ready for your review:<\/b> /);
  assert.match(textOf(review[0]!), /<a href="https:\/\/github\.com\/o\/r\/pull\/12">Pull request<\/a>/);
  assert.equal((await rowsFor(b))[0]!.kind, "handover");

  // --- quiet hours hold messages, and they go out when quiet hours end
  const hour = (offset: number) => new Date(Date.now() + offset * 3_600_000).toISOString().slice(11, 16);
  await writeConfig({ quietHours: { start: hour(-1), end: hour(1), timeZone: "UTC" } });
  const c = await track("C", { stage: "failed", stage_at: new Date(), stage_summary: "Tests failed." });
  mark = calls.length;
  result = await pass();
  assert.equal(since(mark, "sendMessage").length, 0);
  assert.equal((await rowsFor(c)).length, 0, "a failure waits out quiet hours");
  assert.ok(result.held >= 1);
  await writeConfig({});
  await pass();
  assert.equal(since(mark, "sendMessage").length, 1, "the held failure goes out when quiet hours end");
  assert.match(textOf(since(mark, "sendMessage")[0]!), /❌ [^]*Tests failed\./);

  // --- a chat Telegram refuses ends the pass's sends, and the event is tried again later
  telegram = fresh("-404");
  const d = await track("D", { stage: "waiting", stage_at: new Date(), question: "Gone?" });
  await track("D2", { stage: "waiting", stage_at: new Date(), question: "Gone too?" });
  mark = calls.length;
  result = await pass();
  assert.equal(since(mark, "sendMessage").length, 1, "one refused send ends the pass's sending");
  assert.match(result.errors!.join("\n"), /chat not found/);
  assert.equal((await rowsFor(d)).length, 0, "a failed send leaves no row behind");
  telegram = fresh();
  await pass();
  assert.equal((await rowsFor(d))[0]!.state, "open", "sent once the chat works");

  // --- 429: a short retry_after is waited out, one call at a time
  const e = await track("E", { stage: "waiting", stage_at: new Date(), question: "Rate limited?" });
  forced.push({ method: "sendMessage", status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 } } });
  maxInFlight = 0;
  mark = calls.length;
  await pass();
  const tries = calls.slice(mark).filter((c) => c.method === "sendMessage");
  assert.equal(tries.length, 2, "the 429 and its retry");
  assert.ok(tries[1]!.at - tries[0]!.at >= 950, "the retry waited for retry_after");
  assert.equal(maxInFlight, 1, "one call at a time");
  assert.equal((await rowsFor(e))[0]!.state, "open");

  // --- a long retry_after pauses the client; the event waits for a later pass
  const f = await track("F", { stage: "waiting", stage_at: new Date(), question: "Paused?" });
  forced.push({ method: "sendMessage", status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests: retry after 120", parameters: { retry_after: 120 } } });
  result = await pass();
  assert.ok(result.rateLimitedUntil && Date.parse(result.rateLimitedUntil) > Date.now() + 100_000, "the pass stops and says until when");
  assert.equal((await rowsFor(f)).length, 0, "no row is left posting");
  mark = calls.length;
  await pass();
  assert.equal(calls.length, mark, "while paused nothing reaches Telegram");
  await assert.rejects(telegram.client.sendMessage(CHAT, { text: "x" }), TelegramRateLimited);
  telegram = fresh();
  await pass();
  assert.equal((await rowsFor(f))[0]!.state, "open", "sent once the pause is over");

  // --- the per-pass call budget defers the rest to the next pass
  const burst = await Promise.all(Array.from({ length: 22 }, (_, i) => track(`G${i}`, { stage: "waiting", stage_at: new Date(), question: `Burst ${i}?` })));
  mark = calls.length;
  result = await pass();
  assert.equal(calls.length - mark, 20, "at most MAX_CALLS_PER_PASS calls");
  assert.equal(result.deferred, true);
  await pass();
  for (const id of burst) assert.equal((await rowsFor(id)).length, 1, "every burst event is sent exactly once");

  // --- a row a dead runner left posting is sent again
  const h = await track("H", { stage: "waiting", stage_at: new Date(), question: "Crashed?" });
  const hEvent = notifyEvents([(await db.select().from(jobs).where(eq(jobs.id, h as JobRow["id"])))[0]!])[0]!;
  const stale = new Date(Date.now() - POSTING_STALE_MS - 1000);
  await db.insert(telegramMessages).values({ id: hEvent.id, job_id: hEvent.job.id, kind: hEvent.kind, state: "posting", created_at: stale, updated_at: stale });
  await pass();
  assert.equal((await rowsFor(h))[0]!.state, "open");

  // --- the token never appears in errors or messages
  const unreachable = telegramClient({ token: TOKEN, baseUrl: "http://127.0.0.1:1", minGapMs: 0 });
  const network = await unreachable.sendMessage(CHAT, { text: "x" }).catch((error: unknown) => error as Error);
  assert.ok(network instanceof Error);
  assert.ok(!network.message.includes(TOKEN) && !network.message.includes(encodeURIComponent(TOKEN)), `a network error does not quote the URL: ${network.message}`);
  forced.push({ method: "sendMessage", status: 400, body: { ok: false, error_code: 400, description: `Bad Request: token ${TOKEN} echoed` } });
  const echoed = await telegram.client.sendMessage(CHAT, { text: "x" }).catch((error: unknown) => error as Error);
  assert.ok(echoed instanceof Error && !echoed.message.includes(TOKEN), "an error that echoes the token is redacted");
  const wrong = await telegramClient({ token: "987654321:BBwrong-token-for-regressions-0000000", baseUrl, minGapMs: 0 }).sendMessage(CHAT, { text: "x" }).catch((error: unknown) => error as Error);
  assert.match(String(wrong), /Telegram sendMessage failed: http 401: Unauthorized/);
  assert.ok(!String(wrong).includes("BBwrong-token"));
  forced.push({ method: "sendMessage", status: 400, body: { ok: false, error_code: 400, description: `Bad Request: can't parse ${TOKEN}` } });
  await track("L", { title: `Leak ${TOKEN}`, stage: "failed", stage_at: new Date(), stage_summary: `Failed with TELEGRAM_BOT_TOKEN=${TOKEN}` });
  result = await pass();
  assert.ok(result.errors && result.errors.length > 0, "the refused send is an error");
  assert.ok(!JSON.stringify(result).includes(TOKEN), "the pass's errors carry no token");
  await pass();
  for (const call of calls) assert.ok(!JSON.stringify(call.params).includes(TOKEN), `${call.method} carries no token in its body`);

  console.log("telegram regressions passed");
} finally {
  if (created.length > 0) {
    await db.delete(telegramMessages).where(inArray(telegramMessages.job_id, created as JobRow["id"][]));
    await db.delete(jobs).where(inArray(jobs.id, created as JobRow["id"][]));
  }
  await db.delete(notificationSettings);
  await server.close();
}
process.exit(0);
