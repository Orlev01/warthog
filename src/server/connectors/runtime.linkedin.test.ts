// Connecting LinkedIn (docs/adr/linkedin-connector.md): LinkedIn's web sign-in uses the client
// secret and state, not PKCE; its ID token comes from https://www.linkedin.com/oauth; its
// access lasts 60 days with no renewal for apps outside its partner programmes, so the
// connection is left to lapse at expiry into the usual "Reconnect needed", and reconnecting the
// same account renews the same connection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import { createConnectorRuntime } from "./runtime";
import { loadConfig } from "../config";
import { createDb, loadMigrations, runMigrations } from "../db/index";
import { createUser } from "../db/users";
import { getConnectionCredentials } from "../db/connections";
import type { RecordMetricInput } from "../metrics/record";

const base = { NODE_ENV: "test", PUBLIC_BASE_URL: "https://app.example.test", WEBAUTHN_RP_ID: "example.test",
  DATABASE_URL: "pglite:memory", WARTHOG_HMAC_KEY: Buffer.alloc(32, 11).toString("base64"), WARTHOG_DEV_KEK: Buffer.alloc(32, 12).toString("base64") };
const config = loadConfig({ ...base, LINKEDIN_CLIENT_ID: "li-client", LINKEDIN_CLIENT_SECRET: "li-secret" });
const now = new Date("2026-11-20T01:00:00Z");
const SIXTY_DAYS = 60 * 86_400;

test("LinkedIn connects with its client secret and state (no PKCE), names the account by email, and lapses at expiry", async () => {
  const db = await createDb("pglite:memory");
  try {
    await runMigrations(db, await loadMigrations());
    const user = await createUser(db, { email: "owner@example.test", wrappedDek: "test-key" });
    const session = { id: "li-session", userId: user.id, createdAt: now, lastSeenAt: now, steppedUpAt: now };
    const dek = new Uint8Array(32).fill(8);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const idToken = () => {
      const issued = Math.floor(Date.now() / 1000);
      const body = [{ alg: "RS256" }, { iss: "https://www.linkedin.com/oauth", aud: "li-client", sub: "782bbtaQ", iat: issued, exp: issued + 3600 }]
        .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url")).join(".");
      return body + "." + sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url");
    };
    const tokenBodies: URLSearchParams[] = [];
    const metrics: RecordMetricInput[] = [];
    const runtime = createConnectorRuntime({ db, config, clock: { now: () => now }, recordMetric: async (m) => { metrics.push(m); },
      keyWrapper: { wrap: async () => "unused", unwrap: async () => dek.slice() },
      fetch: async (url, init) => {
        if (String(url) === "https://api.linkedin.com/v2/userinfo") {
          assert.equal(new Headers(init?.headers).get("authorization"), "Bearer li-access");
          return Response.json({ sub: "782bbtaQ", name: "Sam Lee", email: "sam@example.com", email_verified: true });
        }
        assert.equal(String(url), "https://www.linkedin.com/oauth/v2/accessToken");
        tokenBodies.push(new URLSearchParams(String(init?.body)));
        return Response.json({ access_token: "li-access", expires_in: SIXTY_DAYS, scope: "email,openid,profile,w_member_social", token_type: "Bearer", id_token: idToken() });
      } });

    const url = new URL((await runtime.begin(session, "linkedin")).url);
    assert.equal(url.origin + url.pathname, "https://www.linkedin.com/oauth/v2/authorization");
    assert.deepEqual(new Set(url.searchParams.get("scope")!.split(" ")), new Set(["openid", "profile", "email", "w_member_social"]));
    assert.equal(url.searchParams.get("redirect_uri"), "https://app.example.test/connect/callback");
    assert.equal(url.searchParams.get("client_id"), "li-client");
    assert.equal(url.searchParams.get("code_challenge"), null, "LinkedIn's web sign-in doesn't take PKCE");
    assert.equal(url.searchParams.get("prompt"), null);
    const state = url.searchParams.get("state")!;
    assert.ok(state);

    const connection = await runtime.complete({ ...runtime.take(session, state)!, userId: user.id, code: "li-code", state });
    assert.equal(connection.accountLabel, "sam@example.com");
    const sent = tokenBodies[0]!;
    assert.equal(sent.get("grant_type"), "authorization_code");
    assert.equal(sent.get("client_secret"), "li-secret");
    assert.equal(sent.get("code_verifier"), null);
    const stored = await getConnectionCredentials(db, user.id, connection.id, dek);
    assert.equal(stored?.refresh_token, undefined);
    assert.equal(stored?.expires_at, new Date(now.getTime() + SIXTY_DAYS * 1000).toISOString());

    // One job, due at expiry, takes the connection to "Reconnect needed".
    const jobs = (await db.query("SELECT type, run_at FROM jobs")).rows;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.type, "connection.refresh");
    const due = new Date(jobs[0]!.run_at as string).getTime();
    assert.ok(Math.abs(due - (now.getTime() + SIXTY_DAYS * 1000)) <= 10 * 60_000, "due when the access lapses, not before");
    await assert.rejects(runtime.refresh({ userId: user.id, connectionId: connection.id }));
    assert.equal(tokenBodies.length, 1, "nothing to renew with, so LinkedIn isn't asked");
    assert.deepEqual(metrics.filter((m) => m.name === "connector.refresh").map((m) => m.dimensions?.outcome), ["lapsed"], "an expected lapse, not a failure");

    // Reconnecting the same account renews the same connection.
    await db.query("UPDATE connections SET status = 'needs_reconnect' WHERE id = $1", [connection.id]);
    const again = new URL((await runtime.begin(session, "linkedin", connection.id)).url);
    const againState = again.searchParams.get("state")!;
    const renewed = await runtime.complete({ ...runtime.take(session, againState)!, userId: user.id, code: "li-code-2", state: againState });
    assert.equal(renewed.id, connection.id);
    assert.equal(renewed.status, "connected");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM jobs WHERE status = 'pending'")).rows[0]!.n, 1, "one lapse queued, not two");
  } finally { await db.close(); }
});

test("without a LinkedIn client configured, LinkedIn isn't offered and can't be started", async () => {
  const db = await createDb("pglite:memory");
  try {
    await runMigrations(db, await loadMigrations());
    const unconfigured = loadConfig(base);
    const user = await createUser(db, { email: "owner@example.test", wrappedDek: "test-key" });
    const session = { id: "s", userId: user.id, createdAt: now, lastSeenAt: now, steppedUpAt: now };
    const runtime = createConnectorRuntime({ db, config: unconfigured, clock: { now: () => now }, fetch: async () => { throw new Error("no network"); } });
    await assert.rejects(runtime.begin(session, "linkedin"), /not configured/i);
    for (const half of [{ LINKEDIN_CLIENT_ID: "id" }, { LINKEDIN_CLIENT_SECRET: "secret" }]) {
      const partial = createConnectorRuntime({ db, config: loadConfig({ ...base, ...half }), clock: { now: () => now }, fetch: async () => { throw new Error("no network"); } });
      await assert.rejects(partial.begin(session, "linkedin"), /not configured/i, JSON.stringify(half));
    }
  } finally { await db.close(); }
});
