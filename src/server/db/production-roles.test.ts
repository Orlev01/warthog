import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../test/db";
import { createUser } from "./users";

test("runtime role writes ordinary data but cannot bypass append-only activity or own migrations", async () => {
  const db = await freshDb();
  try {
    await db.query("SET ROLE warthog_app");
    await db.query("SELECT * FROM users LIMIT 0");
    await db.query("SELECT * FROM approval_sms_attempts LIMIT 0");
    await db.query("INSERT INTO approval_sms_attempts (approval_id, attempted_at) SELECT gen_random_uuid(), now() WHERE false");
    await assert.rejects(db.query("DELETE FROM approval_sms_attempts WHERE false"), /permission denied/);
    await assert.rejects(db.query("UPDATE approval_sms_attempts SET attempted_at = now() WHERE false"), /permission denied/);
    await db.query("UPDATE oauth_clients SET redirect_uris = redirect_uris WHERE false");
    for (const sql of ["DELETE FROM users WHERE false", "UPDATE activity_entries SET kind = kind WHERE false", "DELETE FROM activity_entries WHERE false", "DELETE FROM activity_disputes WHERE false", "TRUNCATE activity_entries", "DELETE FROM schema_migrations WHERE false"]) {
      await assert.rejects(db.query(sql), /permission denied/, sql);
    }
    await db.query("SELECT * FROM schema_migrations LIMIT 0");
  } finally { await db.query("RESET ROLE"); await db.close(); }
});

test("purge role can remove an account and OAuth credentials but cannot rewrite activity", async () => {
  const db = await freshDb();
  try {
    await db.query("SET ROLE warthog_purge");
    for (const table of ["users", "agents", "receipt_files", "account_purge_queue"]) await db.query(`SELECT * FROM ${table} LIMIT 0`);
    for (const table of ["users", "oauth_tokens", "oauth_auth_codes", "oauth_access_keys"]) await db.query(`DELETE FROM ${table} WHERE false`);
    await assert.rejects(db.query("UPDATE activity_entries SET kind = kind WHERE false"), /permission denied/);
    await assert.rejects(db.query("TRUNCATE activity_entries"), /permission denied/);
  } finally { await db.query("RESET ROLE"); await db.close(); }
});

// 13 Nov — the single-shot undo guard. The runtime role claims an entry's undo and releases
// it again (INSERT, SELECT, DELETE) but can never rewrite a claim; the purge role's account
// delete carries the person's claims away by cascade.
test("runtime role claims and releases undo claims but cannot rewrite them; an account purge removes them", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "undo-claim-roles@warthog.com.au", wrappedDek: "synthetic" });
    await db.query("SET ROLE warthog_app");
    const claim = "INSERT INTO activity_undo_claims (user_id, entry_seq, claimed_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING RETURNING entry_seq";
    assert.equal((await db.query(claim, [user.id, 2])).rows.length, 1, "the runtime role wins a fresh claim");
    assert.equal((await db.query(claim, [user.id, 2])).rows.length, 0, "a second claim of the same entry is not won");
    await db.query("DELETE FROM activity_undo_claims WHERE user_id = $1 AND entry_seq = $2", [user.id, 2]);
    await assert.rejects(db.query("UPDATE activity_undo_claims SET claimed_at = now() WHERE false"), /permission denied/);
    await db.query(claim, [user.id, 1]);
    await db.query("RESET ROLE");

    await db.query("SET ROLE warthog_purge");
    await db.query("DELETE FROM users WHERE id = $1", [user.id]);
    await db.query("RESET ROLE");
    const left = await db.query("SELECT count(*)::int AS n FROM activity_undo_claims WHERE user_id = $1", [user.id]);
    assert.equal(Number(left.rows[0]?.n), 0, "the purged account's claims are gone");
  } finally { await db.query("RESET ROLE"); await db.close(); }
});
