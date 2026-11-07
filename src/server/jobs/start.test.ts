// E18-S11 — Instrumentation starts the job scheduler.
//
// Next calls `register()` (exported from `src/instrumentation.ts`) once at server start-up.
// There this epic boots the in-process scheduler loop exactly once on the Node server
// runtime, with the full registry wired, so the approval, notification, connector-health,
// currency, reminder, metrics, integrity and purge loops actually run in the deployed app.
//
// A Next instrumentation ENTRY file may export only its framework fields (`register`,
// `onRequestError`), so the testable logic lives in a SIBLING seam the entry wires its real
// deps into. These tests pin that seam, named here as:
//
//   // src/server/jobs/start.ts — the recurring-loop composition root the entry delegates to.
//   interface SchedulerLoopDeps {
//     readonly runtime: string | undefined;              // process.env.NEXT_RUNTIME
//     readonly createScheduler: () => { tick(): Promise<unknown> };  // full-registry scheduler
//     readonly setInterval: (onTick: () => unknown, ms: number) => unknown;  // timer seam
//     readonly intervalMs: number;
//     readonly log: (entry: unknown) => void;            // receives ALREADY-REDACTED failures
//   }
//   // Returns the register() the entry exports: it starts the loop AT MOST ONCE and ONLY on
//   // the Node server runtime; a repeat call starts no second scheduler. The real
//   // `src/instrumentation.ts` passes { runtime: process.env.NEXT_RUNTIME,
//   // createScheduler: getScheduler, setInterval, intervalMs, log } — so the db comes from
//   // config (getScheduler → compose.ts → getServerDb → loadConfig().databaseUrl, branching
//   // the pglite:/postgres scheme), never a raw process.env read at this root (AC2/AC3).
//   function createRegister(deps: SchedulerLoopDeps): () => void | Promise<void>;
//
// RED-first: `./start` does NOT exist yet, so every test below fails to import until the
// builder creates the seam and wires `src/instrumentation.ts` over it. That absence IS the
// point of test-first — do NOT implement anything to make these pass.
//
// Acceptance criteria → tests:
//   AC1  register() starts the scheduler exactly once on the Node server runtime with the
//        full registry wired; a second register() starts no second scheduler; off the Node
//        runtime (edge / unset) it starts nothing.                     → T1, T2
//   AC4  a real approval.fallback row (with its approvalId) is run END TO END by the started
//        runtime through the ACTUAL dispatch entry; periodic sweeps tick on their intervals
//        (the loop drives a real tick on each firing, and a real sweep runs).  → T3, T4, T5
//   AC5  a tick failure is logged THROUGH REDACTION and never swallowed (no empty catch). → T6
//   AC2/AC3/INV-103  the started runtime runs purely from its deps; no ambient env secret is
//        folded into what it logs or writes; config is read from env.    → T7
//
// The db-branch itself (pglite:/postgres from config) is owned by the composition root the
// started runtime REUSES (getServerDb / compose.ts, E18-S21) and covered by db/index +
// config tests; these tests exercise the started runtime against the in-memory ("memory")
// branch database and prove it reads no raw env at this root (T7), rather than duplicating
// that branch test here.
//
// Behaviour only: spies for the loop/timer, real DB state (jobs / approvals / approval_links)
// and the injected email sender for the end-to-end paths. No test asserts source text, none
// imports src/instrumentation.ts (calling the real register() would boot real timers and the
// global server db), and each DB-backed test uses its own isolated freshDb(), closed in a
// finally. No test touches the network or Azure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createRegister } from "./start";

import { createScheduler } from "./scheduler";
import { buildDispatchTable, buildPeriodicSweeps } from "./registry";

import { enqueue } from "../db/jobs";
import { freshDb } from "../../test/db";
import { fixedClock, type Clock } from "../seams/clock";
import { fixedRandom } from "../seams/random";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { fakeRateSource } from "../currency/rate-source";
import { createApproval } from "../db/approvals";
import { createUser } from "../db/users";
// The EXACT type string production code enqueues for the approval fallback job — imported
// from the module that owns it, never retyped (AC4).
import { FALLBACK_JOB_TYPE } from "../notify/approval-notifier";
import type { OutgoingMessage } from "../notify/senders";
import type { Db } from "../db/index";

const T0 = new Date("2026-03-01T00:00:00.000Z");
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const INTERVAL_MS = MINUTE_MS;

// A Luhn-valid card number planted in a thrown error, so T6 can prove the loop routes the
// failure THROUGH redaction before logging: the full number is masked (only the last four
// survive), so the whole string must be absent from the log.
const CARD = "4111111111111111";

