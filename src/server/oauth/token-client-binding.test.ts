import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import { freshDb } from "../../test/db";
import { createDb, loadMigrations, runMigrations, type Db } from "../db/index";
import { loadConfig } from "../config";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import { createAuthCode, createClient, resolveToken } from "./store";
import { exchangeToken, REFRESH_REUSE_GRACE_MS } from "./token";
import { verifyBearer } from "./verify-bearer";
import { createRevokeHandler } from "../../app/oauth/revoke/handler";

const NOW = new Date("2026-11-11T00:00:00Z");
const CLIENT_A = "https://client-a.example.test/oauth.json";
const CLIENT_B = "https://client-b.example.test/oauth.json";
const REDIRECT = "https://client.example.test/callback";
const VERIFIER = "a".repeat(43);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const deps = (db: Db, now = NOW) => ({ db, clock: fixedClock(now), random: systemRandom, hmacKey: new Uint8Array(32).fill(7) });

async function grant(db: Db, connectionId: string, clientId = CLIENT_A) {
  const code = randomUUID();
  await createAuthCode(db, {
    codeHash: digest(code), connectionId, clientId,
    codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"),
    redirectUri: REDIRECT, resource: "https://warthog.example.test/mcp", expiresAt: new Date(NOW.getTime() + 60_000),
  });
  const result = await exchangeToken({ params: new URLSearchParams({ grant_type: "authorization_code",
    code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: VERIFIER }) }, deps(db));
  assert.ok(result.ok);
  return result.body;
}

function refresh(db: Db, token: string, clientId: string | null = CLIENT_A, now = NOW) {
  const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: token });
  if (clientId !== null) params.set("client_id", clientId);
  return exchangeToken({ params }, deps(db, now));
}

async function clients(db: Db) {
  for (const clientId of [CLIENT_A, CLIENT_B]) {
    await createClient(db, { clientId, registration: "dcr", redirectUris: [REDIRECT] });
  }
}

test("code grants, refresh rotation and retry grace retain the exact issuing client", async () => {
  const db = await freshDb();
  try {
    await clients(db);
    const initial = await grant(db, randomUUID());
    const rotated = await refresh(db, initial.refresh_token);
    assert.ok(rotated.ok);
    const retry = await refresh(db, initial.refresh_token, CLIENT_A, new Date(NOW.getTime() + 1_000));
    assert.ok(retry.ok);
    assert.equal(retry.body.refresh_token, rotated.body.refresh_token);
    const rows = (await db.query("SELECT client_id FROM oauth_tokens")).rows;
    assert.ok(rows.length >= 4);
    assert.ok(rows.every((row) => row.client_id === CLIENT_A));
  } finally { await db.close(); }
});

for (const wrongClient of [null, "", CLIENT_B, CLIENT_A.toUpperCase()]) {
  test(`a refresh from ${wrongClient ? "a mismatched client" : "a missing client"} cannot consume or revoke the real client's tokens: ${wrongClient}`, async () => {
    const db = await freshDb();
    try {
      await clients(db);
      const initial = await grant(db, randomUUID());
      const before = (await db.query("SELECT * FROM oauth_tokens ORDER BY token_hash")).rows;
      const refused = await refresh(db, initial.refresh_token, wrongClient);
      assert.equal(refused.ok, false);
      assert.deepEqual((await db.query("SELECT * FROM oauth_tokens ORDER BY token_hash")).rows, before);
      const rotated = await refresh(db, initial.refresh_token);
      assert.ok(rotated.ok);
      const later = new Date(NOW.getTime() + REFRESH_REUSE_GRACE_MS + 1);
      const replay = await refresh(db, initial.refresh_token, wrongClient, later);
      assert.equal(replay.ok, false);
      assert.ok((await refresh(db, rotated.body.refresh_token, CLIENT_A, later)).ok,
        "a mismatched replay must not revoke the legitimate token family");
    } finally { await db.close(); }
  });
}

