import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../test/db";

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
