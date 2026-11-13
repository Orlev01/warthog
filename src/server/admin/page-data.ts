// The admin portal's page loaders (docs/design/admin-portal.md §5): one per page, each
// composing the allowlisted reads (./reads.ts) and the range windows (src/domain/admin/range.ts)
// into that page's view model (src/domain/admin/model.ts). Loaders format nothing for
// display and fetch nothing the reads module does not expose; they turn identifiers into
// plain-word labels, zero-fill series over the window's buckets, compare the window with the
// one before it, and name what needs attention as sentences with links. Every loader copes
// with an empty database.

import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import type { MetricSeam } from "../metrics/seam";
import {
  ACCOUNT_FILTERS,
  type AccountFilter, type AccountsModel, type AttentionItem, type BreakdownRow, type FunnelStep, type Measure,
  type MilestoneRow, type OverviewModel, type RangeKey, type RangeWindow, type ReliabilityModel, type SeriesPoint,
  type SignupsModel, type SweepRow, type SystemModel, type TrafficModel, type UsageModel,
} from "../../domain/admin/model";
import { bucketStarts, fillSeries, hoursOfToday, measure, rangeWindow } from "../../domain/admin/range";
import { SWEEP_INTERVALS, sweepOverdue } from "../../domain/admin/sweeps";
import {
  connectorLabel, errorCategoryLabel, factorLabel, hostLabel, outcomeLabel, platformLabel, routeLabel, sweepLabel,
} from "../../domain/admin/labels";
import {
  AGENT_REQUEST, AGENT_REQUEST_LATENCY, APPROVAL_RESPONSE_TIME, CONNECTOR_CONNECT, CONNECTOR_REFRESH, HTTP_REQUESTS,
  INTEGRITY_CHECK, JOB_FAILURE, SIGNIN_ATTEMPT, SIGNUP_COMPLETED, SIGNUP_STEP, parseTrafficLabel,
} from "../metrics/names";
import { METRIC_RETENTION_DAYS } from "../metrics/retention";
import * as reads from "./reads";

export interface AdminPageDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly timeZone: string;
  readonly smsEnabled: boolean;
  readonly azureMetricsUrl?: string | null;
  readonly recordMetric?: MetricSeam;
  // A connector's catalogue name, for ids without a known brand mark (optional seam).
  readonly connectorName?: (id: string) => string | undefined;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// Agent request outcomes that are neither completed nor merely waiting for a person.
const FAILED_OUTCOMES = new Set(["refused", "failed", "error", "unknown"]);

type Win = Pick<RangeWindow, "from" | "to">;
function previousOf(window: RangeWindow): Win {
  return { from: window.previousFrom, to: window.previousTo };
}

function series(window: RangeWindow, timeZone: string, rows: readonly reads.MetricRow[]): SeriesPoint[] {
  return fillSeries(window, timeZone, rows.map((r) => ({ at: r.recordedAt, value: r.value })));
}

function instantsSeries(window: RangeWindow, timeZone: string, instants: readonly string[]): SeriesPoint[] {
  return fillSeries(window, timeZone, instants.map((at) => ({ at, value: 1 })));
}

function sum(rows: readonly { value: number }[]): number {
  return rows.reduce((n, r) => n + r.value, 0);
}

function sorted(rows: BreakdownRow[]): BreakdownRow[] {
  return [...rows].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

function byDimension(rows: readonly reads.MetricRow[], pick: (r: reads.MetricRow) => string | null, label: (key: string) => string, brand = false): BreakdownRow[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const key = pick(row);
    if (key === null) continue;
    totals.set(key, (totals.get(key) ?? 0) + row.value);
  }
  return sorted([...totals.entries()].map(([key, value]) => ({ key, label: label(key), value, ...(brand ? { brand: key } : {}) })));
}

function failedRequests(rows: readonly reads.MetricRow[]): reads.MetricRow[] {
  return rows.filter((r) => r.outcome !== null && FAILED_OUTCOMES.has(r.outcome));
}

function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  return (new Date(to).getTime() - new Date(from).getTime()) / DAY_MS;
}

