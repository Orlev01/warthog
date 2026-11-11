// E14-S09 — Life-admin reminders job (`src/server/life-admin/reminders-job.ts`);
// brief §"Life admin": "reminders by notification before due dates (default 14 days
// and 1 day before, adjustable per record)"; constitution principle 13 (reminders are
// deterministic code, no AI) and the project hard rule (nothing personal leaks into a
// notification). The timer that fires each record's due-date reminders exactly once
// without leaking personal content.
//
// RED-first: `./reminders-job` does not exist yet, so importing `runLifeAdminReminders`
// throws at load and every test here fails until the builder writes the module. That
// absence IS the point of test-first; do NOT implement anything to make these pass — the
// builder writes `reminders-job.ts` afterwards to this contract.
//
// These tests pin BEHAVIOUR (what the job DOES when run: which reminders it pushes and to
// whom, that each fired offset is marked sent so a second run is silent, that the message
// carries only a reference and no personal content, that it stays within each owner's
// scope, and that its queries bind every value), never the source text of any module — a
// later rename that preserves behaviour must not redden them. The clock is the injected
// seam (never Date.now()); the push channel is an injected fake (conventions: "external
// services sit behind interfaces with fakes; tests never touch the network"). The job's
// reads/writes run against the REAL store (`../db/life-admin-records`) over an in-memory
// PGlite with the real migrations (`../../test/db`), so idempotency and member-scoping are
// exercised end to end.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface LifeAdminRemindersDeps {   // injected seams — this module reads no process.env
//     db: Db;             // the parameterizing data seam (listDueForReminder / markReminderSent)
//     clock: Clock;       // the current instant — "due" is computed from it, never Date.now()
//     push: PushSender;   // the CONFIGURED push channel (the dev outbox in dev, the real Web
//                         //   Push sender in prod — which is wired is the composition root's
//                         //   job, not this module's). Carries ONLY a reference, no personal content.
//   }
//
//   runLifeAdminReminders(deps): Promise<void>
//     • Reads EVERY person's due, unsent reminders (`listDueForReminder` — metadata only, no
//       DEK: it never decrypts a field) and, for each (record, offset) now due:
//         – sends ONE push to the record's OWNER through `deps.push` carrying a REFERENCE to
//           the record (the record id — an opaque value the app resolves after sign-in) and
//           NO personal content; then
//         – marks that offset sent (`markReminderSent`) so it never fires again.
//     • Defaults to 14 days and 1 day before the due date, but a record's own reminder offsets
//       override the defaults (the offsets live on the record, so the job honours whatever it finds).
//     • Idempotent: a second run over the same records the same day sends nothing more, because
//       every fired offset is already marked sent and drops out of the due set.
//     • Member scope: each reminder reaches the record's OWNER (carried on the due reminder),
//       never another person — the job reads across people but routes each one to its owner.
//
// Acceptance criteria → tests:
//   AC1 a record 14 days (then 1 day) before its due date triggers ONE reminder each to the
//       owner via the configured push sender; per-record custom offsets override the defaults.
//   AC2 a second run the same day over the same records sends nothing more (idempotent) — each
//       fired offset is marked sent.
//   AC3 the reminder payload carries no personal content — only a reference the app resolves.
//   OBL [validate-and-parameterize-input] (INV-102) — a handler on the `../http/validate`
//       boundary rejects malformed / oversized / mis-shaped input with a 4xx BEFORE the sweep
//       runs; and the job's own queries BIND every value (the record id, the clock instant), so
//       a SQL-injection-shaped record cannot alter a query — the table survives and the reminder
//       still fires. The handler below is a TEST FIXTURE (the intended usage of a cron trigger),
//       not an implementation file.
//   OBL [secrets-from-env] (INV-103) — the job runs purely from its injected db / clock / push,
//       reads no `process.env`, and folds no ambient env secret into any notification it emits.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db test
// uses its own `freshDb()` (an isolated in-memory PGlite), so the parallel test files share no
// state. "Absence" assertions are scoped narrowly to the one surface under test (a reminder's
// NOTIFICATION outputs), never the whole database, since the same value may legitimately live
// (encrypted) elsewhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import { runLifeAdminReminders } from "./reminders-job";
import { createRecord, listRecordsForUser, updateRecord, type RecordKind } from "../db/life-admin-records";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";
import type { OutgoingMessage, PushSender } from "../notify/senders";
import type { Db, QueryResult } from "../db/index";

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// A fixed instant the single-phase tests read time through. Mirrors the store's own
// reminder tests: dates below keep ≥ 2-day margins from the relevant clock instant so no
// driver/timezone date-boundary rounding can flip a due/not-due decision.
const NOW = new Date("2026-11-10T12:00:00Z");