test("replay revokes the issuing client's family without crossing clients on the same connection", async () => {
  const db = await freshDb();
  try {
    await clients(db);
    const connection = randomUUID();
    const a = await grant(db, connection, CLIENT_A);
    const b = await grant(db, connection, CLIENT_B);
    const aNext = await refresh(db, a.refresh_token, CLIENT_A);
    assert.ok(aNext.ok);
    const later = new Date(NOW.getTime() + REFRESH_REUSE_GRACE_MS + 1);
    assert.deepEqual(await refresh(db, a.refresh_token, CLIENT_A, later), { ok: false, error: "invalid_grant" });
    assert.equal(await resolveToken(db, digest(aNext.body.refresh_token)), null);
    assert.equal(await resolveToken(db, digest(a.access_token)), null);
    assert.ok((await refresh(db, b.refresh_token, CLIENT_B, later)).ok);

    // An explicit connection revocation still cuts off every token and pending code.
    const anotherA = await grant(db, connection, CLIENT_A);
    const revoke = await createRevokeHandler({ db })(new Request("https://warthog.example.test/oauth/revoke", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: anotherA.access_token }),
    }));
    assert.equal(revoke.status, 200);
    assert.equal((await db.query("SELECT token_hash FROM oauth_tokens WHERE connection_id = $1", [connection])).rows.length, 0);
  } finally { await db.close(); }
});

test("a dynamically validated CIMD client need not have a persisted DCR registration to retain its binding", async () => {
  const db = await freshDb();
  try {
    // authorize's resolver accepts a validated CIMD document without inserting oauth_clients.
    const initial = await grant(db, randomUUID(), CLIENT_A);
    assert.ok((await refresh(db, initial.refresh_token, CLIENT_A)).ok);
    assert.equal((await refresh(db, initial.refresh_token, CLIENT_B)).ok, false);
  } finally { await db.close(); }
});

test("the additive migration leaves legacy refresh unbound and access tokens usable without guessing from codes", async () => {
  const db = await createDb("pglite:memory");
  try {
    const migrations = await loadMigrations();
    const binding = migrations.find((migration) => migration.name.startsWith("0105_"));
    assert.ok(binding);
    await runMigrations(db, migrations.filter((migration) => migration !== binding));
    const connection = randomUUID();
    await clients(db);
    // Even an outstanding code naming the same connection does not prove which client
    // originally minted an existing token, since consumed code history is absent.
    await createAuthCode(db, { codeHash: "unrelated-code", connectionId: connection, clientId: CLIENT_B,
      codeChallenge: "challenge", redirectUri: REDIRECT, resource: "https://warthog.example.test/mcp",
      expiresAt: new Date(NOW.getTime() + 60_000) });
    const rawAccess = randomUUID();
    const rawRefresh = randomUUID();
    const expiry = new Date(NOW.getTime() + 3_600_000);
    await db.query("INSERT INTO oauth_tokens (token_hash, connection_id, kind, expires_at) VALUES ($1,$3,'access',$4),($2,$3,'refresh',$4)",
      [digest(rawAccess), digest(rawRefresh), connection, expiry.toISOString()]);
    await runMigrations(db, migrations);
    await runMigrations(db, migrations);
    const before = (await db.query("SELECT * FROM oauth_tokens ORDER BY token_hash")).rows;
    assert.ok(before.every((row) => row.client_id === null));
    assert.deepEqual(await refresh(db, rawRefresh, CLIENT_A), { ok: false, error: "invalid_grant" });
    assert.deepEqual(await refresh(db, rawRefresh, CLIENT_B), { ok: false, error: "invalid_grant" });
    assert.deepEqual((await db.query("SELECT * FROM oauth_tokens ORDER BY token_hash")).rows, before);
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "pglite:memory", PUBLIC_BASE_URL: "https://warthog.example.test", WEBAUTHN_RP_ID: "warthog.example.test",
      WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=", WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=" });
    assert.deepEqual(await verifyBearer(new Request("https://warthog.example.test/mcp", { headers: { authorization: `Bearer ${rawAccess}` } }),
      { db, config, clock: fixedClock(NOW) }), { ok: true, connectionId: connection });
  } finally { await db.close(); }
});
