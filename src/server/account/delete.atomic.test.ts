import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { createApproval } from "../db/approvals";
import { enqueue } from "../db/jobs";
import { withTransaction, type Db } from "../db/index";
import { createSession } from "../auth/session";
import { completeAccountReset, RESET_WAIT_MS } from "../auth/account-reset";
import { createOutbox } from "../notify/outbox";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import { createReleaseStore } from "../crypto/release-store";
import { deleteAccount } from "./delete";
import { createResetExecutor } from "./reset-executor";
import { runAccountPurge } from "./purge-job";
import { enqueueAccountPurge } from "../db/account-purge";

const clock = fixedClock(new Date("2026-11-09T00:00:00Z"));

test("deletion journal failure precedes every durable revocation", async () => {
  const db = await freshDb();
  try {
    const { userId } = await fixture(db);
    const before = await snapshot(db, userId);
    const outbox = createOutbox();
    await assert.rejects(deleteAccount({ db, revoker: createResetExecutor(db),
      senders: { email: outbox, sms: outbox, push: outbox },
      journal: { async requested() { throw new Error("journal unavailable"); }, async completed() { assert.fail(); } },
    }, { userId }), /journal unavailable/);
    assert.deepEqual(await snapshot(db, userId), before);
    assert.equal(outbox.list().length, 0);
  } finally { await db.close(); }
});

test("completion follows commit and a failed completion is retried before purge", async () => {
  const db = await freshDb();
  try {
    const { userId } = await fixture(db);
    const outbox = createOutbox();
    const events: string[] = [];
    let available = false;
    const journal = {
      async requested(id: string) { assert.equal(id, userId); events.push("requested"); },
      async completed(id: string) {
        assert.equal(id, userId);
        assert.equal((await snapshot(db, id)).wrappedDek, "");
        events.push("completed");
        if (!available) throw new Error("journal unavailable");
      },
    };
    assert.deepEqual(await deleteAccount({ db, revoker: createResetExecutor(db),
      senders: { email: outbox, sms: outbox, push: outbox }, journal }, { userId }), { ok: true });
    assert.deepEqual(events, ["requested", "completed"]);
    const blobStore = { async put() {}, async get() { return null; }, async delete() { assert.fail("no receipts in fixture"); } };
    await assert.rejects(runAccountPurge(db, { blobStore, journal }), /could not be purged/);
    assert.equal((await db.query("SELECT id FROM users WHERE id = $1", [userId])).rows.length, 1);
    available = true;
    assert.deepEqual(await runAccountPurge(db, { blobStore, journal }), { purged: [userId] });
  } finally { await db.close(); }
});

async function fixture(db: Db) {
  const user = await createUser(db, { email: `${randomUUID()}@example.test`, wrappedDek: "wrapped-key" });
  const connectionId = randomUUID();
  const agent = await createAgent(db, { userId: user.id, connectionId, displayName: "Test", platform: "test" }, clock);
  const approval = await createApproval(db, { userId: user.id, agentId: agent.id, detail: {} }, new Uint8Array(32), clock);
  await createSession(db, user.id, { clock, random: systemRandom });
  await db.query("INSERT INTO oauth_tokens (token_hash, connection_id, kind, expires_at) VALUES ($1,$2,'access',$3)",
    [randomUUID(), connectionId, "2027-01-01T00:00:00Z"]);
  await db.query("INSERT INTO oauth_access_keys (key_hash, connection_id) VALUES ($1,$2)", [randomUUID(), connectionId]);
  await db.query(`INSERT INTO oauth_auth_codes (code_hash, connection_id, client_id, code_challenge, redirect_uri, resource, expires_at)
    VALUES ($1,$2,'test','challenge','https://example.test/callback','https://example.test/mcp',$3)`,
    [randomUUID(), connectionId, "2027-01-01T00:00:00Z"]);
  await enqueue(db, { type: "account_reset.complete", payload: { userId: user.id }, runAt: clock.now() });
  await enqueue(db, { type: "approval.fallback", payload: { approvalId: approval.id }, runAt: clock.now() });
  await enqueue(db, { type: "unrelated", payload: { userId: "another-person" }, runAt: clock.now() });
  return { userId: user.id, connectionId, approvalId: approval.id };
}

