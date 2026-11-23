import { createHash } from "node:crypto";
import { harnessLabel } from "./harness";
import { INBOX_ACTIONS, INBOX_KINDS, type InboxAction, type InboxKind } from "./inbox";
import { ACTION_LABELS, clip, EMOJI, LABELS, redact, type MessageFacts, type NotifyEvent, type NotifyKind } from "./slack";
import { sourceLink } from "./sources/shapes";

// Telegram notifications: the Bot API calls the runner's notifier (runner/telegram.ts) and the
// panel's webhook (lib/telegram-webhook.ts) make, and what a message says and which buttons it has. The events, their ids and their resolutions are Slack's (lib/slack.ts), so
// both channels send the same things. Messages are HTML (parse_mode HTML) with every text escaped.
//
// One call at a time per client, with a gap between calls, under Telegram's limits. A 429 waits out
// retry_after when it is short; a longer one pauses the client, and every call until then throws
// TelegramRateLimited without reaching Telegram. The token is in every request's URL, so no error
// carries the URL or a message that could contain it: errors name the method and Telegram's
// description, redacted.

export const TELEGRAM_API_URL = "https://api.telegram.org";

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly description: string,
  ) {
    super(`Telegram ${method} failed: ${description}`);
  }
}

export class TelegramRateLimited extends Error {
  constructor(readonly until: number) {
    super(`Telegram is rate limiting the factory until ${new Date(until).toISOString()}`);
  }
}

