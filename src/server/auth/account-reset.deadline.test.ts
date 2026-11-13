import assert from "node:assert/strict";
import { test } from "node:test";

import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { claim } from "../db/jobs";
import { createOutbox } from "../notify/outbox";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import { issueEmailCode } from "./email-code";
import {
  completeAccountReset,
  getCompletedAccountReset,
  hasCompletedReset,
  requestAccountReset,
  REENROL_WINDOW_MS,
  RESET_WAIT_MS,
} from "./account-reset";

// Completion now alerts every channel; these tests are about the deadline, so the alerts
// land in a throwaway outbox.
function quietSenders() {
  const outbox = createOutbox();
  return { push: outbox, email: outbox, sms: outbox };
}

const START = new Date("2026-11-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

test("reset completion enforces the seven-day boundary and claims a due reset only once", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "reset-deadline@example.test", wrappedDek: "test-key" });
    await db.query("INSERT INTO account_resets (user_id, status, requested_at) VALUES ($1, 'pending', $2)",
      [user.id, START.toISOString()]);
    let erases = 0;
    let revokes = 0;
    const executor = {
      eraseVaultData: async () => { erases++; },
      revokeAgentsAndConnections: async () => { revokes++; },
    };
    const before = { executor, senders: quietSenders(), clock: fixedClock(new Date(START.getTime() + RESET_WAIT_MS - 1)) };
    assert.equal((await completeAccountReset(db, { userId: user.id }, before)).ok, false);
    assert.equal(erases, 0);
    assert.equal(revokes, 0);
    assert.equal((await db.query("SELECT status FROM account_resets WHERE user_id = $1", [user.id])).rows[0]?.status, "pending");

    const due = { executor, senders: quietSenders(), clock: fixedClock(new Date(START.getTime() + RESET_WAIT_MS)) };
    const outcomes = await Promise.all([
      completeAccountReset(db, { userId: user.id }, due),
      completeAccountReset(db, { userId: user.id }, due),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
    assert.equal(erases, 1);
    assert.equal(revokes, 1);
  } finally { await db.close(); }
});

test("an already-claimed older timer cannot complete a newly requested reset", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "reset-renewed@example.test", wrappedDek: "test-key" });
    const outbox = createOutbox();
    const hmacKey = new Uint8Array(32).fill(7);
    let erases = 0;
    const executor = { eraseVaultData: async () => { erases++; }, revokeAgentsAndConnections: async () => {} };
    const request = async (instant: Date) => {
      const clock = fixedClock(instant);
      await issueEmailCode(db, user.email, { purpose: "reset", clock, random: systemRandom, hmacKey, emailSender: outbox });
      const code = outbox.list().filter((message) => message.channel === "email").at(-1)?.body.match(/\b\d{6}\b/)?.[0];
      assert.ok(code);
      assert.deepEqual(await requestAccountReset(db, { email: user.email, code },
        { clock, hmacKey, senders: { email: outbox, sms: outbox, push: outbox } }), { ok: true });
    };
    await request(START);
    const originalDue = new Date(START.getTime() + RESET_WAIT_MS);
    const claimed = await claim(db, fixedClock(originalDue));
    assert.ok(claimed, "the old timer is already running before the new request");
    await request(originalDue);
    assert.equal((await db.query("SELECT status FROM jobs WHERE id = $1", [claimed.id])).rows[0]?.status, "claimed");

    assert.equal((await completeAccountReset(db, { userId: user.id },
      { executor, senders: quietSenders(), clock: fixedClock(originalDue) })).ok, false);
    assert.equal(erases, 0, "the superseded running timer cannot erase the vault");
    assert.equal((await db.query("SELECT status FROM account_resets WHERE user_id = $1", [user.id])).rows[0]?.status, "pending");

    assert.deepEqual(await completeAccountReset(db, { userId: user.id },
      { executor, senders: quietSenders(), clock: fixedClock(new Date(originalDue.getTime() + RESET_WAIT_MS)) }), { ok: true });
    assert.equal(erases, 1, "the new reset completes only after its own seven-day wait");
  } finally { await db.close(); }
});

