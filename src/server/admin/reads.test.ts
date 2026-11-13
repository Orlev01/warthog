// The admin reads (src/server/admin/reads.ts; docs/design/admin-portal.md §3): a static
// guard that the module never names a content-bearing column, and behaviour over a seeded
// database — tombstones excluded from every account count, bounds half-open, the funnel,
// milestones, active people and agents, connector health, approvals, jobs, sweeps, the
// accounts list with its filters, and the exact-address lookup — with the proof that no
// seeded content string ever appears in any result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { freshDb } from "../../test/db";
import type { RecordMetricInput } from "../metrics/record";
import * as reads from "./reads";
import { NOW, SECRET_AGENT_NAME, SECRET_CREDENTIALS, SECRET_EMAIL, SECRET_IDENTITY, SECRET_LABEL, SECRET_PAYLOAD, seedAdminWorld } from "./seed.test-helper";

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const daysAgo = (d: number) => hoursAgo(d * 24);
const WINDOW_7D = { from: daysAgo(7), to: NOW.toISOString() };

test("the reads module never names a content-bearing column or imports key material (static guard)", () => {
  const source = readFileSync(new URL("./reads.ts", import.meta.url), "utf8")
    .replaceAll("wrapped_dek <> ''", "")
    .replaceAll("wrapped_dek = ''", "")
    .replaceAll("lower(email) = $1", "");
  for (const forbidden of ["payload_ct", "credentials", "wrapped_dek", "detail", "question", "args", "secret_enc", "public_key", "credential_id", "account_label", "display_name", "endpoint", "keys", "email", "merchant", "amount", "key-wrapper", "envelope", "recorder", "dekFor", "SELECT *"]) {
    assert.doesNotMatch(source, new RegExp(`\\b${forbidden.replace(/[-*]/g, "\\$&")}\\b`), `reads.ts must not mention ${forbidden}`);
  }
});

test("metric reads: rows in a half-open window, totals, breakdowns, percentiles and latest snapshots", async () => {
  const db = await freshDb();
  try {
    await seedAdminWorld(db);
    const rows = await reads.metricRows(db, "agent.request", WINDOW_7D);
    assert.equal(rows.length, 9, "seven daily executed (days 0–6) plus the failed and refused ones");
    assert.ok(rows.every((r) => r.recordedAt >= WINDOW_7D.from && r.recordedAt < WINDOW_7D.to));
    assert.equal(await reads.metricTotal(db, "agent.request", WINDOW_7D), 9);
    assert.deepEqual(await reads.metricBreakdown(db, "agent.request", WINDOW_7D, "outcome"), [
      { label: "executed", value: 7 }, { label: "failed", value: 1 }, { label: "refused", value: 1 },
    ]);
    assert.deepEqual(await reads.metricBreakdown(db, "agent.request", WINDOW_7D, "errorCategory"), [
      { label: "denied", value: 1 }, { label: "tool_error", value: 1 },
    ]);
    const [p50, p95] = await reads.metricPercentiles(db, "agent.request.latency_ms", WINDOW_7D, [0.5, 0.95]);
    assert.ok(p50! >= 100 && p50! <= 160, `p50 ${p50}`);
    assert.ok(p95! > 160 && p95! <= 900, `p95 ${p95}`);
    assert.deepEqual(await reads.metricPercentiles(db, "nothing", WINDOW_7D, [0.5]), [null]);
    const latest = await reads.metricLatest(db, "integrity.check", "outcome");
    assert.deepEqual(latest.map((l) => [l.label, l.value]), [["fail", 0], ["pass", 3]]);
    assert.equal(reads.percentile([1, 2, 3, 4], 0.5), 2.5);
    assert.equal(reads.median([5, 1, 3]), 3);
  } finally {
    await db.close();
  }
});