export type TelegramClientOptions = {
  token: string;
  /** The fake server's URL in the regressions; Telegram's otherwise. */
  baseUrl?: string;
  minGapMs?: number;
  /** The longest retry_after a call waits out itself; a longer one pauses the client. */
  maxWaitMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** One inline button; callback_data is `<code>:<token>`, see callbackData. */
export type InlineButton = { text: string; callback_data: string };
export type InlineKeyboard = InlineButton[][];
/** A message's text and, while its event is open, the buttons of its inbox actions. */
export type TelegramMessage = { text: string; keyboard?: InlineKeyboard };
export type SendOptions = {
  /** Sent as a reply to this message. */
  replyTo?: number;
  /** Opens the owner's reply box on this message, with this placeholder; their reply is the text a button asked for. */
  forceReply?: string;
};
export type TelegramClient = ReturnType<typeof telegramClient>;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const errorResponse = (body: Record<string, unknown>) => ({
  description: typeof body.description === "string" ? body.description : "unknown error",
  retryAfter: Number((body.parameters as { retry_after?: unknown } | undefined)?.retry_after),
});

export function telegramClient({ token, baseUrl = TELEGRAM_API_URL, minGapMs = 1_000, maxWaitMs = 10_000, retries = 2, sleep = wait, now = Date.now }: TelegramClientOptions) {
  let chain: Promise<unknown> = Promise.resolve();
  let lastCallAt = 0;
  let pausedUntil = 0;
  const base = baseUrl.replace(/\/+$/, "");
  const fail = (method: string, description: string) => new TelegramApiError(method, redact(description, [token, encodeURIComponent(token)]));

  async function send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      if (now() < pausedUntil) throw new TelegramRateLimited(pausedUntil);
      const gap = lastCallAt + minGapMs - now();
      if (gap > 0) await sleep(gap);
      lastCallAt = now();
      let response: Response;
      try {
        response = await fetch(`${base}/bot${token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        // A network error's message may quote the URL, and with it the token; fail redacts it.
        throw fail(method, error instanceof Error ? error.message : String(error));
      }
      const body = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      if (response.status === 429) {
        const { retryAfter } = errorResponse(body);
        const header = Number(response.headers.get("retry-after"));
        const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Number.isFinite(header) && header > 0 ? header : 30;
        const waitMs = seconds * 1_000;
        if (waitMs > maxWaitMs || attempt >= retries) {
          pausedUntil = now() + waitMs;
          throw new TelegramRateLimited(pausedUntil);
        }
        await sleep(waitMs);
        continue;
      }
      if (body.ok !== true) throw fail(method, response.ok ? errorResponse(body).description : `http ${response.status}: ${errorResponse(body).description}`);
      return body;
    }
  }

  function call(method: string, params: Record<string, unknown>) {
    const result = chain.then(() => send(method, params));
    chain = result.catch(() => undefined);
    return result;
  }

  const markup = (message: TelegramMessage) => (message.keyboard && message.keyboard.length > 0 ? { reply_markup: { inline_keyboard: message.keyboard } } : {});

  return {
    async sendMessage(chatId: string, message: TelegramMessage, options: SendOptions = {}) {
      const body = await call("sendMessage", {
        chat_id: chatId,
        text: message.text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...markup(message),
        ...(options.replyTo !== undefined && { reply_parameters: { message_id: options.replyTo, allow_sending_without_reply: true } }),
        ...(options.forceReply !== undefined && { reply_markup: { force_reply: true, input_field_placeholder: clip(options.forceReply, 64) } }),
      });
      const result = body.result as { message_id?: unknown; chat?: { id?: unknown } } | undefined;
      if (typeof result?.message_id !== "number") throw new TelegramApiError("sendMessage", "no message_id in the answer");
      return { chatId: result.chat?.id === undefined ? chatId : String(result.chat.id), messageId: result.message_id };
    },
    async editMessageText(chatId: string, messageId: number, message: TelegramMessage) {
      try {
        // A message without a keyboard loses the one it had: a resolved or pending message has no buttons.
        await call("editMessageText", { chat_id: chatId, message_id: messageId, text: message.text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...markup(message) });
      } catch (error) {
        // The message already says this, which is the state the edit wanted.
        if (error instanceof TelegramApiError && /message is not modified/i.test(error.description)) return;
        throw error;
      }
    },
    /** Swaps only the buttons, as the Approve and merge confirmation does. */
    async editMessageReplyMarkup(chatId: string, messageId: number, keyboard: InlineKeyboard) {
      try {
        await call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
      } catch (error) {
        if (error instanceof TelegramApiError && /message is not modified/i.test(error.description)) return;
        throw error;
      }
    },
    /** Ends the button's spinner with a short note; Telegram shows at most 200 characters. */
    async answerCallbackQuery(callbackQueryId: string, text: string) {
      await call("answerCallbackQuery", { callback_query_id: callbackQueryId, text: clip(redact(text, [token]), 200) });
    },
    async setWebhook(params: { url: string; secretToken: string; allowedUpdates: readonly string[]; dropPendingUpdates: boolean }) {
      await call("setWebhook", { url: params.url, secret_token: params.secretToken, allowed_updates: params.allowedUpdates, drop_pending_updates: params.dropPendingUpdates });
    },
    async getWebhookInfo() {
      return ((await call("getWebhookInfo", {})).result ?? {}) as Record<string, unknown>;
    },
    pausedUntil: () => pausedUntil,
  };
}

// --- buttons

/**
 * The buttons a message can carry, by the code its callback_data holds. Most run an inbox action
 * at once; `prompt` ones ask for text with a force_reply message first; Approve and merge asks to
 * confirm, and the confirmation (`confirm`) runs it. `cancel` puts the message's buttons back.
 */
export const TELEGRAM_BUTTONS = {
  an: { action: "answer", mode: "prompt", label: ACTION_LABELS.answer },
  ap: { action: "approve", mode: "ask", label: ACTION_LABELS.approve },
  ok: { action: "approve", mode: "now", label: "✅ Confirm: approve and merge" },
  rc: { action: "request_changes", mode: "prompt", label: ACTION_LABELS.request_changes },
  fu: { action: "follow_up", mode: "prompt", label: ACTION_LABELS.follow_up },
  cl: { action: "close", mode: "now", label: ACTION_LABELS.close },
  dm: { action: "dismiss", mode: "now", label: ACTION_LABELS.dismiss },
  rs: { action: "retry_stop", mode: "now", label: ACTION_LABELS.retry_stop },
  rt: { action: "retry", mode: "now", label: ACTION_LABELS.retry },
  rn: { action: "retry", mode: "prompt", label: "Retry with note" },
  no: { action: null, mode: "cancel", label: "Cancel" },
} as const satisfies Record<string, { action: InboxAction | null; mode: "now" | "prompt" | "ask" | "cancel"; label: string }>;
export type ButtonCode = keyof typeof TELEGRAM_BUTTONS;

/** Each inbox kind's buttons, in rows: the panel's actions, with Retry offered with and without a note. */
export const TELEGRAM_KEYBOARDS = {
  question: [["an"]],
  handover: [["ap"], ["rc", "cl"]],
  failed: [["rt", "rn"], ["cl", "dm"]],
  revert_failed: [["fu", "dm"]],
  stop_unconfirmed: [["rs", "dm"]],
} as const satisfies Record<InboxKind, readonly (readonly ButtonCode[])[]>;

/** What a factory message's text answers when the owner replies to it; the other kinds take buttons only. */
export const REPLY_ACTIONS: Partial<Record<InboxKind, InboxAction>> = {
  question: "answer",
  handover: "request_changes",
  failed: "retry",
  revert_failed: "follow_up",
};

/** Telegram's limit for callback_data, in bytes. */
export const CALLBACK_DATA_MAX = 64;
const TOKEN_RE = /^[0-9a-f]{16}$/;

/** The short id an event's buttons carry: event ids hold a job id and a timestamp, too long for callback_data. Migration 0042 derives the same in SQL. */
export const telegramToken = (eventId: string) => createHash("sha256").update(eventId).digest("hex").slice(0, 16);

export const callbackData = (code: ButtonCode, token: string) => `${code}:${token}`;

export function parseCallbackData(data: string): { button: (typeof TELEGRAM_BUTTONS)[ButtonCode]; code: ButtonCode; token: string } | null {
  const [code, token, ...rest] = data.split(":");
  if (rest.length > 0 || !code || !token || !TOKEN_RE.test(token) || !Object.hasOwn(TELEGRAM_BUTTONS, code)) return null;
  return { button: TELEGRAM_BUTTONS[code as ButtonCode], code: code as ButtonCode, token };
}

const isInboxKind = (kind: NotifyKind): kind is InboxKind => (INBOX_KINDS as readonly string[]).includes(kind);

/** The open message's keyboard for an event; none for an update (merged, reverted). */
export function eventKeyboard(kind: NotifyKind, eventId: string): InlineKeyboard {
  if (!isInboxKind(kind)) return [];
  const token = telegramToken(eventId);
  return TELEGRAM_KEYBOARDS[kind].map((row) => row.map((code) => ({ text: TELEGRAM_BUTTONS[code].label, callback_data: callbackData(code, token) })));
}

/** The keyboard Approve and merge swaps in: confirm or cancel. */
export const confirmKeyboard = (eventId: string): InlineKeyboard => [
  [
    { text: TELEGRAM_BUTTONS.ok.label, callback_data: callbackData("ok", telegramToken(eventId)) },
    { text: TELEGRAM_BUTTONS.no.label, callback_data: callbackData("no", telegramToken(eventId)) },
  ],
];

// Every keyboard's actions are the inbox kind's; a mismatch is a bug, caught at load.
for (const kind of INBOX_KINDS) {
  const offered = new Set(TELEGRAM_KEYBOARDS[kind].flat().map((code) => TELEGRAM_BUTTONS[code].action));
  if ([...offered].sort().join() !== [...INBOX_ACTIONS[kind]].sort().join()) throw new Error(`Telegram's ${kind} buttons are not the inbox's actions`);
}

/** Telegram's HTML parse mode needs these escaped in text and in attribute values. */
export const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const TITLE_MAX = 150;
const REASON_MAX = 600;
const usd = (spend: NonNullable<MessageFacts["spend"]>) => `$${spend.usd.toFixed(2)}${spend.known ? "" : "+"}`;
const link = (href: string, label: string) => `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;

/**
 * The message for an event: what it needs while open, with its inbox actions' buttons when the
 * event's id is given; what is on its way while an action is pending; how it resolved once
 * resolved. Links go to the panel, the PR and the issue. Only an open message has buttons.
 */
export function renderTelegram(
  event: Pick<NotifyEvent, "kind" | "job" | "reason"> & { id?: string },
  facts: MessageFacts,
  resolved: string | null = null,
  pending: string | null = null,
): TelegramMessage {
  const { job, kind } = event;
  const clean = (text: string) => redact(text, facts.secrets).replace(/\s+/g, " ").trim();
  const title = clip(clean(job.title), TITLE_MAX);
  const status = resolved ?? pending;
  const line = status ? `<b>${escapeHtml(status)}</b> · ${escapeHtml(LABELS[kind])}` : `<b>${escapeHtml(LABELS[kind])}:</b> ${escapeHtml(clip(clean(event.reason), REASON_MAX))}`;
  const meta = [job.repo, ...(job.provider ? [harnessLabel(job.provider)] : []), ...(facts.spend ? [usd(facts.spend)] : [])];
  const source = sourceLink(job);
  const links = [
    link(`${facts.panelUrl}/inbox?job=${encodeURIComponent(job.key)}`, "Open in panel"),
    ...(job.pr_url ? [link(job.pr_url, "Pull request")] : []),
    ...(/^https?:\/\//.test(source.href) ? [link(source.href, `${source.label} issue`)] : []),
  ];
  const text = [`${EMOJI[kind]} <b>${escapeHtml(job.key)} · ${escapeHtml(title)}</b>`, line, escapeHtml(meta.join(" · ")), links.join(" · ")].join("\n");
  const keyboard = !status && event.id ? eventKeyboard(kind, event.id) : [];
  return keyboard.length > 0 ? { text, keyboard } : { text };
}
