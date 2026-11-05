// E12-S07 — Approval notifier (`src/server/notify/approval-notifier.ts`), design §10
// Notifications; brief NFR "WHEN an approval request is created, THE SYSTEM SHALL send
// a push notification to every device the person has registered within 5 seconds" and
// "IF a person has no registered push device … THEN … send one SMS … and one email …"
// (the fallback, armed at `created_at + fallback_delay`).
//
// RED-first: `./approval-notifier` does not exist yet, so importing `notifyApprovalCreated`
// throws and every test here fails until the builder writes the minimum code to pass.
// That absence IS the point of test-first; do NOT implement anything to make these pass —
// the builder writes `approval-notifier.ts` afterwards.
//
// These tests pin BEHAVIOUR (what the notifier DOES for a created approval: which devices
// it pushes to, what the push carries, that it schedules a fallback at created_at + the
// person's delay, and that it stays within member scope / parameter-binds its input),
// never the source text of any module — a later rename that preserves behaviour must not
// redden them. Everything the notifier touches is driven through ALREADY-BUILT, tested
// seams: the push-subscriptions store (`registerSubscription`), the notification-prefs
// store (`saveNotificationPrefs`), the users store (`createUser`) and the jobs queue
// (read back straight from the `jobs` table). The push sender is a spy, so "pushed vs not"
// and "what the payload carried" are observed directly. No network, no Azure.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // The push seam the notifier depends on — one device at a time, carrying ONLY the
//   // approval id (never personal content). Both the real VAPID Web Push sender
//   // (E12-S02 `createWebPushSender`, method `sendApprovalPush`) and a dev adapter over
//   // the process-wide outbox satisfy it; which one is wired is the composition root's
//   // job (selectSenders), not this module's.
//   interface ApprovalPushSender {
//     sendApprovalPush(subscription: PushDeviceSubscription, approvalId: string): Promise<void>;
//   }
//
//   interface NotifyApprovalCreatedDeps {
//     db: Db;                 // the parameterizing db seam (subscriptions / prefs / jobs)
//     clock: Clock;           // the current instant (active-subscription filtering)
//     push: ApprovalPushSender;  // the CONFIGURED push sender (dev outbox adapter in dev)
//   }
//
//   interface NotifyApprovalCreatedInput {
//     userId: string;         // the OWNING person (member scope) — from the session /
//                             // agent connection, NEVER a client value
//     approvalId: string;     // the just-created approval (the ONLY thing the push carries)
//     createdAt: Date | string;  // when the approval was created — the fallback is due
//                             // at createdAt + the person's delay (NOT clock.now())
//     dek: Uint8Array;        // the owner's data key, to decrypt their device subscriptions
//   }
//
//   notifyApprovalCreated(deps, input): Promise<void>
//     • pushes the approval id to EVERY one of the owner's active registered devices
//       through `deps.push`, and
//     • schedules ONE fallback job (payload carrying the approval id) due at
//       createdAt + the person's fallbackDelayMinutes (default 2), read from the
//       notification-prefs store.
//     • A push send failure does NOT derail it: the fallback is still scheduled and the
//       call resolves (the fallback IS the recovery — web-push.ts rejects a failed send
//       so a fallback channel can run).
//     • Malformed / oversized input is rejected with a 4xx BEFORE anything is sent or
//       scheduled; an injection-shaped (but well-formed) id is opaque data, bound as a
//       parameter.
//
// Acceptance criteria → tests:
//   AC1  pushes the approval id to EVERY registered device of the owner.
//   AC2  schedules a fallback at created_at + the person's delay (saved + default), and a
//        push failure still schedules it; with NO device registered, the fallback is still
//        scheduled (the brief's "no registered push device → SMS/email fallback").
//   AC3  the push payload carries ONLY the approval id — no personal content.
//   OBL  [validate-and-parameterize-input] a malformed/oversized id is rejected with a
//        4xx (nothing sent, nothing scheduled); an injection-shaped id is carried verbatim
//        as bound data and cannot alter a query; the device read is member-scoped (the
//        owner's devices only, never another person's).
//   OBL  [secrets-from-env] the notifier holds no secret and needs no ambient config — it
//        works from its injected db / clock / push seam + input alone.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { notifyApprovalCreated } from "./approval-notifier";
import type { PushDeviceSubscription } from "./web-push";
import { registerSubscription } from "../db/push-subscriptions";
import { saveNotificationPrefs } from "../db/notification-prefs";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import { fixedClock, type Clock } from "../seams/clock";
import type { Db } from "../db/index";

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const MINUTE_MS = 60_000;

// The frozen instant most tests read time through. Mid-month noon UTC, so the fallback
// due-time arithmetic is unambiguous.
const NOW = new Date("2026-11-15T12:00:00.000Z");

