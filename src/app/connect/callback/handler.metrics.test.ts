// A person declining at the provider is one `connector.connect` event with outcome
// `declined` for that connector (docs/design/admin-portal.md §4); an invalid decline
// (no pending flow) records nothing; a throwing seam never changes the redirect.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createConnectCallbackHandler } from "./handler";
import { loadConfig } from "../../../server/config";
import type { RecordMetricInput } from "../../../server/metrics/record";

const config = loadConfig({ NODE_ENV: "test", PUBLIC_BASE_URL: "https://app.example.test", WEBAUTHN_RP_ID: "example.test",
  DATABASE_URL: "pglite:memory", WARTHOG_HMAC_KEY: Buffer.alloc(32, 11).toString("base64"), WARTHOG_DEV_KEK: Buffer.alloc(32, 12).toString("base64") });
const now = new Date("2026-11-13T01:00:00Z");
const session = { id: "session", userId: "person", createdAt: now, lastSeenAt: now, steppedUpAt: now };
const flow = { connectorId: "google-gmail", accountLabel: "person@gmail.test", codeVerifier: "a".repeat(43) };

test("a declined provider sign-in records the connector's decline and nothing personal", async () => {
  const metrics: RecordMetricInput[] = [];
  const handler = createConnectCallbackHandler({
    config, resolveSession: async () => session,
    takePendingFlow: async (_userId, state) => (state === "known" ? flow : null),
    recordMetric: async (m) => { metrics.push(m); },
  });
  const declined = await handler.GET(new Request("https://app.example.test/connect/callback?error=access_denied&state=known"));
  assert.equal(declined.status, 303);
  assert.equal(declined.headers.get("location"), "https://app.example.test/connectors?notice=connection-declined");
  const invalid = await handler.GET(new Request("https://app.example.test/connect/callback?error=access_denied&state=unknown"));
  assert.equal(invalid.status, 400);
  assert.deepEqual(metrics.map((m) => [m.name, m.value, m.dimensions?.connectorId, m.dimensions?.outcome]), [["connector.connect", 1, "google-gmail", "declined"]]);
  assert.ok(!JSON.stringify(metrics).includes("gmail.test") && !JSON.stringify(metrics).includes("known"), "no label or state in metrics");

  const broken = createConnectCallbackHandler({ config, resolveSession: async () => session, takePendingFlow: async () => flow, recordMetric: async () => { throw new Error("metrics down"); } });
  assert.equal((await broken.GET(new Request("https://app.example.test/connect/callback?error=access_denied&state=known"))).status, 303);
});
