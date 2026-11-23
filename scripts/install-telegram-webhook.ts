import { existsSync } from "node:fs";
import { panelUrl, redact } from "../lib/slack";
import { telegramClient } from "../lib/telegram";

// Points the bot's webhook at the panel: `bun scripts/install-telegram-webhook.ts`. Reads
// TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and FACTORY_PANEL_URL (default the Vercel panel) from
// the shell or .env.local, calls setWebhook with the secret token, message and callback_query
// updates and drop_pending_updates, then prints getWebhookInfo. Neither value is ever printed.

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
if (!token || !secret) {
  console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (in the shell or .env.local) first.");
  process.exit(1);
}
// Telegram takes 1-256 characters of A-Z, a-z, 0-9, _ and -.
if (!/^[\w-]{1,256}$/.test(secret)) {
  console.error("TELEGRAM_WEBHOOK_SECRET may hold only letters, digits, _ and -, at most 256 of them.");
  process.exit(1);
}

const secrets = [token, secret];
const url = `${panelUrl()}/api/telegram/webhook`;
const client = telegramClient({ token, baseUrl: process.env.TELEGRAM_API_URL?.trim() || undefined, minGapMs: 0 });
try {
  await client.setWebhook({ url, secretToken: secret, allowedUpdates: ["message", "callback_query"], dropPendingUpdates: true });
  console.log(`Webhook set to ${url}`);
  console.log(redact(JSON.stringify(await client.getWebhookInfo(), null, 2), secrets));
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : String(error), secrets));
  process.exit(1);
}
