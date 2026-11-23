import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import type { JobRow } from "../db/schema";
import type { MergeDecision } from "../lib/merge-decision";
import type { Job } from "../lib/sources/types";

// Acting from Telegram: updates straight into the webhook handler, a fake Bot API on localhost, and
// the panel's own inbox actions and createJob behind them.

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;
const TOKEN = "123456789:AAregression-telegram-actions-0123456789";
const SECRET = "regression-webhook-secret_0123456789";
const CHAT = "424242";

const { db } = await import("../db/client");
const { auditLog, intents, jobs, telegramMessages, telegramPrompts, telegramUpdates } = await import("../db/schema");
const { linearJob } = await import("./fixtures");
const { approveDetailSchema, feedbackDetailSchema, INBOX_ACTIONS, INBOX_KINDS } = await import("../lib/inbox");
const { notifyEvents } = await import("../lib/slack");
const { chatRequestId } = await import("../lib/chat-actions");
const { CALLBACK_DATA_MAX, callbackData, confirmKeyboard, eventKeyboard, parseCallbackData, renderTelegram, TELEGRAM_BUTTONS, TELEGRAM_KEYBOARDS, telegramClient, telegramToken } = await import(
  "../lib/telegram"
);
const { ALREADY_RESOLVED, handleTelegramUpdate, SECRET_HEADER, USAGE, verifySecret } = await import("../lib/telegram-webhook");
const { ownerFromAllowlist } = await import("../lib/slack-interactions");
const { serve } = await import("./serve");

// --- the fake Bot API
type Call = { method: string; params: Record<string, unknown> };
const calls: Call[] = [];
let nextId = 10_000;
const server = await serve(0, async (request) => {
  const [, bot, method] = new URL(request.url).pathname.match(/^\/bot([^/]+)\/(.+)$/) ?? [];
  const params = JSON.parse((await request.text()) || "{}") as Record<string, unknown>;
  calls.push({ method: method ?? "", params });
  if (decodeURIComponent(bot ?? "") !== TOKEN) return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
  if (method === "sendMessage") return Response.json({ ok: true, result: { message_id: nextId++, chat: { id: Number(params.chat_id) } } });
  return Response.json({ ok: true, result: true });
});
const baseUrl = `http://localhost:${server.port}`;

const prefix = `TGA${Date.now() % 1_000_000}`;
const created: string[] = [];
const replies: { job: Job; requestId: string; body: string }[] = [];
const filed: { title: string; description: string; labels?: unknown }[] = [];

const tasks: Promise<void>[] = [];
const drain = async () => {
  while (tasks.length > 0) await Promise.all(tasks.splice(0));
};
const owner = async () => ownerFromAllowlist();
const registry = [
  { repo: "o/default-repo", display_name: null, enabled: true, is_default: true },
  { repo: "o/other-repo", display_name: "Other", enabled: true, is_default: false },
];
const deps = {
  webhookSecret: SECRET,
  chatId: CHAT,
  telegram: telegramClient({ token: TOKEN, baseUrl, minGapMs: 0 }),
  inbox: {
    db,
    user: owner,
    reply: async (job: Job, requestId: string, body: string) => void replies.push({ job, requestId, body }),
    newJob: {
      user: owner,
      file: async (draft: { title: string; description: string; labels?: unknown }) => {
        filed.push(draft);
        return { key: "FAC-999", url: "https://plane.test/browse/FAC-999/" };
      },
      harnesses: async () => null,
      registry: async () => registry,
    },
  },
  panelUrl: "https://panel.test",
  secrets: [TOKEN, SECRET],
  after: (task: () => Promise<void>) => void tasks.push(task()),
  pollMs: 20,
  followMs: 1_000,
} as unknown as Parameters<typeof handleTelegramUpdate>[1];

let updateId = Math.floor(Date.now() / 1000) * 1000;
const post = (update: object, secret: string | null = SECRET) =>
  handleTelegramUpdate(
    new Request("http://localhost/api/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret !== null && { [SECRET_HEADER]: secret }) },
      body: JSON.stringify(update),
    }),
    deps,
  );
/** Sends one update and waits for its work; returns the update's id and the calls it made. */
async function send(body: object, opts: { secret?: string | null; id?: number } = {}) {
  const id = opts.id ?? ++updateId;
  const mark = calls.length;
  const response = await post({ update_id: id, ...body }, opts.secret === undefined ? SECRET : opts.secret);
  await drain();
  return { id, status: response.status, calls: calls.slice(mark) };
}
const press = (data: string, messageId: number, chat = CHAT) =>
  send({ callback_query: { id: `cb-${updateId}`, from: { id: Number(chat) }, data, message: { message_id: messageId, chat: { id: Number(chat) } } } });