// A fresh random 256-bit DEK (the job never sees a DEK; this is only to create records).
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque base64; never read here).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id plus the DEK their record fields are encrypted under.
async function makePerson(db: Db, who: string): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = freshDek();
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return { userId: user.id, dek };
}

// A clock whose "now" the test controls: `set` jumps it to an instant, so a reminder that
// becomes due at a later date can be fired deterministically without touching the wall clock.
function mutableClock(start: Date): { clock: Clock; set(at: Date): void } {
  let current = start.getTime();
  return {
    clock: {
      now(): Date {
        return new Date(current);
      },
    },
    set(at: Date): void {
      current = at.getTime();
    },
  };
}

// A recording push channel: records every notification so a test can count them and scan
// their contents. Satisfies the PushSender shape the job depends on.
function recordingPush(): { sender: PushSender; sent: OutgoingMessage[] } {
  const sent: OutgoingMessage[] = [];
  return {
    sender: {
      async sendPush(message: OutgoingMessage): Promise<void> {
        sent.push(message);
      },
    },
    sent,
  };
}

// The full, scannable text of one notification — recipient, body and link together, so an
// "absence" scan covers everywhere a value could ride.
function messageBlob(m: OutgoingMessage): string {
  return `${m.recipient}\n${m.body}\n${m.link ?? ""}\n${JSON.stringify(m)}`;
}

test("reminder links select the record's life-admin tab and anchor", async () => {
  const db = await freshDb();
  try {
    const person = await makePerson(db, "reminder-link");
    const tabs: Record<RecordKind, string> = {
      subscription: "subscriptions", receipt_warranty: "receipts", renewal_appointment: "renewals",
    };
    const push = recordingPush();
    for (const kind of Object.keys(tabs) as RecordKind[]) {
      const record = await createRecord(db, {
        userId: person.userId, kind, fields: { name: "Private reminder" },
        dueDate: "2026-11-20", status: "active", source: { kind: "person" },
      }, person.dek);
      await runLifeAdminReminders({ db, clock: fixedClock(NOW), push: push.sender });
      const url = new URL(push.sent.at(-1)!.link!, "https://warthog.test");
      assert.equal(url.pathname, "/life-admin");
      assert.equal(url.searchParams.get("view"), "life");
      assert.equal(url.searchParams.get("tab"), tabs[kind]);
      assert.equal(url.hash, `#record-${record.id}`);
    }
  } finally { await db.close(); }
});

test("legacy overflowing offsets cannot break other due reminders", async () => {
  const db = await freshDb();
  try {
    const person = await makePerson(db, "reminder-overflow");
    const record = await createRecord(db, {
      userId: person.userId, kind: "subscription", fields: subscriptionFields(),
      dueDate: "2026-11-20", status: "active", source: { kind: "person" },
    }, person.dek);
    await db.query("UPDATE life_admin_records SET reminder_offsets = $2::int[] WHERE id = $1", [record.id, [2147483647, 14, -1]]);
    const push = recordingPush();
    await runLifeAdminReminders({ db, clock: fixedClock(NOW), push: push.sender });
    assert.equal(push.sent.length, 1, "a legacy invalid offset is skipped while valid reminders still send");
    assert.deepEqual(await sentOffsetsOf(db, person.userId, person.dek, record.id), [14]);
  } finally { await db.close(); }
});

