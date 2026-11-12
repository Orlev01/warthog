import assert from "node:assert/strict";
import { test } from "node:test";
import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { createInMemoryBlobStore } from "../storage/blob";
import { prepareIsolatedRestore } from "./restore";

const now = new Date("2026-11-12T03:00:00.000Z");
const point = new Date("2026-11-11T00:00:00.000Z");
const snapshot = (id: string) => ({ coverageFrom: "2026-11-10T00:00:00.000Z",
  capturedAt: now.toISOString(), retentionDays: 42, records: [
    { version: 1 as const, userId: id, event: "requested" as const, at: "2026-11-12T01:00:00.000Z" },
    { version: 1 as const, userId: id, event: "completed" as const, at: "2026-11-12T01:01:00.000Z" },
  ] });

test("a restored deleted account is removed; surviving data remains but credentials are invalidated", async () => {
  const db = await freshDb();
  try {
    const deleted = await createUser(db, { email: "deleted@example.test", wrappedDek: "historical-key" });
    const survivor = await createUser(db, { email: "survivor@example.test", wrappedDek: "retained-key" });
    await db.query("INSERT INTO passkeys (user_id,credential_id,public_key,counter) VALUES ($1,'old-passkey','synthetic',0)", [survivor.id]);
    await db.query("INSERT INTO vault_unlock_methods (user_id,method,wrapped_key) VALUES ($1,'passphrase','old-envelope')", [survivor.id]);
    const result = await prepareIsolatedRestore({ db, blobs: createInMemoryBlobStore(), snapshot: snapshot(deleted.id), restorePoint: point, now });
    assert.deepEqual(result, { deletedAccounts: 1, deletedReceiptBlobs: 0, requiresCredentialReenrollment: true, trafficMayOpen: false });
    assert.equal((await db.query("SELECT id FROM users WHERE id = $1", [deleted.id])).rows.length, 0);
    assert.equal((await db.query("SELECT wrapped_dek FROM users WHERE id = $1", [survivor.id])).rows[0]?.wrapped_dek, "retained-key");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM passkeys")).rows[0]?.n, 0);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM vault_unlock_methods")).rows[0]?.n, 0);
    assert.equal((await prepareIsolatedRestore({ db, blobs: createInMemoryBlobStore(), snapshot: snapshot(deleted.id), restorePoint: point, now })).deletedAccounts, 0);
  } finally { await db.close(); }
});

test("ambiguous deletion evidence prevents every database and blob operation", async () => {
  let touched = false;
  const id = "11111111-1111-4111-8111-111111111111";
  const data = snapshot(id); data.records.pop();
  await assert.rejects(prepareIsolatedRestore({
    db: { async query() { touched = true; throw new Error("must not touch database"); }, async close() {} },
    blobs: { async put() { touched = true; }, async get() { touched = true; return null; }, async delete() { touched = true; } },
    snapshot: data, restorePoint: point, now,
  }), /Unresolved deletion intent/);
  assert.equal(touched, false);
});

test("committed deletions already in the snapshot are purged even without a journal event", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "queued@example.test", wrappedDek: "" });
    await db.query("INSERT INTO account_purge_queue (user_id) VALUES ($1)", [user.id]);
    const evidence = { ...snapshot(user.id), records: [] };
    const result = await prepareIsolatedRestore({ db, blobs: createInMemoryBlobStore(), snapshot: evidence, restorePoint: point, now });
    assert.equal(result.deletedAccounts, 1);
    assert.equal((await db.query("SELECT id FROM users")).rows.length, 0);
  } finally { await db.close(); }
});

test("an inconsistent restored purge queue fails before any destructive action", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "inconsistent@example.test", wrappedDek: "still-live" });
    await db.query("INSERT INTO account_purge_queue (user_id) VALUES ($1)", [user.id]);
    await assert.rejects(prepareIsolatedRestore({ db, blobs: createInMemoryBlobStore(), snapshot: { ...snapshot(user.id), records: [] }, restorePoint: point, now }), /inconsistent deletion/);
    assert.equal((await db.query("SELECT wrapped_dek FROM users")).rows[0]?.wrapped_dek, "still-live");
  } finally { await db.close(); }
});

test("historical household ownership requires reconciliation instead of deleting others' shared resources", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "former-owner@example.test", wrappedDek: "historical-key" });
    await db.query("INSERT INTO households (owner_id,currency) VALUES ($1,'AUD')", [user.id]);
    await assert.rejects(prepareIsolatedRestore({ db, blobs: createInMemoryBlobStore(), snapshot: snapshot(user.id), restorePoint: point, now }), /household ownership/);
    assert.equal((await db.query("SELECT wrapped_dek FROM users WHERE id = $1", [user.id])).rows[0]?.wrapped_dek, "historical-key");
  } finally { await db.close(); }
});
