import { handleTelegramUpdate } from "@/lib/telegram-webhook";
import { telegramRouteDeps } from "@/lib/telegram-route-deps";

export const runtime = "nodejs";
/** The work after the answer follows the runner's answer for up to 50 seconds. */
export const maxDuration = 60;

/** Telegram's webhook: buttons, replies and /job. The proxy lets it through; the secret token header is the check. */
export async function POST(request: Request) {
  return handleTelegramUpdate(request, telegramRouteDeps());
}
