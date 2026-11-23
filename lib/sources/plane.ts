import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "../../db/schema";
import { jobs } from "../../db/schema";
import { loadConfig, type FactoryLimits, type PlaneConfig } from "../config";
import type { Stage } from "../events";
import { attemptBranch } from "../factory";
import { OVERRIDE_GROUPS, type SourceOverrides } from "../ticket-overrides";
import { hmacHex, sameHex, type IntentDraft, type Verdict } from "../webhooks";
import { FACTORY_SOURCE, htmlToText, markdownToHtml, PANEL_SOURCE, PlaneError, planeClient, type PlaneClient, type PlaneIssue, type PlaneLabel, type PlaneState } from "./plane-client";
import { relay } from "./relay";
import { jobId, type SourceStateDraftOf } from "./shapes";
import type { Job as AnyJob, FileDraft, FiledJob, LabelGroupSpec, Reply, ResumePlan, SourceAdapter, SourceWebhook } from "./types";
import { SourceGoneError } from "./types";

// Plane (self-hosted) as a job source. A job is a work item in one project that carries the
// factory label in an unstarted state; its key is the project identifier and sequence, FAC-7.
// The factory's comments, issues and labels carry external_source = marshal-factory and a
// deterministic external_id, so a replayed write finds the first one instead of duplicating.
//
// The panel runs on Vercel and cannot reach a Plane that only listens on a private network, so its
// writes (file, reply, label sync) go through ./relay: it records a source_request intent and the
// runner, next to Plane, does the write and stores the answer.

type Job = AnyJob<"plane">;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const DELETED = "the work item was deleted in Plane";
const CLOSED_GROUPS = new Set(["completed", "cancelled"]);
const ANNOUNCED = "In Progress";
const FAILED_LABEL = "factory-failed";

/** A deterministic external id for something the factory writes, so a replay finds the first write. */
export const externalId = (...parts: string[]) => parts.join(":").slice(0, 255);
export const claimCommentId = (issueId: string, attempt = 1) => (attempt > 1 ? externalId("claim", issueId, String(attempt)) : externalId("claim", issueId));
export const stageCommentId = (issueId: string, stageEventId: string) => externalId("stage", issueId, stageEventId);
export const resumeCommentId = (issueId: string, replyIds: readonly string[]) => externalId("resume", issueId, ...replyIds);

// ---------------------------------------------------------------------------------------------
// Webhook

/**
 * Plane signs a delivery with X-Plane-Signature, the hex HMAC-SHA256 of the JSON body under the
 * webhook's secret key. Plane's deliveries carry no timestamp; ingest stores each X-Plane-Delivery
 * once, so a replayed delivery records nothing new.
 */
export function verifyPlane(rawBody: string, signature: string | null, secret: string): Verdict {
  if (!secret) return { ok: false, reason: "no webhook secret configured" };
  if (!signature || !sameHex(signature.toLowerCase(), hmacHex(secret, rawBody))) return { ok: false, reason: "bad signature" };
  return { ok: true };
}

const payloadSchema = z.object({
  event: z.string(),
  action: z.string(),
  data: z.record(z.string(), z.unknown()).nullish(),
  activity: z.object({ field: z.string().nullish() }).partial().nullish(),
});

const LABEL_OR_STATE_FIELDS = new Set(["labels", "label_ids", "state", "state_id"]);

/**
 * What a Plane delivery means. Plane sends one delivery per changed field, and its issue payload
 * names labels but only the state's id, so a labeled issue becomes a claim intent and the claim
 * itself checks the state; a label or state change becomes a stop intent that the runner confirms
 * against Plane before acting on it.
 */
export function planeIntent(body: unknown, opts: { projectId: string | undefined; label: string }): IntentDraft | null {
  const payload = payloadSchema.parse(body);
  const data = payload.data ?? {};
  if (payload.event === "issue_comment") {
    if (payload.action !== "create" && payload.action !== "created") return null;
    const issueId = z.string().optional().catch(undefined).parse(data.issue);
    if (!issueId || (opts.projectId && data.project !== opts.projectId)) return null;
    const source = z.string().nullish().catch(null).parse(data.external_source);
    // The factory's own comments are not answers.
    if (source === FACTORY_SOURCE) return null;
    return { kind: "answer", jobId: jobId("plane", issueId) };
  }
  if (payload.event !== "issue") return null;
  const id = z.string().optional().catch(undefined).parse(data.id);
  if (!id) return null;
  const base = { jobId: jobId("plane", id) };
  if (payload.action === "delete" || payload.action === "deleted") return { kind: "stop", ...base, detail: DELETED };
  if (opts.projectId && data.project !== opts.projectId) return null;
  const labels = z
    .array(z.union([z.object({ name: z.string() }).loose(), z.string()]))
    .catch([])
    .parse(data.labels ?? []);
  const labeled = labels.some((l) => typeof l !== "string" && same(l.name, opts.label));
  const field = payload.activity?.field ?? null;
  if (field && LABEL_OR_STATE_FIELDS.has(field)) {
    if (!labeled) return { kind: "stop", ...base, detail: `the ${opts.label} label was removed in Plane` };
    return { kind: "claim", ...base };
  }
  return labeled ? { kind: "claim", ...base } : null;
}

