import { harnessLabel } from "./harness";
import { clip, EMOJI, LABELS, redact, type MessageFacts, type NotifyEvent } from "./slack";
import { sourceLink } from "./sources/shapes";

// Telegram notifications: the Bot API calls the runner's notifier (runner/telegram.ts) makes, and
// what a message says. The events, their ids and their resolutions are Slack's (lib/slack.ts), so
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

export type TelegramMessage = { text: string };
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

  return {
    async sendMessage(chatId: string, message: TelegramMessage) {
      const body = await call("sendMessage", { chat_id: chatId, text: message.text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      const result = body.result as { message_id?: unknown; chat?: { id?: unknown } } | undefined;
      if (typeof result?.message_id !== "number") throw new TelegramApiError("sendMessage", "no message_id in the answer");
      return { chatId: result.chat?.id === undefined ? chatId : String(result.chat.id), messageId: result.message_id };
    },
    async editMessageText(chatId: string, messageId: number, message: TelegramMessage) {
      try {
        await call("editMessageText", { chat_id: chatId, message_id: messageId, text: message.text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      } catch (error) {
        // The message already says this, which is the state the edit wanted.
        if (error instanceof TelegramApiError && /message is not modified/i.test(error.description)) return;
        throw error;
      }
    },
    pausedUntil: () => pausedUntil,
  };
}

/** Telegram's HTML parse mode needs these escaped in text and in attribute values. */
export const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const TITLE_MAX = 150;
const REASON_MAX = 600;
const usd = (spend: NonNullable<MessageFacts["spend"]>) => `$${spend.usd.toFixed(2)}${spend.known ? "" : "+"}`;
const link = (href: string, label: string) => `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;

/** The message for an event: what it needs while open, how it resolved once resolved, with links to the panel, the PR and the issue. */
export function renderTelegram(event: Pick<NotifyEvent, "kind" | "job" | "reason">, facts: MessageFacts, resolved: string | null = null): TelegramMessage {
  const { job, kind } = event;
  const clean = (text: string) => redact(text, facts.secrets).replace(/\s+/g, " ").trim();
  const title = clip(clean(job.title), TITLE_MAX);
  const line = resolved ? `<b>${escapeHtml(resolved)}</b> · ${escapeHtml(LABELS[kind])}` : `<b>${escapeHtml(LABELS[kind])}:</b> ${escapeHtml(clip(clean(event.reason), REASON_MAX))}`;
  const meta = [job.repo, ...(job.provider ? [harnessLabel(job.provider)] : []), ...(facts.spend ? [usd(facts.spend)] : [])];
  const source = sourceLink(job);
  const links = [
    link(`${facts.panelUrl}/inbox?job=${encodeURIComponent(job.key)}`, "Open in panel"),
    ...(job.pr_url ? [link(job.pr_url, "Pull request")] : []),
    ...(/^https?:\/\//.test(source.href) ? [link(source.href, `${source.label} issue`)] : []),
  ];
  return { text: [`${EMOJI[kind]} <b>${escapeHtml(job.key)} · ${escapeHtml(title)}</b>`, line, escapeHtml(meta.join(" · ")), links.join(" · ")].join("\n") };
}