// ── timer seam ──────────────────────────────────────────────────────────────────────
// A fake `setInterval` that captures each loop the started runtime arms (never fires a real
// timer). `calls.length` is how many schedulers were started; `calls[i].fn` is the loop body
// a test drives by hand.
function captureInterval() {
  const calls: Array<{ fn: () => unknown; ms: number }> = [];
  return {
    calls,
    setInterval: (fn: () => unknown, ms: number): number => {
      calls.push({ fn, ms });
      return calls.length;
    },
  };
}

// Fire the started loop once and wait for its (possibly fire-and-forget) tick to settle. A
// loop body may return the tick promise (awaited directly) or detach it (`void tick()…`);
// either way, drive() then `waitFor` lets the work drain.
async function drive(fn: () => unknown): Promise<void> {
  await fn();
}

// Poll an (optionally async) predicate, yielding to the event loop between checks, so a
// detached tick's real DB work has a chance to finish.
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for: ${label}`);
}

// ── DB observation helpers (behaviour, not source text) ───────────────────────────────
async function statusOf(db: Db, id: string): Promise<string | undefined> {
  const result = await db.query("SELECT status FROM jobs WHERE id = $1", [id]);
  return result.rows[0]?.status as string | undefined;
}

async function approvalStatus(db: Db, id: string): Promise<string | undefined> {
  const result = await db.query("SELECT status FROM approvals WHERE id = $1", [id]);
  return result.rows[0]?.status as string | undefined;
}

// A COMPLETE seam bundle for the registry builders, from cheap fakes plus whichever real
// seams a test needs (db, clock, keyWrapper, an email recorder). The builders only ASSEMBLE
// handlers/sweeps from these — the fakes never run unless the matching handler/sweep does.
function jobSeams(args: {
  db: Db;
  clock: Clock;
  keyWrapper: KeyWrapper;
  onEmail?: (message: OutgoingMessage) => void;
}) {
  return {
    db: args.db,
    clock: args.clock,
    keyWrapper: args.keyWrapper,
    random: fixedRandom(7),
    senders: {
      push: { sendPush: async (): Promise<void> => {} },
      email: {
        sendEmail: async (message: OutgoingMessage): Promise<void> => {
          args.onEmail?.(message);
        },
      },
      sms: { sendSms: async (): Promise<void> => {} },
    },
    push: { sendPush: async (): Promise<void> => {} },
    refresh: async (): Promise<void> => {},
    resetExecutor: {
      eraseVaultData: async (): Promise<void> => {},
      revokeAgentsAndConnections: async (): Promise<void> => {},
    },
    rateSource: fakeRateSource({ rateDate: "2026-03-01", baseCurrency: "AUD", rates: { USD: 0.65 } }),
    publicBaseUrl: "https://warthog.com.au",
  };
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper`, returning the ids a
// test needs (so the real expiry sweep can recover the DEK).
async function makePerson(
  db: Db,
  who: string,
  keyWrapper: KeyWrapper,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(32);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}-${randomUUID()}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

// Arrange a PENDING approval created at `createdAt` (its fixed window opens there), owned by
// `person`.
async function arrangeApproval(
  db: Db,
  person: { userId: string; dek: Uint8Array },
  createdAt: Date,
): Promise<string> {
  const approval = await createApproval(
    db,
    { userId: person.userId, agentId: randomUUID(), detail: { field: "card", amount: 1 } },
    person.dek,
    fixedClock(createdAt),
  );
  return approval.id;
}

// ===========================================================================
// T1 (AC1) — register() starts the scheduler exactly once on the Node runtime, and a second
// register() starts no second scheduler.
// ===========================================================================

test("register() starts the scheduler exactly once on the node runtime; a repeat call starts no second scheduler", async () => {
  const ci = captureInterval();
  let created = 0;
  const register = createRegister({
    runtime: "nodejs",
    createScheduler: () => {
      created += 1;
      return { tick: async (): Promise<void> => {} };
    },
    setInterval: ci.setInterval,
    intervalMs: INTERVAL_MS,
    log: () => {},
  });

  await register();

  assert.equal(ci.calls.length, 1, "the scheduler loop is started exactly once");
  assert.equal(created, 1, "the full-registry scheduler is built once (not rebuilt per tick)");
  assert.equal(ci.calls[0]?.ms, INTERVAL_MS, "the loop runs on the injected interval, not a hard-coded value");

  // Next may call register() more than once — a second call must NOT arm a second loop.
  await register();

  assert.equal(ci.calls.length, 1, "calling register() again starts no second scheduler");
  assert.equal(created, 1, "calling register() again does not rebuild the scheduler");
});

