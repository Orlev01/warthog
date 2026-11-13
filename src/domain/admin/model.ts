// The admin portal's view models (docs/design/admin-portal.md §5): the contract between the
// reads/loaders (src/server/admin/page-data.ts, which fill these from plaintext operational
// metadata and metric events only) and the views (src/components/admin/*, which render them
// and never fetch). Pure types, no React, no I/O. Instants are ISO-8601 strings; counts are
// plain numbers; every label here is a short identifier or plain words — never personal
// content, an address, a path or free text typed by a member.

export type RangeKey = "today" | "7d" | "30d" | "90d";
export const RANGE_KEYS: readonly RangeKey[] = ["today", "7d", "30d", "90d"];

// The window a page shows, with the equal-length window before it for comparison.
export interface RangeWindow {
  readonly key: RangeKey;
  readonly from: string; // inclusive
  readonly to: string; // exclusive
  readonly previousFrom: string;
  readonly previousTo: string;
  readonly bucket: "hour" | "day";
  readonly label: string; // "today", "the last 7 days"
  readonly previousLabel: string; // "yesterday", "the previous 7 days"
}

export interface SeriesPoint {
  readonly at: string; // bucket start, ISO
  readonly value: number;
}

// A count in the window beside the previous window's (null when there is no earlier period).
export interface Measure {
  readonly value: number;
  readonly previous: number | null;
}

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export interface BreakdownRow {
  readonly key: string;
  readonly label: string; // plain words ("Gmail", "Claude", "Timed out")
  readonly value: number;
  readonly href?: string;
  readonly tone?: Tone;
  // A connector or platform id for a brand mark beside the label, when one applies.
  readonly brand?: string;
}

export interface FunnelStep {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly href?: string;
}

export interface AttentionItem {
  readonly id: string;
  readonly text: string; // one sentence, plain words
  readonly href: string; // the detail page on the admin host (un-prefixed path)
  readonly tone: "warning" | "danger";
}

export interface Ratio {
  readonly numerator: number;
  readonly denominator: number;
}

export interface SweepRow {
  readonly name: string;
  readonly intervalMs: number;
  readonly lastRunAt: string | null;
  readonly overdue: boolean;
}

export interface MilestoneRow {
  readonly key: string;
  readonly label: string; // "Added a second factor"
  readonly reached: number;
  readonly of: number;
  readonly medianDays: number | null;
  readonly href?: string;
}

interface PageBase {
  readonly timeZone: string; // IANA zone every instant is displayed in
  readonly generatedAt: string;
}

interface RangedPage extends PageBase {
  readonly range: RangeWindow;
}

export interface OverviewModel extends RangedPage {
  readonly tiles: {
    readonly signups: Measure & { readonly series: readonly SeriesPoint[] };
    readonly activePeople: Measure;
    readonly agentRequests: Measure & { readonly failed: number };
    readonly approvalsDecided: Measure & { readonly medianResponseMs: number | null };
    readonly needsAttention: number;
  };
  readonly attention: readonly AttentionItem[];
  readonly funnel: readonly FunnelStep[];
  readonly trends: {
    readonly signups: readonly SeriesPoint[];
    readonly activePeople: readonly SeriesPoint[];
    readonly requests: readonly SeriesPoint[];
  };
  readonly topServices: readonly BreakdownRow[];
}

export interface SignupsModel extends RangedPage {
  readonly perBucket: readonly SeriesPoint[];
  readonly total: Measure;
  readonly activeAccounts: number;
  readonly funnel: readonly FunnelStep[]; // code sent → email verified → factor enrolled → completed
  readonly refusals: readonly BreakdownRow[];
  readonly factors: readonly BreakdownRow[]; // passkey vs authenticator among completed
  readonly milestones: readonly MilestoneRow[];
}