function sweepRows(runs: readonly { name: string; lastRunAt: string }[], now: Date): SweepRow[] {
  const ran = new Map(runs.map((r) => [r.name, r.lastRunAt]));
  const ticked = runs.length > 0;
  return Object.keys(SWEEP_INTERVALS).map((name) => {
    const lastRunAt = ran.get(name) ?? null;
    return { name, intervalMs: SWEEP_INTERVALS[name]!, lastRunAt, overdue: sweepOverdue(name, lastRunAt ? new Date(lastRunAt) : null, now, ticked) };
  });
}

function schedulerLastTick(runs: readonly { lastRunAt: string }[]): string | null {
  return runs.reduce<string | null>((latest, r) => (latest === null || r.lastRunAt > latest ? r.lastRunAt : latest), null);
}

function base(deps: AdminPageDeps, key: RangeKey) {
  const now = deps.clock.now();
  return { now, range: rangeWindow(key, now, deps.timeZone), timeZone: deps.timeZone, generatedAt: now.toISOString() };
}

// --- The activation funnel and milestones, shared by Overview and Sign-ups ---------------------

const FUNNEL: readonly { key: keyof reads.FunnelCounts; label: string; filter?: AccountFilter }[] = [
  { key: "accounts", label: "Accounts" },
  { key: "withFactor", label: "Added a second factor", filter: "no_factor" },
  { key: "withAgent", label: "Connected an agent", filter: "no_agent" },
  { key: "withService", label: "Connected a service", filter: "no_service" },
  { key: "withRequest", label: "Had an agent request handled", filter: "no_request" },
  { key: "withApproval", label: "Decided an approval" },
];

async function activationFunnel(db: Db): Promise<FunnelStep[]> {
  const counts = await reads.funnelCounts(db);
  return FUNNEL.map((step) => ({
    key: step.key, label: step.label, count: counts[step.key],
    ...(step.filter ? { href: `/accounts?filter=${step.filter}` } : {}),
  }));
}

async function milestones(db: Db): Promise<MilestoneRow[]> {
  const rows = await reads.milestoneInstants(db);
  const of = rows.length;
  const row = (key: string, label: string, pick: (r: reads.MilestoneInstants) => string | null, filter?: AccountFilter): MilestoneRow => {
    const days = rows.map((r) => daysBetween(r.createdAt, pick(r))).filter((d): d is number => d !== null && d >= 0);
    return {
      key, label, reached: rows.filter((r) => pick(r) !== null).length, of,
      medianDays: reads.median(days), ...(filter ? { href: `/accounts?filter=${filter}` } : {}),
    };
  };
  return [
    row("factor", "Added a second factor", (r) => r.firstFactorAt, "no_factor"),
    row("agent", "Connected an agent", (r) => r.firstAgentAt, "no_agent"),
    row("service", "Connected a service", (r) => r.firstServiceAt, "no_service"),
    row("request", "Had an agent request handled", (r) => r.firstRequestAt, "no_request"),
    row("approval", "Decided an approval", (r) => r.firstApprovalAt),
  ];
}

// --- Approvals ----------------------------------------------------------------------------------

async function approvalHealth(db: Db, window: RangeWindow, timeZone: string) {
  const outcomes = await reads.approvalOutcomes(db, window);
  const previous = await reads.approvalOutcomes(db, previousOf(window));
  const decided = outcomes.filter((o) => o.status !== "expired");
  const settled = outcomes.length;
  const expired = outcomes.filter((o) => o.status === "expired").length;
  const [medianResponseMs, p95ResponseMs] = await reads.metricPercentiles(db, APPROVAL_RESPONSE_TIME, window, [0.5, 0.95]);
  return {
    decidedSeries: instantsSeries(window, timeZone, decided.map((o) => o.at)),
    decided: measure(decided.length, previous.filter((o) => o.status !== "expired").length),
    medianResponseMs: medianResponseMs ?? null, p95ResponseMs: p95ResponseMs ?? null,
    expiryRate: settled > 0 ? { numerator: expired, denominator: settled } : null,
    pending: await reads.pendingApprovals(db),
  };
}

// --- What needs attention ------------------------------------------------------------------------