// ===========================================================================
// T2 (AC1) — the loop starts ONLY on the Node server runtime; off it (edge / unset) nothing
// starts.
// ===========================================================================

for (const runtime of ["edge", undefined] as const) {
  test(`register() starts no scheduler off the node server runtime (NEXT_RUNTIME=${runtime ?? "unset"})`, async () => {
    const ci = captureInterval();
    let created = 0;
    const register = createRegister({
      runtime,
      createScheduler: () => {
        created += 1;
        return { tick: async (): Promise<void> => {} };
      },
      setInterval: ci.setInterval,
      intervalMs: INTERVAL_MS,
      log: () => {},
    });

    await register();

    assert.equal(ci.calls.length, 0, "no scheduler loop is armed off the node runtime");
    assert.equal(created, 0, "no scheduler is built off the node runtime");
  });
}

// ===========================================================================
// T3 (AC4) — the started loop drives a scheduler tick on EACH timer firing, so the periodic
// sweeps get their interval ticks.
// ===========================================================================

test("the started loop ticks the scheduler on each timer firing (so periodic sweeps tick on their intervals)", async () => {
  const ci = captureInterval();
  let ticks = 0;
  const register = createRegister({
    runtime: "nodejs",
    createScheduler: () => ({
      tick: async (): Promise<void> => {
        ticks += 1;
      },
    }),
    setInterval: ci.setInterval,
    intervalMs: INTERVAL_MS,
    log: () => {},
  });

  await register();
  assert.equal(ci.calls.length, 1, "precondition: the loop is armed");

  // Each timer firing drives exactly one scheduler tick.
  await drive(ci.calls[0]!.fn);
  await drive(ci.calls[0]!.fn);
  await drive(ci.calls[0]!.fn);

  await waitFor(() => ticks === 3, "the loop ticked the scheduler once per firing");
  assert.equal(ticks, 3, "the loop drives one tick per interval firing");
});

// ===========================================================================
// T4 (AC4) — a REAL enqueued approval.fallback row is executed END TO END by the started
// runtime, through the ACTUAL dispatch entry (the registry's), not a synthetic job.
// ===========================================================================

