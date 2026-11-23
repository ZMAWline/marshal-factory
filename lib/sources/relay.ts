import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { intents } from "../../db/schema";

// The panel runs in the cloud; a source on a private network (self-hosted Plane on Tailscale) can
// only be reached from the runner's machine. The panel records a source_request intent with what it
// wants written, the runner does it next to the source and stores the answer in the intent's result,
// and the panel waits for that answer. Each request carries its own id, which the source write is
// keyed by, so a retry or a late answer never files a job twice.

export type SourceRequest = { source: string; request: Record<string, unknown> };

/** How long the panel waits for the runner; past this the owner is told it is queued. */
const WAIT_MS = 25_000;
const POLL_MS = 750;

export class RelayTimeout extends Error {}

export async function relay<T>(source: string, request: Record<string, unknown>, { waitMs = WAIT_MS }: { waitMs?: number } = {}): Promise<T> {
  const { db } = await import("../../db/client");
  const id = `panel:source_request:${randomUUID()}`;
  const detail: SourceRequest = { source, request };
  await db.insert(intents).values({ id, kind: "source_request", detail: JSON.stringify(detail), created_at: new Date() });
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const [row] = await db.select({ handled_at: intents.handled_at, result: intents.result }).from(intents).where(eq(intents.id, id));
    if (!row?.handled_at) continue;
    const result = JSON.parse(row.result ?? "null") as { error?: string; value?: T } | null;
    if (!result || result.error !== undefined) throw new Error(result?.error ?? "the runner gave no answer");
    return result.value as T;
  }
  throw new RelayTimeout(
    "The runner on the factory's server has not answered yet, so this could not reach the tracker. It is queued and will go through once the runner is online; check the runner if this keeps happening.",
  );
}