async function attention(deps: AdminPageDeps, window: RangeWindow, now: Date): Promise<AttentionItem[]> {
  const { db } = deps;
  const items: AttentionItem[] = [];
  const connectors = await reads.connectionsByConnector(db);
  const failing = connectors.filter((c) => c.failing > 0);
  const failingTotal = sum(failing.map((c) => ({ value: c.failing })));
  if (failingTotal > 0) {
    const names = failing.map((c) => connectorLabel(c.connectorId, deps.connectorName)).join(", ");
    items.push({ id: "reconnect", tone: "warning", href: "/accounts?filter=needs_reconnect",
      text: failingTotal === 1 ? `1 connection needs reconnecting (${names}).` : `${failingTotal} connections need reconnecting (${names}).` });
  }
  const approvals = await reads.approvalOutcomes(db, window);
  const expired = approvals.filter((a) => a.status === "expired").length;
  if (approvals.length >= 4 && expired / approvals.length >= 0.25) {
    items.push({ id: "expiry", tone: "warning", href: "/usage", text: `${expired} of ${approvals.length} approvals expired unanswered ${window.label}.` });
  }
  const runs = await reads.sweepRuns(db);
  for (const sweep of sweepRows(runs, now).filter((s) => s.overdue)) {
    const ago = sweep.lastRunAt ? describeAge(now.getTime() - new Date(sweep.lastRunAt).getTime()) : null;
    items.push({ id: `sweep-${sweep.name}`, tone: "danger", href: "/system",
      text: ago ? `The ${sweepLabel(sweep.name).toLowerCase()} sweep last ran ${ago} ago.` : `The ${sweepLabel(sweep.name).toLowerCase()} sweep has not run yet.` });
  }
  const jobs = await reads.jobHealth(db);
  if (jobs.failed > 0) items.push({ id: "jobs", tone: "danger", href: "/reliability", text: jobs.failed === 1 ? "1 background job has failed." : `${jobs.failed} background jobs have failed.` });
  const integrity = await reads.metricLatest(db, INTEGRITY_CHECK, "outcome");
  const integrityFailed = integrity.find((i) => i.label === "fail")?.value ?? 0;
  if (integrityFailed > 0) items.push({ id: "integrity", tone: "danger", href: "/reliability", text: `The last integrity check failed for ${integrityFailed} ${integrityFailed === 1 ? "account" : "accounts"}.` });
  const signins = await reads.metricRows(db, SIGNIN_ATTEMPT, window);
  const failedSignins = sum(signins.filter((s) => s.outcome === "failed"));
  const okSignins = sum(signins.filter((s) => s.outcome === "ok"));
  if (failedSignins >= 5 && failedSignins > okSignins) items.push({ id: "signins", tone: "warning", href: "/reliability", text: `${failedSignins} sign-in attempts failed ${window.label}, more than succeeded.` });
  const lockouts = await reads.lockoutAlerts(db, window);
  if (lockouts > 0) items.push({ id: "lockouts", tone: "danger", href: "/reliability", text: lockouts === 1 ? `1 account was locked out after repeated failed sign-ins ${window.label}.` : `${lockouts} accounts were locked out after repeated failed sign-ins ${window.label}.` });
  const requests = await reads.metricRows(db, AGENT_REQUEST, window);
  const requestTotal = sum(requests);
  const requestFailed = sum(failedRequests(requests));
  if (requestTotal >= 10 && requestFailed / requestTotal > 0.2) items.push({ id: "requests", tone: "warning", href: "/reliability", text: `${requestFailed} of ${requestTotal} agent requests failed or were refused ${window.label}.` });
  return items;
}

function describeAge(ms: number): string {
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < 1) return `${Math.max(1, Math.floor(ms / 60_000))} minutes`;
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

// --- Loaders -------------------------------------------------------------------------------------