// Compare the MOMENT, not the representation: a stored timestamptz may come back as a
// Date or an ISO string — either is fine and must not redden a test.
const toMs = (value: unknown): number => new Date(value as string | number | Date).getTime();

// Create a person and return their id plus the data key their device subscriptions are
// encrypted under. The wrapped DEK handed to createUser is an opaque stand-in (createUser
// never reads it); the notifier is handed the raw `dek` directly, like the pipeline hands
// it the DEK it already unwrapped.
async function makePerson(db: Db, who: string): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return { userId: user.id, dek };
}

// Register one device for a person (endpoint + keys DEK-encrypted at rest by the store),
// returning the push-service endpoint so a test can prove which devices were pushed.
async function registerDevice(
  db: Db,
  userId: string,
  dek: Uint8Array,
  token: string,
  clock: Clock,
): Promise<string> {
  const endpoint = `https://push.example.com/send/${token}`;
  await registerSubscription(
    db,
    { userId, endpoint, keys: { p256dh: `p256dh-${token}`, auth: `auth-${token}` } },
    dek,
    clock,
  );
  return endpoint;
}

// A push-sender spy: records (endpoint, approvalId) for every send so "pushed vs not" and
// "what the payload carried" are observed directly. `fail: true` makes every send reject,
// standing in for a push service that is unreachable.
function spyPush(opts: { fail?: boolean } = {}) {
  const calls: { endpoint: string; approvalId: string }[] = [];
  const push = {
    async sendApprovalPush(
      subscription: PushDeviceSubscription,
      approvalId: string,
    ): Promise<void> {
      calls.push({ endpoint: subscription.endpoint, approvalId });
      if (opts.fail) throw new Error("push service unavailable");
    },
  };
  return { push, calls };
}

// Read back the fallback job(s) scheduled for one approval, matched by the approval id in
// the jsonb payload (bound as a parameter — the probe value never reaches the SQL text).
async function fallbackJobsFor(
  db: Db,
  approvalId: string,
): Promise<{ type: string; payload: Record<string, unknown>; runAt: unknown }[]> {
  const result = await db.query(
    "SELECT type, payload, run_at FROM jobs WHERE payload->>'approvalId' = $1",
    [approvalId],
  );
  return result.rows.map((row) => ({
    type: row.type as string,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    runAt: row.run_at,
  }));
}

// ===========================================================================
// AC1 — a push to EVERY registered device of the owner.
// ===========================================================================

test("pushes the approval id to every one of the owner's registered devices", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makePerson(db, "ac1-devices");
    const clock = fixedClock(NOW);
    const d1 = await registerDevice(db, userId, dek, "dev1", clock);
    const d2 = await registerDevice(db, userId, dek, "dev2", clock);
    const d3 = await registerDevice(db, userId, dek, "dev3", clock);

    const approvalId = randomUUID();
    const { push, calls } = spyPush();

    await notifyApprovalCreated({ db, clock, push }, { userId, approvalId, createdAt: NOW, dek });

    assert.equal(calls.length, 3, "one push per registered device");
    assert.deepEqual(
      new Set(calls.map((c) => c.endpoint)),
      new Set([d1, d2, d3]),
      "every registered device's endpoint was pushed, exactly once each",
    );
    for (const call of calls) {
      assert.equal(call.approvalId, approvalId, "each push carries the created approval's id");
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — the fallback job: scheduled at created_at + the person's delay, scheduled even
// when a push fails, and scheduled even when the person has no registered device.
// ===========================================================================

test("schedules exactly one fallback job due at created_at + the person's saved delay", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makePerson(db, "ac2-saved");
    const clock = fixedClock(NOW);
    await saveNotificationPrefs(db, { userId, emailFallback: true, fallbackDelayMinutes: 7 });
    await registerDevice(db, userId, dek, "d", clock);

    const approvalId = randomUUID();
    const { push } = spyPush();

    await notifyApprovalCreated({ db, clock, push }, { userId, approvalId, createdAt: NOW, dek });

    const jobs = await fallbackJobsFor(db, approvalId);
    assert.equal(jobs.length, 1, "exactly one fallback job is scheduled for the approval");
    const [job] = jobs;
    assert.ok(job);
    assert.equal(
      toMs(job.runAt),
      NOW.getTime() + 7 * MINUTE_MS,
      "the fallback is due at created_at + the person's 7-minute delay",
    );
    assert.equal(job.payload.approvalId, approvalId, "the fallback job carries the approval id");
    assert.equal(job.type, "approval.fallback", "the fallback job's type is the agreed contract");
  } finally {
    await db.close();
  }
});

