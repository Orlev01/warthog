// E17-S06 — Daily integrity-check job with metrics (`src/server/activity/integrity-job.ts`).
//
// RED-first: the `./integrity-job` module does NOT exist yet, so importing
// `runDailyIntegrityCheck` throws and this whole suite fails until the builder writes it.
// That absence IS the point of test-first — do NOT implement anything to make these pass;
// the builder writes the job afterwards. Every seam this job stands on already exists: the
// per-account check (`./integrity` E08-S02 `checkIntegrity`), the guarded metrics recorder
// (`../metrics/record` E17-S02 `recordMetricEvent`) read back through E17-S01's store
// (`../db/metrics` `queryMetrics`), the notification senders bundle (`../notify/senders`
// `Senders`, satisfied in dev/test by the `../notify/outbox` recorder), the writer that
// builds real hash chains (`./writer` `createDbRecorder`), the clock seam and the
// `../http/validate` boundary.
//
// These tests pin BEHAVIOUR (what RUNNING the job DOES: it runs each account's integrity
// check, records a pass/fail COUNT metric with no content, and messages a person by push
// AND email — never SMS — only when their record FAILS). They read every effect back
// through the real seams — the metric store (`queryMetrics` / the `metric_events` rows) and
// an injected recording senders bundle — so no test asserts on the source text of any
// module: a later behaviour-preserving refactor (a rename, a moved import, a different SQL
// shape) stays green.
//
// WHY this exists (task E17-S06): the brief requires a daily automatic integrity check that
// alerts a person ONLY IF their tamper-evident record breaks and records the pass/fail count
// in operational metrics. This job performs both: it is the scheduled worker that sweeps
// every account, and it is the single place the integrity pass/fail numbers enter metrics.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface DailyIntegrityCheckDeps {
//     readonly db: Db;          // the parameterizing db seam (INV-102)
//     readonly clock: Clock;    // every recorded metric is stamped from here, never Date.now()
//     readonly senders: Senders;// the configured channel bundle; only .push and .email are used
//   }
//
//   runDailyIntegrityCheck(deps: DailyIntegrityCheckDeps): Promise<void>
//     • Sweeps EVERY account and runs the per-account `checkIntegrity(db, userId)` on each.
//     • Records a PASS/FAIL COUNT metric — the metric name "integrity.check" with the
//       allowlisted `outcome` dimension — exactly TWICE per run: one { outcome: "pass" }
//       row whose value is how many accounts verified intact, and one { outcome: "fail" }
//       row whose value is how many failed. BOTH are recorded every run even at 0, so the
//       time series is continuous (as E17-S05 records households.total at 0). A metric is
//       structurally only a count plus that short non-personal label — it carries NO content
//       (constitution principle 19). It is an APPEND log: a second run appends a second pair.
//     • For each account whose record FAILS: sends ONE push (`senders.push.sendPush`) AND
//       ONE email (`senders.email.sendEmail`) addressed to THAT person (recipient = the
//       person's email on file). It sends NO SMS (push and email ONLY). The message body
//       carries no personal content and no secret — never the activity payload.
//     • For each account whose record PASSES: sends nothing on any channel.
//     • Reads no `process.env` and holds no secret (INV-103): it runs purely from its
//       injected db + clock + senders. Every value it writes travels BOUND (INV-102).
//
// Acceptance criteria → tests:
//   AC1 "The job runs the per-account integrity check across accounts and records a pass/fail
//        count metric with no content." — a seeded world of passing + failing accounts is
//        swept; the pass count and fail count read back through queryMetrics with the right
//        values keyed by outcome; both counts are recorded even when one is 0; each is stamped
//        from the injected clock; a second run appends; and no personal value reaches any metric
//        cell (scoped to metric_events, the unit under test).
//   AC2 "An account whose record fails the check triggers a push and an email to that person."
//        + "An account whose record passes triggers no notification." — the failing person gets
//        exactly one push and one email addressed to them and NO SMS; the passing people get
//        nothing; a wholly-passing world sends nothing at all.
//   AC3 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / extra-field input with a
//        4xx BEFORE any query; an injection-shaped field never reaches a query and the tables
//        survive; and every value the job writes travels BOUND (never spliced into SQL). The
//        handler below is a test FIXTURE (the intended usage), not an implementation file.
//   AC4 [obligation:secrets-from-env] (INV-103) — the job reads no `process.env`: a decoy
//        secret planted in the environment never lands in a recorded metric or a notification.
//
// Each real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations, including E17-S01's metrics schema) and closes it in a `finally`, so tests share
// no state. Tests never touch the network or Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { runDailyIntegrityCheck } from "./integrity-job";
import { createDbRecorder } from "./writer";
import { createUser } from "../db/users";
import { queryMetrics, type MetricEvent } from "../db/metrics";
import { createOutbox, type SentMessage } from "../notify/outbox";
import type { Senders } from "../notify/senders";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";
import { freshDb } from "../../test/db";
import type { Db, QueryResult } from "../db/index";

