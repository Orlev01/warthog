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
    for (const sql of ["SELECT * FROM approval_settings LIMIT 0", "INSERT INTO approval_settings (user_id, expiry_minutes, updated_at) SELECT gen_random_uuid(), 15, now() WHERE false", "UPDATE approval_settings SET expiry_minutes = 15 WHERE false", "DELETE FROM approval_settings WHERE false"]) {
      await db.query(sql);
    }
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
// it again (INSERT, SELECT, DELETE) and may record the approval a held undo waits on
// (UPDATE of approval_id only), but can never rewrite who or what a claim is for, or when it
// was made; the purge role's account delete carries the person's claims away by cascade.
test("runtime role claims and releases undo claims, may set only their approval, and an account purge removes them", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "undo-claim-roles@warthog.com.au", wrappedDek: "synthetic" });
    await db.query("SET ROLE warthog_app");
    const claim = "INSERT INTO activity_undo_claims (user_id, entry_seq, claimed_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING RETURNING entry_seq";
    assert.equal((await db.query(claim, [user.id, 2])).rows.length, 1, "the runtime role wins a fresh claim");
    assert.equal((await db.query(claim, [user.id, 2])).rows.length, 0, "a second claim of the same entry is not won");
    await db.query("DELETE FROM activity_undo_claims WHERE user_id = $1 AND entry_seq = $2", [user.id, 2]);
    await db.query(claim, [user.id, 1]);
    await db.query("UPDATE activity_undo_claims SET approval_id = gen_random_uuid() WHERE user_id = $1 AND entry_seq = $2", [user.id, 1]);
    for (const column of ["claimed_at = now()", "user_id = user_id", "entry_seq = entry_seq + 1"]) {
      await assert.rejects(db.query(`UPDATE activity_undo_claims SET ${column} WHERE false`), /permission denied/, column);
    }
    await db.query("RESET ROLE");

    await db.query("SET ROLE warthog_purge");
    await db.query("DELETE FROM users WHERE id = $1", [user.id]);
    await db.query("RESET ROLE");
    const left = await db.query("SELECT count(*)::int AS n FROM activity_undo_claims WHERE user_id = $1", [user.id]);
    assert.equal(Number(left.rows[0]?.n), 0, "the purged account's claims are gone");
  } finally { await db.query("RESET ROLE"); await db.close(); }
});

// 16 Nov — agent runs (docs/adr/agent-runs.md). The runtime role starts runs, reads them and
// marks one seen (UPDATE of last_seen_at only); it can never rewrite whose a run is, when it
// started or what the agent said it was for. Entry links are append-only like the entries.
// An account purge carries both away by cascade.
test("runtime role starts and touches runs but cannot rewrite them, links are append-only, and a purge removes both", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "run-roles@warthog.com.au", wrappedDek: "synthetic" });
    const agent = await db.query("INSERT INTO agents (user_id, connection_id, display_name, platform, status, connected_at) VALUES ($1, gen_random_uuid(), 'Claude', 'claude', 'connected', now()) RETURNING id", [user.id]);
    const agentId = String(agent.rows[0]!.id);
    await db.query("SET ROLE warthog_app");
    const run = "5d0c2a4e-8b1f-4c3d-9e2a-7f6b5a4c3d2e";
    await db.query("INSERT INTO agent_runs (user_id, id, agent_id, started_at, last_seen_at) VALUES ($1, $2, $3, now(), now())", [user.id, run, agentId]);
    await db.query("UPDATE agent_runs SET last_seen_at = now() WHERE user_id = $1 AND id = $2", [user.id, run]);
    for (const column of ["label_ct = label_ct", "agent_id = agent_id", "user_id = user_id", "started_at = now()", "via = via"]) {
      await assert.rejects(db.query(`UPDATE agent_runs SET ${column} WHERE false`), /permission denied/, column);
    }
    await assert.rejects(db.query("DELETE FROM agent_runs WHERE false"), /permission denied/);
    await db.query("INSERT INTO activity_entry_runs (user_id, entry_seq, run_id) VALUES ($1, 1, $2)", [user.id, run]);
    await assert.rejects(db.query("UPDATE activity_entry_runs SET run_id = run_id WHERE false"), /permission denied/);
    await assert.rejects(db.query("DELETE FROM activity_entry_runs WHERE false"), /permission denied/);
    await db.query("RESET ROLE");

    await db.query("SET ROLE warthog_purge");
    await db.query("DELETE FROM users WHERE id = $1", [user.id]);
    await db.query("RESET ROLE");
    for (const table of ["agent_runs", "activity_entry_runs"]) {
      const left = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [user.id]);
      assert.equal(Number(left.rows[0]?.n), 0, `the purged account's ${table} are gone`);
    }
  } finally { await db.query("RESET ROLE"); await db.close(); }
});