async function snapshot(db: Db, userId: string) {
  const user = await db.query("SELECT wrapped_dek FROM users WHERE id = $1", [userId]);
  const counts: Record<string, number> = {};
  for (const table of ["sessions", "oauth_tokens", "oauth_auth_codes", "oauth_access_keys", "account_purge_queue", "jobs"]) {
    counts[table] = Number((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n);
  }
  return { wrappedDek: user.rows[0]?.wrapped_dek, counts,
    status: (await db.query("SELECT status FROM agents WHERE user_id = $1", [userId])).rows[0]?.status };
}

for (const failedStatement of [
  "UPDATE users SET wrapped_dek", "DELETE FROM oauth_tokens", "DELETE FROM oauth_auth_codes",
  "DELETE FROM oauth_access_keys", "UPDATE agents SET status", "DELETE FROM connections",
  "DELETE FROM sessions", "DELETE FROM jobs", "INSERT INTO account_purge_queue", "COMMIT",
]) {
  test(`account deletion rolls back every durable change when ${failedStatement} fails`, async () => {
    const real = await freshDb();
    try {
      const { userId, connectionId, approvalId } = await fixture(real);
      const before = await snapshot(real, userId);
      const outbox = createOutbox();
      const releases = createReleaseStore(clock);
      const key = `${userId}:${connectionId}:${approvalId}`;
      releases.put(key, "private release");
      let injected = false;
      const db: Db = {
        async query(text, values) {
          if (text.includes(failedStatement)) { injected = true; throw new Error("synthetic storage failure"); }
          return real.query(text, values);
        },
        close: () => real.close(),
      };
      await assert.rejects(deleteAccount({ db, revoker: createResetExecutor(db),
        senders: { email: outbox, sms: outbox, push: outbox }, releases }, { userId }), /synthetic storage failure/);
      assert.ok(injected);
      assert.deepEqual(await snapshot(real, userId), before);
      assert.equal(releases.collect(key), "private release", "rollback preserves in-memory releases");
      assert.equal(outbox.list().length, 0, "no confirmation precedes commit");
    } finally { await real.close(); }
  });
}

test("deletion uses one pinned transaction, then clears only that person's releases and jobs", async () => {
  const real = await freshDb();
  try {
    const { userId, connectionId, approvalId } = await fixture(real);
    const outbox = createOutbox();
    const releases = createReleaseStore(clock);
    const key = `${userId}:${connectionId}:${approvalId}`;
    releases.put(key, "private release");
    releases.put(`other:${connectionId}:${approvalId}`, "keep");
    let transactions = 0;
    const db: Db = {
      query: async () => { throw new Error("query escaped pinned transaction"); },
      transaction: async (fn) => { transactions++; return withTransaction(real, fn); },
      close: () => real.close(),
    };
    assert.deepEqual(await deleteAccount({ db, revoker: createResetExecutor(db),
      senders: { email: outbox, sms: outbox, push: outbox }, releases }, { userId }), { ok: true });
    assert.equal(transactions, 1);
    assert.deepEqual(await snapshot(real, userId), { wrappedDek: "", status: "disconnected",
      counts: { sessions: 0, oauth_tokens: 0, oauth_auth_codes: 0, oauth_access_keys: 0, account_purge_queue: 1, jobs: 1 } });
    assert.equal(releases.collect(key), undefined);
    assert.equal(releases.collect(`other:${connectionId}:${approvalId}`), "keep");
    assert.equal(outbox.list().length, 1);
  } finally { await real.close(); }
});

test("purge removes legacy user/approval job payloads before their ownership rows disappear", async () => {
  const db = await freshDb();
  try {
    const { userId } = await fixture(db);
    await enqueueAccountPurge(db, userId);
    await db.query("SET ROLE warthog_purge");
    await assert.rejects(db.query("UPDATE users SET email = email WHERE false"), /permission denied/,
      "the row-lock privilege must not grant general user updates");
    await runAccountPurge(db, { blobStore: { put: async () => {}, get: async () => new Uint8Array(), delete: async () => {} } });
    const jobs = await db.query("SELECT payload FROM jobs");
    assert.deepEqual(jobs.rows.map((row) => row.payload), [{ userId: "another-person" }]);
  } finally { await db.close(); }
});

for (const fails of [false, true]) {
  test(`account reset ${fails ? "retains releases on rollback" : "discards releases only after commit"}`, async () => {
    const real = await freshDb();
    try {
      const { userId, connectionId, approvalId } = await fixture(real);
      await real.query("INSERT INTO account_resets (user_id, status, requested_at) VALUES ($1,'pending',$2)",
        [userId, clock.now().toISOString()]);
      const releases = createReleaseStore(clock);
      const key = `${userId}:${connectionId}:${approvalId}`;
      releases.put(key, "private release");
      const db: Db = { query: (text, values) => {
        if (fails && text.includes("UPDATE agents SET status")) return Promise.reject(new Error("synthetic reset failure"));
        return real.query(text, values);
      }, close: () => real.close() };
      const completion = completeAccountReset(db, { userId }, { executor: createResetExecutor(db), releases, clock: fixedClock(new Date(clock.now().getTime() + RESET_WAIT_MS)) });
      if (fails) await assert.rejects(completion, /synthetic reset failure/);
      else assert.deepEqual(await completion, { ok: true });
      assert.equal(releases.collect(key), fails ? "private release" : undefined);
      assert.equal((await real.query("SELECT status FROM account_resets WHERE user_id = $1", [userId])).rows[0]?.status,
        fails ? "pending" : "done");
      assert.equal((await real.query("SELECT wrapped_dek FROM users WHERE id = $1", [userId])).rows[0]?.wrapped_dek,
        "wrapped-key", "reset preserves the account data key");
    } finally { await real.close(); }
  });
}
