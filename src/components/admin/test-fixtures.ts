// Hand-built view models for the admin views' render tests: one populated and one empty of
// each page. Test-only; never imported by production code.
import type {
  AccountsModel, OverviewModel, RangeWindow, ReliabilityModel, SignupsModel, SystemModel, TrafficModel, UsageModel,
} from "@/domain/admin/model";

export const NOW = new Date("2026-11-13T05:00:00Z");
export const TZ = "Australia/Sydney";

export const RANGE_7D: RangeWindow = {
  key: "7d",
  from: "2026-11-05T13:00:00Z", to: "2026-11-13T05:00:00Z",
  previousFrom: "2026-10-29T13:00:00Z", previousTo: "2026-11-05T13:00:00Z",
  bucket: "day", label: "the last 7 days", previousLabel: "the previous 7 days",
};

const days = (values: number[]) => values.map((value, i) => ({ at: `2026-11-${String(6 + i).padStart(2, "0")}T13:00:00Z`, value }));

export const OVERVIEW: OverviewModel = {
  range: RANGE_7D, timeZone: TZ, generatedAt: NOW.toISOString(),
  tiles: {
    signups: { value: 14, previous: 12, series: days([1, 2, 0, 4, 3, 2, 2]) },
    activePeople: { value: 9, previous: 7 },
    agentRequests: { value: 240, previous: 180, failed: 12 },
    approvalsDecided: { value: 31, previous: 30, medianResponseMs: 4 * 60_000 },
    needsAttention: 2,
  },
  attention: [
    { id: "reconnect", text: "2 connections need reconnecting (Gmail)", href: "/reliability", tone: "warning" },
    { id: "sweep", text: "The exchange-rates sweep last ran 3 days ago", href: "/system", tone: "danger" },
  ],
  funnel: [
    { key: "accounts", label: "Accounts", count: 42, href: "/accounts" },
    { key: "factor", label: "Added a second factor", count: 40, href: "/accounts?filter=no_factor" },
    { key: "agent", label: "Connected an agent", count: 20, href: "/accounts?filter=no_agent" },
    { key: "service", label: "Connected a service", count: 14, href: "/accounts?filter=no_service" },
    { key: "request", label: "Had a request handled", count: 12, href: "/accounts?filter=no_request" },
    { key: "approval", label: "Decided an approval", count: 9 },
  ],
  trends: { signups: days([1, 2, 0, 4, 3, 2, 2]), activePeople: days([3, 4, 4, 6, 5, 7, 9]), requests: days([20, 30, 25, 40, 45, 38, 42]) },
  topServices: [{ key: "gmail", label: "Gmail", value: 8, brand: "gmail" }, { key: "google-calendar", label: "Google Calendar", value: 5, brand: "google-calendar" }],
};

export const OVERVIEW_EMPTY: OverviewModel = {
  range: RANGE_7D, timeZone: TZ, generatedAt: NOW.toISOString(),
  tiles: {
    signups: { value: 0, previous: null, series: [] },
    activePeople: { value: 0, previous: null },
    agentRequests: { value: 0, previous: null, failed: 0 },
    approvalsDecided: { value: 0, previous: null, medianResponseMs: null },
    needsAttention: 0,
  },
  attention: [], funnel: [{ key: "accounts", label: "Accounts", count: 0 }],
  trends: { signups: [], activePeople: [], requests: [] }, topServices: [],
};

export const SIGNUPS: SignupsModel = {
  range: RANGE_7D, timeZone: TZ, generatedAt: NOW.toISOString(),
  perBucket: days([1, 2, 0, 4, 3, 2, 2]), total: { value: 14, previous: 12 }, activeAccounts: 42,
  funnel: [
    { key: "code_sent", label: "Code sent", count: 20 }, { key: "email_verified", label: "Email verified", count: 17 },
    { key: "factor_enrolled", label: "Second factor added", count: 15 }, { key: "completed", label: "Account created", count: 14 },
  ],
  refusals: [{ key: "throttled", label: "Too many codes", value: 2, tone: "warning" }, { key: "code_rejected", label: "Wrong code", value: 5 }],
  factors: [{ key: "passkey", label: "Passkey", value: 11 }, { key: "totp", label: "Authenticator app", value: 3 }],
  milestones: [
    { key: "factor", label: "Added a second factor", reached: 40, of: 42, medianDays: 0 },
    { key: "agent", label: "Connected an agent", reached: 20, of: 42, medianDays: 2.4, href: "/accounts?filter=no_agent" },
  ],
};

export const SIGNUPS_EMPTY: SignupsModel = {
  range: RANGE_7D, timeZone: TZ, generatedAt: NOW.toISOString(),
  perBucket: [], total: { value: 0, previous: null }, activeAccounts: 0, funnel: [], refusals: [], factors: [], milestones: [],
};

