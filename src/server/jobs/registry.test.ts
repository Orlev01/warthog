// E18-S21 — Background job registry (`src/server/jobs/registry.ts`), reworked into TWO
// explicit parts:
//   (1) PERIODIC SWEEPS the scheduler runs directly on their interval (no job rows): the
//       approvals expire-due sweep, life-admin reminders, exchange rates, account purge,
//       metrics snapshot and the daily integrity check; and
//   (2) a DISPATCH TABLE for payload-driven queue rows, keyed on the EXACT type strings
//       production code enqueues — approval.fallback, connection.refresh,
//       connection.google_reminder, connection.google_lapse, account_reset.complete —
//       imported from their modules' exported constants, never retyped.
//
// RED-first: the reworked registry does NOT exist yet (today it exports a single
// `jobRegistry` array of nine name/handler/intervalMs entries, two of which —
// `connector-token-refresh`, `connector-health` — match NO type any production code
// enqueues). The new builders and the exported type constants below do not exist until the
// builder writes them, so every test here fails. That absence IS the point of test-first —
// do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR (the DATA the registry exposes: which enqueued types have a
// dispatch handler, which periodic sweeps exist, that the two dead entries are gone, that
// the two halves are disjoint), never the source text of any module. The dispatch keys are
// checked against each owning module's EXPORTED type constant (imported here), so a rename
// of a constant travels through this test's own import of it rather than reddening a grep.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   import type { Job } from "../db/jobs";
//
//   // One periodic sweep the scheduler runs directly on its interval (no job rows).
//   interface PeriodicSweep {
//     readonly name: string;
//     readonly intervalMs: number;          // > 0
//     readonly run: () => void | Promise<void>;
//   }
//
//   // The superset of seams every handler/sweep is wired from (the composition root
//   // supplies the real ones; each builder reads only the subset it needs).
//   interface JobSeams {
//     db; clock; keyWrapper; random; senders; push; refresh; resetExecutor; rateSource;
//     publicBaseUrl;
//   }
//
//   // The dispatch table for payload-driven queue rows: enqueued `type` → the handler
//   // that runs a claimed row of that type.
//   function buildDispatchTable(seams: JobSeams): Record<string, (job: Job) => Promise<void>>;
//
//   // The periodic sweeps, run directly by the scheduler on their interval.
//   function buildPeriodicSweeps(seams: JobSeams): readonly PeriodicSweep[];
//
// The five enqueued types (AC1) come from the modules that enqueue them, as EXPORTED
// constants this test imports rather than retyping: FALLBACK_JOB_TYPE
// ("approval.fallback"), REFRESH_TYPE / GOOGLE_REMINDER_TYPE / GOOGLE_LAPSE_TYPE
// ("connection.refresh" / ".google_reminder" / ".google_lapse"), COMPLETE_JOB_TYPE
// ("account_reset.complete").
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { buildDispatchTable, buildPeriodicSweeps } from "./registry";

// The EXACT enqueued type strings, imported from each owning module's EXPORTED constant
// (AC1) — never retyped here.
import { FALLBACK_JOB_TYPE } from "../notify/approval-notifier";
import { REFRESH_TYPE, GOOGLE_REMINDER_TYPE, GOOGLE_LAPSE_TYPE } from "../connectors/jobs";
import { COMPLETE_JOB_TYPE } from "../auth/account-reset";

import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import { fixedRandom } from "../seams/random";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fakeRateSource } from "../currency/rate-source";
import { createInMemoryBlobStore } from "../storage/blob";
import { createUser } from "../db/users";
import { enqueueAccountPurge } from "../db/account-purge";
import type { Db } from "../db/index";

const T0 = new Date("2026-03-01T00:00:00.000Z");

// Every job type production code enqueues — each must have a dispatch handler (AC1).
const EXPECTED_DISPATCH_TYPES = [
  FALLBACK_JOB_TYPE,
  REFRESH_TYPE,
  GOOGLE_REMINDER_TYPE,
  GOOGLE_LAPSE_TYPE,
  COMPLETE_JOB_TYPE,
] as const;

// The periodic sweeps the scheduler runs directly on their interval.
const EXPECTED_SWEEP_NAMES = [
  "approval-expiry",
  "life-admin-reminders",
  "exchange-rates",
  "account-purge",
  "metrics-snapshot",
  "daily-integrity-check",
  "oauth-cleanup",
  "traffic-flush",
  "operator-role",
  "metrics-retention",
  "request-arrivals",
] as const;

// The two registry entries that matched no real enqueued job — removed by this task.
const REMOVED_NAMES = ["connector-token-refresh", "connector-health"] as const;

