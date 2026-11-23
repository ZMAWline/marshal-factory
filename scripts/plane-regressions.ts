import "./test-guard";
import assert from "node:assert/strict";
import { and, eq, isNull } from "drizzle-orm";
import { hmacHex } from "../lib/webhooks";

const { db } = await import("../db/client");
const { intents } = await import("../db/schema");
const { factorySchema } = await import("../lib/config");
const { createPlaneAdapter, filePlaneJob, labelGroupsOf, planeIntent, planResume, stageCommentId, verifyPlane } = await import("../lib/sources/plane");
const { FACTORY_SOURCE, htmlToText, markdownToHtml, PANEL_SOURCE, planeClient, PlaneError } = await import("../lib/sources/plane-client");
const { relay, RelayTimeout } = await import("../lib/sources/relay");
const { handleSourceRequest, allSources } = await import("../lib/sources");

type PlaneClient = ReturnType<typeof planeClient>;
const PROJECT = "11111111-2222-3333-4444-555555555555";
const config = { baseUrl: "https://plane.test", apiKey: "k", workspace: "ws", projectId: PROJECT };

// ---- Webhook signature: the hex HMAC-SHA256 of the body Plane sends, under the webhook's secret key.
{
  const body = JSON.stringify({ event: "issue", action: "update", data: { id: "i1" } });
  assert.deepEqual(verifyPlane(body, hmacHex("s3cret", body), "s3cret"), { ok: true }, "a body signed with the secret verifies");
  assert.deepEqual(verifyPlane(body, hmacHex("s3cret", body).toUpperCase(), "s3cret"), { ok: true }, "hex case does not matter");
  assert.equal(verifyPlane(body, hmacHex("other", body), "s3cret").ok, false, "another secret's signature fails");
  assert.equal(verifyPlane(`${body} `, hmacHex("s3cret", body), "s3cret").ok, false, "a changed body fails");
  assert.equal(verifyPlane(body, null, "s3cret").ok, false, "no signature fails");
  assert.equal(verifyPlane(body, hmacHex("", body), "").ok, false, "an empty secret never verifies");
}

// ---- What a delivery means.
{
  const opts = { projectId: PROJECT, label: "factory" };
  const issue = (labels: string[], extra: Record<string, unknown> = {}) => ({ id: "i1", project: PROJECT, labels: labels.map((name) => ({ id: `L:${name}`, name })), ...extra });
  assert.deepEqual(planeIntent({ event: "issue", action: "created", data: issue(["factory"]) }, opts), { kind: "claim", jobId: "plane:i1" }, "a labeled new item is a claim");
  assert.deepEqual(
    planeIntent({ event: "issue", action: "updated", data: issue(["Factory", "bug"]), activity: { field: "labels" } }, opts),
    { kind: "claim", jobId: "plane:i1" },
    "adding the label (any case) is a claim",
  );
  assert.deepEqual(
    planeIntent({ event: "issue", action: "updated", data: issue(["bug"]), activity: { field: "labels" } }, opts),
    { kind: "stop", jobId: "plane:i1", detail: "the factory label was removed in Plane" },
    "a label change without the factory label is a stop the runner confirms",
  );
  assert.deepEqual(
    planeIntent({ event: "issue", action: "updated", data: issue(["bug"]), activity: { field: "state_id" } }, opts),
    { kind: "stop", jobId: "plane:i1", detail: "the factory label was removed in Plane" },
    "a state change on an unlabeled item is a stop too, which confirmStop decides",
  );
  assert.equal(planeIntent({ event: "issue", action: "updated", data: issue(["bug"]), activity: { field: "name" } }, opts), null, "an unrelated edit of an unlabeled item means nothing");
  assert.deepEqual(planeIntent({ event: "issue", action: "deleted", data: { id: "i1" } }, opts), { kind: "stop", jobId: "plane:i1", detail: "the work item was deleted in Plane" }, "a deletion is a stop");
  assert.equal(planeIntent({ event: "issue", action: "created", data: issue(["factory"], { project: "other" }) }, opts), null, "another project's items are ignored");
  assert.deepEqual(planeIntent({ event: "issue_comment", action: "created", data: { id: "c1", issue: "i1", project: PROJECT } }, opts), { kind: "answer", jobId: "plane:i1" }, "a person's comment is an answer");
  assert.deepEqual(
    planeIntent({ event: "issue_comment", action: "created", data: { id: "c1", issue: "i1", project: PROJECT, external_source: PANEL_SOURCE } }, opts),
    { kind: "answer", jobId: "plane:i1" },
    "the panel's answer is an answer",
  );
  assert.equal(planeIntent({ event: "issue_comment", action: "created", data: { id: "c1", issue: "i1", project: PROJECT, external_source: FACTORY_SOURCE } }, opts), null, "the factory's own comment is not");
  assert.equal(planeIntent({ event: "issue_comment", action: "updated", data: { id: "c1", issue: "i1", project: PROJECT } }, opts), null, "an edited comment is not a new answer");
  assert.equal(planeIntent({ event: "cycle", action: "created", data: { id: "x" } }, opts), null, "other events mean nothing");
}