export const USAGE: UsageModel = {
  range: RANGE_7D, timeZone: TZ, generatedAt: NOW.toISOString(),
  activePeople: { today: 3, week: 9, month: 20 },
  activeAgents: { today: 4, week: 11, month: 18, byPlatform: [{ key: "claude", label: "Claude", value: 7, brand: "claude" }, { key: "chatgpt", label: "ChatGPT", value: 4, brand: "chatgpt" }] },
  requests: {
    series: days([20, 30, 25, 40, 45, 38, 42]), total: { value: 240, previous: 180 },
    byOutcome: [{ key: "executed", label: "Done", value: 200, tone: "success" }, { key: "pending_approval", label: "Waiting for approval", value: 28 }, { key: "failed", label: "Failed", value: 12, tone: "danger" }],
    byPlatform: [{ key: "claude", label: "Claude", value: 150, brand: "claude" }],
    byConnector: [{ key: "gmail", label: "Gmail", value: 90, brand: "gmail" }],
    latency: { p50: 120, p95: 850 },
  },
  approvals: { decidedSeries: days([3, 5, 4, 6, 5, 4, 4]), decided: { value: 31, previous: 30 }, medianResponseMs: 4 * 60_000, p95ResponseMs: 40 * 60_000, expiryRate: { numerator: 3, denominator: 34 }, pending: 2 },
  connections: [{ key: "gmail", label: "Gmail", value: 8, brand: "gmail", failing: 2 }, { key: "outlook", label: "Outlook", value: 3, brand: "outlook", failing: 0 }],
  servicesRequested: [{ key: "notion", label: "Notion", value: 3 }],
};

export const USAGE_EMPTY: UsageModel = {
  range: RANGE_7D, timeZone: TZ, generatedAt: NOW.toISOString(),
  activePeople: { today: 0, week: 0, month: 0 }, activeAgents: { today: 0, week: 0, month: 0, byPlatform: [] },
  requests: { series: [], total: { value: 0, previous: null }, byOutcome: [], byPlatform: [], byConnector: [], latency: { p50: null, p95: null } },
  approvals: { decidedSeries: [], decided: { value: 0, previous: null }, medianResponseMs: null, p95ResponseMs: null, expiryRate: null, pending: 0 },
  connections: [], servicesRequested: [],
};

export const ACCOUNTS: AccountsModel = {
  timeZone: TZ, generatedAt: NOW.toISOString(),
  lookup: { searched: true, account: { reference: "a1b2c3d4", role: "member", createdAt: "2026-11-10T01:00:00Z", factors: ["passkey"], agents: 2, connections: 3, failingConnections: 1, lastActiveAt: "2026-11-13T04:04:00Z", pendingApprovals: 1, household: "owner", agentsByPlatform: [{ key: "claude", label: "Claude", value: 2, brand: "claude" }], connectionsByConnector: [{ key: "gmail", label: "Gmail", value: 1, brand: "gmail" }], requestCount: 57 } },
  filter: "all",
  counts: { all: 2, no_factor: 1, no_agent: 1, no_service: 1, no_request: 1, needs_reconnect: 1 },
  accounts: [
    { reference: "a1b2c3d4", role: "admin", createdAt: "2026-11-10T01:00:00Z", factors: ["passkey", "totp"], agents: 2, connections: 3, failingConnections: 1, lastActiveAt: "2026-11-13T04:04:00Z", pendingApprovals: 1, household: "owner" },
    { reference: "e5f6a7b8", role: "member", createdAt: "2026-11-12T01:00:00Z", factors: [], agents: 0, connections: 0, failingConnections: 0, lastActiveAt: null, pendingApprovals: 0, household: null },
  ],
  total: 2,
};

export const ACCOUNTS_EMPTY: AccountsModel = {
  timeZone: TZ, generatedAt: NOW.toISOString(),
  lookup: { searched: false, account: null }, filter: "all",
  counts: { all: 0, no_factor: 0, no_agent: 0, no_service: 0, no_request: 0, needs_reconnect: 0 }, accounts: [], total: 0,
};