test("a real approval.fallback row is run end to end by the started runtime through the actual dispatch entry", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    // A real pending, unopened approval owned by a real person.
    const person = await makePerson(db, "fallback", keyWrapper);
    const approvalId = await arrangeApproval(db, person, T0);

    // The scheduler the started runtime boots: the registry's REAL dispatch table over a
    // recording email sender, draining the SAME db.
    const emails: OutgoingMessage[] = [];
    const seams = jobSeams({ db, clock: fixedClock(T0), keyWrapper, onEmail: (m) => emails.push(m) });
    const dispatch = buildDispatchTable(seams);
    assert.equal(
      typeof dispatch[FALLBACK_JOB_TYPE],
      "function",
      "precondition: the registry's dispatch table has the real approval.fallback entry",
    );
    const scheduler = createScheduler({
      getDb: async () => db,
      clock: fixedClock(T0),
      sweeps: [],
      dispatch,
      log: () => {},
    });

    const ci = captureInterval();
    const register = createRegister({
      runtime: "nodejs",
      createScheduler: () => scheduler,
      setInterval: ci.setInterval,
      intervalMs: INTERVAL_MS,
      log: () => {},
    });

    // The real queue row production enqueues: the fallback type with the approval id payload.
    const row = await enqueue(db, {
      type: FALLBACK_JOB_TYPE,
      payload: { approvalId },
      runAt: new Date(T0.getTime() - HOUR_MS),
    });

    await register();
    await drive(ci.calls[0]!.fn);
    await waitFor(async () => (await statusOf(db, row.id)) === "done", "the fallback row reaches done");

    // runApprovalFallback ran end-to-end through the started runtime: it issued the single-use
    // link and sent the fallback email.
    const links = await db.query("SELECT count(*)::int AS n FROM approval_links WHERE approval_id = $1", [approvalId]);
    assert.ok(
      Number(links.rows[0]?.n) > 0,
      "the started runtime executed runApprovalFallback (a single-use approval link was issued)",
    );
    assert.equal(emails.length, 1, "the started runtime sent exactly one fallback email through the injected sender");
    assert.equal(await statusOf(db, row.id), "done", "the fallback row is marked done once handled");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// T5 (AC4) — a REAL periodic sweep runs through the started runtime: the approval-expiry
// sweep from the registry expires a past-due pending approval when the loop fires.
// ===========================================================================

test("a real periodic sweep (approval-expiry) runs through the started runtime", async () => {
  const NOW = new Date("2026-11-15T12:00:00.000Z");
  // Created a day ago, so its window has long since ended → past-due at NOW.
  const CREATED_DUE = new Date(NOW.getTime() - DAY_MS);
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const person = await makePerson(db, "expiry", keyWrapper);
    const dueId = await arrangeApproval(db, person, CREATED_DUE);
    assert.equal(await approvalStatus(db, dueId), "pending", "precondition: the overdue approval starts pending");

    const clock = fixedClock(NOW);
    const sweeps = buildPeriodicSweeps(jobSeams({ db, clock, keyWrapper }));
    const expirySweep = sweeps.find((s) => s.name === "approval-expiry");
    assert.ok(expirySweep, "precondition: buildPeriodicSweeps includes the approval-expiry sweep");
    const scheduler = createScheduler({
      getDb: async () => db,
      clock,
      sweeps: [expirySweep!],
      dispatch: {},
      log: () => {},
    });

    const ci = captureInterval();
    const register = createRegister({
      runtime: "nodejs",
      createScheduler: () => scheduler,
      setInterval: ci.setInterval,
      intervalMs: INTERVAL_MS,
      log: () => {},
    });

    await register();
    await drive(ci.calls[0]!.fn);
    await waitFor(async () => (await approvalStatus(db, dueId)) === "expired", "the overdue approval is expired");

    assert.equal(
      await approvalStatus(db, dueId),
      "expired",
      "the started runtime ran the real approval-expiry sweep",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// T6 (AC5) — a tick failure is logged THROUGH REDACTION and never swallowed (no empty catch).
// ===========================================================================

test("a tick failure is logged through redaction and never swallowed", async () => {
  const ci = captureInterval();
  const logs: unknown[] = [];
  const register = createRegister({
    runtime: "nodejs",
    createScheduler: () => ({
      tick: async (): Promise<void> => {
        // A card number inside the failure so we can prove it is redacted before logging.
        throw new Error(`TICK_BOOM ${CARD}`);
      },
    }),
    setInterval: ci.setInterval,
    intervalMs: INTERVAL_MS,
    log: (entry) => logs.push(entry),
  });

  await register();
  await drive(ci.calls[0]!.fn);
  await waitFor(() => logs.length > 0, "the tick failure is logged");

  // Never swallowed: an empty `catch(() => {})` would leave logs empty.
  assert.ok(logs.length > 0, "the tick failure is logged, never swallowed");

  const logged = logs.map((e) => JSON.stringify(e)).join("\n");
  assert.ok(logged.includes("TICK_BOOM"), "the tick's failure (its error) is logged");
  assert.ok(
    !logged.includes(CARD),
    "the logged failure passed through redaction (the card number is masked, not leaked)",
  );
});

// ===========================================================================
// T7 (AC2 / AC3 / INV-103) — the started runtime runs purely from its deps: no ambient env
// secret is folded into what it logs or writes; config is read from env, not arbitrary
// process.env, at this composition root.
// ===========================================================================

test("the started runtime folds no ambient env secret into what it logs or writes", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog_instrumentation";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    // A real scheduler draining one benign row, so the started runtime actually writes to the
    // (in-memory "memory"-branch) database for us to scan.
    let handled = false;
    const scheduler = createScheduler({
      getDb: async () => db,
      clock: fixedClock(T0),
      sweeps: [],
      dispatch: {
        "work.item": async () => {
          handled = true;
        },
      },
      log: () => {},
    });

    const ci = captureInterval();
    const logs: unknown[] = [];
    const register = createRegister({
      runtime: "nodejs",
      createScheduler: () => scheduler,
      setInterval: ci.setInterval,
      intervalMs: INTERVAL_MS,
      log: (entry) => logs.push(entry),
    });

    const row = await enqueue(db, { type: "work.item", runAt: new Date(T0.getTime() - HOUR_MS) });

    await register();
    await drive(ci.calls[0]!.fn);
    await waitFor(async () => (await statusOf(db, row.id)) === "done", "the benign row is processed");
    assert.ok(handled, "precondition: the started runtime processed a row");

    // No ambient env value leaked into the loop's log.
    const logged = logs.map((e) => JSON.stringify(e)).join("\n");
    assert.ok(!logged.includes(DECOY), "no ambient env secret is logged by the started runtime");

    // No ambient env value was folded into anything the started runtime wrote.
    const all = await db.query("SELECT * FROM jobs");
    assert.ok(all.rows.length > 0, "the started runtime wrote job rows to scan");
    for (const r of all.rows) {
      for (const cell of Object.values(r)) {
        const text = typeof cell === "string" ? cell : JSON.stringify(cell);
        assert.ok(!text.includes(DECOY), "no ambient env value is folded into a row the started runtime writes");
      }
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
