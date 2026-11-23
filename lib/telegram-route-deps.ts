import { after } from "next/server";
import { inboxDeps } from "@/lib/inbox-deps";
import { panelUrl, secretValues } from "@/lib/slack";
import { ownerFromAllowlist } from "@/lib/slack-interactions";
import { telegramClient } from "@/lib/telegram";
import type { TelegramWebhookDeps } from "@/lib/telegram-webhook";

/** What the Telegram webhook acts with: the panel's env, its inbox and new-job actions as the owner, and next/server's after. */
export function telegramRouteDeps(): TelegramWebhookDeps {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return {
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || undefined,
    chatId: process.env.TELEGRAM_CHAT_ID?.trim() || undefined,
    telegram: token ? telegramClient({ token, baseUrl: process.env.TELEGRAM_API_URL?.trim() || undefined, minGapMs: 0 }) : null,
    inbox: inboxDeps(async () => ownerFromAllowlist()),
    panelUrl: panelUrl(),
    secrets: secretValues(process.env),
    after,
  };
}