export async function loadOverview(deps: AdminPageDeps, key: RangeKey): Promise<OverviewModel> {
  const { db, timeZone } = deps;
  const { now, range, generatedAt } = base(deps, key);
  const previous = previousOf(range);
  const signups = await reads.signupInstants(db, range);
  const previousSignups = await reads.signupInstants(db, previous);
  const requests = await reads.metricRows(db, AGENT_REQUEST, range);
  const previousRequests = await reads.metricTotal(db, AGENT_REQUEST, previous);
  const approvals = await approvalHealth(db, range, timeZone);
  const items = await attention(deps, range, now);
  const seen = await reads.lastSeenInstants(db, range);
  const connectors = await reads.connectionsByConnector(db);
  return {
    range, timeZone, generatedAt,
    tiles: {
      signups: { ...measure(signups.length, previousSignups.length), series: instantsSeries(range, timeZone, signups) },
      activePeople: measure(await reads.activePeople(db, range.from), await reads.activePeopleBetween(db, previous)),
      agentRequests: { ...measure(sum(requests), previousRequests), failed: sum(failedRequests(requests)) },
      approvalsDecided: { ...approvals.decided, medianResponseMs: approvals.medianResponseMs },
      needsAttention: items.length,
    },
    attention: items,
    funnel: await activationFunnel(db),
    trends: {
      signups: instantsSeries(range, timeZone, signups),
      activePeople: instantsSeries(range, timeZone, seen),
      requests: series(range, timeZone, requests),
    },
    topServices: sorted(connectors.map((c) => ({ key: c.connectorId, label: connectorLabel(c.connectorId, deps.connectorName), value: c.total, brand: c.connectorId }))).slice(0, 8),
  };
}

export async function loadSignups(deps: AdminPageDeps, key: RangeKey): Promise<SignupsModel> {
  const { db, timeZone } = deps;
  const { range, generatedAt } = base(deps, key);
  const signups = await reads.signupInstants(db, range);
  const previousSignups = await reads.signupInstants(db, previousOf(range));
  const steps = await reads.metricRows(db, SIGNUP_STEP, range);
  const completed = await reads.metricRows(db, SIGNUP_COMPLETED, range);
  const stepCount = (outcome: string) => sum(steps.filter((s) => s.outcome === outcome));
  const completedOk = completed.filter((c) => c.outcome === "ok");
  const refusal = (key: string, label: string, value: number): BreakdownRow => ({ key, label, value, tone: "warning" });
  return {
    range, timeZone, generatedAt,
    perBucket: instantsSeries(range, timeZone, signups),
    total: measure(signups.length, previousSignups.length),
    activeAccounts: (await reads.accountTotals(db)).active,
    funnel: [
      { key: "code_sent", label: "Asked for a code", count: stepCount("code_sent") },
      { key: "email_verified", label: "Verified their email", count: stepCount("email_verified") },
      { key: "factor_enrolled", label: "Added a second factor", count: stepCount("factor_enrolled") },
      { key: "completed", label: "Finished signing up", count: sum(completedOk) },
    ],
    refusals: sorted([
      refusal("throttled", outcomeLabel("throttled"), stepCount("throttled")),
      refusal("code_rejected", outcomeLabel("code_rejected"), stepCount("code_rejected")),
      refusal("account_exists", outcomeLabel("account_exists"), sum(completed.filter((c) => c.outcome === "account_exists"))),
    ].filter((r) => r.value > 0)),
    factors: byDimension(completedOk, (r) => r.platform, factorLabel),
    milestones: await milestones(db),
  };
}

export async function loadUsage(deps: AdminPageDeps, key: RangeKey): Promise<UsageModel> {
  const { db, timeZone } = deps;
  const { now, range, generatedAt } = base(deps, key);
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const monthAgo = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const requests = await reads.metricRows(db, AGENT_REQUEST, range);
  const previousRequests = await reads.metricTotal(db, AGENT_REQUEST, previousOf(range));
  const [p50, p95] = await reads.metricPercentiles(db, AGENT_REQUEST_LATENCY, range, [0.5, 0.95]);
  const monthAgents = await reads.activeAgents(db, monthAgo);
  const connections = await reads.connectionsByConnector(db);
  const requestsTotal = await reads.connectorRequestTotal(db, range);
  return {
    range, timeZone, generatedAt,
    activePeople: { today: await reads.activePeople(db, dayAgo), week: await reads.activePeople(db, weekAgo), month: await reads.activePeople(db, monthAgo) },
    activeAgents: {
      today: (await reads.activeAgents(db, dayAgo)).total,
      week: (await reads.activeAgents(db, weekAgo)).total,
      month: monthAgents.total,
      byPlatform: sorted(monthAgents.byPlatform.map((p) => ({ key: p.label, label: platformLabel(p.label), value: p.value, brand: p.label }))),
    },
    requests: {
      series: series(range, timeZone, requests),
      total: measure(sum(requests), previousRequests),
      byOutcome: byDimension(requests, (r) => r.outcome, outcomeLabel).map((row) => ({ ...row, tone: FAILED_OUTCOMES.has(row.key) ? "danger" : row.key === "executed" ? "success" : "neutral" })),
      byPlatform: byDimension(requests, (r) => r.platform, platformLabel, true),
      byConnector: byDimension(requests, (r) => r.connectorId, (id) => connectorLabel(id, deps.connectorName), true),
      latency: { p50: p50 ?? null, p95: p95 ?? null },
    },
    approvals: await approvalHealth(db, range, timeZone),
    connections: sorted(connections.map((c) => ({ key: c.connectorId, label: connectorLabel(c.connectorId, deps.connectorName), value: c.total, brand: c.connectorId, failing: c.failing, tone: c.failing > 0 ? "warning" : "neutral" }))) as (BreakdownRow & { failing: number })[],
    servicesRequested: [
      ...(await reads.connectorRequestCounts(db, range)).map((r) => ({ key: r.label, label: r.label, value: r.value })),
      ...(requestsTotal > 0 ? [{ key: "_total", label: "All requests for a service", value: requestsTotal }] : []),
    ],
  };
}