test("account reads exclude tombstones and count the funnel, milestones and active people honestly", async () => {
  const db = await freshDb();
  try {
    await seedAdminWorld(db);
    assert.deepEqual(await reads.accountTotals(db), { active: 4, admins: 1, tombstones: 1 });
    assert.equal((await reads.signupInstants(db, WINDOW_7D)).length, 3, "factorOnly, reconnect and fresh signed up this week; the tombstone 40 days ago");
    assert.deepEqual(await reads.funnelCounts(db), { accounts: 4, withFactor: 3, withAgent: 2, withService: 2, withRequest: 1, withApproval: 1 });
    const milestones = await reads.milestoneInstants(db);
    assert.equal(milestones.length, 4);
    const complete = milestones.find((m) => m.firstApprovalAt !== null)!;
    assert.ok(complete.firstFactorAt! > complete.createdAt!);
    assert.ok(complete.firstRequestAt !== null && complete.firstServiceAt !== null && complete.firstAgentAt !== null);
    assert.equal(await reads.activePeople(db, daysAgo(1)), 1);
    assert.equal(await reads.activePeople(db, daysAgo(7)), 2);
    assert.equal(await reads.activePeople(db, daysAgo(30)), 3);
    assert.equal((await reads.lastSeenInstants(db, WINDOW_7D)).length, 2);
    assert.deepEqual(await reads.activeAgents(db, daysAgo(1)), { total: 1, byPlatform: [{ label: "claude", value: 1 }] });
    assert.deepEqual((await reads.activeAgents(db, daysAgo(7))).byPlatform, [{ label: "chatgpt", value: 1 }, { label: "claude", value: 1 }]);
    assert.deepEqual(await reads.agentsByPlatform(db), [{ label: "chatgpt", value: 1 }, { label: "claude", value: 1 }]);
    assert.deepEqual(await reads.householdCounts(db), { total: 1, members: 2 });
    assert.equal(await reads.adminSessionCount(db), 1);
  } finally {
    await db.close();
  }
});

test("connector, approval, activity, job, sweep and system reads", async () => {
  const db = await freshDb();
  try {
    await seedAdminWorld(db);
    assert.deepEqual(await reads.connectionsByConnector(db), [
      { connectorId: "gmail", total: 2, failing: 1 }, { connectorId: "outlook", total: 1, failing: 0 },
    ]);
    assert.deepEqual(await reads.connectorRequestCounts(db, WINDOW_7D), [{ label: "spotify", value: 2 }], "a service asked for once is not named");
    assert.equal(await reads.connectorRequestTotal(db, WINDOW_7D), 3);
    const outcomes = await reads.approvalOutcomes(db, WINDOW_7D);
    assert.deepEqual(outcomes.map((o) => o.status), ["approved", "expired"]);
    assert.equal(await reads.pendingApprovals(db), 1);
    assert.deepEqual(await reads.activityCounts(db, { from: daysAgo(30), to: NOW.toISOString() }), [{ kind: "tool_call", outcome: "executed", count: 1 }]);
    const jobs = await reads.jobHealth(db);
    assert.equal(jobs.failed, 1);
    assert.equal(jobs.pending, 1);
    assert.ok(jobs.oldestPendingAt);
    assert.deepEqual(jobs.byTypeStatus, [{ type: "approval.fallback", status: "pending", count: 1 }, { type: "connection.refresh", status: "failed", count: 1 }]);
    assert.deepEqual((await reads.sweepRuns(db)).map((s) => s.name), ["approval-expiry", "exchange-rates", "metrics-snapshot", "traffic-flush"]);
    assert.match((await reads.migrationVersion(db))!, /^01\d\d_/);
    const store = await reads.metricStoreStats(db);
    assert.ok(store.rows > 30 && store.oldestAt !== null);
    assert.equal(await reads.lockoutAlerts(db, WINDOW_7D), 1);
  } finally {
    await db.close();
  }
});

test("the accounts list and filters show operational facts only, newest first, never an address", async () => {
  const db = await freshDb();
  try {
    const seeded = await seedAdminWorld(db);
    const all = await reads.listAccounts(db, "all");
    assert.equal(all.length, 4, "the tombstone is not an account");
    assert.deepEqual(all.map((a) => a.reference), [seeded.fresh, seeded.reconnect, seeded.factorOnly, seeded.complete].map((id) => id.slice(0, 8)));
    const complete = all[3]!;
    assert.deepEqual(complete.factors, ["passkey"]);
    assert.equal(complete.agents, 1);
    assert.equal(complete.connections, 1);
    assert.equal(complete.pendingApprovals, 1);
    assert.equal(complete.household, "owner");
    assert.equal(complete.role, "admin");
    assert.ok(complete.lastActiveAt);
    assert.deepEqual(await reads.accountFilterCounts(db), { all: 4, no_factor: 1, no_agent: 2, no_service: 2, no_request: 3, needs_reconnect: 1 });
    assert.deepEqual((await reads.listAccounts(db, "needs_reconnect")).map((a) => a.reference), [seeded.reconnect.slice(0, 8)]);
    assert.deepEqual((await reads.listAccounts(db, "no_factor")).map((a) => a.reference), [seeded.fresh.slice(0, 8)]);
    assert.equal((await reads.listAccounts(db, "all", 2)).length, 2, "capped");
    const serialised = JSON.stringify(all);
    for (const secret of [SECRET_EMAIL, "example.test", SECRET_IDENTITY, SECRET_PAYLOAD, SECRET_CREDENTIALS, SECRET_LABEL, SECRET_AGENT_NAME]) {
      assert.ok(!serialised.includes(secret), `accounts list leaks ${secret}`);
    }
  } finally {
    await db.close();
  }
});