let messages = 0;
const say = (text: string, replyTo?: number, chat = CHAT) =>
  send({ message: { message_id: 500 + ++messages, chat: { id: Number(chat) }, from: { id: Number(chat) }, text, ...(replyTo !== undefined && { reply_to_message: { message_id: replyTo } }) } });

const decision = (over: Partial<MergeDecision> = {}): MergeDecision => ({
  outcome: "handover",
  reasons: ["The agent isn't confident."],
  autonomy: "auto",
  evaluatedAt: new Date().toISOString(),
  headSha: "h1",
  headSeenAt: null,
  stageEventId: null,
  ...over,
});

let messageIds = 100;
/** A job with its open Telegram message, as the notifier leaves it. */
async function item(n: string, over: Partial<typeof jobs.$inferInsert>) {
  const row = linearJob(`${prefix}-${n}`, `${prefix}-${n}`, { title: `Job ${n}`, url: `https://linear.app/x/issue/${prefix}-${n}`, stage_at: new Date(), ...over });
  await db.insert(jobs).values(row);
  created.push(row.id!);
  const [job] = await db.select().from(jobs).where(eq(jobs.id, row.id!));
  const [event] = notifyEvents([job!]).filter((e) => e.open);
  assert.ok(event, `job ${n} is an inbox item`);
  const now = new Date();
  const messageId = ++messageIds;
  await db
    .insert(telegramMessages)
    .values({ id: event.id, job_id: job!.id, kind: event.kind, state: "open", chat_id: CHAT, message_id: messageId, token: telegramToken(event.id), created_at: now, updated_at: now });
  return { id: job!.id, eventId: event.id, messageId, token: telegramToken(event.id) };
}
const intentsFor = (id: string) => db.select().from(intents).where(eq(intents.job_id, id as JobRow["id"]));
const answered = (c: Call[]) => c.filter((x) => x.method === "answerCallbackQuery").map((x) => x.params.text);
const sent = (c: Call[]) => c.filter((x) => x.method === "sendMessage");
const edits = (c: Call[], messageId: number) => c.filter((x) => x.method === "editMessageText" && x.params.message_id === messageId);
const keyboardOf = (call: Call) => (call.params.reply_markup as { inline_keyboard?: { callback_data: string }[][] } | undefined)?.inline_keyboard;
const codesOf = (call: Call) => (keyboardOf(call) ?? []).flat().map((b) => b.callback_data.split(":")[0]);