export async function loadAccounts(deps: AdminPageDeps, input: { email?: string | null; filter?: string | null }): Promise<AccountsModel> {
  const { db, timeZone } = deps;
  const generatedAt = deps.clock.now().toISOString();
  const filter: AccountFilter = (ACCOUNT_FILTERS as readonly string[]).includes(input.filter ?? "") ? (input.filter as AccountFilter) : "all";
  const address = input.email?.trim() ?? "";
  const account = address ? await reads.lookupAccount(db, address, { recordMetric: deps.recordMetric }) : null;
  const facts = account
    ? {
        ...account,
        agentsByPlatform: account.agentsByPlatform.map((r) => ({ ...r, label: platformLabel(r.key) })),
        connectionsByConnector: account.connectionsByConnector.map((r) => ({ ...r, label: connectorLabel(r.key, deps.connectorName) })),
      }
    : null;
  const counts = await reads.accountFilterCounts(db);
  return {
    timeZone, generatedAt,
    lookup: { searched: address.length > 0, account: facts },
    filter, counts,
    accounts: await reads.listAccounts(db, filter),
    total: counts.all,
  };
}

export async function loadReliability(deps: AdminPageDeps, key: RangeKey): Promise<ReliabilityModel> {
  const { db, timeZone } = deps;
  const { now, range, generatedAt } = base(deps, key);
  const previous = previousOf(range);
  const signins = await reads.metricRows(db, SIGNIN_ATTEMPT, range);
  const failedSignins = signins.filter((s) => s.outcome === "failed");
  const requests = await reads.metricRows(db, AGENT_REQUEST, range);
  const previousRequests = await reads.metricRows(db, AGENT_REQUEST, previous);
  const failed = failedRequests(requests);
  const connectors = await reads.connectionsByConnector(db);
  const refreshes = await reads.metricRows(db, CONNECTOR_REFRESH, range);
  const connects = await reads.metricRows(db, CONNECTOR_CONNECT, range);
  const integrity = await reads.metricLatest(db, INTEGRITY_CHECK, "outcome");
  const jobs = await reads.jobHealth(db);
  const jobFailures = await reads.metricRows(db, JOB_FAILURE, range);
  const runs = await reads.sweepRuns(db);
  const connectorRow = (id: string, value: number, tone: BreakdownRow["tone"]): BreakdownRow => ({ key: id, label: connectorLabel(id, deps.connectorName), value, brand: id, tone });
  return {
    range, timeZone, generatedAt,
    signins: {
      byOutcome: byDimension(signins, (r) => r.outcome, outcomeLabel).map((row) => ({ ...row, tone: row.key === "ok" ? "success" : row.key === "failed" ? "danger" : "warning" })),
      failedByCategory: byDimension(failedSignins, (r) => r.errorCategory, errorCategoryLabel).map((row) => ({ ...row, tone: "danger" })),
      failedSeries: series(range, timeZone, failedSignins),
      lockoutAlerts: await reads.lockoutAlerts(db, range),
    },
    agentErrors: {
      total: measure(sum(requests), sum(previousRequests)),
      failed: measure(sum(failed), sum(failedRequests(previousRequests))),
      byCategory: byDimension(failed, (r) => r.errorCategory, errorCategoryLabel).map((row) => ({ ...row, tone: "danger" })),
      byPlatform: byDimension(failed, (r) => r.platform, platformLabel, true),
      byConnector: byDimension(failed, (r) => r.connectorId, (id) => connectorLabel(id, deps.connectorName), true),
    },
    connectors: {
      needsReconnect: sorted(connectors.filter((c) => c.failing > 0).map((c) => connectorRow(c.connectorId, c.failing, "warning"))),
      refreshFailures: byDimension(refreshes.filter((r) => r.outcome !== "ok"), (r) => r.connectorId, (id) => connectorLabel(id, deps.connectorName), true).map((row) => ({ ...row, tone: "danger" })),
      connectFailures: byDimension(connects.filter((r) => r.outcome !== "ok"), (r) => r.connectorId, (id) => connectorLabel(id, deps.connectorName), true).map((row) => ({ ...row, tone: "warning" })),
    },
    integrity: {
      lastRunAt: integrity.length ? integrity.map((i) => i.recordedAt).sort().at(-1)! : null,
      passed: integrity.find((i) => i.label === "pass")?.value ?? null,
      failed: integrity.find((i) => i.label === "fail")?.value ?? null,
    },
    jobs: { ...jobs, failuresSeries: series(range, timeZone, jobFailures) },
    sweeps: sweepRows(runs, now),
  };
}

