import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../test/db";
import { createAuthCode, createClient, getClient } from "./store";
import { cleanupOAuth } from "./cleanup";

test("cleanup removes expired codes/tokens and old unused DCR registrations without removing used clients or static keys", async () => {
  const db = await freshDb();
  try {
    const now = new Date("2026-11-09T00:00:00Z");
    for (const clientId of ["old-unused", "old-used", "recent", "cimd"]) {
      await createClient(db, { clientId, registration: clientId === "cimd" ? "cimd" : "dcr", redirectUris: ["https://client.example/callback"] });
      await db.query("UPDATE oauth_clients SET created_at = $2::timestamptz WHERE client_id = $1", [clientId, clientId === "recent" ? now.toISOString() : "2026-09-01T00:00:00Z"]);
    }
    const connectionId = "00000000-0000-4000-8000-000000000001";
    await createAuthCode(db, { codeHash: "expired-code", clientId: "old-used", connectionId, codeChallenge: "challenge", redirectUri: "https://client.example/callback", resource: "https://app.example/mcp", expiresAt: now });
    await createAuthCode(db, { codeHash: "live-code", clientId: "recent", connectionId, codeChallenge: "challenge", redirectUri: "https://client.example/callback", resource: "https://app.example/mcp", expiresAt: new Date(now.getTime() + 60_000) });
    await db.query("INSERT INTO oauth_tokens (token_hash,connection_id,kind,expires_at) VALUES ('expired-access',$1,'access',$2),('live-refresh',$1,'refresh',$3)", [connectionId, now.toISOString(), "2026-12-01T00:00:00Z"]);
    await db.query("INSERT INTO oauth_access_keys (key_hash, connection_id) VALUES ('static-key',$1)", [connectionId]);
    await cleanupOAuth(db, now);
    assert.equal(await getClient(db, "old-unused"), null);
    for (const id of ["old-used", "recent", "cimd"]) assert.ok(await getClient(db, id), id);
    assert.deepEqual((await db.query("SELECT code_hash FROM oauth_auth_codes")).rows, [{ code_hash: "live-code" }]);
    assert.deepEqual((await db.query("SELECT token_hash FROM oauth_tokens")).rows, [{ token_hash: "live-refresh" }]);
    assert.equal((await db.query("SELECT * FROM oauth_access_keys")).rows.length, 1);
    await cleanupOAuth(db, now);
    assert.ok(await getClient(db, "old-used"), "repeated cleanup preserves a previously used registration");
  } finally { await db.close(); }
});

test("cleanup preserves refresh replay evidence and grace retries while pruning abandoned old families", async () => {
  const db = await freshDb();
  try {
    const active = "00000000-0000-4000-8000-000000000001";
    const abandoned = "00000000-0000-4000-8000-000000000002";
    const now = new Date("2026-11-09T00:00:00Z");
    await db.query(`INSERT INTO oauth_tokens (token_hash,connection_id,kind,expires_at) VALUES
      ('retired-active',$1,'refresh','2026-09-01'), ('active-successor',$1,'refresh','2026-12-01'),
      ('old-abandoned',$2,'refresh','2026-09-01'), ('grace-retry',$2,'refresh','2026-11-08T23:59:59Z')`, [active, abandoned]);
    await cleanupOAuth(db, now);
    const hashes = (await db.query("SELECT token_hash FROM oauth_tokens ORDER BY token_hash")).rows.map((r) => r.token_hash);
    assert.deepEqual(hashes, ["active-successor", "grace-retry", "retired-active"]);
  } finally { await db.close(); }
});