test("the exact-address lookup is case-insensitive, bound, returns facts or null, and records only the outcome", async () => {
  const db = await freshDb();
  try {
    const seeded = await seedAdminWorld(db);
    const metrics: RecordMetricInput[] = [];
    const recordMetric = async (m: RecordMetricInput) => { metrics.push(m); };
    const found = await reads.lookupAccount(db, "  Secret-Person@Example.TEST ", { recordMetric });
    assert.ok(found);
    assert.equal(found.reference, seeded.complete.slice(0, 8));
    assert.equal(found.requestCount, 12);
    assert.deepEqual(found.agentsByPlatform.map((r) => [r.key, r.value]), [["claude", 1]]);
    assert.deepEqual(found.connectionsByConnector.map((r) => [r.key, r.value]), [["gmail", 1]]);
    assert.equal(await reads.lookupAccount(db, "nobody@example.test", { recordMetric }), null);
    assert.equal(await reads.lookupAccount(db, "gone@example.test", { recordMetric }), null, "a tombstone is not found");
    assert.equal(await reads.lookupAccount(db, "' OR 1=1 --", { recordMetric }), null, "a SQL-shaped address is just an address");
    assert.deepEqual(metrics.map((m) => [m.name, m.dimensions?.outcome]), [["admin.lookup", "found"], ["admin.lookup", "none"], ["admin.lookup", "none"], ["admin.lookup", "none"]]);
    const serialised = JSON.stringify(found) + JSON.stringify(metrics);
    for (const secret of [SECRET_EMAIL, SECRET_IDENTITY, SECRET_PAYLOAD, SECRET_CREDENTIALS, SECRET_LABEL, SECRET_AGENT_NAME, seeded.complete]) {
      assert.ok(!serialised.includes(secret), `lookup leaks ${secret}`);
    }
  } finally {
    await db.close();
  }
});

test("every read copes with an empty database", async () => {
  const db = await freshDb();
  try {
    const window = { from: "2026-11-01T00:00:00Z", to: "2026-11-13T00:00:00Z" };
    assert.deepEqual(await reads.metricRows(db, "agent.request", window), []);
    assert.equal(await reads.metricTotal(db, "agent.request", window), 0);
    assert.deepEqual(await reads.metricLatest(db, "users.total", "outcome"), []);
    assert.deepEqual(await reads.accountTotals(db), { active: 0, admins: 0, tombstones: 0 });
    assert.deepEqual(await reads.funnelCounts(db), { accounts: 0, withFactor: 0, withAgent: 0, withService: 0, withRequest: 0, withApproval: 0 });
    assert.deepEqual(await reads.milestoneInstants(db), []);
    assert.equal(await reads.activePeople(db, window.from), 0);
    assert.deepEqual(await reads.activeAgents(db, window.from), { total: 0, byPlatform: [] });
    assert.deepEqual(await reads.connectionsByConnector(db), []);
    assert.deepEqual(await reads.approvalOutcomes(db, window), []);
    assert.deepEqual(await reads.jobHealth(db), { byTypeStatus: [], failed: 0, pending: 0, oldestPendingAt: null });
    assert.deepEqual(await reads.sweepRuns(db), []);
    assert.deepEqual(await reads.metricStoreStats(db), { rows: 0, oldestAt: null });
    assert.deepEqual(await reads.listAccounts(db, "all"), []);
    assert.equal(await reads.lookupAccount(db, "nobody@example.test"), null);
  } finally {
    await db.close();
  }
});