export interface UsageModel extends RangedPage {
  readonly activePeople: { readonly today: number; readonly week: number; readonly month: number };
  readonly activeAgents: {
    readonly today: number;
    readonly week: number;
    readonly month: number;
    readonly byPlatform: readonly BreakdownRow[];
  };
  readonly requests: {
    readonly series: readonly SeriesPoint[];
    readonly total: Measure;
    readonly byOutcome: readonly BreakdownRow[];
    readonly byPlatform: readonly BreakdownRow[];
    readonly byConnector: readonly BreakdownRow[];
    readonly latency: { readonly p50: number | null; readonly p95: number | null };
  };
  readonly approvals: {
    readonly decidedSeries: readonly SeriesPoint[];
    readonly decided: Measure;
    readonly medianResponseMs: number | null;
    readonly p95ResponseMs: number | null;
    readonly expiryRate: Ratio | null; // expired / (approved + denied + expired)
    readonly pending: number;
  };
  readonly connections: readonly (BreakdownRow & { readonly failing: number })[];
  readonly servicesRequested: readonly BreakdownRow[];
}

export type AccountFilter = "all" | "no_factor" | "no_agent" | "no_service" | "no_request" | "needs_reconnect";
export const ACCOUNT_FILTERS: readonly AccountFilter[] = ["all", "no_factor", "no_agent", "no_service", "no_request", "needs_reconnect"];

export interface AccountRow {
  readonly reference: string; // the first eight characters of the account id — never an address
  readonly role: string;
  readonly createdAt: string | null;
  readonly factors: readonly ("passkey" | "totp")[];
  readonly agents: number;
  readonly connections: number;
  readonly failingConnections: number;
  readonly lastActiveAt: string | null;
  readonly pendingApprovals: number;
  readonly household: "owner" | "member" | null;
}

export interface AccountFacts extends AccountRow {
  readonly agentsByPlatform: readonly BreakdownRow[];
  readonly connectionsByConnector: readonly BreakdownRow[];
  readonly requestCount: number;
}

export interface AccountsModel extends PageBase {
  readonly lookup: {
    readonly searched: boolean; // an address was submitted
    readonly account: AccountFacts | null; // the exact match, or null
  };
  readonly filter: AccountFilter;
  readonly counts: Readonly<Record<AccountFilter, number>>;
  readonly accounts: readonly AccountRow[]; // newest first, capped
  readonly total: number;
}

export interface ReliabilityModel extends RangedPage {
  readonly signins: {
    readonly byOutcome: readonly BreakdownRow[];
    readonly failedByCategory: readonly BreakdownRow[];
    readonly failedSeries: readonly SeriesPoint[];
    readonly lockoutAlerts: number;
  };
  readonly agentErrors: {
    readonly total: Measure;
    readonly failed: Measure;
    readonly byCategory: readonly BreakdownRow[];
    readonly byPlatform: readonly BreakdownRow[];
    readonly byConnector: readonly BreakdownRow[];
  };
  readonly connectors: {
    readonly needsReconnect: readonly BreakdownRow[];
    readonly refreshFailures: readonly BreakdownRow[];
    readonly connectFailures: readonly BreakdownRow[];
  };
  readonly integrity: { readonly lastRunAt: string | null; readonly passed: number | null; readonly failed: number | null };
  readonly jobs: {
    readonly byTypeStatus: readonly { readonly type: string; readonly status: string; readonly count: number }[];
    readonly failed: number;
    readonly pending: number;
    readonly oldestPendingAt: string | null;
    readonly failuresSeries: readonly SeriesPoint[];
  };
  readonly sweeps: readonly SweepRow[];
}

export interface TrafficModel extends RangedPage {
  readonly requests: Measure;
  readonly documents: Measure;
  readonly limited: number;
  readonly series: { readonly requests: readonly SeriesPoint[]; readonly documents: readonly SeriesPoint[] };
  readonly byRoute: readonly BreakdownRow[];
  readonly byHost: readonly BreakdownRow[];
  readonly todayByHour: readonly SeriesPoint[];
  readonly azureMetricsUrl: string | null;
}

export interface SystemModel extends PageBase {
  readonly migration: string | null;
  readonly smsEnabled: boolean;
  readonly accounts: { readonly active: number; readonly admins: number; readonly tombstones: number };
  readonly households: { readonly total: number; readonly members: number };
  readonly sweeps: readonly SweepRow[];
  readonly schedulerLastTickAt: string | null; // the most recent sweep run
  readonly metricEvents: { readonly rows: number; readonly oldestAt: string | null; readonly retentionDays: number };
  readonly adminSessions: number;
}