test("duplicate configured reminder offsets produce one notification per offset", async () => {
  const db = await freshDb();
  try {
    const person = await makePerson(db, "reminder-duplicate-offset");
    const record = await createRecord(db, {
      userId: person.userId, kind: "subscription", fields: subscriptionFields(),
      dueDate: "2026-11-20", reminderOffsets: [14, 14, 1], status: "active", source: { kind: "person" },
    }, person.dek);
    const push = recordingPush();
    await runLifeAdminReminders({ db, clock: fixedClock(NOW), push: push.sender });
    assert.equal(push.sent.length, 1);
    assert.deepEqual(await sentOffsetsOf(db, person.userId, person.dek, record.id), [14]);
  } finally { await db.close(); }
});

test("a reminder completing after rescheduling does not mark the new due-date cycle sent", async () => {
  const db = await freshDb();
  try {
    const person = await makePerson(db, "reminder-reschedule");
    const record = await createRecord(db, {
      userId: person.userId, kind: "subscription", fields: subscriptionFields(),
      dueDate: "2026-11-20", status: "active", source: { kind: "person" },
    }, person.dek);
    await runLifeAdminReminders({ db, clock: fixedClock(NOW), push: {
      async sendPush() {
        await updateRecord(db, { id: record.id, userId: person.userId, fields: subscriptionFields(),
          dueDate: "2027-11-20", status: "active" }, person.dek);
      },
    } });
    assert.deepEqual(await sentOffsetsOf(db, person.userId, person.dek, record.id), []);
    const push = recordingPush();
    await runLifeAdminReminders({ db, clock: fixedClock(new Date("2027-11-10T12:00:00Z")), push: push.sender });
    assert.equal(push.sent.length, 1, "the new cycle still receives its 14-day reminder");
  } finally { await db.close(); }
});

test("a reminder completing after its offset is removed does not reintroduce a sent marker", async () => {
  const db = await freshDb();
  try {
    const person = await makePerson(db, "reminder-offset-change");
    const record = await createRecord(db, {
      userId: person.userId, kind: "subscription", fields: subscriptionFields(),
      dueDate: "2026-11-20", status: "active", source: { kind: "person" },
    }, person.dek);
    await runLifeAdminReminders({ db, clock: fixedClock(NOW), push: {
      async sendPush() {
        await updateRecord(db, { id: record.id, userId: person.userId, fields: subscriptionFields(),
          dueDate: "2026-11-20", reminderOffsets: [1], status: "custom status" }, person.dek);
      },
    } });
    assert.deepEqual(await sentOffsetsOf(db, person.userId, person.dek, record.id), []);
    const push = recordingPush();
    await runLifeAdminReminders({ db, clock: fixedClock(new Date("2026-11-19T12:00:00Z")), push: push.sender });
    assert.equal(push.sent.length, 1, "the remaining offset still sends with an arbitrary status");
    assert.deepEqual(await sentOffsetsOf(db, person.userId, person.dek, record.id), [1]);
  } finally { await db.close(); }
});

// Convenience builder for a subscription record's content (free-text so it round-trips
// exactly through JSON). The content is DEK-encrypted; the metadata (dueDate/offsets) is not.
function subscriptionFields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { service: "Netflix", cost: "15.99", billingCycle: "monthly", ...over };
}

// Read back one record's sent-markers (plaintext metadata) under its owner's DEK.
async function sentOffsetsOf(db: Db, userId: string, dek: Uint8Array, recordId: string): Promise<number[]> {
  const records = await listRecordsForUser(db, userId, dek);
  const record = records.find((r) => r.id === recordId);
  assert.ok(record, "the record exists for the sent-offset read");
  return [...record!.sentOffsets].sort((a, b) => a - b);
}