export async function loadTraffic(deps: AdminPageDeps, key: RangeKey): Promise<TrafficModel> {
  const { db, timeZone } = deps;
  const { now, range, generatedAt } = base(deps, key);
  const rows = await reads.metricRows(db, HTTP_REQUESTS, range);
  const previousRows = await reads.metricRows(db, HTTP_REQUESTS, previousOf(range));
  const parsed = (r: reads.MetricRow) => parseTrafficLabel(r.outcome);
  const documents = (list: readonly reads.MetricRow[]) => list.filter((r) => parsed(r)?.kind === "document");
  const todayRows = await reads.metricRows(db, HTTP_REQUESTS, { from: hoursOfToday(now, timeZone).from, to: now.toISOString() });
  return {
    range, timeZone, generatedAt,
    requests: measure(sum(rows), sum(previousRows)),
    documents: measure(sum(documents(rows)), sum(documents(previousRows))),
    limited: sum(rows.filter((r) => parsed(r)?.kind === "limited")),
    series: { requests: series(range, timeZone, rows), documents: series(range, timeZone, documents(rows)) },
    byRoute: byDimension(rows, (r) => parsed(r)?.route ?? null, (route) => routeLabel(route as Parameters<typeof routeLabel>[0])),
    byHost: byDimension(rows, (r) => parsed(r)?.host ?? null, (host) => hostLabel(host as Parameters<typeof hostLabel>[0])),
    todayByHour: fillSeries(hoursOfToday(now, timeZone), timeZone, todayRows.map((r) => ({ at: r.recordedAt, value: r.value }))),
    azureMetricsUrl: deps.azureMetricsUrl ?? null,
  };
}

export async function loadSystem(deps: AdminPageDeps): Promise<SystemModel> {
  const { db, timeZone } = deps;
  const now = deps.clock.now();
  const runs = await reads.sweepRuns(db);
  const store = await reads.metricStoreStats(db);
  return {
    timeZone, generatedAt: now.toISOString(),
    migration: await reads.migrationVersion(db),
    smsEnabled: deps.smsEnabled,
    accounts: await reads.accountTotals(db),
    households: await reads.householdCounts(db),
    sweeps: sweepRows(runs, now),
    schedulerLastTickAt: schedulerLastTick(runs),
    metricEvents: { rows: store.rows, oldestAt: store.oldestAt, retentionDays: METRIC_RETENTION_DAYS },
    adminSessions: await reads.adminSessionCount(db),
  };
}

// Every bucket start of a window, for views that want the axis without the series.
export function windowBuckets(window: RangeWindow, timeZone: string): string[] {
  return bucketStarts(window, timeZone);
}
