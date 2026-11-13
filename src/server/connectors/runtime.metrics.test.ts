// Connector connect/refresh outcome metrics (docs/design/admin-portal.md §4): one
// `connector.connect` per completed or failed connect (the failing stage as its category)
// and one `connector.refresh` per renewal that went through or failed — carrying only the
// connector id and the outcome, never an account label, token or identity value. The seam
// is optional and best effort. Driven through the real runtime with a fake provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectorRuntime } from "./runtime";
import { loadConfig } from "../config";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import type { RecordMetricInput } from "../metrics/record";

const config = loadConfig({ NODE_ENV: "test", PUBLIC_BASE_URL: "https://app.example.test", WEBAUTHN_RP_ID: "example.test",
  DATABASE_URL: "pglite:memory", WARTHOG_HMAC_KEY: Buffer.alloc(32, 11).toString("base64"), WARTHOG_DEV_KEK: Buffer.alloc(32, 12).toString("base64"),
  GOOGLE_CLIENT_ID: "test-google", GOOGLE_CLIENT_SECRET: "test-google-secret", MICROSOFT_CLIENT_ID: "test-microsoft", MICROSOFT_CLIENT_SECRET: "test-microsoft-secret", GOOGLE_EARLY_ACCESS: "owner@example.test" });
const now = new Date("2026-11-13T01:00:00Z");
const CONNECTOR = "microsoft-outlook-calendar";

// A Microsoft provider that answers the profile and token endpoints; `tokenFails` makes the
// token endpoint refuse, which fails a connect at token exchange and a renewal outright.
function providerFetch(state: { tokenFails: boolean }): typeof fetch {
  return async (url, init) => {
    if (String(url).startsWith("https://graph.microsoft.com/v1.0/me?")) return Response.json({ mail: null, userPrincipalName: "connected@outlook.test" });
    if (state.tokenFails) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
    const refreshing = new URLSearchParams(String(init?.body)).get("grant_type") === "refresh_token";
    return Response.json({ access_token: refreshing ? "next-access" : "first-access", token_type: "Bearer", expires_in: 3600, refresh_token: refreshing ? "rotated-refresh" : "initial-refresh" });
  };
}

function harness(db: Awaited<ReturnType<typeof freshDb>>, recordMetric: ((input: RecordMetricInput) => Promise<void>) | undefined, state = { tokenFails: false }) {
  const dek = new Uint8Array(32).fill(8);
  return createConnectorRuntime({ db, config, clock: { now: () => now }, keyWrapper: { wrap: async () => "unused", unwrap: async () => dek.slice() }, fetch: providerFetch(state), recordMetric });
}

const summary = (metrics: RecordMetricInput[]) => metrics.map((m) => [m.name, m.dimensions?.connectorId, m.dimensions?.outcome, m.dimensions?.errorCategory]);

test("a connect that goes through records ok, a renewal records ok then failed, and a connect that fails at the token exchange names that stage", async () => {
  const db = await freshDb();
  try {
    const metrics: RecordMetricInput[] = [];
    const state = { tokenFails: false };
    const runtime = harness(db, async (m) => { metrics.push(m); }, state);
    const user = await createUser(db, { email: "owner@example.test", wrappedDek: "test-key" });
    const session = { id: "session", userId: user.id, createdAt: now, lastSeenAt: now, steppedUpAt: now };

    const begin = async () => { const url = new URL((await runtime.begin(session, CONNECTOR)).url); return url.searchParams.get("state")!; };
    let state1 = await begin();
    const connected = await runtime.complete({ ...runtime.take(session, state1)!, userId: user.id, code: "code", state: state1 });
    await runtime.refresh({ userId: user.id, connectionId: connected.id });
    state.tokenFails = true;
    await assert.rejects(runtime.refresh({ userId: user.id, connectionId: connected.id }), /refresh failed/i);
    state1 = await begin();
    await assert.rejects(runtime.complete({ ...runtime.take(session, state1)!, userId: user.id, code: "code", state: state1 }), /could not be connected/);
    await runtime.refresh({ userId: "00000000-0000-0000-0000-000000000000", connectionId: connected.id });

    assert.deepEqual(summary(metrics), [
      ["connector.connect", CONNECTOR, "ok", undefined],
      ["connector.refresh", CONNECTOR, "ok", undefined],
      ["connector.refresh", CONNECTOR, "failed", undefined],
      ["connector.connect", CONNECTOR, "failed", "token_exchange"],
    ]);
    assert.ok(metrics.every((m) => m.value === 1));
    const serialised = JSON.stringify(metrics);
    assert.ok(!serialised.includes("outlook.test") && !serialised.includes("access") && !serialised.includes(user.id), "no label, token or id in metrics");
  } finally {
    await db.close();
  }
});

test("a throwing seam never changes a connect's outcome, and no seam records nothing", async () => {
  const db = await freshDb();
  try {
    const runtime = harness(db, async () => { throw new Error("metrics down"); });
    const user = await createUser(db, { email: "owner@example.test", wrappedDek: "test-key" });
    const session = { id: "session", userId: user.id, createdAt: now, lastSeenAt: now, steppedUpAt: now };
    const state = new URL((await runtime.begin(session, CONNECTOR)).url).searchParams.get("state")!;
    const connected = await runtime.complete({ ...runtime.take(session, state)!, userId: user.id, code: "code", state });
    assert.equal(connected.connectorId, CONNECTOR);
    const silent = harness(db, undefined);
    await silent.refresh({ userId: user.id, connectionId: connected.id });
  } finally {
    await db.close();
  }
});