test("falls back to the default 2-minute delay when the person has saved no preference", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makePerson(db, "ac2-default");
    const clock = fixedClock(NOW);
    await registerDevice(db, userId, dek, "d", clock);

    const approvalId = randomUUID();
    const { push } = spyPush();

    await notifyApprovalCreated({ db, clock, push }, { userId, approvalId, createdAt: NOW, dek });

    const jobs = await fallbackJobsFor(db, approvalId);
    assert.equal(jobs.length, 1);
    assert.equal(
      toMs(jobs[0]!.runAt),
      NOW.getTime() + 2 * MINUTE_MS,
      "with no saved preference the fallback uses the brief's default 2-minute delay",
    );
  } finally {
    await db.close();
  }
});

test("the fallback is due at created_at, not at the current clock instant", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makePerson(db, "ac2-createdat");
    // The clock is TEN MINUTES after the approval was created: if the notifier scheduled
    // from clock.now() instead of createdAt the due time would be wrong. The device never
    // expires, so the later clock does not filter it out of the active list.
    const createdAt = NOW;
    const clock = fixedClock(new Date(NOW.getTime() + 10 * MINUTE_MS));
    await registerDevice(db, userId, dek, "d", clock);

    const approvalId = randomUUID();
    const { push } = spyPush();

    await notifyApprovalCreated({ db, clock, push }, { userId, approvalId, createdAt, dek });

    const jobs = await fallbackJobsFor(db, approvalId);
    assert.equal(jobs.length, 1);
    assert.equal(
      toMs(jobs[0]!.runAt),
      createdAt.getTime() + 2 * MINUTE_MS,
      "the fallback is anchored to created_at + delay, not clock.now() + delay",
    );
  } finally {
    await db.close();
  }
});

test("a push failure still schedules the fallback (and does not reject)", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makePerson(db, "ac2-pushfail");
    const clock = fixedClock(NOW);
    await registerDevice(db, userId, dek, "d", clock);

    const approvalId = randomUUID();
    const { push, calls } = spyPush({ fail: true });

    // The send is attempted and fails — the notifier must recover, not blow up approval
    // creation: it still schedules the fallback and resolves.
    await notifyApprovalCreated({ db, clock, push }, { userId, approvalId, createdAt: NOW, dek });

    assert.ok(calls.length >= 1, "the push to the device was attempted");
    const jobs = await fallbackJobsFor(db, approvalId);
    assert.equal(jobs.length, 1, "a failed push still schedules the fallback");
    assert.equal(toMs(jobs[0]!.runAt), NOW.getTime() + 2 * MINUTE_MS);
  } finally {
    await db.close();
  }
});

test("with no registered device, sends no push but still schedules the fallback", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makePerson(db, "ac2-nodevice");
    const clock = fixedClock(NOW);

    const approvalId = randomUUID();
    const { push, calls } = spyPush();

    await notifyApprovalCreated({ db, clock, push }, { userId, approvalId, createdAt: NOW, dek });

    assert.equal(calls.length, 0, "no device registered ⇒ no push is sent");
    const jobs = await fallbackJobsFor(db, approvalId);
    assert.equal(jobs.length, 1, "the fallback is scheduled even with no registered device");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — the push payload carries ONLY the approval id (no personal content).
// ===========================================================================

test("the push carries only the approval id — no other content leaves in the payload", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makePerson(db, "ac3-payload");
    const clock = fixedClock(NOW);
    await registerDevice(db, userId, dek, "only-device", clock);

    // A plain opaque approval id. The notifier is handed ONLY this id — never the
    // approval's (personal) detail — so the only approval-derived value it can put in the
    // payload is the id itself.
    const approvalId = randomUUID();
    const { push, calls } = spyPush();

    await notifyApprovalCreated({ db, clock, push }, { userId, approvalId, createdAt: NOW, dek });

    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(call);
    // The only approval-derived value in the payload is the opaque id — never any
    // human-readable approval detail. The push seam's `(subscription, approvalId)` shape
    // leaves no slot for personal content, and the notifier never loads the detail.
    assert.equal(call.approvalId, approvalId, "the payload is exactly the approval id");
    assert.equal(typeof call.approvalId, "string");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// OBL [validate-and-parameterize-input] — a 4xx on malformed/oversized input (nothing
// sent, nothing scheduled); an injection-shaped id is opaque bound data; the device read
// is member-scoped.
// ===========================================================================

test("rejects an empty (malformed) approval id with a 4xx before sending or scheduling anything", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makePerson(db, "obl-empty");
    const clock = fixedClock(NOW);
    await registerDevice(db, userId, dek, "d", clock);
    const { push, calls } = spyPush();

    await assert.rejects(
      () => notifyApprovalCreated({ db, clock, push }, { userId, approvalId: "", createdAt: NOW, dek }),
      (err: unknown) => {
        const status = (err as { status?: number }).status;
        assert.equal(typeof status, "number", "the rejection carries an HTTP status");
        assert.ok(status! >= 400 && status! < 500, `malformed input is a 4xx, got ${status}`);
        return true;
      },
    );

    assert.equal(calls.length, 0, "a malformed id sends no push");
    const anyJobs = await db.query("SELECT type FROM jobs");
    assert.equal(anyJobs.rows.length, 0, "a malformed id schedules no fallback (validated first)");
  } finally {
    await db.close();
  }
});

