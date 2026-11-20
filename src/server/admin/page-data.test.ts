// The admin page loaders (src/server/admin/page-data.ts; docs/design/admin-portal.md §5):
// every loader copes with an empty database, and on the seeded world each page's model
// carries the right counts, series, labels, attention items and comparisons — and never a
// seeded content string, address, agent name or account id.
import { test } from "node:test";
import assert from "node:assert/strict";

import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import type { RecordMetricInput } from "../metrics/record";
import { loadAccounts, loadOverview, loadReliability, loadSignups, loadSystem, loadTraffic, loadUsage, type AdminPageDeps } from "./page-data";
import { NOW, SECRET_AGENT_NAME, SECRET_CREDENTIALS, SECRET_EMAIL, SECRET_IDENTITY, SECRET_LABEL, SECRET_PAYLOAD, seedAdminWorld } from "./seed.test-helper";

const SYDNEY = "Australia/Sydney";

function depsFor(db: Awaited<ReturnType<typeof freshDb>>, metrics: RecordMetricInput[] = []): AdminPageDeps {
  return {
    db, clock: fixedClock(NOW), timeZone: SYDNEY, smsEnabled: false, azureMetricsUrl: "https://portal.azure.test/apps",
    recordMetric: async (m) => { metrics.push(m); },
    connectorName: (id) => (id === "outlook" ? "Outlook (catalogue)" : undefined),
  };
}

async function everything(deps: AdminPageDeps) {
  return {
    overview: await loadOverview(deps, "7d"),
    signups: await loadSignups(deps, "7d"),
    usage: await loadUsage(deps, "30d"),
    accounts: await loadAccounts(deps, { email: SECRET_EMAIL, filter: "all" }),
    reliability: await loadReliability(deps, "7d"),
    traffic: await loadTraffic(deps, "today"),
    system: await loadSystem(deps),
  };
}

test("every loader copes with an empty database", async () => {
  const db = await freshDb();
  try {
    const all = await everything(depsFor(db));
    assert.equal(all.overview.tiles.signups.value, 0);
    assert.equal(all.overview.tiles.needsAttention, 0);
    assert.deepEqual(all.overview.attention, []);
    assert.equal(all.overview.funnel[0]!.count, 0);
    assert.equal(all.overview.trends.requests.length, 7, "zero-filled buckets");
    assert.equal(all.signups.funnel.length, 4);
    assert.deepEqual(all.signups.refusals, []);
    assert.equal(all.usage.requests.latency.p50, null);
    assert.equal(all.usage.approvals.expiryRate, null);
    assert.deepEqual(all.accounts.accounts, []);
    assert.equal(all.accounts.lookup.searched, true);
    assert.equal(all.accounts.lookup.account, null);
    assert.equal(all.reliability.integrity.lastRunAt, null);
    assert.ok(all.reliability.sweeps.every((s) => !s.overdue), "nothing has ticked, nothing is overdue");
    assert.equal(all.traffic.requests.value, 0);
    assert.equal(all.traffic.todayByHour.length, 10);
    assert.equal(all.system.migration?.startsWith("01"), true);
    assert.equal(all.system.schedulerLastTickAt, null);
  } finally {
    await db.close();
  }
});

test("the overview compares the window with the one before and names what needs attention", async () => {
  const db = await freshDb();
  try {
    await seedAdminWorld(db);
    const overview = await loadOverview(depsFor(db), "7d");
    assert.equal(overview.range.label, "the last 7 days");
    assert.deepEqual(overview.tiles.signups.series.map((p) => p.value), [0, 1, 0, 1, 0, 0, 1], "8, 10 and 13 November");
    assert.equal(overview.tiles.signups.value, 3);
    assert.equal(overview.tiles.signups.previous, 0);
    assert.equal(overview.tiles.activePeople.value, 2, "two people seen this week");
    assert.equal(overview.tiles.activePeople.previous, 1, "one person last seen the week before");
    assert.equal(overview.tiles.agentRequests.value, 9);
    assert.equal(overview.tiles.agentRequests.failed, 2);
    assert.equal(overview.tiles.agentRequests.previous, 3);
    assert.equal(overview.tiles.approvalsDecided.value, 1);
    assert.equal(overview.tiles.approvalsDecided.medianResponseMs, 240_000);
    assert.deepEqual(overview.funnel.map((s) => [s.label, s.count]), [
      ["Accounts", 4], ["Added a second factor", 3], ["Connected an agent", 2], ["Connected a service", 2], ["Had an agent request handled", 1], ["Decided an approval", 1],
    ]);
    assert.equal(overview.funnel[1]!.href, "/accounts?filter=no_factor");
    assert.deepEqual(overview.topServices.map((s) => [s.label, s.value, s.brand]), [["Gmail", 2, "gmail"], ["Outlook (catalogue)", 1, "outlook"]]);
    const ids = overview.attention.map((a) => a.id);
    assert.ok(ids.includes("reconnect"), "a failing connection");
    assert.ok(ids.includes("sweep-exchange-rates"), "the rates sweep is five days stale");
    assert.ok(ids.includes("jobs"), "a failed job");
    assert.ok(ids.includes("lockouts"), "a lockout alert");
    assert.ok(!ids.includes("integrity"), "the last integrity check passed");
    assert.equal(overview.tiles.needsAttention, overview.attention.length);
    const reconnect = overview.attention.find((a) => a.id === "reconnect")!;
    assert.equal(reconnect.text, "1 connection needs reconnecting (Gmail).");
    assert.equal(reconnect.href, "/accounts?filter=needs_reconnect");
    assert.match(overview.attention.find((a) => a.id === "sweep-exchange-rates")!.text, /exchange rates sweep last ran 5 days ago/);
    assert.equal(overview.trends.requests.reduce((n, p) => n + p.value, 0), 9);
  } finally {
    await db.close();
  }
});