// --- constants --------------------------------------------------------------------

// A fixed snapshot instant: every recorded metric must be stamped from THIS clock, never
// Date.now(). The whole-day window brackets it for queryMetrics read-backs.
const AT = "2026-11-21T03:00:00.000Z";
const CLOCK: Clock = fixedClock(new Date(AT));
const DAY_FROM = "2026-11-21T00:00:00.000Z";
const DAY_TO = "2026-11-21T23:59:59.999Z";

// A separate, earlier instant for building the activity chains' occurred_at — a clean
// whole-ms UTC instant so a timestamptz round-trip reproduces the string the chain hashed.
const T0 = new Date("2026-01-01T00:00:00.000Z");

// The pinned metric contract: ONE name, a pass/fail COUNT split by the allowlisted outcome
// dimension (the tester's choice; the builder conforms, as E17-S05 pins "users.total" etc.).
const INTEGRITY_CHECK = "integrity.check";
const OUTCOME_PASS = "pass";
const OUTCOME_FAIL = "fail";

// A distinctive marker woven into every seeded email, so any fragment surfacing in a metric
// cell (or a notification BODY) is a genuine personal-content leak, not a coincidence.
const MARKER = "PERSONALTOKEN";

// The injection probe reused across the parameterize tests.
const INJECTION = "boom'); DROP TABLE metric_events; --";

// A short, safe dimension label (alphanumeric first char, then up to 63 of
// alphanumerics/_/./-): the shape a non-personal dimension must take. Prose (spaces), an
// email (`@`) and most sentences fail it, so a value matching it cannot be a message/identity.
const DIMENSION_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,63}$/;

// --- fixtures ---------------------------------------------------------------------