const webhook: SourceWebhook = {
  secretEnv: "PLANE_WEBHOOK_SECRET",
  deliveryHeader: "X-Plane-Delivery",
  eventHeader: "X-Plane-Event",
  verify: (raw, headers, secret) => verifyPlane(raw, headers.get("x-plane-signature"), secret),
  intent: (body, env) => planeIntent(body, { projectId: env.PLANE_PROJECT_ID, label: env.FACTORY_LABEL ?? "factory" }),
};

// ---------------------------------------------------------------------------------------------
// Resume

type WaitingJob = Pick<Job, "external_id" | "stage_event_id" | "question" | "delivered_reply_ids">;

/**
 * Decides what a waiting work item needs. Replies are the comments after the question that the
 * factory did not write (no factory external_source) and that no earlier resume delivered.
 */
export function planResume(issue: WaitingJob, plane: { state: { name: string; group: string }; comments: readonly (Reply & { source: string | null; externalId: string | null })[] }): ResumePlan {
  if (CLOSED_GROUPS.has(plane.state.group)) return { kind: "close", state: plane.state.name };
  if (!issue.stage_event_id) return { kind: "wait" };
  const questionId = stageCommentId(issue.external_id, issue.stage_event_id);
  const asked = plane.comments.find((c) => c.externalId === questionId);
  if (!asked) return { kind: "wait" };
  const delivered = new Set(issue.delivered_reply_ids);
  const replies = plane.comments
    .filter((c) => c.createdAt > asked.createdAt && c.source !== FACTORY_SOURCE && !delivered.has(c.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(({ id, body, createdAt }) => ({ id, body, createdAt }));
  if (replies.length === 0) return { kind: "wait" };
  return { kind: "resume", question: issue.question ?? asked.body, replies, answer: replies.map((r) => r.body.trim()).join("\n\n") };
}

// ---------------------------------------------------------------------------------------------
// Labels and states

/** The label groups an issue's labels sit in: Plane nests a label under a parent label. */
export function labelGroupsOf(issueLabels: readonly PlaneLabel[], all: readonly PlaneLabel[]) {
  const byId = new Map(all.map((l) => [l.id, l]));
  return issueLabels.flatMap((l) => {
    const parent = l.parent ? byId.get(l.parent) : undefined;
    return parent ? [{ name: l.name, group: parent.name }] : [];
  });
}

export function planeOverrides(state: SourceStateDraftOf<"plane">): SourceOverrides {
  const inGroup = (group: string) => (state.labelGroups ?? []).filter((l) => same(l.group, group)).map((l) => l.name);
  return { harness: inGroup(OVERRIDE_GROUPS.harness), runsOn: inGroup(OVERRIDE_GROUPS.runsOn), repository: inGroup(OVERRIDE_GROUPS.repository) };
}

function stopReason(issue: PlaneIssue | undefined, label: string) {
  if (!issue || issue.deleted_at) return DELETED;
  if (issue.archived_at) return "the work item was archived in Plane";
  if (CLOSED_GROUPS.has(issue.state.group)) return `work item moved to ${issue.state.name} in Plane`;
  if (!issue.labels.some((l) => same(l.name, label))) return `the ${label} label was removed in Plane`;
  return undefined;
}

const stateNamed = (states: readonly PlaneState[], name: string) => {
  const state = states.find((s) => same(s.name, name));
  if (!state) throw new Error(`the Plane project has no state named ${name}`);
  return state.id;
};

const todoOf = (states: readonly PlaneState[]) => (states.find((s) => s.group === "unstarted" && same(s.name, "Todo")) ?? states.find((s) => s.group === "unstarted"))?.id;

/** Finds a plain label by name, creating it when missing. */
async function labelId(client: PlaneClient, labels: PlaneLabel[], name: string) {
  const found = labels.find((l) => same(l.name, name) && !l.parent);
  if (found) return found.id;
  const created = await client.createLabel({ name, external_id: externalId("label", name.toLowerCase()) });
  labels.push(created);
  return created.id;
}

const GROUP_COLOR = "#5e6ad2";
const CHILD_COLOR = "#95a2b3";
const labelKey = (group: string, child: string) => `${group.toLowerCase()}/${child.toLowerCase()}`;

/** Creates the label groups and children the project is missing; never renames, moves or deletes one. */
export async function syncPlaneLabelGroups(client: PlaneClient, desired: readonly LabelGroupSpec[]) {
  const created: string[] = [];
  const problems: string[] = [];
  const ids = new Map<string, string>();
  const labels = await client.labels();
  for (const { group, children } of desired) {
    const named = labels.filter((l) => same(l.name, group));
    let groupId = named.find((l) => !l.parent)?.id;
    if (!groupId) {
      if (named.length > 0) {
        problems.push(`A label named "${group}" exists inside another label; move it to the top level in Plane and sync again.`);
        continue;
      }
      const made = await client.createLabel({ name: group, color: GROUP_COLOR, external_id: externalId("label-group", group.toLowerCase()) });
      labels.push(made);
      groupId = made.id;
      created.push(group);
    }
    for (const child of children) {
      const existing = labels.filter((l) => same(l.name, child));
      const inGroup = existing.find((l) => l.parent === groupId);
      if (inGroup) {
        ids.set(labelKey(group, child), inGroup.id);
        continue;
      }
      if (existing.length > 0) {
        problems.push(`A label named "${child}" exists outside the ${group} group; move it into the group in Plane.`);
        continue;
      }
      const made = await client.createLabel({ name: child, parent: groupId, color: CHILD_COLOR, external_id: externalId("label", group.toLowerCase(), child.toLowerCase()) });
      labels.push(made);
      ids.set(labelKey(group, child), made.id);
      created.push(`${group} / ${child}`);
    }
  }
  return { created, problems, ids };
}

// ---------------------------------------------------------------------------------------------
// Adapter

export type PlaneDeps = {
  client: PlaneClient;
  db: NodePgDatabase<typeof schema>;
  limits: FactoryLimits;
};

export function planeConfigured() {
  try {
    return Boolean(loadConfig().plane);
  } catch {
    return false;
  }
}

function requirePlane(): PlaneConfig {
  const plane = loadConfig().plane;
  if (!plane) throw new Error("the factory config has no plane section, so Plane is not configured");
  return plane;
}

async function runtimeDeps(): Promise<PlaneDeps> {
  const config = loadConfig();
  const { db } = await import("../../db/client");
  return { client: planeClient(requirePlane()), db, limits: config.factory };
}

type WriteBack = { state?: string; labels?: { add?: string[]; remove?: string[] }; comment?: (job: Job) => string };

const writeBackTable = (factoryLabel: string): Partial<Record<Stage, WriteBack>> => ({
  pr: {
    state: "In Review",
    comment: (i) =>
      [
        `marshal-factory has a pull request ready for review: ${i.pr_url}`,
        i.stage_summary ?? "",
        i.merge_assessment?.assumptions.length ? `**Assumptions I made**\n\n${i.merge_assessment.assumptions.map((a) => `- ${a}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
  },
  waiting: { comment: (i) => `marshal-factory stopped and needs an answer before it can continue:\n\n${i.question ?? i.stage_summary}` },
  failed: {
    state: "Todo",
    labels: { add: [FAILED_LABEL], remove: [factoryLabel] },
    comment: (i) => `marshal-factory gave up on this work item (attempt ${i.attempt}): ${i.stage_summary}\n\nAdd the \`${factoryLabel}\` label again to retry.`,
  },
  merged: { state: "Done" },
});

const commentIds = sql`coalesce(${jobs.source_state}->'factoryCommentIds', '[]'::jsonb)`;

async function postComment({ db, client }: PlaneDeps, job: Job, id: string, body: string) {
  await db
    .update(jobs)
    .set({
      source_state: sql`jsonb_set(${jobs.source_state}, '{factoryCommentIds}', case when ${commentIds} ? ${id} then ${commentIds} else ${commentIds} || jsonb_build_array(${id}::text) end)`,
    })
    .where(eq(jobs.id, job.id));
  await client.comment(job.writeback.issueId, id, markdownToHtml(body));
}

async function recordState({ db }: PlaneDeps, job: Job, state: string, extra: { updated_at?: Date } = {}) {
  await db
    .update(jobs)
    .set({ source_state: sql`jsonb_set(${jobs.source_state}, '{state}', to_jsonb(${state}::text))`, ...extra })
    .where(eq(jobs.id, job.id));
}

const gone = (error: unknown) => error instanceof PlaneError && error.notFound;

export function createPlaneAdapter(load: () => PlaneDeps | Promise<PlaneDeps>): SourceAdapter<"plane"> {
  let loaded: PlaneDeps | undefined;
  const deps = async () => (loaded ??= await load());
  let statesCache: PlaneState[] | undefined;
  const statesOf = async ({ client }: PlaneDeps) => (statesCache ??= await client.states());
  let prefix: string | undefined;
  const identifierOf = async ({ client }: PlaneDeps) => (prefix ??= await client.identifier());

  /** The issue's label ids after adding and removing by name; the factory label and override labels are kept. */
  async function relabel(d: PlaneDeps, issue: PlaneIssue, change: WriteBack["labels"]) {
    if (!change) return undefined;
    const all = await d.client.labels();
    const drop = new Set((change.remove ?? []).map((n) => n.toLowerCase()));
    const keep = issue.labels.filter((l) => !drop.has(l.name.toLowerCase())).map((l) => l.id);
    const add = [];
    for (const name of change.add ?? []) if (!issue.labels.some((l) => same(l.name, name))) add.push(await labelId(d.client, all, name));
    return [...new Set([...keep, ...add])];
  }

  async function apply(d: PlaneDeps, issueId: string, action: Pick<WriteBack, "state" | "labels">) {
    const issue = await d.client.issue(issueId);
    const labels = await relabel(d, issue, action.labels);
    const state = action.state ? stateNamed(await statesOf(d), action.state) : undefined;
    if (state === undefined && labels === undefined) return;
    await d.client.update(issueId, { ...(state ? { state } : {}), ...(labels ? { labels } : {}) });
  }

  return {
    source: "plane",
    webhook,
    configured: planeConfigured,

    async ready() {
      const d = await deps();
      const [issues, all, identifier] = await Promise.all([d.client.issues(), d.client.labels(), identifierOf(d)]);
      return issues
        .filter((i) => !i.archived_at && !i.deleted_at && i.state.group === "unstarted" && i.labels.some((l) => same(l.name, d.limits.label)))
        .map((i) => {
          const key = `${identifier}-${i.sequence_id}`;
          return {
            externalId: i.id,
            key,
            title: i.name,
            url: d.client.browseUrl(key),
            description: htmlToText(i.description_html) || null,
            writeback: { kind: "plane" as const, issueId: i.id },
            sourceState: { state: i.state.name, labels: i.labels.map((l) => l.name), labelGroups: labelGroupsOf(i.labels, all) },
          };
        });
    },

    async announceClaim(job) {
      if (job.source_state.state === ANNOUNCED) return;
      const d = await deps();
      await apply(d, job.writeback.issueId, { state: ANNOUNCED, ...(job.attempt > 1 ? { labels: { remove: [FAILED_LABEL] } } : {}) });
      await postComment(
        d,
        job,
        claimCommentId(job.writeback.issueId, job.attempt),
        job.attempt > 1 ? `Picked up by marshal-factory again (attempt ${job.attempt}, branch ${attemptBranch(job.key, job.attempt)}).` : "Picked up by marshal-factory.",
      );
      await recordState(d, job, ANNOUNCED, { updated_at: new Date() });
    },

    async writeBack(job, transition) {
      try {
        const d = await deps();
        const action = writeBackTable(d.limits.label)[transition.stage];
        if (!action) return false;
        if (action.state || action.labels) await apply(d, job.writeback.issueId, action);
        if (action.comment) await postComment(d, job, stageCommentId(job.writeback.issueId, transition.eventId), action.comment(job));
        if (action.state) await recordState(d, job, action.state);
        return true;
      } catch (error) {
        if (gone(error)) throw new SourceGoneError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },

    async replies(job) {
      const { client } = await deps();
      const [issue, comments] = await Promise.all([client.issue(job.external_id), client.comments(job.external_id)]);
      return planResume(job, {
        state: issue.state,
        comments: comments.map((c) => ({ id: c.id, body: htmlToText(c.comment_html), createdAt: c.created_at, source: c.external_source ?? null, externalId: c.external_id ?? null })),
      });
    },

    async stopWanted(open) {
      const { client, limits } = await deps();
      const issues = await client.issues();
      const wanted = [];
      for (const job of open) {
        const reason = stopReason(
          issues.find((i) => i.id === job.external_id),
          limits.label,
        );
        if (reason) wanted.push({ job, reason });
      }
      return wanted;
    },

    async confirmStop(externalIdOf, detail) {
      if (detail === DELETED) return { stop: true, reopen: false };
      const { client, limits } = await deps();
      let issue: PlaneIssue;
      try {
        issue = await client.issue(externalIdOf);
      } catch (error) {
        if (gone(error)) return { stop: true, reopen: false };
        throw error;
      }
      const stillLabeled = issue.labels.some((l) => same(l.name, limits.label));
      if (stillLabeled && !CLOSED_GROUPS.has(issue.state.group) && !issue.archived_at) return { stop: false };
      return { stop: true, reopen: issue.state.group === "started" };
    },

    async note(job, key, body) {
      await postComment(await deps(), job, externalId("note", job.writeback.issueId, key), body);
    },

    async labels(job) {
      const { client } = await deps();
      return (await client.issue(job.writeback.issueId)).labels.map((l) => l.name);
    },

    async reopen(job) {
      await apply(await deps(), job.writeback.issueId, { state: "Todo" });
    },

    async requeue(job) {
      const d = await deps();
      await apply(d, job.writeback.issueId, { state: "Todo", labels: { add: [d.limits.label] } });
    },

    async acknowledgeReplies(job, replyIds) {
      await postComment(await deps(), job, resumeCommentId(job.writeback.issueId, replyIds), "Answer received, resuming.");
    },

    async syncLabelGroups(groups) {
      const d = await deps();
      const { created, problems } = await syncPlaneLabelGroups(d.client, groups);
      return { team: await identifierOf(d), created, problems };
    },

    overrides: planeOverrides,

    describe: (job) => `Plane work item ${job.key}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Writes the panel asks for. The runner does them (through the relay); they need Plane's network.

/** Files a job as a Todo work item with the factory label, keyed by the request, so a double submit finds the first. */
export async function filePlaneJob(client: PlaneClient, limits: Pick<FactoryLimits, "label">, draft: FileDraft): Promise<FiledJob> {
  const [states, labels, identifier] = await Promise.all([client.states(), client.labels(), client.identifier()]);
  const todo = todoOf(states);
  if (!todo) throw new Error("the Plane project has no Todo state");
  const overrideIds: string[] = [];
  if (draft.labels?.length) {
    const groups = await syncPlaneLabelGroups(client, draft.labels.map((l) => ({ group: l.group, children: [l.name] })));
    for (const l of draft.labels) {
      const id = groups.ids.get(labelKey(l.group, l.name));
      if (!id) throw new Error(`cannot apply the ${l.group} label "${l.name}": ${groups.problems.join(" ")}`);
      overrideIds.push(id);
    }
  }
  const tagIds = [];
  for (const tag of draft.tags ?? []) tagIds.push(await labelId(client, labels, tag));
  const issue = await client.createIssue({
    name: draft.title,
    description_html: markdownToHtml(draft.description),
    state: todo,
    labels: [await labelId(client, labels, limits.label), ...tagIds, ...overrideIds],
    external_id: externalId("panel-job", draft.requestId),
  });
  const key = `${identifier}-${issue.sequence_id}`;
  return { key, url: client.browseUrl(key) };
}

/** Posts the owner's answer as a comment that is not the factory's own, so the runner reads it as a reply. */
export async function replyOnPlane(client: PlaneClient, issueId: string, requestId: string, body: string) {
  await client.comment(issueId, externalId("panel-answer", issueId, requestId), markdownToHtml(body), PANEL_SOURCE);
}

/** What the runner does for a source_request intent with source plane. */
export async function handlePlaneRequest(request: { op: "file"; draft: FileDraft } | { op: "reply"; issueId: string; requestId: string; body: string } | { op: "sync_labels"; groups: LabelGroupSpec[] }) {
  const d = await runtimeDeps();
  switch (request.op) {
    case "file":
      return filePlaneJob(d.client, d.limits, request.draft);
    case "reply":
      await replyOnPlane(d.client, request.issueId, request.requestId, request.body);
      return { posted: true };
    case "sync_labels": {
      const { created, problems } = await syncPlaneLabelGroups(d.client, request.groups);
      return { team: await d.client.identifier(), created, problems };
    }
  }
}

export const plane: SourceAdapter<"plane"> = {
  ...createPlaneAdapter(runtimeDeps),
  file: (draft) => relay<FiledJob>("plane", { op: "file", draft }),
  reply: async (job, requestId, body) => void (await relay("plane", { op: "reply", issueId: job.writeback.issueId, requestId, body })),
  panelSyncLabelGroups: (groups) => relay("plane", { op: "sync_labels", groups: [...groups] }),
  uploadImage: async () => {
    throw new Error("Images can't be attached from the panel while the factory uses Plane. File the job, then add the image to the work item in Plane.");
  },
};