test("sign-ups, usage, reliability, traffic and system models carry labelled, zero-filled, compared numbers", async () => {
  const db = await freshDb();
  try {
    await seedAdminWorld(db);
    const deps = depsFor(db);
    const signups = await loadSignups(deps, "7d");
    assert.deepEqual(signups.funnel.map((s) => s.count), [2, 1, 1, 1]);
    assert.deepEqual(signups.refusals.map((r) => [r.label, r.value]), [["Throttled", 1]]);
    assert.deepEqual(signups.factors.map((f) => [f.label, f.value]), [["Passkey", 1]]);
    assert.equal(signups.activeAccounts, 4);
    const factor = signups.milestones.find((m) => m.key === "factor")!;
    assert.equal(factor.reached, 3);
    assert.equal(factor.of, 4);
    assert.ok(factor.medianDays !== null && factor.medianDays >= 0 && factor.medianDays <= 1);

    const usage = await loadUsage(deps, "30d");
    assert.deepEqual(usage.activePeople, { today: 1, week: 2, month: 3 });
    assert.deepEqual([usage.activeAgents.today, usage.activeAgents.week, usage.activeAgents.month], [1, 2, 2]);
    assert.deepEqual(usage.activeAgents.byPlatform.map((p) => p.label), ["ChatGPT", "Claude"]);
    assert.equal(usage.requests.total.value, 12);
    assert.deepEqual(usage.requests.byOutcome.map((r) => [r.label, r.value, r.tone]), [["Completed", 10, "success"], ["Failed", 1, "danger"], ["Refused", 1, "danger"]]);
    assert.deepEqual(usage.requests.byConnector.map((r) => [r.label, r.brand]), [["Gmail", "gmail"]]);
    assert.ok(usage.requests.latency.p50 !== null && usage.requests.latency.p95 !== null);
    assert.equal(usage.approvals.decided.value, 2);
    assert.deepEqual(usage.approvals.expiryRate, { numerator: 1, denominator: 3 });
    assert.equal(usage.approvals.pending, 1);
    assert.deepEqual(usage.connections.map((c) => [c.label, c.value, c.failing]), [["Gmail", 2, 1], ["Outlook (catalogue)", 1, 0]]);
    assert.deepEqual(usage.servicesRequested.map((s) => [s.label, s.value]), [["spotify", 2], ["All requests for a service", 3]]);

    const reliability = await loadReliability(deps, "7d");
    assert.deepEqual(reliability.signins.byOutcome.map((r) => [r.label, r.value]), [["Failed", 2], ["Succeeded", 1]]);
    assert.deepEqual(reliability.signins.failedByCategory.map((r) => [r.label, r.value]), [["Authenticator code", 1], ["Passkey", 1]]);
    assert.equal(reliability.signins.lockoutAlerts, 1);
    assert.equal(reliability.agentErrors.failed.value, 2);
    assert.deepEqual(reliability.agentErrors.byCategory.map((r) => r.label), ["Denied by a rule", "Tool error"]);
    assert.deepEqual(reliability.connectors.needsReconnect.map((r) => [r.label, r.value]), [["Gmail", 1]]);
    assert.deepEqual(reliability.connectors.refreshFailures.map((r) => [r.label, r.value]), [["Gmail", 1]]);
    assert.deepEqual(reliability.integrity, { lastRunAt: reliability.integrity.lastRunAt, passed: 3, failed: 0 });
    assert.ok(reliability.integrity.lastRunAt);
    assert.equal(reliability.jobs.failed, 1);
    assert.equal(reliability.jobs.failuresSeries.reduce((n, p) => n + p.value, 0), 1);
    assert.ok(reliability.sweeps.find((s) => s.name === "exchange-rates")!.overdue);
    assert.ok(!reliability.sweeps.find((s) => s.name === "approval-expiry")!.overdue);
    assert.ok(reliability.sweeps.find((s) => s.name === "operator-role")!.overdue, "never ran while the scheduler ticks");

    const traffic = await loadTraffic(deps, "today");
    assert.equal(traffic.requests.value, 28);
    assert.equal(traffic.documents.value, 7);
    assert.equal(traffic.limited, 1);
    assert.deepEqual(traffic.byRoute.map((r) => [r.label, r.value]), [["Member pages", 25], ["Admin portal", 2], ["Sign-in and sign-up", 1]]);
    assert.deepEqual(traffic.byHost.map((r) => [r.label, r.value]), [["App", 26], ["Admin portal", 2]]);
    assert.equal(traffic.todayByHour.reduce((n, p) => n + p.value, 0), 28);
    assert.equal(traffic.azureMetricsUrl, "https://portal.azure.test/apps");

    const system = await loadSystem(deps);
    assert.deepEqual(system.accounts, { active: 4, admins: 1, tombstones: 1 });
    assert.deepEqual(system.households, { total: 1, members: 2 });
    assert.equal(system.adminSessions, 1);
    assert.equal(system.metricEvents.retentionDays, 400);
    assert.ok(system.schedulerLastTickAt);
    assert.equal(system.sweeps.length, 11);
  } finally {
    await db.close();
  }
});