// ---- Resume: replies are comments after the question that the factory did not write.
{
  const job = { external_id: "i1", stage_event_id: "ev1", question: "Which colour?", delivered_reply_ids: ["c-old"] };
  const q = { id: "cq", body: "Which colour?", createdAt: "2026-11-01T10:00:00Z", source: FACTORY_SOURCE, externalId: stageCommentId("i1", "ev1") };
  const open = { name: "In Progress", group: "started" };
  assert.deepEqual(planResume(job, { state: open, comments: [q] }), { kind: "wait" }, "no reply yet: wait");
  assert.deepEqual(planResume(job, { state: { name: "Done", group: "completed" }, comments: [q] }), { kind: "close", state: "Done" }, "a closed item closes the job");
  assert.deepEqual(planResume({ ...job, stage_event_id: "other" }, { state: open, comments: [q] }), { kind: "wait" }, "a question not posted yet: wait");
  const plan = planResume(job, {
    state: open,
    comments: [
      q,
      { id: "c-before", body: "early", createdAt: "2026-11-01T09:00:00Z", source: null, externalId: null },
      { id: "c-ours", body: "Answer received", createdAt: "2026-11-01T10:01:00Z", source: FACTORY_SOURCE, externalId: "resume:x" },
      { id: "c-old", body: "delivered", createdAt: "2026-11-01T10:02:00Z", source: null, externalId: null },
      { id: "c2", body: " blue ", createdAt: "2026-11-01T10:04:00Z", source: PANEL_SOURCE, externalId: "panel-answer:i1:r" },
      { id: "c1", body: "red", createdAt: "2026-11-01T10:03:00Z", source: null, externalId: null },
    ],
  });
  assert.deepEqual(
    plan,
    {
      kind: "resume",
      question: "Which colour?",
      replies: [
        { id: "c1", body: "red", createdAt: "2026-11-01T10:03:00Z" },
        { id: "c2", body: " blue ", createdAt: "2026-11-01T10:04:00Z" },
      ],
      answer: "red\n\nblue",
    },
    "new human and panel replies, oldest first; earlier, delivered and factory comments are left out",
  );
}

// ---- Rich text both ways.
{
  assert.equal(htmlToText("<p>Hello &amp; <strong>bye</strong></p><ul><li>one</li><li>two</li></ul><p>a<br>b</p>"), "Hello & bye\n- one\n- two\na\nb");
  assert.equal(htmlToText('<p>see <a href="https://x.test/a">docs</a> <img src="https://x.test/i.png"></p>'), "see docs (https://x.test/a) [image: https://x.test/i.png]");
  assert.equal(htmlToText(null), "");
  assert.equal(
    markdownToHtml("Hi **you** <b>\n\n- `a`\n- b\n\nlink https://x.test/p and [d](https://x.test/d)"),
    '<p>Hi <strong>you</strong> &lt;b&gt;</p><ul><li><code>a</code></li><li>b</li></ul><p>link <a href="https://x.test/p">https://x.test/p</a> and <a href="https://x.test/d">d</a></p>',
    "markdown becomes Plane HTML and raw HTML is escaped",
  );
  assert.equal(htmlToText(markdownToHtml("line one\nline two")), "line one\nline two", "line breaks survive a round trip");
}

