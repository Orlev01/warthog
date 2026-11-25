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
    // The person's "what agents see" level (0124), the same shape of setting.
    for (const sql of ["SELECT * FROM read_settings LIMIT 0", "INSERT INTO read_settings (user_id, level, updated_at) SELECT gen_random_uuid(), 'open', now() WHERE false", "UPDATE read_settings SET level = 'standard' WHERE false", "DELETE FROM read_settings WHERE false"]) {
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

// 23 Nov — the sign-in code tables and household invites are keyed by an address, outside the
// account cascade, so the purge deletes them by the person's address (review 2026-11-23, High).
// The purge role may find and delete those rows, and nothing more.
test("purge role can delete sign-in code and invite rows by address but cannot write them", async () => {
  const db = await freshDb();
  try {
    await db.query("SET ROLE warthog_purge");
    for (const table of ["email_codes", "email_code_attempts", "email_code_alerts", "household_invites"]) {
      await db.query(`DELETE FROM ${table} WHERE lower(btrim(email)) = lower(btrim($1))`, ["someone@example.com"]);
      await assert.rejects(db.query(`UPDATE ${table} SET email = email WHERE false`), /permission denied/, `${table}: no update`);
      await assert.rejects(db.query(`SELECT * FROM ${table} LIMIT 0`), /permission denied/, `${table}: only the address column is readable`);
    }
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

// 16 Nov — agent runs (docs/adr/agent-runs.md). The runtime role starts runs, reads them,
// marks one seen and (since 25 Nov) updates what the agent says it is working on; it can never
// rewrite whose a run is, when it started or how it came in. Entry links are append-only like
// the entries.
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
    // 25 Nov — status updates (docs/adr/agent-runs.md): the agent may change what it says the
    // conversation is working on; each change is also an entry in the hash-chained record.
    await db.query("UPDATE agent_runs SET label_ct = label_ct, label_changed_at = now() WHERE user_id = $1 AND id = $2", [user.id, run]);
    for (const column of ["agent_id = agent_id", "user_id = user_id", "started_at = now()", "via = via"]) {
      await assert.rejects(db.query(`UPDATE agent_runs SET ${column} WHERE false`), /permission denied/, column);
    }
    await assert.rejects(db.query("DELETE FROM agent_runs WHERE false"), /permission denied/);
    // The exact statements the application runs: resolveRun's UPDATE … RETURNING under the
    // column grant, and the writer's guarded INSERT … SELECT.
    const touched = await db.query("UPDATE agent_runs SET last_seen_at = GREATEST(last_seen_at, now()) WHERE user_id = $1 AND id = $2 AND agent_id = $3 RETURNING id, label_ct", [user.id, run, agentId]);
    assert.equal(touched.rows.length, 1);
    await db.query("INSERT INTO activity_entry_runs (user_id, entry_seq, run_id) SELECT $1, 1, id FROM agent_runs WHERE user_id = $1 AND id = $2::uuid", [user.id, run]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM activity_entry_runs WHERE user_id = $1", [user.id])).rows[0]!.n, 1);
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