// A COMPLETE seam bundle for the builders. They only ASSEMBLE closures from these seams
// (nothing is invoked at build time), so cheap structural fakes suffice. Returned as a
// variable so its superset of fields stays assignable to the builders' seam type.
function jobSeams(db: Db) {
  return {
    db,
    clock: fixedClock(T0),
    keyWrapper: localAesKeyWrapper(randomBytes(32)),
    random: fixedRandom(7),
    senders: {
      push: { sendPush: async (): Promise<void> => {} },
      email: { sendEmail: async (): Promise<void> => {} },
      sms: { sendSms: async (): Promise<void> => {} },
    },
    push: { sendPush: async (): Promise<void> => {} },
    refresh: async (): Promise<void> => {},
    resetExecutor: {
      eraseVaultData: async (): Promise<void> => {},
      revokeAgentsAndConnections: async (): Promise<void> => {},
    },
    rateSource: fakeRateSource({ rateDate: "2026-03-01", baseCurrency: "AUD", rates: { USD: 0.65 } }),
    blobStore: createInMemoryBlobStore(),
    publicBaseUrl: "https://warthog.com.au",
  };
}

test("the imported type constants are the exact enqueued type strings production code uses (AC1)", () => {
  assert.equal(FALLBACK_JOB_TYPE, "approval.fallback");
  assert.equal(REFRESH_TYPE, "connection.refresh");
  assert.equal(GOOGLE_REMINDER_TYPE, "connection.google_reminder");
  assert.equal(GOOGLE_LAPSE_TYPE, "connection.google_lapse");
  assert.equal(COMPLETE_JOB_TYPE, "account_reset.complete");
});

test("the dispatch table has a handler for every enqueued job type, and only those (AC1)", async () => {
  const db = await freshDb();
  try {
    const table = buildDispatchTable(jobSeams(db));
    const keys = Object.keys(table);

    // Every enqueued type has a callable handler.
    for (const type of EXPECTED_DISPATCH_TYPES) {
      assert.equal(typeof table[type], "function", `dispatch table is missing a handler for "${type}"`);
    }

    // Exactly those types — no stray/speculative entries, no duplicates.
    assert.deepEqual(
      [...keys].sort(),
      [...new Set(EXPECTED_DISPATCH_TYPES)].sort(),
      "the dispatch table is keyed on EXACTLY the enqueued type strings",
    );
  } finally {
    await db.close();
  }
});

test("the periodic sweeps include expiry, interval jobs and OAuth cleanup", async () => {
  const db = await freshDb();
  try {
    const sweeps = buildPeriodicSweeps(jobSeams(db));
    const names = sweeps.map((s) => s.name);

    assert.deepEqual([...names].sort(), [...EXPECTED_SWEEP_NAMES].sort(), "all required sweeps are present exactly once");
    assert.equal(new Set(names).size, sweeps.length, "no duplicate sweep names");

    // The approvals expire-due sweep is present (its behaviour is pinned in scheduler.test.ts).
    assert.ok(sweeps.some((s) => s.name === "approval-expiry"), "the approvals expire-due sweep must be present");

    // Every sweep runs directly: a positive interval and a callable run function.
    for (const sweep of sweeps) {
      assert.equal(typeof sweep.run, "function", `${sweep.name}: run must be a function`);
      assert.equal(typeof sweep.intervalMs, "number", `${sweep.name}: intervalMs must be a number`);
      assert.ok(Number.isFinite(sweep.intervalMs) && sweep.intervalMs > 0, `${sweep.name}: intervalMs must be > 0`);
    }
  } finally {
    await db.close();
  }
});

test("the dead registry entries (connector-token-refresh, connector-health) are removed", async () => {
  const db = await freshDb();
  try {
    const dispatchKeys = new Set(Object.keys(buildDispatchTable(jobSeams(db))));
    const sweepNames = new Set(buildPeriodicSweeps(jobSeams(db)).map((s) => s.name));

    for (const dead of REMOVED_NAMES) {
      assert.ok(!dispatchKeys.has(dead), `"${dead}" must not be a dispatch type (it matched no real job)`);
      assert.ok(!sweepNames.has(dead), `"${dead}" must not be a periodic sweep (it matched no real job)`);
    }
  } finally {
    await db.close();
  }
});

test("the registry splits cleanly: no periodic sweep name is an enqueued dispatch type, and vice versa", async () => {
  const db = await freshDb();
  try {
    const dispatchKeys = new Set(Object.keys(buildDispatchTable(jobSeams(db))));
    const sweepNames = new Set(buildPeriodicSweeps(jobSeams(db)).map((s) => s.name));

    for (const name of sweepNames) {
      assert.ok(!dispatchKeys.has(name), `periodic sweep "${name}" must not also be a dispatch type (the halves are disjoint)`);
    }
    for (const type of dispatchKeys) {
      assert.ok(!sweepNames.has(type), `dispatch type "${type}" must not also be a periodic sweep (the halves are disjoint)`);
    }
  } finally {
    await db.close();
  }
});

