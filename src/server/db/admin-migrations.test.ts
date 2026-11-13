// Migrations 0110–0112 (docs/design/admin-portal.md §4): users.created_at is added and
// backfilled from the earliest factor or recovery-code instant an existing account holds;
// admin_sessions is revoked by the app session's deletion; the new indexes exist. These
// pin BEHAVIOUR against the real migration files run by the real runner, never the SQL text.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createDb, loadMigrations, runMigrations } from "./index";
import { freshDb } from "../../test/db";

test("0110 backfills created_at from the earliest factor an existing account holds, and defaults it for new rows", async () => {
  const db = await createDb("pglite:memory");
  try {
    const all = await loadMigrations();
    const before = all.filter((m) => m.name < "0110");
    const after = all.filter((m) => m.name >= "0110");
    assert.ok(before.length > 0 && after.length >= 3, "the migration set splits around 0110");
    await runMigrations(db, before);

    // Three pre-existing accounts: a passkey (older) plus a later authenticator, an
    // authenticator only, and a tombstone with nothing left to backfill from.
    const [{ id: both }] = (await db.query("INSERT INTO users (email, wrapped_dek) VALUES ('both@example.test', 'wrapped') RETURNING id")).rows as { id: string }[];
    const [{ id: totpOnly }] = (await db.query("INSERT INTO users (email, wrapped_dek) VALUES ('totp@example.test', 'wrapped') RETURNING id")).rows as { id: string }[];
    const [{ id: bare }] = (await db.query("INSERT INTO users (email, wrapped_dek) VALUES ('bare@example.test', '') RETURNING id")).rows as { id: string }[];
    await db.query("INSERT INTO passkeys (user_id, credential_id, public_key, counter, created_at) VALUES ($1, 'cred-1', 'pk', 0, '2026-11-01T10:00:00Z')", [both]);
    await db.query("INSERT INTO totp_secrets (user_id, secret_enc, created_at) VALUES ($1, 'enc', '2026-11-05T10:00:00Z')", [both]);
    await db.query("INSERT INTO recovery_codes (user_id, auth_hash, salt, created_at) VALUES ($1, 'h', 's', '2026-11-01T10:00:01Z')", [both]);
    await db.query("INSERT INTO totp_secrets (user_id, secret_enc, created_at) VALUES ($1, 'enc', '2026-11-07T08:30:00Z')", [totpOnly]);

    await runMigrations(db, after);

    const rows = (await db.query("SELECT id, created_at FROM users ORDER BY email")).rows as { id: string; created_at: Date | string | null }[];
    const byId = new Map(rows.map((r) => [r.id, r.created_at]));
    assert.equal(new Date(byId.get(both) as string).toISOString(), "2026-11-01T10:00:00.000Z", "the earliest instant wins");
    assert.equal(new Date(byId.get(totpOnly) as string).toISOString(), "2026-11-07T08:30:00.000Z", "LEAST ignores the absent factors");
    assert.equal(byId.get(bare), null, "nothing to backfill from stays null rather than inventing a date");

    const [{ created_at }] = (await db.query("INSERT INTO users (email, wrapped_dek) VALUES ('new@example.test', 'wrapped') RETURNING created_at")).rows as { created_at: Date | string | null }[];
    assert.ok(created_at != null && Number.isFinite(new Date(created_at as string).getTime()), "a new account gets a creation instant by default");
  } finally {
    await db.close();
  }
});

test("admin_sessions rows are revoked when their app session or account goes", async () => {
  const db = await freshDb();
  try {
    const [{ id: userId }] = (await db.query("INSERT INTO users (email, wrapped_dek, role) VALUES ('admin@example.test', 'wrapped', 'admin') RETURNING id")).rows as { id: string }[];
    const [{ id: sessionId }] = (await db.query(
      "INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at) VALUES ($1, 'hash-a', now(), now()) RETURNING id", [userId],
    )).rows as { id: string }[];
    await db.query(
      "INSERT INTO admin_sessions (session_id, user_id, handoff_hash, handoff_expires_at, created_at, last_seen_at) VALUES ($1, $2, 'h', now(), now(), now())",
      [sessionId, userId],
    );
    assert.equal(Number((await db.query("SELECT count(*)::int AS n FROM admin_sessions")).rows[0]!.n), 1);
    await db.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
    assert.equal(Number((await db.query("SELECT count(*)::int AS n FROM admin_sessions")).rows[0]!.n), 0, "deleting the app session cascades");
  } finally {
    await db.close();
  }
});

test("the range-scan indexes exist", async () => {
  const db = await freshDb();
  try {
    const names = (await db.query("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'")).rows.map((r) => r.indexname as string);
    for (const expected of ["metric_events_recorded_idx", "sessions_last_seen_idx", "activity_entries_occurred_idx", "users_created_idx", "admin_sessions_session_idx"]) {
      assert.ok(names.includes(expected), `${expected} is defined`);
    }
  } finally {
    await db.close();
  }
});
