import { eq } from "drizzle-orm";
import { intents, type IntentKind, type JobRow } from "@/db/schema";
import type { InboxAction } from "@/lib/inbox";
import {
  answerQuestion,
  approveMerge,
  closeJob,
  describeOutcome,
  dismissJob,
  fileFollowUp,
  intentOutcome,
  requestChanges,
  retryFailed,
  retryStop,
  type InboxDeps,
  type InboxOutcome,
} from "@/lib/inbox-actions";
import { mergeDecisionSchema } from "@/lib/merge-decision";
import { uuidFrom } from "@/lib/slack-request";

// What the chat front doors share (Slack in lib/slack-interactions.ts, Telegram in
// lib/telegram-webhook.ts): an action on a notification runs the panel's own inbox action as the
// owner, keyed by a request id derived from the event, and is followed until the runner handled it.

export type ChatChannel = "slack" | "telegram";

/**
 * The request id of one attempt at one action on one event: a double click, a second form or a
 * redelivery gets the same one, so it records one intent, files one issue or posts one answer; a
 * UUID, as the inbox actions want. `after` is the request id of the attempt the runner refused.
 */
export const chatRequestId = (channel: ChatChannel, eventId: string, action: InboxAction, after = "") =>
  uuidFrom(`${channel}:${eventId}:${action}${after && `:${after}`}`);

/** The intent each runner-handled action records, keyed panel:<kind>:<request id>. */
const INTENT_KINDS = {
  answer: "answer",
  approve: "approve_merge",
  request_changes: "request_changes",
  close: "close_job",
  retry_stop: "retry_stop",
  retry: "retry_job",
} as const satisfies Partial<Record<InboxAction, IntentKind>>;

/**
 * The request id for this action: the first attempt's, or the one after the last attempt the
 * runner refused, so the action can be tried again. An action while an attempt is pending or done
 * gets that attempt's id and records nothing new.
 */
export async function nextRequestId(inbox: InboxDeps, channel: ChatChannel, eventId: string, action: InboxAction) {
  let id = chatRequestId(channel, eventId, action);
  if (!(action in INTENT_KINDS)) return id;
  const kind = INTENT_KINDS[action as keyof typeof INTENT_KINDS];
  for (;;) {
    const [intent] = await inbox.db.select().from(intents).where(eq(intents.id, `panel:${kind}:${id}`));
    if (!intent?.handled_at || describeOutcome(kind, intent.result).status !== "failed") return id;
    id = chatRequestId(channel, eventId, action, id);
  }
}

export function runAction(inbox: InboxDeps, action: InboxAction, job: JobRow, requestId: string, text: string): Promise<InboxOutcome> {
  switch (action) {
    case "answer":
      return answerQuestion(inbox, job.id, requestId, text);
    case "approve": {
      const decision = mergeDecisionSchema.safeParse(job.merge_decision).data;
      return approveMerge(inbox, job.id, requestId, decision?.review?.headSha ?? decision?.headSha ?? null);
    }
    case "request_changes":
      return requestChanges(inbox, job.id, requestId, text);
    case "follow_up":
      return fileFollowUp(inbox, job.id, requestId, text);
    case "close":
      return closeJob(inbox, job.id, requestId, text);
    case "dismiss":
      return dismissJob(inbox, job.id);
    case "retry_stop":
      return retryStop(inbox, job.id, requestId);
    case "retry":
      return retryFailed(inbox, job.id, requestId, text);
    default: {
      const never: never = action;
      throw new Error(`unknown inbox action ${String(never)}`);
    }
  }
}

export type FollowOptions = { pollMs?: number; followMs?: number };

/** Follows the intent until the runner handled it, as the panel's detail pane does; once it stops following, the notifier has the last word. */
export async function follow(inbox: InboxDeps, intentId: string, { pollMs = 2_000, followMs = 50_000 }: FollowOptions = {}): Promise<InboxOutcome> {
  const deadline = Date.now() + followMs;
  for (;;) {
    const outcome = await intentOutcome(inbox, intentId);
    if (outcome.status === "failed") return { ok: false, message: outcome.message };
    if (outcome.status === "done") return { ok: true, intentId };
    if (Date.now() + pollMs > deadline) return { ok: true, intentId };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