// A non-delegating recording db: records every (text, values) and returns no rows, so a test
// can prove WHAT reached the query layer without a real database. Satisfies `Db` structurally.
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []): Promise<QueryResult> {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] });
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

// A recording wrapper over a REAL db: records each (text, values) and delegates, so a test can
// prove HOW the job's real queries reached the query layer (bound value vs. spliced text).
function recordingDelegatingDb(real: Db): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []): Promise<QueryResult> {
      calls.push({ text, values });
      return real.query(text, values);
    },
    close(): Promise<void> {
      return real.close();
    },
  };
}

// Whether a relation of this exact name exists — a non-throwing probe scoped to the one table
// under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// ===========================================================================
// AC1 — a record 14 days (then 1 day) before its due date triggers ONE reminder each, to the
// owner, through the configured push sender; the earlier offset is never fired twice.
// ===========================================================================

test("fires the 14-day reminder, then the 1-day reminder — one each, to the owner, never twice", async () => {
  const db = await freshDb();
  try {
    const mc = mutableClock(new Date("2026-11-10T12:00:00Z"));
    const { userId, dek } = await makePerson(db, "ac1");

    // dueDate 2026-11-20, default offsets [14, 1]:
    //   offset 14 → reminder date 2026-11-06   offset 1 → reminder date 2026-11-19
    const saved = await createRecord(
      db,
      { userId, kind: "subscription", fields: subscriptionFields(), dueDate: "2026-11-20", status: "active", source: { kind: "person" } },
      dek,
    );

    const push = recordingPush();

    // Phase 1 — the 14-day window (now 2026-11-10): only the 14-day reminder is due.
    mc.set(new Date("2026-11-10T12:00:00Z"));
    await runLifeAdminReminders({ db, clock: mc.clock, push: push.sender });

    assert.equal(push.sent.length, 1, "exactly one reminder fires at the 14-day mark");
    assert.equal(push.sent[0]!.recipient, userId, "the reminder is addressed to the record's owner");
    assert.ok((push.sent[0]!.body ?? "").length > 0, "the reminder carries a message body");
    assert.ok(messageBlob(push.sent[0]!).includes(saved.id), "the reminder carries a reference to the record");
    assert.deepEqual(await sentOffsetsOf(db, userId, dek, saved.id), [14], "the 14-day offset is marked sent");

    // Phase 2 — the 1-day window (now 2026-11-21, one day past due): the 1-day reminder is now
    // due; the 14-day reminder is already sent and must NOT fire again.
    mc.set(new Date("2026-11-21T12:00:00Z"));
    await runLifeAdminReminders({ db, clock: mc.clock, push: push.sender });

    assert.equal(push.sent.length, 2, "exactly one more reminder fires at the 1-day mark (the 14-day one is not re-sent)");
    assert.equal(push.sent[1]!.recipient, userId, "the second reminder also reaches the owner");
    assert.ok(messageBlob(push.sent[1]!).includes(saved.id), "the second reminder also references the record");
    assert.deepEqual(await sentOffsetsOf(db, userId, dek, saved.id), [1, 14], "both offsets are now marked sent");
  } finally {
    await db.close();
  }
});

test("a record with NO due date is never reminded", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makePerson(db, "ac1-nodate");
    await createRecord(
      db,
      { userId, kind: "subscription", fields: subscriptionFields({ service: "NoDate" }), dueDate: null, status: "active", source: { kind: "person" } },
      dek,
    );

    const push = recordingPush();
    await runLifeAdminReminders({ db, clock: fixedClock(NOW), push: push.sender });

    assert.equal(push.sent.length, 0, "a record with no due date produces no reminder");
  } finally {
    await db.close();
  }
});