// ---- The client: retries, idempotent creates and pagination.
{
  const sent: { method: string; url: string; body?: unknown }[] = [];
  const answers: (() => Response)[] = [];
  const fetchFake = (async (url: string, init: RequestInit) => {
    sent.push({ method: init.method ?? "GET", url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    assert.equal((init.headers as Record<string, string>)["x-api-key"], "k", "every call sends the API key");
    const next = answers.shift();
    if (!next) throw new Error(`unexpected ${init.method} ${url}`);
    return next();
  }) as unknown as typeof fetch;
  const client = planeClient(config, { fetch: fetchFake, sleep: async () => {} });
  const state = { id: "s", name: "Todo", group: "unstarted" };
  const item = { id: "i9", sequence_id: 9, name: "x", created_at: "2026-11-01T00:00:00Z", state, labels: [] };

  answers.push(() => new Response("busy", { status: 502 }), () => Response.json({ results: [state], next_cursor: "c", next_page_results: true }), () => Response.json({ results: [{ ...state, id: "s2" }], next_page_results: false }));
  assert.deepEqual((await client.states()).map((s) => s.id), ["s", "s2"], "a 502 is retried and every page is read");
  assert.match(sent[2]!.url, /cursor=c/, "the next page asks for the cursor");

  sent.length = 0;
  answers.push(() => Response.json({ error: "exists", id: "i9" }, { status: 409 }), () => Response.json(item));
  const created = await client.createIssue({ name: "x", description_html: "<p>x</p>", state: "s", labels: [], external_id: "panel-job:r1" });
  assert.equal(created.id, "i9", "a replayed create returns the first item");
  assert.deepEqual(sent[0]!.body, { name: "x", description_html: "<p>x</p>", state: "s", labels: [], external_id: "panel-job:r1", external_source: FACTORY_SOURCE }, "creates carry the factory's external source");
  assert.match(sent[1]!.url, /\/work-items\/i9\/\?expand=labels,state$/);

  answers.push(() => Response.json({ error: "The requested resource does not exist." }, { status: 404 }));
  await assert.rejects(client.issue("gone"), (e: unknown) => e instanceof PlaneError && e.notFound, "a missing item is a not-found PlaneError");
  assert.equal(client.browseUrl("FAC-9"), "https://plane.test/ws/browse/FAC-9/");
}

// ---- The adapter against a fake client.
function fakePlane() {
  const states = ["Backlog:backlog", "Todo:unstarted", "In Progress:started", "In Review:started", "Done:completed", "Cancelled:cancelled"].map((s) => {
    const [name, group] = s.split(":") as [string, string];
    return { id: `S:${name}`, name, group };
  });
  const labels = [
    { id: "L:factory", name: "factory", parent: null },
    { id: "L:Repository", name: "Repository", parent: null },
    { id: "L:demo", name: "demo", parent: "L:Repository" },
  ];
  const at = (name: string) => states.find((s) => s.name === name)!;
  const items = [
    { id: "i1", sequence_id: 1, name: "ready one", description_html: "<p>do it</p>", created_at: "t", state: at("Todo"), labels: [labels[0]!, labels[2]!] },
    { id: "i2", sequence_id: 2, name: "not labeled", created_at: "t", state: at("Todo"), labels: [] },
    { id: "i3", sequence_id: 3, name: "started", created_at: "t", state: at("In Progress"), labels: [labels[0]!] },
    { id: "i4", sequence_id: 4, name: "archived", created_at: "t", archived_at: "t", state: at("Todo"), labels: [labels[0]!] },
  ];
  const calls: unknown[][] = [];
  const client = {
    identifier: async () => "FAC",
    states: async () => states,
    labels: async () => labels,
    createLabel: async (input: { name: string; parent?: string | null; external_id: string }) => {
      calls.push(["createLabel", input.name, input.parent ?? null, input.external_id]);
      const made = { id: `L:${input.name}`, name: input.name, parent: input.parent ?? null };
      labels.push(made);
      return made;
    },
    issues: async () => items,
    issue: async (id: string) => {
      const found = items.find((i) => i.id === id);
      if (!found) throw new PlaneError("Plane answered 404", 404);
      return found;
    },
    update: async (id: string, fields: unknown) => void calls.push(["update", id, fields]),
    createIssue: async (input: Record<string, unknown>) => {
      calls.push(["createIssue", input]);
      return { ...items[0]!, id: "new", sequence_id: 42 };
    },
    comments: async () => [],
    comment: async (issueId: string, id: string, html: string, source?: string) => void calls.push(["comment", issueId, id, html, source ?? FACTORY_SOURCE]),
    browseUrl: (key: string) => `https://plane.test/ws/browse/${key}/`,
  };
  return { client: client as unknown as PlaneClient, calls, items, at };
}

{
  const { client, items, at } = fakePlane();
  const adapter = createPlaneAdapter(() => ({ client, db, limits: factorySchema.parse({}) }));
  assert.equal(adapter.describe({ key: "FAC-1" }), "Plane work item FAC-1");
  const drafts = await adapter.ready();
  assert.deepEqual(
    drafts,
    [
      {
        externalId: "i1",
        key: "FAC-1",
        title: "ready one",
        url: "https://plane.test/ws/browse/FAC-1/",
        description: "do it",
        writeback: { kind: "plane", issueId: "i1" },
        sourceState: { state: "Todo", labels: ["factory", "demo"], labelGroups: [{ name: "demo", group: "Repository" }] },
      },
    ],
    "only labeled, unstarted, unarchived items are ready, keyed by project identifier and sequence",
  );
  assert.deepEqual(adapter.overrides(drafts[0]!.sourceState), { harness: [], runsOn: [], repository: ["demo"] }, "a Repository child label routes the job");

  items[2]!.labels = [];
  assert.deepEqual(await adapter.confirmStop("i3", "the factory label was removed in Plane"), { stop: true, reopen: true }, "a started item that lost the label stops and is reopened");
  assert.deepEqual(await adapter.confirmStop("i1", "x"), { stop: false }, "a still-labeled open item does not stop");
  assert.deepEqual(await adapter.confirmStop("missing", "x"), { stop: true, reopen: false }, "a deleted item stops");
  items[0]!.state = at("Cancelled");
  assert.deepEqual(await adapter.confirmStop("i1", "x"), { stop: true, reopen: false }, "a cancelled item stops");
}

{
  const { client, calls } = fakePlane();
  const filed = await filePlaneJob(client, { label: "factory" }, { requestId: "r1", title: "Add hello", description: "Say **hi**", labels: [{ group: "Repository", name: "demo" }, { group: "Harness", name: "Claude Code" }], tags: ["review"] });
  assert.deepEqual(filed, { key: "FAC-42", url: "https://plane.test/ws/browse/FAC-42/" }, "filing returns the new item's key and link");
  const create = calls.find((c) => c[0] === "createIssue")![1] as Record<string, unknown>;
  assert.deepEqual(create, {
    name: "Add hello",
    description_html: "<p>Say <strong>hi</strong></p>",
    state: "S:Todo",
    labels: ["L:factory", "L:review", "L:demo", "L:Claude Code"],
    external_id: "panel-job:r1",
  });
  assert.deepEqual(
    calls.filter((c) => c[0] === "createLabel").map((c) => c.slice(1, 3)),
    [
      ["Harness", null],
      ["Claude Code", "L:Harness"],
      ["review", null],
    ],
    "a missing label group, child and tag are created; existing ones are reused",
  );
}

{
  const desired = labelGroupsOf([{ id: "a", name: "demo", parent: "g" }, { id: "b", name: "bug", parent: null }], [{ id: "g", name: "Repository", parent: null }]);
  assert.deepEqual(desired, [{ name: "demo", group: "Repository" }], "only labels under a parent are in a group");
}

// ---- Plane is a source only where the config sets it up; a test config has none.
assert.ok(!allSources().some((s) => s.source === "plane"), "an unconfigured Plane is left out of the runner's source loops");

// ---- The relay: the panel records a request, the runner answers in the intent's result.
{
  await db.delete(intents).where(eq(intents.kind, "source_request"));
  const answer = async (value: object | { error: string }) => {
    for (let i = 0; i < 40; i++) {
      const [open] = await db.select().from(intents).where(and(eq(intents.kind, "source_request"), isNull(intents.handled_at))).orderBy(intents.created_at);
      if (open) {
        await db.update(intents).set({ handled_at: new Date(), result: JSON.stringify(value) }).where(eq(intents.id, open.id));
        return JSON.parse(open.detail!) as unknown;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the relay never recorded its request");
  };
  const [result, detail] = await Promise.all([relay("plane", { op: "file", draft: { requestId: "r" } }, { waitMs: 8_000 }), answer({ value: { key: "FAC-5", url: "u" } })]);
  assert.deepEqual(detail, { source: "plane", request: { op: "file", draft: { requestId: "r" } } }, "the request names its source and write");
  assert.deepEqual(result, { key: "FAC-5", url: "u" }, "the runner's value is the answer");
  await assert.rejects(Promise.all([relay("plane", { op: "reply" }, { waitMs: 8_000 }), answer({ error: "Plane answered 500" })]), /Plane answered 500/, "the runner's error reaches the panel");
  await assert.rejects(relay("plane", { op: "sync_labels" }, { waitMs: 1_000 }), (e: unknown) => e instanceof RelayTimeout, "no runner: the owner is told it is queued");
  await db.delete(intents).where(eq(intents.kind, "source_request"));
  await assert.rejects(handleSourceRequest(JSON.stringify({ source: "linear", request: {} })), /no relayed writes for source linear/);
}

console.log("plane regressions passed");
process.exit(0);
