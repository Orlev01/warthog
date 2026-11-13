// Agent token metrics (docs/design/admin-portal.md §4): every token request is one
// `agent.token` event whose outcome is `ok` or the OAuth error code — never a token, code,
// client id or connection id. The seam is optional and best effort.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { exchangeToken } from "./token";
import { createClient, createAuthCode } from "./store";
import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import type { RecordMetricInput } from "../metrics/record";

const MCP_RESOURCE = "https://warthog.com.au/mcp";
const CLIENT_ID = "https://claude.ai/.well-known/oauth-client";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const NOW = new Date("2026-01-01T00:00:00.000Z");
const HMAC_KEY = new Uint8Array(32).fill(0x11);

test("an exchange that mints tokens records ok; refusals record their OAuth error code; nothing identifying is recorded", async () => {
  const db = await freshDb();
  try {
    await createClient(db, { clientId: CLIENT_ID, registration: "cimd", redirectUris: [REDIRECT_URI] });
    const connectionId = randomUUID();
    const rawCode = `code-${randomUUID()}`;
    await createAuthCode(db, {
      codeHash: createHash("sha256").update(rawCode, "utf8").digest("hex"), connectionId, clientId: CLIENT_ID,
      codeChallenge: createHash("sha256").update(CODE_VERIFIER, "utf8").digest("base64url"), redirectUri: REDIRECT_URI, resource: MCP_RESOURCE,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    const metrics: RecordMetricInput[] = [];
    const deps = { db, clock: fixedClock(NOW), random: systemRandom, hmacKey: HMAC_KEY, recordMetric: async (m: RecordMetricInput) => { metrics.push(m); } };
    const params = (grant: Record<string, string>) => ({ params: new URLSearchParams(grant) });

    assert.equal((await exchangeToken(params({ grant_type: "password" }), deps)).ok, false);
    assert.equal((await exchangeToken(params({ grant_type: "authorization_code", code: rawCode }), deps)).ok, false, "a code exchange needs its client and verifier");
    assert.equal((await exchangeToken(params({ grant_type: "refresh_token", refresh_token: "nope", client_id: CLIENT_ID }), deps)).ok, false);
    const minted = await exchangeToken(params({ grant_type: "authorization_code", code: rawCode, code_verifier: CODE_VERIFIER, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID }), deps);
    assert.ok(minted.ok);

    assert.deepEqual(metrics.map((m) => [m.name, m.value, m.dimensions?.outcome]), [
      ["agent.token", 1, "unsupported_grant_type"], ["agent.token", 1, "invalid_request"], ["agent.token", 1, "invalid_grant"], ["agent.token", 1, "ok"],
    ]);
    const serialised = JSON.stringify(metrics);
    assert.ok(!serialised.includes(rawCode) && !serialised.includes(connectionId) && !serialised.includes("claude.ai"), "no code, connection or client in metrics");

    const broken = { ...deps, recordMetric: async () => { throw new Error("metrics down"); } };
    assert.equal((await exchangeToken(params({ grant_type: "password" }), broken)).ok, false);
  } finally {
    await db.close();
  }
});