test("a record whose reminders are all still in the future produces nothing yet", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makePerson(db, "ac1-future");
    // dueDate 2026-12-15, offsets [14,1] → earliest reminder 2026-12-01, well after NOW (2026-11-10).
    await createRecord(
      db,
      { userId, kind: "subscription", fields: subscriptionFields({ service: "Future" }), dueDate: "2026-12-15", status: "active", source: { kind: "person" } },
      dek,
    );

    const push = recordingPush();
    await runLifeAdminReminders({ db, clock: fixedClock(NOW), push: push.sender });

    assert.equal(push.sent.length, 0, "no reminder fires before the earliest offset is due");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — per-record custom offsets OVERRIDE the defaults.
// ===========================================================================

test("per-record custom offsets override the 14/1 defaults", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(new Date("2026-11-22T12:00:00Z"));
    const custom = await makePerson(db, "ac1-custom");
    const standard = await makePerson(db, "ac1-standard");

    // CUSTOM: dueDate 2026-12-20, offsets [30, 7] → offset 30's reminder date is 2026-11-20
    // (DUE on 2026-11-22, margin 2); offset 7 → 2026-12-13 (not yet).
    const customRecord = await createRecord(
      db,
      { userId: custom.userId, kind: "renewal_appointment", fields: { what: "Passport renewal", where: "Post office" }, dueDate: "2026-12-20", reminderOffsets: [30, 7], status: "upcoming", source: { kind: "person" } },
      custom.dek,
    );

    // STANDARD: same dueDate 2026-12-20 but DEFAULT offsets [14, 1] → earliest reminder
    // 2026-12-06, NOT due on 2026-11-22. If the job wrongly applied the defaults to the custom
    // record, it would be silent on 2026-11-22; if it wrongly applied 30 to the standard record,
    // the standard one would fire. Exactly one push, for the custom record, proves the override.
    const standardRecord = await createRecord(
      db,
      { userId: standard.userId, kind: "renewal_appointment", fields: { what: "Rego", where: "Service NSW" }, dueDate: "2026-12-20", status: "upcoming", source: { kind: "person" } },
      standard.dek,
    );

    const push = recordingPush();
    await runLifeAdminReminders({ db, clock, push: push.sender });

    assert.equal(push.sent.length, 1, "only the custom-offset record's 30-day reminder is due on this day");
    assert.equal(push.sent[0]!.recipient, custom.userId, "the reminder goes to the custom record's owner");
    assert.ok(messageBlob(push.sent[0]!).includes(customRecord.id), "the reminder references the custom record");

    assert.deepEqual(await sentOffsetsOf(db, custom.userId, custom.dek, customRecord.id), [30], "the custom 30-day offset fired (not a default)");
    assert.deepEqual(await sentOffsetsOf(db, standard.userId, standard.dek, standardRecord.id), [], "the default-offset record has fired nothing yet");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — idempotent: a second run the same day over the same records sends nothing more.
// ===========================================================================

test("idempotent: a second run over the same records the same day sends nothing more", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "ac2");
    // dueDate 2026-11-20 → offset 14 is due on NOW (2026-11-10), offset 1 is not.
    const saved = await createRecord(
      db,
      { userId, kind: "subscription", fields: subscriptionFields(), dueDate: "2026-11-20", status: "active", source: { kind: "person" } },
      dek,
    );

    const push = recordingPush();

    await runLifeAdminReminders({ db, clock, push: push.sender });
    assert.equal(push.sent.length, 1, "the first run fires the due reminder once");
    assert.deepEqual(await sentOffsetsOf(db, userId, dek, saved.id), [14], "the offset is marked sent after the first run");

    // Same clock, same records, nothing opened or changed: the second run must be silent.
    await runLifeAdminReminders({ db, clock, push: push.sender });
    assert.equal(push.sent.length, 1, "a second run the same day sends no additional reminder");
    assert.deepEqual(await sentOffsetsOf(db, userId, dek, saved.id), [14], "the sent-marker is not duplicated");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Member scope — the job reads across people but routes each reminder to its OWNER.
// ===========================================================================

test("delivers each reminder only to the record's owner — never another person", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const alice = await makePerson(db, "sec-alice");
    const bob = await makePerson(db, "sec-bob");

    // Both have a record whose 14-day reminder is due on NOW.
    const aliceRecord = await createRecord(
      db,
      { userId: alice.userId, kind: "subscription", fields: subscriptionFields({ service: "Alice sub" }), dueDate: "2026-11-20", status: "active", source: { kind: "person" } },
      alice.dek,
    );
    const bobRecord = await createRecord(
      db,
      { userId: bob.userId, kind: "renewal_appointment", fields: { what: "Bob rego", where: "x" }, dueDate: "2026-11-20", status: "active", source: { kind: "person" } },
      bob.dek,
    );

    const push = recordingPush();
    await runLifeAdminReminders({ db, clock, push: push.sender });

    assert.equal(push.sent.length, 2, "both owners' due reminders fire (the job reads across people)");

    const toAlice = push.sent.filter((m) => m.recipient === alice.userId);
    const toBob = push.sent.filter((m) => m.recipient === bob.userId);
    assert.equal(toAlice.length, 1, "Alice gets exactly her own reminder");
    assert.equal(toBob.length, 1, "Bob gets exactly his own reminder");
    assert.ok(messageBlob(toAlice[0]!).includes(aliceRecord.id), "Alice's reminder references Alice's record");
    assert.ok(!messageBlob(toAlice[0]!).includes(bobRecord.id), "Alice's reminder never references Bob's record");
    assert.ok(messageBlob(toBob[0]!).includes(bobRecord.id), "Bob's reminder references Bob's record");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — the reminder payload carries NO personal content: only a reference the app resolves
// after sign-in. The job reads metadata only (it never decrypts a field), so field content
// cannot leak into a message. Scoped to the notification outputs only.
// ===========================================================================

test("the reminder carries a reference but no personal content (the encrypted field never leaks)", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "ac3");

    // A unique, recognizable secret buried in the record's (DEK-encrypted) fields. If the job
    // ever surfaced the detail, this would appear in a message body or link.
    const secret = `SECRET_subscription_detail_${randomUUID()}`;
    const saved = await createRecord(
      db,
      {
        userId,
        kind: "subscription",
        fields: subscriptionFields({ service: secret, howToCancel: `cancel-at ${secret}` }),
        dueDate: "2026-11-20",
        status: "active",
        source: { kind: "person" },
      },
      dek,
    );

    const push = recordingPush();
    await runLifeAdminReminders({ db, clock, push: push.sender });

    assert.ok(push.sent.length >= 1, "a reminder was sent (so the leak scan is meaningful)");
    for (const message of push.sent) {
      assert.ok(!messageBlob(message).includes(secret), "no personal field content appears in the reminder");
    }
    // The positive half: the message carries a reference (the record id) the app resolves.
    assert.ok(messageBlob(push.sent[0]!).includes(saved.id), "the reminder carries a reference to the record");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// OBL [validate-and-parameterize-input] (INV-102) — a handler on the `../http/validate`
// boundary rejects malformed / oversized / mis-shaped input with a 4xx BEFORE the sweep runs.
//
// The handler below is a TEST FIXTURE that exercises the real validation boundary and this
// task's `runLifeAdminReminders` — the intended usage of a "run the reminders sweep now" cron
// trigger, not an implementation file. The sweep takes no per-record input (it is global), so
// the trigger body is empty; a malformed / oversized / unexpected body is refused before the
// sweep touches the db or the push channel.
// ===========================================================================

function remindersTriggerHandler(deps: {
  db: Db;
  clock: Clock;
  push: PushSender;
}): (req: Request) => Promise<Response> {
  const schema = z.object({}).strict();
  return async (req: Request): Promise<Response> => {
    try {
      await parseBody(schema, req, { maxBytes: 8 * 1024 });
      await runLifeAdminReminders(deps);
      return new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test sees
      // the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/jobs/life-admin-reminders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the trigger handler rejects malformed JSON with a 4xx and never runs the sweep", async () => {
  const db = recordingDb();
  const push = recordingPush();
  const handler = remindersTriggerHandler({ db, clock: fixedClock(NOW), push: push.sender });

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
  assert.equal(push.sent.length, 0, "malformed input must never send a reminder");
});

test("the trigger handler rejects an oversized body with a 4xx and never runs the sweep", async () => {
  const db = recordingDb();
  const push = recordingPush();
  const handler = remindersTriggerHandler({ db, clock: fixedClock(NOW), push: push.sender });

  // ~20 KiB body, well over the handler's 8 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ filler: "a".repeat(20 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
  assert.equal(push.sent.length, 0, "an oversized body must never send a reminder");
});

test("the trigger handler rejects an unexpected body field with a 4xx and never runs the sweep", async () => {
  const db = recordingDb();
  const push = recordingPush();
  const handler = remindersTriggerHandler({ db, clock: fixedClock(NOW), push: push.sender });

  // The sweep is global — it takes no client-supplied record target. A smuggled field is refused.
  const res = await handler(jsonRequest(JSON.stringify({ recordId: "x'); DROP TABLE life_admin_records; --" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-shaped body must never reach a query");
  assert.equal(push.sent.length, 0, "a mis-shaped body must never send a reminder");
});

test("the trigger handler accepts a well-formed (empty) body and runs the sweep", async () => {
  const db = recordingDb();
  const push = recordingPush();
  const handler = remindersTriggerHandler({ db, clock: fixedClock(NOW), push: push.sender });

  const res = await handler(jsonRequest("{}"));

  assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
  // The recording db has no due reminders (it returns no rows), so nothing is pushed — but the
  // sweep DID run: it issued its due-reminder read, proving the handler drives the job.
  assert.ok(db.calls.length >= 1, "a valid trigger runs the sweep (its due-reminder read reaches the db)");
});

// ===========================================================================
// OBL [validate-and-parameterize-input] (INV-102) — the job's own queries BIND every value, so a
// record carrying a SQL-injection-shaped status/field is swept without altering a query: the
// record id and the clock instant travel as bound values, no injected statement is ever spliced
// into the SQL, the table survives, and the reminder still fires and is marked sent.
// ===========================================================================

test("a SQL-injection-shaped record is swept with everything bound — no query is altered, the table survives", async () => {
  const real = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(real, "obl-inject");

    const statusProbe = "active'); DROP TABLE life_admin_records; --"; // plaintext metadata, bound as a value
    const fieldProbe = "Buy milk'); DROP TABLE life_admin_records; --"; // lands in the DEK-encrypted fields blob
    const saved = await createRecord(
      real,
      { userId, kind: "subscription", fields: subscriptionFields({ service: fieldProbe }), dueDate: "2026-11-20", status: statusProbe, source: { kind: "person" } },
      dek,
    );

    const rec = recordingDelegatingDb(real);
    const push = recordingPush();
    await runLifeAdminReminders({ db: rec, clock, push: push.sender });

    // The reminder still fired and was marked sent — the probe did not derail the sweep.
    assert.equal(push.sent.length, 1, "the due reminder still fires for a record carrying a probe");
    assert.deepEqual(await sentOffsetsOf(real, userId, dek, saved.id), [14], "the offset is marked sent");

    // The sweep's queries BIND their values and splice nothing: the record id reaches
    // markReminderSent as a bound parameter, the clock instant is bound on the read, and no
    // injected statement ever appears in the SQL text.
    assert.ok(rec.calls.length >= 1, "the sweep issued at least one query");
    assert.ok(
      rec.calls.some((c) => c.values.some((v) => v === saved.id)),
      "the record id travels as a BOUND value (markReminderSent is parameterized)",
    );
    assert.ok(
      rec.calls.some((c) => c.values.some((v) => v instanceof Date)),
      "the clock instant travels as a BOUND value on the due-reminder read",
    );
    for (const call of rec.calls) {
      assert.ok(!call.text.toUpperCase().includes("DROP TABLE"), "no injected statement appears in the SQL text");
      assert.ok(!call.text.includes(statusProbe), "the status probe is never spliced into the SQL text");
      assert.ok(!call.text.includes(saved.id), "the record id is bound, never concatenated into the SQL");
    }

    // The table survived the probe (it was stored as data, never executed).
    assert.equal(await tableExists(real, "life_admin_records"), true, "the life_admin_records table is intact");
  } finally {
    await real.close();
  }
});

// ===========================================================================
// OBL [secrets-from-env] (INV-103) — the job runs purely from its injected db / clock / push and
// folds no ambient env secret into any notification it emits. Shown behaviourally: a decoy secret
// planted in the environment appears in no reminder the job produces.
// ===========================================================================

test("no ambient env secret reaches a reminder — the job runs from injected deps only", async () => {
  const DECOY = "env-decoy-SECRET-must-never-be-used";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const { userId, dek } = await makePerson(db, "obl-secrets");
    await createRecord(
      db,
      { userId, kind: "subscription", fields: subscriptionFields(), dueDate: "2026-11-20", status: "active", source: { kind: "person" } },
      dek,
    );

    // Only db / clock / push — no connection string, no config, no env.
    const push = recordingPush();
    await runLifeAdminReminders({ db, clock, push: push.sender });

    assert.ok(push.sent.length >= 1, "a reminder was sent with no secret handed to the job (so the scan is meaningful)");
    for (const message of push.sent) {
      assert.ok(!messageBlob(message).includes(DECOY), "no ambient env secret appears in any reminder");
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===========================================================================
// One undeliverable reminder never blocks the rest (review finding: a push that threw ended
// the sweep, so that reminder — first again every hour — stopped every later reminder for
// everyone, silently).
// ===========================================================================

test("a reminder whose push fails is retried next sweep, and every other due reminder still goes", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(new Date("2026-11-10T12:00:00Z"));
    const alice = await makePerson(db, "hol-alice");
    const bob = await makePerson(db, "hol-bob");
    const record = (userId: string, dek: Uint8Array, dueDate: string) =>
      createRecord(
        db,
        { userId, kind: "subscription", fields: subscriptionFields(), dueDate, status: "active", source: { kind: "person" } },
        dek,
      );
    // Alice's reminder is due first, so the sweep reaches it before Bob's.
    const aliceRecord = await record(alice.userId, alice.dek, "2026-11-19");
    const bobRecord = await record(bob.userId, bob.dek, "2026-11-20");

    // Alice's push channel is broken this sweep; Bob's is fine.
    const sent: OutgoingMessage[] = [];
    let aliceBroken = true;
    const push: PushSender = {
      async sendPush(message: OutgoingMessage): Promise<void> {
        if (aliceBroken && message.recipient === alice.userId) throw new Error("push subscription gone");
        sent.push(message);
      },
    };

    await assert.rejects(runLifeAdminReminders({ db, clock, push }), "the failure is surfaced, not swallowed");
    assert.deepEqual(sent.map((m) => m.recipient), [bob.userId], "Bob's reminder still went");
    assert.deepEqual(await sentOffsetsOf(db, bob.userId, bob.dek, bobRecord.id), [14]);
    assert.deepEqual(await sentOffsetsOf(db, alice.userId, alice.dek, aliceRecord.id), [], "Alice's is not marked sent");

    aliceBroken = false;
    await runLifeAdminReminders({ db, clock, push });
    assert.deepEqual(sent.map((m) => m.recipient), [bob.userId, alice.userId], "Alice's reminder goes on the next sweep");
    assert.deepEqual(await sentOffsetsOf(db, alice.userId, alice.dek, aliceRecord.id), [14]);
  } finally {
    await db.close();
  }
});