export const RELIABILITY: ReliabilityModel = {
  range: RANGE_7D, timeZone: TZ, generatedAt: NOW.toISOString(),
  signins: { byOutcome: [{ key: "ok", label: "Signed in", value: 40, tone: "success" }, { key: "failed", label: "Failed", value: 3, tone: "danger" }], failedByCategory: [{ key: "passkey", label: "Passkey", value: 2 }, { key: "totp", label: "Authenticator code", value: 1 }], failedSeries: days([0, 1, 0, 0, 2, 0, 0]), lockoutAlerts: 1 },
  agentErrors: { total: { value: 240, previous: 180 }, failed: { value: 12, previous: 15 }, byCategory: [{ key: "tool_error", label: "Tool error", value: 7, tone: "danger" }], byPlatform: [{ key: "claude", label: "Claude", value: 12, brand: "claude" }], byConnector: [{ key: "gmail", label: "Gmail", value: 5, brand: "gmail" }] },
  connectors: { needsReconnect: [{ key: "gmail", label: "Gmail", value: 2, brand: "gmail", tone: "warning" }], refreshFailures: [], connectFailures: [] },
  integrity: { lastRunAt: "2026-11-13T00:10:00Z", passed: 42, failed: 0 },
  jobs: { byTypeStatus: [{ type: "approval.fallback", status: "done", count: 30 }, { type: "connection.refresh", status: "failed", count: 1 }], failed: 1, pending: 2, oldestPendingAt: "2026-11-13T04:50:00Z", failuresSeries: days([0, 0, 0, 1, 0, 0, 0]) },
  sweeps: [{ name: "approval-expiry", intervalMs: 60_000, lastRunAt: "2026-11-13T04:59:00Z", overdue: false }, { name: "exchange-rates", intervalMs: 86_400_000, lastRunAt: "2026-11-10T00:00:00Z", overdue: true }],
};

export const RELIABILITY_EMPTY: ReliabilityModel = {
  range: RANGE_7D, timeZone: TZ, generatedAt: NOW.toISOString(),
  signins: { byOutcome: [], failedByCategory: [], failedSeries: [], lockoutAlerts: 0 },
  agentErrors: { total: { value: 0, previous: null }, failed: { value: 0, previous: null }, byCategory: [], byPlatform: [], byConnector: [] },
  connectors: { needsReconnect: [], refreshFailures: [], connectFailures: [] },
  integrity: { lastRunAt: null, passed: null, failed: null },
  jobs: { byTypeStatus: [], failed: 0, pending: 0, oldestPendingAt: null, failuresSeries: [] },
  sweeps: [],
};

export const TRAFFIC: TrafficModel = {
  range: RANGE_7D, timeZone: TZ, generatedAt: NOW.toISOString(),
  requests: { value: 5200, previous: 4100 }, documents: { value: 900, previous: 850 }, limited: 3,
  series: { requests: days([600, 700, 650, 800, 900, 750, 800]), documents: days([100, 120, 110, 150, 160, 130, 130]) },
  byRoute: [{ key: "portal", label: "Signed-in app", value: 3000 }, { key: "mcp", label: "Agent connections", value: 1500 }, { key: "public", label: "Public pages", value: 400 }],
  byHost: [{ key: "app", label: "Member app", value: 5100 }, { key: "admin", label: "Admin portal", value: 100 }],
  todayByHour: Array.from({ length: 24 }, (_, h) => ({ at: `2026-11-12T${String(h).padStart(2, "0")}:00:00Z`, value: h * 3 })),
  azureMetricsUrl: "https://portal.azure.com/#view/HubsExtension/BrowseResource/resourceType/Microsoft.App%2FcontainerApps",
};

export const TRAFFIC_EMPTY: TrafficModel = {
  range: RANGE_7D, timeZone: TZ, generatedAt: NOW.toISOString(),
  requests: { value: 0, previous: null }, documents: { value: 0, previous: null }, limited: 0,
  series: { requests: [], documents: [] }, byRoute: [], byHost: [], todayByHour: [], azureMetricsUrl: null,
};

export const SYSTEM: SystemModel = {
  timeZone: TZ, generatedAt: NOW.toISOString(),
  migration: "0112_admin_indexes", smsEnabled: false,
  accounts: { active: 42, admins: 1, tombstones: 2 }, households: { total: 3, members: 7 },
  sweeps: [{ name: "traffic-flush", intervalMs: 60_000, lastRunAt: "2026-11-13T04:59:30Z", overdue: false }],
  schedulerLastTickAt: "2026-11-13T04:59:30Z",
  metricEvents: { rows: 12_345, oldestAt: "2026-11-05T00:00:00Z", retentionDays: 400 },
  adminSessions: 1,
};

export const SYSTEM_EMPTY: SystemModel = {
  timeZone: TZ, generatedAt: NOW.toISOString(),
  migration: null, smsEnabled: false, accounts: { active: 0, admins: 0, tombstones: 0 }, households: { total: 0, members: 0 },
  sweeps: [], schedulerLastTickAt: null, metricEvents: { rows: 0, oldestAt: null, retentionDays: 400 }, adminSessions: 0,
};
