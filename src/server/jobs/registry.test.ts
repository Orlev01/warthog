// E18-S09 — Background job registry (`src/server/jobs/registry.ts`).
//
// RED-first: `./registry` does NOT exist yet, so importing `jobRegistry` throws and
// every test here fails until the builder writes the minimum code to pass. That
// absence IS the point of test-first — do NOT implement anything to make these pass;
// the builder writes `registry.ts` afterwards. Every job module this registry wires
// together already exists (built across E09–E17); only the registry that enumerates
// them is missing.
//
// These tests pin BEHAVIOUR (what the registry EXPOSES as data: the set of jobs, each
// job's stable name, its handler, and its schedule/interval), never the source text
// of any module. The handler-resolution checks compare FUNCTION REFERENCES against
// the real job modules' exports — reference equality, not a grep of source — so a
// later behaviour-preserving refactor (a moved import, a reworded comment) stays
// green, while a rename of a run function correctly travels through this test's own
// import of it.
//
// WHY this exists (task E18-S09): the scheduler (E18-S10) and instrumentation
// (E18-S11) must know every in-process background job to run. One explicit, auditable
// registry is the single ignition list that wires the nine job modules of E09–E17
// into the running app, each with a stable name (so it is auditable and loggable),
// its handler (the module's run function), and the schedule/interval the scheduler
// ticks it on.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // One in-process background job: a stable machine name, the handler that runs
//   // it (the corresponding job module's run function / runnable export), and the
//   // interval in milliseconds the scheduler ticks it on.
//   interface JobRegistryEntry {
//     readonly name: string;
//     readonly handler: (...args: never[]) => unknown; // the module's run function
//     readonly intervalMs: number;                     // schedule/interval, ms, > 0
//   }
//
//   // The auditable enumeration of every background job, exactly once.
//   export const jobRegistry: readonly JobRegistryEntry[];
//
// The nine stable names (AC1), machine-stable (kebab-case) forms of the backlog's
// descriptive list "connector token-refresh, connector-health, approval-fallback,
// approval-expiry, life-admin-reminders, exchange-rates, account-purge,
// metrics-snapshot and daily-integrity-check":
//
//   connector-token-refresh, connector-health, approval-fallback, approval-expiry,
//   life-admin-reminders, exchange-rates, account-purge, metrics-snapshot,
//   daily-integrity-check
//
// Handler resolution (AC2): seven jobs have a single dedicated run function, so each
// of those handlers must BE that function (reference equality). The two connector
// jobs (token-refresh, health) share one module (`../connectors/jobs`) that exposes
// no `run*` function — it runs connector work through `createConnectorJobHandler`
// plus schedule helpers — so their handlers are checked to be a runnable export of
// that very module rather than pinned to a run function that does not exist.
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";

import { jobRegistry } from "./registry";

// The seven jobs with a dedicated, unambiguous run function — the handler must BE it.
import { runApprovalFallback } from "../notify/fallback-job";
import { runApprovalExpiry } from "../approvals/expiry-job";
import { runLifeAdminReminders } from "../life-admin/reminders-job";
import { runRatesJob } from "../currency/rates-job";
import { runAccountPurge } from "../account/purge-job";
import { runMetricsSnapshot } from "../metrics/snapshot-job";
import { runDailyIntegrityCheck } from "../activity/integrity-job";

// The two connector jobs share this module, which exposes no `run*` function.
import * as connectorJobs from "../connectors/jobs";

// Every stable name the registry MUST enumerate, exactly once (AC1).
const EXPECTED_NAMES = [
  "connector-token-refresh",
  "connector-health",
  "approval-fallback",
  "approval-expiry",
  "life-admin-reminders",
  "exchange-rates",
  "account-purge",
  "metrics-snapshot",
  "daily-integrity-check",
] as const;

// name → the job module's run function it must resolve to (AC2), for the seven jobs
// that have one. The connector jobs are handled separately (no run function exists).
const EXPECTED_RUN_FN: Record<string, unknown> = {
  "approval-fallback": runApprovalFallback,
  "approval-expiry": runApprovalExpiry,
  "life-admin-reminders": runLifeAdminReminders,
  "exchange-rates": runRatesJob,
  "account-purge": runAccountPurge,
  "metrics-snapshot": runMetricsSnapshot,
  "daily-integrity-check": runDailyIntegrityCheck,
};

const CONNECTOR_JOB_NAMES = ["connector-token-refresh", "connector-health"] as const;

// Find the single entry for a name, failing loudly if it is absent.
function entryFor(name: string): { name: string; handler: unknown; intervalMs: unknown } {
  const entry = jobRegistry.find((e) => e.name === name);
  assert.ok(entry, `registry is missing the "${name}" job`);
  return entry as { name: string; handler: unknown; intervalMs: unknown };
}

test("the registry enumerates exactly the nine background jobs, each once, with no duplicate names", () => {
  const names = jobRegistry.map((e) => e.name);

  // Exactly nine entries — no more (no stray/speculative jobs), no fewer.
  assert.equal(jobRegistry.length, 9, "the registry must hold exactly nine jobs");

  // No duplicate names: the set of names is the same size as the list.
  assert.equal(new Set(names).size, 9, "every job name must be unique (no duplicates)");

  // The names are exactly the nine required, regardless of order.
  assert.deepEqual([...names].sort(), [...EXPECTED_NAMES].sort());
});

test("every entry has a non-empty stable string name and a callable handler", () => {
  for (const name of EXPECTED_NAMES) {
    const entry = entryFor(name);
    assert.equal(typeof entry.name, "string", `${name}: name must be a string`);
    assert.ok(entry.name.length > 0, `${name}: name must be non-empty`);
    assert.equal(typeof entry.handler, "function", `${name}: handler must be a function`);
  }
});

test("every entry carries a positive numeric schedule/interval (intervalMs)", () => {
  for (const name of EXPECTED_NAMES) {
    const entry = entryFor(name);
    assert.equal(typeof entry.intervalMs, "number", `${name}: intervalMs must be a number`);
    assert.ok(
      Number.isFinite(entry.intervalMs as number),
      `${name}: intervalMs must be a finite number`,
    );
    assert.ok((entry.intervalMs as number) > 0, `${name}: intervalMs must be greater than zero`);
  }
});

test("each dedicated-run-function job's handler IS the corresponding job module's run function", () => {
  for (const [name, runFn] of Object.entries(EXPECTED_RUN_FN)) {
    const entry = entryFor(name);
    assert.equal(
      entry.handler,
      runFn,
      `${name}: handler must resolve to the corresponding job module's run function`,
    );
  }
});

test("the connector jobs' handlers resolve to a runnable export of the connectors/jobs module", () => {
  // Runtime function exports of the connector job module (types are erased), e.g.
  // createConnectorJobHandler / scheduleConnectionRefresh / scheduleGoogleLapse.
  const connectorFns = Object.values(connectorJobs).filter(
    (v): v is (...args: never[]) => unknown => typeof v === "function",
  );
  assert.ok(connectorFns.length > 0, "the connectors/jobs module must export at least one function");

  for (const name of CONNECTOR_JOB_NAMES) {
    const entry = entryFor(name);
    assert.equal(typeof entry.handler, "function", `${name}: handler must be a function`);
    assert.ok(
      connectorFns.includes(entry.handler as (...args: never[]) => unknown),
      `${name}: handler must resolve to a run function of the connectors/jobs module`,
    );
  }
});