test("rejects an oversized approval id with a 4xx before sending or scheduling anything", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makePerson(db, "obl-oversized");
    const clock = fixedClock(NOW);
    await registerDevice(db, userId, dek, "d", clock);
    const { push, calls } = spyPush();

    const oversized = "x".repeat(100_000); // far beyond any id length / the 4 KB push cap

    await assert.rejects(
      () =>
        notifyApprovalCreated({ db, clock, push }, { userId, approvalId: oversized, createdAt: NOW, dek }),
      (err: unknown) => {
        const status = (err as { status?: number }).status;
        assert.equal(typeof status, "number", "the rejection carries an HTTP status");
        assert.ok(status! >= 400 && status! < 500, `oversized input is a 4xx, got ${status}`);
        return true;
      },
    );

    assert.equal(calls.length, 0, "an oversized id sends no push");
    const anyJobs = await db.query("SELECT type FROM jobs");
    assert.equal(anyJobs.rows.length, 0, "an oversized id schedules no fallback (validated first)");
  } finally {
    await db.close();
  }
});

test("a SQL-injection-shaped approval id is carried verbatim as bound data; the jobs table is intact", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makePerson(db, "obl-injection");
    const clock = fixedClock(NOW);
    await registerDevice(db, userId, dek, "d", clock);

    // A well-formed (short, non-empty) but injection-shaped id. If it were spliced into
    // the SQL instead of bound, this would drop the jobs table; bound, it is stored and
    // compared as opaque data.
    const probe = "'); DROP TABLE jobs; --";
    const { push, calls } = spyPush();

    await notifyApprovalCreated({ db, clock, push }, { userId, approvalId: probe, createdAt: NOW, dek });

    // The jobs table still exists and holds the row — the probe did not alter the query.
    const jobs = await fallbackJobsFor(db, probe);
    assert.equal(jobs.length, 1, "the injection-shaped id is stored and matched as data");
    assert.equal(jobs[0]!.payload.approvalId, probe, "the fallback payload carries the id verbatim");
    // The push path received it verbatim too — opaque, alters nothing.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.approvalId, probe);
  } finally {
    await db.close();
  }
});

test("pushes only to the OWNER's devices — never another person's (member-scoped by userId)", async () => {
  const db = await freshDb();
  try {
    const owner = await makePerson(db, "obl-owner");
    const other = await makePerson(db, "obl-other");
    const clock = fixedClock(NOW);

    const ownerEndpoint = await registerDevice(db, owner.userId, owner.dek, "owner-dev", clock);
    const otherEndpoint = await registerDevice(db, other.userId, other.dek, "other-dev", clock);

    const approvalId = randomUUID();
    const { push, calls } = spyPush();

    await notifyApprovalCreated(
      { db, clock, push },
      { userId: owner.userId, approvalId, createdAt: NOW, dek: owner.dek },
    );

    const pushed = new Set(calls.map((c) => c.endpoint));
    assert.ok(pushed.has(ownerEndpoint), "the owner's device is pushed");
    assert.ok(!pushed.has(otherEndpoint), "another person's device is NEVER pushed");
    assert.equal(calls.length, 1, "only the owner's single device was pushed");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// OBL [secrets-from-env] — the notifier holds no secret and needs no ambient config.
// The ONE secret in the push path (the VAPID signing key) is read from injected config by
// the Web Push sender (enforced test-first in E12-S02, web-push.test.ts); the notifier
// merely USES whatever push sender it is handed. The behavioural manifestation here: it
// works purely from its injected db / clock / push seam + input — no config object, no env.
// ===========================================================================

test("notifies from injected deps alone: no secret and no ambient configuration are needed", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makePerson(db, "obl-secrets");
    const clock = fixedClock(NOW);
    await registerDevice(db, userId, dek, "d", clock);

    const approvalId = randomUUID();
    const { push, calls } = spyPush();

    // Only db / clock / push + the input — no VAPID key, no connection string, no env.
    await notifyApprovalCreated({ db, clock, push }, { userId, approvalId, createdAt: NOW, dek });

    assert.equal(calls.length, 1, "the push happened with no secret handed to the notifier");
    const jobs = await fallbackJobsFor(db, approvalId);
    assert.equal(jobs.length, 1, "the fallback was scheduled with no secret handed to the notifier");
  } finally {
    await db.close();
  }
});
