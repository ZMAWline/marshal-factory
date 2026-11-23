import { z } from "zod";
import type { PlaneConfig } from "../config";
import { forbidInTest } from "../test-mode";

// A small client for Plane's REST API (/api/v1), self-hosted. Only the Plane adapter imports it.
// Every write the factory makes carries external_source/external_id, and Plane refuses a second
// create with the same pair (409, naming the first one's id), so a replayed create converges.

const TIMEOUT_MS = 15_000;
const ATTEMPTS = 3;
const BACKOFF_MS = 250;

/** What the factory's own writes carry in external_source; anything else on an issue is a person. */
export const FACTORY_SOURCE = "marshal-factory";
/** The panel's answers: posted for the owner, so the runner reads them as replies, not as the factory's own. */
export const PANEL_SOURCE = "marshal-factory-panel";

export class PlaneError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
  }
  get notFound() {
    return this.status === 404;
  }
}

const stateSchema = z.object({ id: z.string(), name: z.string(), group: z.string() });
export type PlaneState = z.infer<typeof stateSchema>;

const labelSchema = z.object({ id: z.string(), name: z.string(), parent: z.string().nullish() });
export type PlaneLabel = z.infer<typeof labelSchema>;

/** A work item with labels and state expanded (?expand=labels,state). */
const issueSchema = z.object({
  id: z.string(),
  sequence_id: z.number(),
  name: z.string(),
  description_html: z.string().nullish(),
  archived_at: z.string().nullish(),
  deleted_at: z.string().nullish(),
  created_at: z.string(),
  state: stateSchema,
  labels: z.array(labelSchema).default([]),
});
export type PlaneIssue = z.infer<typeof issueSchema>;

const commentSchema = z.object({
  id: z.string(),
  comment_html: z.string().nullish(),
  external_id: z.string().nullish(),
  external_source: z.string().nullish(),
  created_at: z.string(),
});
export type PlaneComment = z.infer<typeof commentSchema>;

const page = <T extends z.ZodType>(item: T) =>
  z.object({ results: z.array(item), next_cursor: z.string().nullish(), next_page_results: z.boolean().nullish() });

const realFetch: typeof fetch = (input, init) => {
  forbidInTest("the Plane API");
  return fetch(input, init);
};

export type PlaneOptions = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> };

export function planeClient(config: PlaneConfig, { fetch: fetchImpl = realFetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: PlaneOptions = {}) {
  const project = `${config.baseUrl}/api/v1/workspaces/${config.workspace}/projects/${config.projectId}`;

  async function send(method: string, url: string, body?: unknown) {
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined;
      try {
        res = await fetchImpl(url, {
          method,
          headers: { "x-api-key": config.apiKey, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt === ATTEMPTS) throw error;
      }
      if (res && (attempt === ATTEMPTS || (res.status < 500 && res.status !== 429))) return res;
      await sleep(BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random()));
    }
  }

  async function call<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const res = await send(method, `${project}${path}`, body);
    const text = await res.text();
    if (!res.ok) {
      const message = (() => {
        try {
          const json = JSON.parse(text) as { error?: string; detail?: string };
          return json.error ?? json.detail ?? text;
        } catch {
          return text;
        }
      })();
      throw new PlaneError(`Plane answered ${res.status} to ${method} ${path}: ${message.slice(0, 300)}`, res.status);
    }
    return schema.parse(text ? JSON.parse(text) : null);
  }

  /** A create carrying an external id: a 409 means it exists already, and Plane names its id. */
  async function createOnce<T>(path: string, body: unknown, schema: z.ZodType<T>, fetchExisting: (id: string) => Promise<T>): Promise<T> {
    const res = await send("POST", `${project}${path}`, body);
    const text = await res.text();
    if (res.status === 409) {
      const id = z.object({ id: z.string() }).safeParse(JSON.parse(text)).data?.id;
      if (!id) throw new PlaneError(`Plane answered 409 to POST ${path} without the existing id`, 409);
      return fetchExisting(id);
    }
    if (!res.ok) throw new PlaneError(`Plane answered ${res.status} to POST ${path}: ${text.slice(0, 300)}`, res.status);
    return schema.parse(JSON.parse(text));
  }

  async function all<T>(path: string, item: z.ZodType<T>): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    let cursor: string | undefined;
    for (let pages = 0; pages < 50; pages++) {
      const data = await call("GET", `${path}${sep}per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, page(item));
      out.push(...data.results);
      if (!data.next_page_results || !data.next_cursor) break;
      cursor = data.next_cursor;
    }
    return out;
  }

  const issue = (id: string) => call("GET", `/work-items/${id}/?expand=labels,state`, issueSchema);

  return {
    /** The project's identifier, such as FAC, which prefixes its work item keys. */
    identifier: async () => (await call("GET", "/", z.object({ identifier: z.string() }))).identifier,
    states: () => all("/states/", stateSchema),
    labels: () => all("/labels/", labelSchema),
    createLabel: (input: { name: string; parent?: string | null; color?: string; external_id: string }) =>
      createOnce("/labels/", { ...input, external_source: FACTORY_SOURCE }, labelSchema, (id) => call("GET", `/labels/${id}/`, labelSchema)),
    issues: () => all("/work-items/?expand=labels,state", issueSchema),
    issue,
    /** Sets fields on a work item; `labels` replaces the whole set, so pass every label id it should keep. */
    update: (id: string, fields: { state?: string; labels?: string[] }) => call("PATCH", `/work-items/${id}/`, z.unknown(), fields),
    createIssue: (input: { name: string; description_html: string; state: string; labels: string[]; external_id: string }) =>
      createOnce("/work-items/", { ...input, external_source: FACTORY_SOURCE }, z.object({ id: z.string() }), async (id) => ({ id })).then(({ id }) => issue(id)),
    comments: (issueId: string) => all(`/work-items/${issueId}/comments/`, commentSchema),
    comment: (issueId: string, externalId: string, html: string, source: string = FACTORY_SOURCE) =>
      createOnce(
        `/work-items/${issueId}/comments/`,
        { comment_html: html, external_id: externalId, external_source: source },
        commentSchema,
        (id) => call("GET", `/work-items/${issueId}/comments/${id}/`, commentSchema),
      ),
    /** The link a person opens, such as https://plane.example.com/ws/browse/FAC-7/. */
    browseUrl: (key: string) => `${config.baseUrl}/${config.workspace}/browse/${key}/`,
  };
}

export type PlaneClient = ReturnType<typeof planeClient>;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

/** Plane stores rich text as HTML; agents and replies read it as plain text with line breaks kept. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/(p|div|li|h[1-6]|pre|blockquote|tr)>/gi, "\n")
    .replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, "[image: $1]")
    .replace(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (_m, href: string, text: string) => (text && text !== href ? `${text} (${href})` : href))
    .replace(/<[^>]+>/g, "")
    .replace(/&(#?\w+);/g, (m, name: string) => ENTITIES[name] ?? (name.startsWith("#") ? String.fromCharCode(Number(name.slice(1))) : m))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The little Markdown the factory writes (paragraphs, bullets, bold, code, links, images) as Plane's HTML. */
export function markdownToHtml(markdown: string): string {
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1">')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  return markdown
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");
      if (lines.every((l) => /^\s*[-*] /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`;
      if (/^#{1,6} /.test(lines[0]!) && lines.length === 1) return `<h3>${inline(lines[0]!.replace(/^#{1,6} /, ""))}</h3>`;
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    })
    .join("");
}