// Review fix W3.2 — the account-purge sweep runs with the job runtime's blob store, so a
// purged person's receipt ciphertext is deleted from storage, not orphaned.
test("the account-purge sweep deletes a purged person's receipt blobs through the seams' blob store", async () => {
  const db = await freshDb();
  try {
    const seams = jobSeams(db);
    const user = await createUser(db, { email: "purge-sweep@warthog.com.au", wrappedDek: "d3JhcHBlZA==" });
    const record = await db.query(
      `INSERT INTO life_admin_records (user_id, kind, fields, status, source_kind)
       VALUES ($1, 'receipt_warranty', 'v1:f', 'active', 'person') RETURNING id`,
      [user.id],
    );
    await db.query(
      `INSERT INTO receipt_files (user_id, record_id, blob_key, nonce, content_type, size)
       VALUES ($1, $2, 'receipts/sweep', 'n', 'image/png', 1)`,
      [user.id, record.rows[0]!.id],
    );
    await seams.blobStore.put("receipts/sweep", new Uint8Array([9]));
    await enqueueAccountPurge(db, user.id);

    const sweep = buildPeriodicSweeps(seams).find((s) => s.name === "account-purge");
    assert.ok(sweep, "the account-purge sweep is registered");
    await sweep.run();

    assert.equal(await seams.blobStore.get("receipts/sweep"), null, "the receipt blob is deleted");
    const left = await db.query("SELECT 1 FROM users WHERE id = $1", [user.id]);
    assert.equal(left.rows.length, 0, "the account is purged");
  } finally {
    await db.close();
  }
});

// --- The admin portal's sweeps (docs/design/admin-portal.md §4) -------------------------------
import { getTrafficCounter } from "../http/traffic";
import { queryMetrics, recordMetric } from "../db/metrics";

test("traffic-flush, operator-role and metrics-retention run on their intervals and do what they say", async () => {
  const db = await freshDb();
  try {
    const seams = { ...jobSeams(db), operatorEmail: "Operator@Example.test" };
    const sweeps = buildPeriodicSweeps(seams);
    const byName = Object.fromEntries(sweeps.map((s) => [s.name, s]));
    assert.equal(byName["traffic-flush"]!.intervalMs, 60_000);
    assert.equal(byName["operator-role"]!.intervalMs, 60 * 60_000);
    assert.equal(byName["metrics-retention"]!.intervalMs, 24 * 60 * 60_000);

    // traffic-flush drains the process-wide counter into http.requests rows.
    getTrafficCounter().drain();
    getTrafficCounter().count("app", "public", "document");
    await byName["traffic-flush"]!.run();
    const traffic = await queryMetrics(db, { name: "http.requests", from: "2026-02-28T00:00:00Z", to: "2026-03-02T00:00:00Z" });
    assert.deepEqual(traffic.map((e) => [e.outcome, e.value]), [["app.public.document", 1]]);

    // operator-role promotes the configured address, case-insensitively, and nobody else.
    const operator = await createUser(db, { email: "operator@example.test", wrappedDek: "wrapped" });
    const other = await createUser(db, { email: "other@example.test", wrappedDek: "wrapped" });
    await byName["operator-role"]!.run();
    assert.equal((await db.query("SELECT role FROM users WHERE id = $1", [operator.id])).rows[0]!.role, "admin");
    assert.equal((await db.query("SELECT role FROM users WHERE id = $1", [other.id])).rows[0]!.role, "member");

    // metrics-retention keeps the last 400 days and prunes older rows.
    await recordMetric(db, { name: "users.total", value: 1, recordedAt: "2024-12-01T00:00:00Z" });
    await recordMetric(db, { name: "users.total", value: 2, recordedAt: "2025-06-01T00:00:00Z" });
    await byName["metrics-retention"]!.run();
    const kept = await queryMetrics(db, { name: "users.total", from: "2000-01-01T00:00:00Z", to: "2030-01-01T00:00:00Z" });
    assert.deepEqual(kept.map((e) => e.value), [2]);
  } finally {
    await db.close();
  }
});

// --- Telling people their request has arrived (docs/adr/requests-for-members.md) -------------
import { createConnectorRequest } from "../db/connector-requests";
import type { OutgoingMessage } from "../notify/senders";

test("request-arrivals runs hourly and emails the person whose requested service is now connectable", async () => {
  const db = await freshDb();
  try {
    const sent: OutgoingMessage[] = [];
    const base = jobSeams(db);
    const seams = {
      ...base,
      senders: { ...base.senders, email: { sendEmail: async (m: OutgoingMessage): Promise<void> => { sent.push(m); } } },
      requestMatching: {
        match: (name: string) => (name.toLowerCase() === "linkedin" ? { id: "linkedin", name: "LinkedIn" } : undefined),
        onGoogleEarlyAccess: () => false,
        connectorName: () => undefined,
      },
    };
    const person = await createUser(db, { email: "asker@example.test", wrappedDek: "wrapped" });
    await createConnectorRequest(db, { userId: person.id, serviceName: "LinkedIn" }, fixedClock(T0));
    const sweep = buildPeriodicSweeps(seams).find((s) => s.name === "request-arrivals")!;
    assert.equal(sweep.intervalMs, 60 * 60_000);
    await sweep.run();
    assert.deepEqual(sent.map((m) => [m.recipient, m.email?.subject]), [["asker@example.test", "LinkedIn is ready to connect"]]);

    const without = buildPeriodicSweeps(jobSeams(db)).find((s) => s.name === "request-arrivals")!;
    await without.run();
    assert.equal(sent.length, 1, "with no catalogue wired, nothing arrives and nothing is sent");
  } finally {
    await db.close();
  }
});