// A db seam stand-in that records every call instead of running it, so a test can prove a
// REJECTED request issues NO query at all. Returns no rows; satisfies `Db` structurally.
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []): Promise<QueryResult> {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// A pass-through proxy over a real db that captures text + values, so a test can prove each
// value the job writes travelled BOUND (in values) and was never concatenated into the SQL.
interface RecordingProxy extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingProxy(real: Db): RecordingProxy {
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

// A recording senders bundle: the real dev/test outbox (a tested dumb recorder) wired to all
// three channels, so every push / email / sms the job sends is captured with its channel. A
// FRESH outbox per test (not the process singleton), so tests share no state.
interface RecordingSenders extends Senders {
  list(): readonly SentMessage[];
}
function recordingSenders(): RecordingSenders {
  const ob = createOutbox();
  return { push: ob, email: ob, sms: ob, list: () => ob.list() };
}

// Messages sent on one channel.
function onChannel(sent: readonly SentMessage[], channel: SentMessage["channel"]): SentMessage[] {
  return sent.filter((m) => m.channel === channel);
}

// Whether a relation of this exact name exists on this handle (a non-throwing probe scoped to
// the one table under test — behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Row count of a known, tester-controlled table name (never caller input), for "nothing was
// written / nothing was destroyed" assertions.
async function countRows(db: Db, table: string): Promise<number> {
  const result = await db.query(`SELECT count(*)::int AS n FROM ${table}`);
  return result.rows[0]!.n as number;
}

// The same instant regardless of whether the store returns an ISO string or a Date.
function sameInstant(a: unknown, b: string): boolean {
  return new Date(a as string | number | Date).getTime() === new Date(b).getTime();
}

// The integrity.check rows for one outcome, read back through the real store.
function byOutcome(events: MetricEvent[], outcome: string): MetricEvent[] {
  return events.filter((e) => e.outcome === outcome);
}

// Write a sound, writer-built hash chain of `n` entries for one user (genuinely chained over
// ciphertext — exactly what a correct checkIntegrity reports intact). One DEK per user; the
// job never decrypts, so the key is irrelevant to the check.
async function buildSoundChain(db: Db, userId: string, n: number): Promise<void> {
  const dek = randomBytes(32);
  const recorder = createDbRecorder({ db, clock: fixedClock(T0), dekFor: async () => dek });
  for (let i = 1; i <= n; i += 1) {
    await recorder.record({ userId, kind: "tool_call", source: "warthog", payload: { n: i } });
  }
}

// Seed a deterministic world of accounts and return their emails plus the personal tokens that
// must never surface in a metric. One account is tampered (its record FAILS); two verify
// intact (one with a sound chain, one with no entries — a vacuously sound chain).
async function seedWorld(db: Db): Promise<{
  failEmail: string;
  passEmails: string[];
  personal: string[];
  expected: { pass: number; fail: number };
}> {
  const personal: string[] = [];

  // The FAILING account: a sound chain of 3, then a hashed field of entry 2 tampered via
  // direct SQL so the stored entry_hash no longer recomputes — checkIntegrity reports broken.
  const fail = await createUser(db, { email: `fail-${MARKER}@warthog.com.au`, wrappedDek: "wrapped-dek-opaque" });
  personal.push(fail.id, fail.email);
  await buildSoundChain(db, fail.id, 3);
  await db.query("UPDATE activity_entries SET kind = $2 WHERE user_id = $1 AND seq = $3", [fail.id, "tampered", 2]);

  // A PASSING account with a sound chain of 2.
  const pass1 = await createUser(db, { email: `pass1-${MARKER}@warthog.com.au`, wrappedDek: "wrapped-dek-opaque" });
  personal.push(pass1.id, pass1.email);
  await buildSoundChain(db, pass1.id, 2);

  // A PASSING account with NO entries — a vacuously sound chain (still swept, still counted).
  const pass2 = await createUser(db, { email: `pass2-${MARKER}@warthog.com.au`, wrappedDek: "wrapped-dek-opaque" });
  personal.push(pass2.id, pass2.email);

  return {
    failEmail: fail.email,
    passEmails: [pass1.email, pass2.email],
    personal,
    expected: { pass: 2, fail: 1 },
  };
}

// ===========================================================================
// AC1 — the job sweeps every account, runs the per-account check, and records a pass/fail
// COUNT metric (read back through the real store).
// ===========================================================================

test("records the pass count and the fail count of the per-account checks, keyed by outcome", async () => {
  const db = await freshDb();
  try {
    const { expected } = await seedWorld(db);
    await runDailyIntegrityCheck({ db, clock: CLOCK, senders: recordingSenders() });

    const events = await queryMetrics(db, { name: INTEGRITY_CHECK, from: DAY_FROM, to: DAY_TO });

    const passRows = byOutcome(events, OUTCOME_PASS);
    assert.equal(passRows.length, 1, "exactly one pass-count row is recorded per run");
    assert.equal(typeof passRows[0]!.value, "number", "the pass count is a number, not a numeric string");
    assert.equal(passRows[0]!.value, expected.pass, "the pass count equals the accounts that verified intact");

    const failRows = byOutcome(events, OUTCOME_FAIL);
    assert.equal(failRows.length, 1, "exactly one fail-count row is recorded per run");
    assert.equal(failRows[0]!.value, expected.fail, "the fail count equals the accounts whose record was broken");

    // The counts sum to the number of accounts swept — every account was checked exactly once.
    assert.equal(
      passRows[0]!.value + failRows[0]!.value,
      expected.pass + expected.fail,
      "pass + fail covers every account (each checked once, none double-counted)",
    );
  } finally {
    await db.close();
  }
});

test("records a fail count of 0 when every account passes — a continuous point-in-time count", async () => {
  const db = await freshDb();
  try {
    // Two accounts, both sound: the fail-count row is still emitted (reading 0), so the time
    // series has a data point every run.
    const a = await createUser(db, { email: `ok1-${MARKER}@warthog.com.au`, wrappedDek: "wrapped-dek-opaque" });
    const b = await createUser(db, { email: `ok2-${MARKER}@warthog.com.au`, wrappedDek: "wrapped-dek-opaque" });
    await buildSoundChain(db, a.id, 2);
    await buildSoundChain(db, b.id, 1);

    await runDailyIntegrityCheck({ db, clock: CLOCK, senders: recordingSenders() });

    const events = await queryMetrics(db, { name: INTEGRITY_CHECK, from: DAY_FROM, to: DAY_TO });

    const passRows = byOutcome(events, OUTCOME_PASS);
    assert.equal(passRows.length, 1, "the pass count is recorded");
    assert.equal(passRows[0]!.value, 2, "both accounts passed");

    const failRows = byOutcome(events, OUTCOME_FAIL);
    assert.equal(failRows.length, 1, "the fail count is recorded even with no failures");
    assert.equal(failRows[0]!.value, 0, "the fail count reads 0, not absent");
  } finally {
    await db.close();
  }
});

test("stamps every recorded integrity metric with the INJECTED clock instant, not wall-clock time", async () => {
  const db = await freshDb();
  try {
    await seedWorld(db);
    await runDailyIntegrityCheck({ db, clock: CLOCK, senders: recordingSenders() });

    const all = await db.query("SELECT recorded_at FROM metric_events");
    assert.ok(all.rows.length > 0, "the job recorded at least one metric");
    for (const row of all.rows) {
      assert.ok(sameInstant(row.recorded_at, AT), "each integrity metric is stamped with the clock's instant");
    }
  } finally {
    await db.close();
  }
});

test("the metric is an APPEND — running twice records two pass rows and two fail rows", async () => {
  const db = await freshDb();
  try {
    const { expected } = await seedWorld(db);
    await runDailyIntegrityCheck({ db, clock: CLOCK, senders: recordingSenders() });
    await runDailyIntegrityCheck({ db, clock: CLOCK, senders: recordingSenders() });

    const events = await queryMetrics(db, { name: INTEGRITY_CHECK, from: DAY_FROM, to: DAY_TO });

    const passRows = byOutcome(events, OUTCOME_PASS);
    assert.equal(passRows.length, 2, "each run appends its own pass count (an append log, not an upsert)");
    for (const e of passRows) assert.equal(e.value, expected.pass, "each appended pass count carries the same value");

    const failRows = byOutcome(events, OUTCOME_FAIL);
    assert.equal(failRows.length, 2, "each run appends its own fail count");
    for (const e of failRows) assert.equal(e.value, expected.fail, "each appended fail count carries the same value");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 (no content) — the recorded metrics carry only counts and the short outcome label,
// never any user identity. Scoped to metric_events (the unit under test): the same ids/emails
// legitimately live in users/activity rows, so a whole-database scan would overreach.
// ===========================================================================

test("no user id, email or personal marker appears in any recorded integrity metric", async () => {
  const db = await freshDb();
  try {
    const { personal } = await seedWorld(db);
    await runDailyIntegrityCheck({ db, clock: CLOCK, senders: recordingSenders() });

    const all = await db.query("SELECT * FROM metric_events");
    assert.ok(all.rows.length > 0, "the job recorded metrics to scan");

    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell !== "string") continue;
        assert.ok(!cell.includes(MARKER), "no fragment of a seeded email reached a metric cell");
        for (const token of personal) {
          assert.ok(!cell.includes(token), `no seeded identity (${token.slice(0, 8)}…) reached a metric cell`);
        }
      }
    }
  } finally {
    await db.close();
  }
});

test("every recorded integrity metric carries only a finite count and a short non-personal label", async () => {
  const db = await freshDb();
  try {
    await seedWorld(db);
    await runDailyIntegrityCheck({ db, clock: CLOCK, senders: recordingSenders() });

    const all = await db.query(
      "SELECT name, value, platform, connector_id, outcome, error_category FROM metric_events",
    );
    assert.ok(all.rows.length > 0, "the job recorded metrics to inspect");

    for (const row of all.rows) {
      const value = Number(row.value);
      assert.ok(Number.isFinite(value), "every recorded metric value is a finite number (a count)");
      assert.ok(value >= 0, "a count is never negative");

      for (const col of ["platform", "connector_id", "outcome", "error_category"] as const) {
        const dim = row[col];
        if (dim == null) continue;
        assert.equal(typeof dim, "string", `the ${col} dimension is a string label`);
        assert.ok(DIMENSION_LABEL.test(dim as string), `the ${col} dimension "${String(dim)}" is a short non-personal label`);
      }
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a failing account triggers a push AND an email to that person (and no SMS); a passing
// account triggers no notification.
// ===========================================================================

test("a failing account is messaged by push and email to that person, and never by SMS", async () => {
  const db = await freshDb();
  try {
    const { failEmail, passEmails } = await seedWorld(db);
    const senders = recordingSenders();
    await runDailyIntegrityCheck({ db, clock: CLOCK, senders });

    const sent = senders.list();
    const pushes = onChannel(sent, "push");
    const emails = onChannel(sent, "email");
    const texts = onChannel(sent, "sms");

    assert.equal(pushes.length, 1, "exactly one push is sent (one failing account)");
    assert.equal(emails.length, 1, "exactly one email is sent (one failing account)");
    assert.equal(texts.length, 0, "no SMS is sent — the job notifies by push and email ONLY");

    assert.equal(emails[0]!.recipient, failEmail, "the email is addressed to the failing person");
    assert.equal(pushes[0]!.recipient, failEmail, "the push is addressed to the failing person");

    // The notification reached the FAILING person, never a passing one.
    for (const other of passEmails) {
      assert.notEqual(emails[0]!.recipient, other, "a passing account is never emailed");
      assert.notEqual(pushes[0]!.recipient, other, "a passing account is never pushed");
    }
  } finally {
    await db.close();
  }
});

test("a world in which every account passes triggers no notification on any channel", async () => {
  const db = await freshDb();
  try {
    const a = await createUser(db, { email: `allok1-${MARKER}@warthog.com.au`, wrappedDek: "wrapped-dek-opaque" });
    const b = await createUser(db, { email: `allok2-${MARKER}@warthog.com.au`, wrappedDek: "wrapped-dek-opaque" });
    await buildSoundChain(db, a.id, 3);
    // b has no entries — a vacuously sound chain, which still must not be notified.

    const senders = recordingSenders();
    await runDailyIntegrityCheck({ db, clock: CLOCK, senders });

    assert.equal(senders.list().length, 0, "a passing account triggers no push, email or SMS");
  } finally {
    await db.close();
  }
});

test("the failure notification body carries no personal content and no raw payload", async () => {
  const db = await freshDb();
  try {
    await seedWorld(db);
    const senders = recordingSenders();
    await runDailyIntegrityCheck({ db, clock: CLOCK, senders });

    const alerts = senders.list().filter((m) => m.channel === "push" || m.channel === "email");
    assert.equal(alerts.length, 2, "the failing account got a push and an email");
    for (const m of alerts) {
      assert.equal(typeof m.body, "string", "the notification has a body");
      assert.ok(m.body.length > 0, "the body is not empty (no dead notification)");
      // The body (and any link) must not echo the person's identity or activity content — the
      // recipient legitimately IS the email, so the absence check is scoped to body + link.
      assert.ok(!m.body.includes(MARKER), "no personal marker leaks into the notification body");
      if (m.link != null) {
        assert.ok(!m.link.includes(MARKER), "no personal marker leaks into the notification link");
      }
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 [obligation:validate-and-parameterize-input] — a handler on the `../http/validate`
// boundary rejects malformed / oversized / mis-shaped input with a 4xx BEFORE any query; an
// injection-shaped field never reaches a query and the tables survive; and every value the job
// writes travels BOUND. The handler below is a test FIXTURE (the intended usage: parseBody →
// runDailyIntegrityCheck), NOT an implementation file.
// ===========================================================================

// The daily trigger takes NO client-controlled parameters (the sweep is global), so the body is
// a STRICT empty object — any field is rejected at the boundary and never reaches a query. A
// larger-than-cap or malformed body is rejected before parse. A valid (empty) body runs the job.
function integrityJobHandler(db: Db, clock: Clock, senders: Senders): (req: Request) => Promise<Response> {
  const schema = z.object({}).strict();
  return async (req: Request): Promise<Response> => {
    try {
      await parseBody(schema, req, { maxBytes: 4 * 1024 });
      await runDailyIntegrityCheck({ db, clock, senders });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
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
  return new Request("https://warthog.com.au/api/activity/integrity-job", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed and oversized input with a 4xx and never reaches a query", async () => {
  const malformedDb = recordingDb();
  const malformed = await integrityJobHandler(malformedDb, CLOCK, recordingSenders())(jsonRequest("{ not valid json"));
  assert.ok(malformed.status >= 400 && malformed.status < 500, `malformed input must be a 4xx, got ${malformed.status}`);
  assert.equal(malformedDb.calls.length, 0, "malformed input must never reach a query");

  const oversizedDb = recordingDb();
  const oversized = await integrityJobHandler(oversizedDb, CLOCK, recordingSenders())(
    jsonRequest(JSON.stringify({ junk: "x".repeat(10 * 1024) })),
  );
  assert.ok(oversized.status >= 400 && oversized.status < 500, `oversized input must be a 4xx, got ${oversized.status}`);
  assert.equal(oversizedDb.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects an injection-shaped extra field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const res = await integrityJobHandler(db, CLOCK, recordingSenders())(jsonRequest(JSON.stringify({ trigger: INJECTION })));
  assert.ok(res.status >= 400 && res.status < 500, `an injection-shaped field must be a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a rejected body is never parsed into a query");
});

test("an injection-shaped request cannot alter a query: the tables survive and nothing is recorded", async () => {
  const db = await freshDb();
  try {
    await seedWorld(db);
    const usersBefore = await countRows(db, "users");
    const entriesBefore = await countRows(db, "activity_entries");

    const res = await integrityJobHandler(db, CLOCK, recordingSenders())(jsonRequest(JSON.stringify({ trigger: INJECTION })));
    assert.ok(res.status >= 400 && res.status < 500, `the probe must be a 4xx, got ${res.status}`);

    assert.equal(await tableExists(db, "metric_events"), true, "the metric_events table still exists");
    assert.equal(await tableExists(db, "activity_entries"), true, "the activity_entries table still exists");
    assert.equal(await countRows(db, "users"), usersBefore, "the users table is untouched by the probe");
    assert.equal(await countRows(db, "activity_entries"), entriesBefore, "the activity rows are untouched by the probe");
    assert.equal(await countRows(db, "metric_events"), 0, "a rejected trigger records no metric");
  } finally {
    await db.close();
  }
});

test("the handler accepts a well-formed (empty) body and runs the sweep end-to-end", async () => {
  const db = await freshDb();
  try {
    const { expected, failEmail } = await seedWorld(db);
    const senders = recordingSenders();

    const res = await integrityJobHandler(db, CLOCK, senders)(jsonRequest("{}"));
    assert.ok(res.status >= 200 && res.status < 300, `a well-formed body is a 2xx, got ${res.status}`);

    const events = await queryMetrics(db, { name: INTEGRITY_CHECK, from: DAY_FROM, to: DAY_TO });
    assert.equal(byOutcome(events, OUTCOME_PASS)[0]!.value, expected.pass, "the pass count was recorded through the handler");
    assert.equal(byOutcome(events, OUTCOME_FAIL)[0]!.value, expected.fail, "the fail count was recorded through the handler");

    const emails = onChannel(senders.list(), "email");
    assert.equal(emails.length, 1, "the failing account was emailed through the handler");
    assert.equal(emails[0]!.recipient, failEmail, "and the email reached the failing person");
  } finally {
    await db.close();
  }
});

test("every value the job writes travels BOUND as a parameter, never spliced into the SQL text", async () => {
  const db = await freshDb();
  try {
    // A failing account (so a "fail" outcome is written) and a passing one (so a "pass" outcome
    // is written) — both labels are DATA the job writes into an INSERT; they must be bound.
    const fail = await createUser(db, { email: `bindfail-${MARKER}@warthog.com.au`, wrappedDek: "wrapped-dek-opaque" });
    await buildSoundChain(db, fail.id, 2);
    await db.query("UPDATE activity_entries SET kind = $2 WHERE user_id = $1 AND seq = $3", [fail.id, "tampered", 1]);
    const ok = await createUser(db, { email: `bindok-${MARKER}@warthog.com.au`, wrappedDek: "wrapped-dek-opaque" });
    await buildSoundChain(db, ok.id, 2);

    const proxy = recordingProxy(db);
    await runDailyIntegrityCheck({ db: proxy, clock: CLOCK, senders: recordingSenders() });

    const allValues = proxy.calls.flatMap((c) => c.values);
    assert.ok(allValues.includes(OUTCOME_PASS), "the pass outcome travels as a bound value");
    assert.ok(allValues.includes(OUTCOME_FAIL), "the fail outcome travels as a bound value");
    assert.ok(allValues.includes(INTEGRITY_CHECK), "the metric name travels as a bound value");
    for (const call of proxy.calls) {
      assert.ok(!call.text.includes("'pass'"), "the pass outcome is bound, never concatenated into the SQL");
      assert.ok(!call.text.includes("'fail'"), "the fail outcome is bound, never concatenated into the SQL");
      assert.ok(!call.text.includes("'integrity.check'"), "the metric name is bound, never concatenated into the SQL");
      assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
    }

    // And the writes really landed through the proxy (the bound values are inert data).
    const events = await queryMetrics(db, { name: INTEGRITY_CHECK, from: DAY_FROM, to: DAY_TO });
    assert.equal(byOutcome(events, OUTCOME_PASS)[0]!.value, 1, "the pass count was stored");
    assert.equal(byOutcome(events, OUTCOME_FAIL)[0]!.value, 1, "the fail count was stored");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 [obligation:secrets-from-env] — the job reads no process.env: a decoy secret in the
// environment never lands in a recorded metric or a notification; it runs purely from its
// injected db + clock + senders.
// ===========================================================================

test("the job reads no process.env: a decoy secret never lands in a metric or a notification", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog_integrity_job";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    await seedWorld(db);
    const senders = recordingSenders();
    await runDailyIntegrityCheck({ db, clock: CLOCK, senders });

    const all = await db.query("SELECT * FROM metric_events");
    assert.ok(all.rows.length > 0, "the job recorded metrics to scan");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(DECOY), "no ambient env value is folded into a recorded metric");
        }
      }
    }

    for (const m of senders.list()) {
      assert.ok(!m.body.includes(DECOY), "no ambient env value is folded into a notification body");
      assert.ok(!m.recipient.includes(DECOY), "no ambient env value is folded into a notification recipient");
      if (m.link != null) assert.ok(!m.link.includes(DECOY), "no ambient env value is folded into a notification link");
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