try {
  // --- buttons: each kind's are its inbox actions, and every callback_data fits in 64 bytes
  for (const kind of INBOX_KINDS) {
    const actions = new Set(TELEGRAM_KEYBOARDS[kind].flat().map((code) => TELEGRAM_BUTTONS[code].action));
    assert.deepEqual([...actions].sort(), [...INBOX_ACTIONS[kind]].sort(), `${kind}'s buttons are its inbox actions`);
  }
  const longEvent = `linear:${"x".repeat(200)}:9:stop_unconfirmed:${new Date().toISOString()}`;
  for (const keyboard of [...INBOX_KINDS.map((kind) => eventKeyboard(kind, longEvent)), confirmKeyboard(longEvent)]) {
    for (const button of keyboard.flat()) {
      assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= CALLBACK_DATA_MAX, `${button.callback_data} fits in callback_data`);
      assert.equal(parseCallbackData(button.callback_data)?.token, telegramToken(longEvent), "and reads back to the event's token");
    }
  }
  assert.equal(parseCallbackData("zz:0123456789abcdef"), null, "an unknown code");
  assert.equal(parseCallbackData("ap:not-a-token"), null, "a malformed token");
  assert.equal(parseCallbackData(`ap:${"0".repeat(16)}:extra`), null);
  assert.deepEqual(eventKeyboard("merged", "e"), [], "an update offers nothing to do");
  const facts = { panelUrl: "https://panel.test", spend: null, secrets: [TOKEN] };
  const pureJob = { ...linearJob("pure", "PURE-1", { title: "t", stage: "pr", pr_url: "https://github.com/o/r/pull/7" }), attempt: 1 } as JobRow;
  const open = renderTelegram({ id: "e1", kind: "handover", job: pureJob, reason: "r" }, facts);
  assert.deepEqual(open.keyboard!.flat().map((b) => b.callback_data.split(":")[0]), ["ap", "rc", "cl"], "a handover offers approve, request changes and close");
  assert.equal(renderTelegram({ id: "e1", kind: "handover", job: pureJob, reason: "r" }, facts, "✅ Merged").keyboard, undefined, "a resolved message has no buttons");
  assert.equal(renderTelegram({ id: "e1", kind: "handover", job: pureJob, reason: "r" }, facts, null, "⏳ Merging…").keyboard, undefined, "nor does a pending one");
  assert.match(renderTelegram({ id: "e1", kind: "handover", job: pureJob, reason: "r" }, facts, null, "⏳ Merging…").text, /⏳ Merging…/);
  assert.equal(renderTelegram({ kind: "handover", job: pureJob, reason: "r" }, facts).keyboard, undefined, "no event id, no buttons");

  // --- the secret, constant-time
  assert.equal(verifySecret(SECRET, SECRET), true);
  assert.equal(verifySecret(SECRET, `${SECRET}x`), false);
  assert.equal(verifySecret(SECRET, null), false);
  assert.equal(verifySecret(undefined, SECRET), false, "no secret configured, nothing passes");
  assert.equal(verifySecret("", ""), false);

  const hand = await item("H", { stage: "pr", pr_url: "https://github.com/o/r/pull/1", merge_decision: decision() });

  // --- a bad or missing secret is refused before anything is read or written
  for (const secret of [null, "wrong-secret", `${SECRET}0`]) {
    const refused = await send({ callback_query: { id: "cb-x", data: callbackData("ok", hand.token), message: { message_id: hand.messageId, chat: { id: Number(CHAT) } } } }, { secret });
    assert.equal(refused.status, 401, `secret ${secret === null ? "missing" : "wrong"} is refused`);
    assert.deepEqual(refused.calls, [], "and nothing reaches Telegram");
    assert.equal((await db.select().from(telegramUpdates).where(eq(telegramUpdates.update_id, refused.id))).length, 0, "nor is the update recorded");
  }
  assert.equal(
    (await handleTelegramUpdate(new Request("http://localhost/", { method: "POST", headers: { [SECRET_HEADER]: SECRET }, body: "{}" }), { ...deps, webhookSecret: undefined })).status,
    401,
    "no TELEGRAM_WEBHOOK_SECRET, no actions",
  );
  assert.equal((await intentsFor(hand.id)).length, 0);

  // --- another chat is ignored silently
  const foreign = await press(callbackData("ok", hand.token), hand.messageId, "999");
  assert.equal(foreign.status, 200, "answered so Telegram doesn't resend it");
  assert.deepEqual(foreign.calls, [], "with no answer in Telegram");
  assert.equal((await db.select().from(telegramUpdates).where(eq(telegramUpdates.update_id, foreign.id))).length, 0);
  const foreignJob = await say("/job Build something", undefined, "999");
  assert.deepEqual(foreignJob.calls, []);
  assert.equal(filed.length, 0, "a foreign /job files nothing");
  assert.equal((await intentsFor(hand.id)).length, 0, "a foreign button changes nothing");

  // --- Approve and merge asks first; the confirmation records the panel's approve_merge intent
  const ask = await press(callbackData("ap", hand.token), hand.messageId);
  assert.deepEqual(answered(ask.calls), ["Tap Confirm to merge."]);
  const swapped = ask.calls.find((c) => c.method === "editMessageReplyMarkup")!;
  assert.deepEqual(codesOf(swapped), ["ok", "no"], "the buttons become confirm and cancel");
  assert.equal((await intentsFor(hand.id)).length, 0, "nothing recorded before the confirmation");
  const cancel = await press(callbackData("no", hand.token), hand.messageId);
  assert.deepEqual(codesOf(cancel.calls.find((c) => c.method === "editMessageReplyMarkup")!), ["ap", "rc", "cl"], "cancel puts the buttons back");
  const confirm = await press(callbackData("ok", hand.token), hand.messageId);
  assert.deepEqual(answered(confirm.calls), ["⏳ Merging…"]);
  const approvals = await intentsFor(hand.id);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.id, `panel:approve_merge:${chatRequestId("telegram", hand.eventId, "approve")}`);
  assert.deepEqual(approveDetailSchema.parse(JSON.parse(approvals[0]!.detail!)), { actor: OWNER, headSha: "h1", via: "inbox" }, "the inbox's own approval");
  const pending = edits(confirm.calls, hand.messageId)[0]!;
  assert.match(String(pending.params.text), /⏳ Merging…/, "the message turns pending when the button is pressed");
  assert.equal(keyboardOf(pending), undefined, "with no buttons to press again");

  // --- a replayed update_id does nothing
  const replay = await send(
    { callback_query: { id: "cb-replay", data: callbackData("ok", hand.token), message: { message_id: hand.messageId, chat: { id: Number(CHAT) } } } },
    { id: confirm.id },
  );
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.calls, [], "a redelivery reaches nothing");
  assert.equal((await intentsFor(hand.id)).length, 1, "and records nothing");

  // --- the runner refuses: the buttons come back and the chat hears why
  const red = await item("R", { stage: "pr", pr_url: "https://github.com/o/r/pull/2", merge_decision: decision({ headSha: "h2" }) });
  const runner = (async () => {
    for (let i = 0; i < 1000; i++) {
      const [intent] = await intentsFor(red.id);
      if (intent) {
        await db.update(intents).set({ handled_at: new Date(), result: JSON.stringify({ approval: { blocked: "a check is red on h2" } }) }).where(eq(intents.id, intent.id));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  const refusedMerge = await press(callbackData("ok", red.token), red.messageId);
  await runner;
  assert.deepEqual(sent(refusedMerge.calls).map((c) => c.params.text), ["Not merged: a check is red on h2"]);
  assert.deepEqual(codesOf(edits(refusedMerge.calls, red.messageId).at(-1)!), ["ap", "rc", "cl"], "the buttons are back");

  // --- Request changes sends a force_reply prompt; the reply to it is the feedback
  const changes = await item("C", { stage: "pr", pr_url: "https://github.com/o/r/pull/3", merge_decision: decision() });
  const prompted = await press(callbackData("rc", changes.token), changes.messageId);
  assert.deepEqual(answered(prompted.calls), ["Reply to the message below."]);
  const prompt = sent(prompted.calls)[0]!;
  assert.equal((prompt.params.reply_markup as { force_reply?: boolean }).force_reply, true, "the prompt opens the reply box");
  assert.equal((prompt.params.reply_parameters as { message_id: number }).message_id, changes.messageId, "under the factory message");
  const [promptRow] = await db.select().from(telegramPrompts).where(eq(telegramPrompts.event_id, changes.eventId));
  assert.equal(promptRow?.action, "request_changes");
  assert.equal((await intentsFor(changes.id)).length, 0, "nothing recorded until the reply");
  const promptReply = await say("Rename the flag.", promptRow!.message_id);
  const [changeIntent] = await intentsFor(changes.id);
  assert.equal(changeIntent?.kind, "request_changes");
  assert.equal(feedbackDetailSchema.parse(JSON.parse(changeIntent!.detail!)).body, "Rename the flag.");
  assert.deepEqual(sent(promptReply.calls).map((c) => c.params.text), ["⏳ Sending your changes…"]);

  // --- a reply to a PR handed over requests changes
  const direct = await item("D", { stage: "pr", pr_url: "https://github.com/o/r/pull/4", merge_decision: decision() });
  await say("Add a test for the empty case.", direct.messageId);
  const [directIntent] = await intentsFor(direct.id);
  assert.equal(directIntent?.id, `panel:request_changes:${chatRequestId("telegram", direct.eventId, "request_changes")}`);
  assert.equal(feedbackDetailSchema.parse(JSON.parse(directIntent!.detail!)).body, "Add a test for the empty case.");

  // --- a reply to a question answers it in the source, and the job resumes
  const question = await item("Q", { stage: "waiting", question: "Which database?" });
  const answer = await say("Postgres.", question.messageId);
  assert.deepEqual(
    replies.map((r) => [r.job.key, r.requestId, r.body]),
    [[`${prefix}-Q`, chatRequestId("telegram", question.eventId, "answer"), "Postgres."]],
    "posted in the source as the panel does",
  );
  const [answerIntent] = await intentsFor(question.id);
  assert.equal(answerIntent?.kind, "answer");
  assert.match(String(edits(answer.calls, question.messageId)[0]!.params.text), /Answer sent/);
  // The Answer button prompts instead.
  const answerButton = await press(callbackData("an", question.token), question.messageId);
  assert.equal(sent(answerButton.calls).length, 1, "a force_reply prompt");

  // --- failures: Retry at once, Retry with a reply's note, Dismiss, Close
  const failed = await item("F", { stage: "failed", stage_summary: "Tests failed." });
  const retried = await say("Use the other fixture.", failed.messageId);
  const [retryIntent] = await intentsFor(failed.id);
  assert.equal(retryIntent?.kind, "retry_job", "a reply to a failure retries it");
  assert.equal(JSON.parse(retryIntent!.detail!).note, "Use the other fixture.", "with the reply as the note");
  assert.deepEqual(sent(retried.calls).map((c) => c.params.text), ["⏳ Retrying…"]);
  const plain = await item("P", { stage: "failed", stage_summary: "Boom." });
  await press(callbackData("rt", plain.token), plain.messageId);
  const [plainRetry] = await intentsFor(plain.id);
  assert.equal(plainRetry?.kind, "retry_job");
  assert.equal(JSON.parse(plainRetry!.detail!).note, "", "Retry without a note");
  const closing = await item("X", { stage: "failed", stage_summary: "Boom." });
  await press(callbackData("cl", closing.token), closing.messageId);
  assert.equal((await intentsFor(closing.id))[0]?.kind, "close_job");
  const dismissed = await item("Z", { stage: "failed", stage_summary: "Boom." });
  const dismiss = await press(callbackData("dm", dismissed.token), dismissed.messageId);
  assert.deepEqual(answered(dismiss.calls), ["Dismissed"]);
  const [dismissedJob] = await db.select().from(jobs).where(eq(jobs.id, dismissed.id));
  assert.ok(dismissedJob?.dismissed_at, "dismissed at once");
  const stale = await press(callbackData("dm", dismissed.token), dismissed.messageId);
  assert.deepEqual(answered(stale.calls), [ALREADY_RESOLVED], "the event left the inbox, so the button is stale");
  const staleReply = await say("Again?", dismissed.messageId);
  assert.deepEqual(sent(staleReply.calls).map((c) => c.params.text), [ALREADY_RESOLVED]);

  // --- /job files a job through the panel's createJob and answers with its key and link
  const job = await say("/job Add a dark mode toggle\nIt should follow the system setting.");
  assert.equal(filed.length, 1);
  assert.equal(filed[0]!.title, "Add a dark mode toggle");
  assert.equal(filed[0]!.description, "Add a dark mode toggle\nIt should follow the system setting.");
  assert.match(String(JSON.stringify(filed[0]!.labels)), /default-repo/, "the default repo's label, as the panel adds it");
  const filedReply = String(sent(job.calls)[0]!.params.text);
  assert.match(filedReply, /FAC-999/);
  assert.match(filedReply, /https:\/\/plane\.test\/browse\/FAC-999\//);
  await say("/job repo:other Fix the footer");
  assert.equal(filed[1]!.title, "Fix the footer");
  assert.match(JSON.stringify(filed[1]!.labels), /Other/, "repo: picks the repository");
  const noRepo = await say("/job repo:missing Fix it");
  assert.equal(filed.length, 2);
  assert.match(String(sent(noRepo.calls)[0]!.params.text), /No enabled repository is named missing/);
  const bare = await say("/job");
  assert.equal(sent(bare.calls)[0]!.params.text, USAGE, "a bare /job shows the usage");
  assert.equal(filed.length, 2);

  // --- nothing it can't read leaks the token
  for (const call of calls) assert.doesNotMatch(JSON.stringify(call.params), new RegExp(`${TOKEN}|${SECRET}`), "no token or secret in what is sent");

  console.log("telegram actions regressions passed");
} finally {
  if (created.length > 0) {
    const ids = created as JobRow["id"][];
    await db.delete(intents).where(inArray(intents.job_id, ids));
    await db.delete(auditLog).where(inArray(auditLog.job_id, ids));
    const rows = await db.select({ id: telegramMessages.id }).from(telegramMessages).where(inArray(telegramMessages.job_id, ids));
    if (rows.length > 0) await db.delete(telegramPrompts).where(inArray(telegramPrompts.event_id, rows.map((r) => r.id)));
    await db.delete(telegramMessages).where(inArray(telegramMessages.job_id, ids));
    await db.delete(jobs).where(inArray(jobs.id, ids));
  }
  await server.close();
}
process.exit(0);