test("failed alerts from a superseded request cannot cancel the newer reset or delete its timer", async () => {
  const db = await freshDb();
  let releaseAlerts: (() => void) | undefined;
  try {
    const user = await createUser(db, { email: "reset-alert-generation@example.test", wrappedDek: "test-key" });
    const outbox = createOutbox();
    const hmacKey = new Uint8Array(32).fill(7);
    async function resetCode(instant: Date): Promise<string> {
      await issueEmailCode(db, user.email, { purpose: "reset", clock: fixedClock(instant), random: systemRandom, hmacKey, emailSender: outbox });
      const code = outbox.list().filter(message => message.channel === "email").at(-1)?.body.match(/\b\d{6}\b/)?.[0];
      assert.ok(code);
      return code;
    }
    let alertsStarted!: () => void;
    const started = new Promise<void>(resolve => { alertsStarted = resolve; });
    const heldAlerts = new Promise<void>(resolve => { releaseAlerts = resolve; });
    const failAfterNewRequest = async () => {
      alertsStarted();
      await heldAlerts;
      throw new Error("synthetic alert failure");
    };
    const oldRequest = requestAccountReset(db, { email: user.email, code: await resetCode(START) }, {
      clock: fixedClock(START), hmacKey, senders: {
        push: { sendPush: failAfterNewRequest }, email: { sendEmail: failAfterNewRequest },
        sms: { enabled: false, sendSms: failAfterNewRequest },
      },
    });
    await started;
    const renewedAt = new Date(START.getTime() + 60_000);
    assert.deepEqual(await requestAccountReset(db, { email: user.email, code: await resetCode(renewedAt) }, {
      clock: fixedClock(renewedAt), hmacKey, senders: { push: outbox, email: outbox, sms: outbox },
    }), { ok: true });
    releaseAlerts();
    assert.deepEqual(await oldRequest, { ok: false, reason: "alert_failed" });
    const current = (await db.query("SELECT status, requested_at FROM account_resets WHERE user_id = $1", [user.id])).rows[0]!;
    assert.equal(current.status, "pending");
    assert.equal(new Date(current.requested_at as string).getTime(), renewedAt.getTime());
    const timers = (await db.query("SELECT run_at FROM jobs WHERE type = 'account_reset.complete' AND status = 'pending' AND payload->>'userId' = $1", [user.id])).rows;
    assert.equal(timers.length, 1);
    assert.equal(new Date(timers[0]!.run_at as string).getTime(), renewedAt.getTime() + RESET_WAIT_MS);
    let erases = 0;
    const executor = { eraseVaultData: async () => { erases++; }, revokeAgentsAndConnections: async () => {} };
    assert.equal((await completeAccountReset(db, { userId: user.id }, { executor, senders: quietSenders(),
      clock: fixedClock(new Date(START.getTime() + RESET_WAIT_MS)) })).ok, false);
    assert.equal(erases, 0);
  } finally { releaseAlerts?.(); await db.close(); }
});

// The re-enrolment window is measured from when the reset actually completed. A completion
// job that ran days late (an outage) still erased the vault, so the person still gets the
// full 7 days the completion alert promises, not whatever is left of them.
test("a reset completed late still leaves the full 7 days to re-enrol", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "reset-late@example.test", wrappedDek: "test-key" });
    await db.query("INSERT INTO account_resets (user_id, status, requested_at) VALUES ($1, 'pending', $2)",
      [user.id, START.toISOString()]);
    const executor = { eraseVaultData: async () => {}, revokeAgentsAndConnections: async () => {} };
    const late = new Date(START.getTime() + RESET_WAIT_MS + 10 * DAY_MS);
    assert.equal((await completeAccountReset(db, { userId: user.id }, { executor, senders: quietSenders(), clock: fixedClock(late) })).ok, true);

    assert.deepEqual(await getCompletedAccountReset(db, { userId: user.id }, { clock: fixedClock(late) }), {
      completedAt: late,
      reenrolUntil: new Date(late.getTime() + REENROL_WINDOW_MS),
    });
    const lastMoment = fixedClock(new Date(late.getTime() + REENROL_WINDOW_MS - 1));
    assert.equal(await hasCompletedReset(db, { userId: user.id }, { clock: lastMoment }), true);
    const after = fixedClock(new Date(late.getTime() + REENROL_WINDOW_MS));
    assert.equal(await hasCompletedReset(db, { userId: user.id }, { clock: after }), false);
  } finally { await db.close(); }
});