test("the accounts page looks one address up, filters the list, and records only the lookup outcome", async () => {
  const db = await freshDb();
  try {
    const seeded = await seedAdminWorld(db);
    const metrics: RecordMetricInput[] = [];
    const deps = depsFor(db, metrics);
    const found = await loadAccounts(deps, { email: SECRET_EMAIL.toUpperCase(), filter: "needs_reconnect" });
    assert.equal(found.lookup.searched, true);
    assert.equal(found.lookup.account?.reference, seeded.complete.slice(0, 8));
    assert.deepEqual(found.lookup.account?.agentsByPlatform.map((r) => r.label), ["Claude"]);
    assert.deepEqual(found.lookup.account?.connectionsByConnector.map((r) => r.label), ["Gmail"]);
    assert.equal(found.filter, "needs_reconnect");
    assert.deepEqual(found.accounts.map((a) => a.reference), [seeded.reconnect.slice(0, 8)]);
    assert.equal(found.total, 4);
    assert.equal(found.counts.no_factor, 1);
    const unknownFilter = await loadAccounts(deps, { filter: "drop table" });
    assert.equal(unknownFilter.filter, "all");
    assert.equal(unknownFilter.lookup.searched, false);
    assert.equal(unknownFilter.accounts.length, 4);
    assert.deepEqual(metrics.map((m) => [m.name, m.dimensions?.outcome]), [["admin.lookup", "found"]]);
  } finally {
    await db.close();
  }
});

test("no loader output ever carries an address, identity value, payload, credential, label or account id", async () => {
  const db = await freshDb();
  try {
    const seeded = await seedAdminWorld(db);
    const all = await everything(depsFor(db));
    const serialised = JSON.stringify(all);
    for (const secret of [SECRET_EMAIL, "@example.test", SECRET_IDENTITY, SECRET_PAYLOAD, SECRET_CREDENTIALS, SECRET_LABEL, SECRET_AGENT_NAME, seeded.complete, seeded.reconnect, "Once Only Service"]) {
      assert.ok(!serialised.includes(secret), `a loader leaks ${secret}`);
    }
  } finally {
    await db.close();
  }
});

test("Traffic counts Azure's health checks on their own, outside the requests, page loads and breakdowns", async () => {
  const db = await freshDb();
  try {
    const counted = (value: number, outcome: string, hoursAgo: number) =>
      db.query(
        "INSERT INTO metric_events (name, value, recorded_at, outcome) VALUES ('http.requests', $1, $2::timestamptz, $3)",
        [value, new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(), outcome],
      );
    // An hour of Azure's probes (readiness every 5 s, liveness every 10 s) beside a little real traffic.
    await counted(1080, "app.health.fetch", 1);
    await counted(4, "app.portal.document", 1);
    await counted(6, "app.portal.fetch", 1);
    await counted(2, "admin.admin.document", 1);
    await counted(900, "app.health.fetch", 24 * 8);
    await counted(5, "app.portal.fetch", 24 * 8);

    const traffic = await loadTraffic(depsFor(db), "7d");
    assert.deepEqual(traffic.requests, { value: 12, previous: 5 }, "requests are what people and agents asked for");
    assert.deepEqual(traffic.healthChecks, { value: 1080, previous: 900 });
    assert.equal(traffic.documents.value, 6);
    assert.deepEqual(traffic.byRoute.map((r) => [r.label, r.value]), [["Member pages", 10], ["Admin portal", 2]]);
    assert.deepEqual(traffic.byHost.map((r) => [r.label, r.value]), [["App", 10], ["Admin portal", 2]]);
    assert.equal(traffic.series.requests.reduce((n, p) => n + p.value, 0), 12);
    assert.equal(traffic.series.healthChecks.reduce((n, p) => n + p.value, 0), 1080);
    assert.equal(traffic.todayByHour.reduce((n, p) => n + p.value, 0), 12, "today's hours count requests, not health checks");
  } finally {
    await db.close();
  }
});
