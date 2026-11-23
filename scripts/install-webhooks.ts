import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { CONFIG_PATH, loadConfig } from "../lib/config";

process.loadEnvFile(".env.local");
const base = process.env.NEON_FUNCTION_INGEST_BASE_URL!.replace(/\/$/, "");
const config = loadConfig();

async function linear<T>(query: string, variables: object, schema: z.ZodType<T>) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { authorization: config.linearApiKey!, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: unknown; errors?: unknown };
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return schema.parse(json.data);
}

async function linearWebhook() {
  const url = `${base}/webhooks/linear`;
  const { webhooks } = await linear(
    `{ webhooks(first: 100) { nodes { id url } } }`,
    {},
    z.object({ webhooks: z.object({ nodes: z.array(z.object({ id: z.string(), url: z.string() })) }) }),
  );
  const existing = webhooks.nodes.find((w) => w.url === url);
  if (existing) return existing.id;
  const { teams } = await linear(
    `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`,
    { key: config.factory.teamKey },
    z.object({ teams: z.object({ nodes: z.array(z.object({ id: z.string() })) }) }),
  );
  const created = await linear(
    `mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) { webhook { id } } }`,
    {
      input: {
        url,
        teamId: teams.nodes[0]!.id,
        resourceTypes: ["Issue", "Comment"],
        secret: process.env.LINEAR_WEBHOOK_SECRET,
        label: "marshal-factory intake",
      },
    },
    z.object({ webhookCreate: z.object({ webhook: z.object({ id: z.string() }) }) }),
  );
  return created.webhookCreate.webhook.id;
}

/**
 * Plane's API (/api/v1) cannot create webhooks, so this prints what to create in Plane's
 * workspace settings and checks that the signing secret Plane shows has been put in .env.local.
 * The ingest Function reads PLANE_WEBHOOK_SECRET and PLANE_PROJECT_ID.
 */
function planeWebhook() {
  const plane = config.plane!;
  const url = `${base}/webhooks/plane`;
  const secret = process.env.PLANE_WEBHOOK_SECRET;
  console.log(
    [
      "Plane webhook (create it once, by hand):",
      `  1. Open ${plane.baseUrl}/${plane.workspace}/settings/webhooks and click Add webhook.`,
      `  2. URL: ${url}`,
      "  3. Pick individual events: Work items and Work item comments. Leave the rest off.",
      "  4. Create it, copy the secret key Plane shows, and add it to .env.local as PLANE_WEBHOOK_SECRET=...",
      `  5. Deploy it to ingest: neon functions deploy ingest --branch main --src functions/ingest/index.ts --env PLANE_WEBHOOK_SECRET=... --env PLANE_PROJECT_ID=${plane.projectId} --env FACTORY_LABEL=${config.factory.label}`,
      secret ? "  PLANE_WEBHOOK_SECRET is set in .env.local." : "  PLANE_WEBHOOK_SECRET is not in .env.local yet.",
    ].join("\n"),
  );
  return url;
}

const ids: Record<string, string> = {};
if (config.linearApiKey) ids.linear = await linearWebhook();
if (config.plane) ids.plane = planeWebhook();
const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, Record<string, unknown>>;
raw.factory = { ...raw.factory, webhooks: { ...(raw.factory?.webhooks as object), ...ids } };
writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`);
// The mode option only applies when the file is created; the config holds secrets either way.
chmodSync(CONFIG_PATH, 0o600);
console.log(JSON.stringify(ids));
