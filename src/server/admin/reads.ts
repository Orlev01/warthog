// The admin portal's reads — the module with the portal's aggregate SQL (docs/design/admin-portal.md §3).
// The Requests page's reads and its one write live apart, in ./requests.ts, because that is the
// one page allowed to show an address (docs/adr/admin-portal.md, amendment of 20 November 2026).
// Every statement names its columns, binds every value (INV-102), excludes crypto-shredded
// tombstones from every account count, and returns aggregates plus the per-account
// operational facts the design allows. It imports nothing that can decrypt or write content, so
// nothing here can ever decrypt or display a person's content (constitution principle 19):
// a static test pins that no content-bearing column name appears in this file.
//
// Bucketing and percentiles are computed in JavaScript after fetching the rows of one
// window: day buckets must follow the operator's display zone (not UTC), the data is small
// (hourly snapshots, per-minute traffic, a few hundred accounts), and one simple range
// query per read keeps the SQL identical on PGlite and PostgreSQL 16.

import type { Db, Row } from "../db/index";
import { normaliseEmail } from "../db/users";
import { ADMIN_LOOKUP, ADMIN_LOOKUP_OUTCOMES } from "../metrics/names";
import { tryRecord, type MetricSeam } from "../metrics/seam";
import { ACCOUNT_FILTERS, type AccountFacts, type AccountFilter, type AccountRow } from "../../domain/admin/model";

export interface Window {
  readonly from: string; // inclusive ISO instant
  readonly to: string; // exclusive ISO instant
}

export type MetricDimension = "platform" | "connectorId" | "outcome" | "errorCategory";
const DIMENSION_COLUMNS: Readonly<Record<MetricDimension, string>> = {
  platform: "platform", connectorId: "connector_id", outcome: "outcome", errorCategory: "error_category",
};

export interface MetricRow {
  readonly recordedAt: string;
  readonly value: number;
  readonly platform: string | null;
  readonly connectorId: string | null;
  readonly outcome: string | null;
  readonly errorCategory: string | null;
}

function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value == null ? null : iso(value);
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

/** Every event of one metric in [from, to), oldest first, with its dimensions. */
export async function metricRows(db: Db, name: string, window: Window): Promise<MetricRow[]> {
  const result = await db.query(
    `SELECT recorded_at, value, platform, connector_id, outcome, error_category
       FROM metric_events
      WHERE name = $1 AND recorded_at >= $2::timestamptz AND recorded_at < $3::timestamptz
      ORDER BY recorded_at ASC, id ASC`,
    [name, window.from, window.to],
  );
  return result.rows.map((row) => ({
    recordedAt: iso(row.recorded_at),
    value: num(row.value),
    platform: (row.platform ?? null) as string | null,
    connectorId: (row.connector_id ?? null) as string | null,
    outcome: (row.outcome ?? null) as string | null,
    errorCategory: (row.error_category ?? null) as string | null,
  }));
}

/** The sum of one metric's values in the window. */
export async function metricTotal(db: Db, name: string, window: Window): Promise<number> {
  const result = await db.query(
    `SELECT coalesce(sum(value), 0) AS total FROM metric_events
      WHERE name = $1 AND recorded_at >= $2::timestamptz AND recorded_at < $3::timestamptz`,
    [name, window.from, window.to],
  );
  return num(result.rows[0]?.total);
}

/** The sum of one metric's values per label of one dimension, largest first. */
export async function metricBreakdown(
  db: Db, name: string, window: Window, by: MetricDimension,
): Promise<{ readonly label: string; readonly value: number }[]> {
  const column = DIMENSION_COLUMNS[by];
  const result = await db.query(
    `SELECT ${column} AS label, coalesce(sum(value), 0) AS total FROM metric_events
      WHERE name = $1 AND recorded_at >= $2::timestamptz AND recorded_at < $3::timestamptz AND ${column} IS NOT NULL
      GROUP BY ${column} ORDER BY total DESC, label ASC`,
    [name, window.from, window.to],
  );
  return result.rows.map((row) => ({ label: row.label as string, value: num(row.total) }));
}

/** Interpolated percentiles (0–1) over one metric's values in the window; null when empty. */
export async function metricPercentiles(
  db: Db, name: string, window: Window, percentiles: readonly number[],
): Promise<(number | null)[]> {
  const result = await db.query(
    `SELECT value FROM metric_events
      WHERE name = $1 AND recorded_at >= $2::timestamptz AND recorded_at < $3::timestamptz`,
    [name, window.from, window.to],
  );
  const values = result.rows.map((row) => num(row.value)).sort((a, b) => a - b);
  return percentiles.map((p) => percentile(values, p));
}

export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * weight;
}

export function median(values: readonly number[]): number | null {
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

/** The most recent event per label of one dimension (the latest snapshot), any time. */
export async function metricLatest(
  db: Db, name: string, by: MetricDimension,
): Promise<{ readonly label: string; readonly value: number; readonly recordedAt: string }[]> {
  const column = DIMENSION_COLUMNS[by];
  const result = await db.query(
    `SELECT DISTINCT ON (${column}) ${column} AS label, value, recorded_at FROM metric_events
      WHERE name = $1 AND ${column} IS NOT NULL
      ORDER BY ${column}, recorded_at DESC, id DESC`,
    [name],
  );
  return result.rows.map((row) => ({ label: row.label as string, value: num(row.value), recordedAt: iso(row.recorded_at) }));
}

/** When each live account was created, within the window (tombstones excluded). */
export async function signupInstants(db: Db, window: Window): Promise<string[]> {
  const result = await db.query(
    `SELECT created_at FROM users
      WHERE wrapped_dek <> '' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
      ORDER BY created_at ASC`,
    [window.from, window.to],
  );
  return result.rows.map((row) => iso(row.created_at));
}

export interface AccountTotals {
  readonly active: number;
  readonly admins: number;
  readonly tombstones: number;
}

export async function accountTotals(db: Db): Promise<AccountTotals> {
  const result = await db.query(
    `SELECT count(*) FILTER (WHERE wrapped_dek <> '') AS active,
            count(*) FILTER (WHERE wrapped_dek <> '' AND role = 'admin') AS admins,
            count(*) FILTER (WHERE wrapped_dek = '') AS tombstones
       FROM users`,
  );
  const row = result.rows[0] ?? {};
  return { active: num(row.active), admins: num(row.admins), tombstones: num(row.tombstones) };
}

export interface FunnelCounts {
  readonly accounts: number;
  readonly withFactor: number;
  readonly withAgent: number;
  readonly withService: number;
  readonly withRequest: number;
  readonly withApproval: number;
}

// The activation funnel over live accounts: each step counts accounts that reached it.
export async function funnelCounts(db: Db): Promise<FunnelCounts> {
  const result = await db.query(
    `SELECT count(*) AS accounts,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id)
                                OR EXISTS (SELECT 1 FROM totp_secrets t WHERE t.user_id = u.id)) AS with_factor,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM agents a WHERE a.user_id = u.id)) AS with_agent,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM connections c WHERE c.user_id = u.id)) AS with_service,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM agents a WHERE a.user_id = u.id AND a.request_count > 0)) AS with_request,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM approvals ap WHERE ap.user_id = u.id AND ap.decided_at IS NOT NULL)) AS with_approval
       FROM users u WHERE u.wrapped_dek <> ''`,
  );
  const row = result.rows[0] ?? {};
  return {
    accounts: num(row.accounts), withFactor: num(row.with_factor), withAgent: num(row.with_agent),
    withService: num(row.with_service), withRequest: num(row.with_request), withApproval: num(row.with_approval),
  };
}

export interface MilestoneInstants {
  readonly createdAt: string | null;
  readonly firstFactorAt: string | null;
  readonly firstAgentAt: string | null;
  readonly firstServiceAt: string | null;
  readonly firstRequestAt: string | null;
  readonly firstApprovalAt: string | null;
}

// Per live account: when it was created and when it first reached each milestone (instants
// only; the loader turns them into median days).
export async function milestoneInstants(db: Db): Promise<MilestoneInstants[]> {
  const result = await db.query(
    `SELECT u.created_at,
            LEAST((SELECT min(p.created_at) FROM passkeys p WHERE p.user_id = u.id),
                  (SELECT min(t.created_at) FROM totp_secrets t WHERE t.user_id = u.id)) AS first_factor_at,
            (SELECT min(a.connected_at) FROM agents a WHERE a.user_id = u.id) AS first_agent_at,
            (SELECT min(c.connected_at) FROM connections c WHERE c.user_id = u.id) AS first_service_at,
            (SELECT min(e.occurred_at) FROM activity_entries e WHERE e.user_id = u.id AND e.kind IN ('tool_call', 'tool_call_failed')) AS first_request_at,
            (SELECT min(ap.decided_at) FROM approvals ap WHERE ap.user_id = u.id) AS first_approval_at
       FROM users u WHERE u.wrapped_dek <> ''`,
  );
  return result.rows.map((row) => ({
    createdAt: isoOrNull(row.created_at),
    firstFactorAt: isoOrNull(row.first_factor_at),
    firstAgentAt: isoOrNull(row.first_agent_at),
    firstServiceAt: isoOrNull(row.first_service_at),
    firstRequestAt: isoOrNull(row.first_request_at),
    firstApprovalAt: isoOrNull(row.first_approval_at),
  }));
}

/** Distinct live people with a session seen since the instant. */
export async function activePeople(db: Db, since: string): Promise<number> {
  const result = await db.query(
    `SELECT count(DISTINCT s.user_id) AS n FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE u.wrapped_dek <> '' AND s.last_seen_at >= $1::timestamptz`,
    [since],
  );
  return num(result.rows[0]?.n);
}

/** Distinct live people with a session seen within the window (the previous period's count). */
export async function activePeopleBetween(db: Db, window: Window): Promise<number> {
  const result = await db.query(
    `SELECT count(DISTINCT s.user_id) AS n FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE u.wrapped_dek <> '' AND s.last_seen_at >= $1::timestamptz AND s.last_seen_at < $2::timestamptz`,
    [window.from, window.to],
  );
  return num(result.rows[0]?.n);
}

/** Each live person's latest session instant within the window (for a "last seen" series). */
export async function lastSeenInstants(db: Db, window: Window): Promise<string[]> {
  const result = await db.query(
    `SELECT max(s.last_seen_at) AS seen FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE u.wrapped_dek <> '' AND s.last_seen_at >= $1::timestamptz AND s.last_seen_at < $2::timestamptz
      GROUP BY s.user_id`,
    [window.from, window.to],
  );
  return result.rows.map((row) => iso(row.seen));
}

/** Connected agents active since the instant, in total and by platform. */
export async function activeAgents(db: Db, since: string): Promise<{ readonly total: number; readonly byPlatform: { readonly label: string; readonly value: number }[] }> {
  const result = await db.query(
    `SELECT platform, count(*) AS n FROM agents a JOIN users u ON u.id = a.user_id
      WHERE u.wrapped_dek <> '' AND a.status = 'connected' AND a.last_active_at >= $1::timestamptz
      GROUP BY platform ORDER BY n DESC, platform ASC`,
    [since],
  );
  const byPlatform = result.rows.map((row) => ({ label: row.platform as string, value: num(row.n) }));
  return { total: byPlatform.reduce((sum, row) => sum + row.value, 0), byPlatform };
}

/** Connected agents by platform (all time). */
export async function agentsByPlatform(db: Db): Promise<{ readonly label: string; readonly value: number }[]> {
  const result = await db.query(
    `SELECT platform, count(*) AS n FROM agents a JOIN users u ON u.id = a.user_id
      WHERE u.wrapped_dek <> '' AND a.status = 'connected' GROUP BY platform ORDER BY n DESC, platform ASC`,
  );
  return result.rows.map((row) => ({ label: row.platform as string, value: num(row.n) }));
}

export interface ConnectorHealth {
  readonly connectorId: string;
  readonly total: number;
  readonly failing: number;
}

/** Connections per connector, with how many need reconnecting or are in error. */
export async function connectionsByConnector(db: Db): Promise<ConnectorHealth[]> {
  const result = await db.query(
    `SELECT c.connector_id, count(*) AS total,
            count(*) FILTER (WHERE c.status IN ('needs_reconnect', 'error')) AS failing
       FROM connections c JOIN users u ON u.id = c.user_id
      WHERE u.wrapped_dek <> ''
      GROUP BY c.connector_id ORDER BY total DESC, c.connector_id ASC`,
  );
  return result.rows.map((row) => ({ connectorId: row.connector_id as string, total: num(row.total), failing: num(row.failing) }));
}

const SERVICE_LABEL_MAX = 40;

/** Services people asked for in the window: a name only when asked for at least twice. */
export async function connectorRequestCounts(db: Db, window: Window): Promise<{ readonly label: string; readonly value: number }[]> {
  const result = await db.query(
    `SELECT lower(trim(service_name)) AS service, count(*) AS n FROM connector_requests
      WHERE kind = 'service' AND requested_at >= $1::timestamptz AND requested_at < $2::timestamptz
      GROUP BY lower(trim(service_name)) HAVING count(*) >= 2 ORDER BY n DESC, service ASC LIMIT 10`,
    [window.from, window.to],
  );
  return result.rows.map((row) => ({ label: String(row.service).slice(0, SERVICE_LABEL_MAX), value: num(row.n) }));
}

export async function connectorRequestTotal(db: Db, window: Window): Promise<number> {
  const result = await db.query(
    `SELECT count(*) AS n FROM connector_requests WHERE kind = 'service' AND requested_at >= $1::timestamptz AND requested_at < $2::timestamptz`,
    [window.from, window.to],
  );
  return num(result.rows[0]?.n);
}

export interface ApprovalOutcome {
  readonly status: string;
  readonly at: string; // decided_at, or expires_at for an expiry
}

/** Approvals settled in the window — decided or expired — with when. */
export async function approvalOutcomes(db: Db, window: Window): Promise<ApprovalOutcome[]> {
  const result = await db.query(
    `SELECT status, coalesce(decided_at, expires_at) AS at FROM approvals
      WHERE status IN ('approved', 'denied', 'expired')
        AND coalesce(decided_at, expires_at) >= $1::timestamptz AND coalesce(decided_at, expires_at) < $2::timestamptz
      ORDER BY at ASC`,
    [window.from, window.to],
  );
  return result.rows.map((row) => ({ status: row.status as string, at: iso(row.at) }));
}

export async function pendingApprovals(db: Db): Promise<number> {
  const result = await db.query("SELECT count(*) AS n FROM approvals WHERE status = 'pending'");
  return num(result.rows[0]?.n);
}

/** Activity counts by kind and outcome in the window (plaintext metadata only). */
export async function activityCounts(db: Db, window: Window): Promise<{ readonly kind: string; readonly outcome: string | null; readonly count: number }[]> {
  const result = await db.query(
    `SELECT kind, outcome, count(*) AS n FROM activity_entries
      WHERE occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz
      GROUP BY kind, outcome ORDER BY n DESC, kind ASC`,
    [window.from, window.to],
  );
  return result.rows.map((row) => ({ kind: row.kind as string, outcome: (row.outcome ?? null) as string | null, count: num(row.n) }));
}

export interface JobHealth {
  readonly byTypeStatus: { readonly type: string; readonly status: string; readonly count: number }[];
  readonly failed: number;
  readonly pending: number;
  readonly oldestPendingAt: string | null;
}

export async function jobHealth(db: Db): Promise<JobHealth> {
  const grouped = await db.query("SELECT type, status, count(*) AS n FROM jobs GROUP BY type, status ORDER BY type ASC, status ASC");
  const byTypeStatus = grouped.rows.map((row) => ({ type: row.type as string, status: row.status as string, count: num(row.n) }));
  const pending = await db.query("SELECT count(*) AS n, min(run_at) AS oldest FROM jobs WHERE status = 'pending'");
  return {
    byTypeStatus,
    failed: byTypeStatus.filter((r) => r.status === "failed").reduce((n, r) => n + r.count, 0),
    pending: num(pending.rows[0]?.n),
    oldestPendingAt: isoOrNull(pending.rows[0]?.oldest),
  };
}

export async function sweepRuns(db: Db): Promise<{ readonly name: string; readonly lastRunAt: string }[]> {
  const result = await db.query("SELECT name, last_run_at FROM sweep_runs ORDER BY name ASC");
  return result.rows.map((row) => ({ name: row.name as string, lastRunAt: iso(row.last_run_at) }));
}

export async function migrationVersion(db: Db): Promise<string | null> {
  const result = await db.query("SELECT max(name) AS latest FROM schema_migrations");
  return (result.rows[0]?.latest ?? null) as string | null;
}

export async function metricStoreStats(db: Db): Promise<{ readonly rows: number; readonly oldestAt: string | null }> {
  const result = await db.query("SELECT count(*) AS n, min(recorded_at) AS oldest FROM metric_events");
  return { rows: num(result.rows[0]?.n), oldestAt: isoOrNull(result.rows[0]?.oldest) };
}

export async function adminSessionCount(db: Db): Promise<number> {
  const result = await db.query("SELECT count(*) AS n FROM admin_sessions WHERE token_hash IS NOT NULL");
  return num(result.rows[0]?.n);
}

export async function householdCounts(db: Db): Promise<{ readonly total: number; readonly members: number }> {
  const result = await db.query(
    "SELECT (SELECT count(*) FROM households) AS total, (SELECT count(*) FROM household_members) AS members",
  );
  return { total: num(result.rows[0]?.total), members: num(result.rows[0]?.members) };
}

/** Sign-in lockout alerts sent in the window (passkey and sign-in code throttles). */
export async function lockoutAlerts(db: Db, window: Window): Promise<number> {
  const result = await db.query(
    `SELECT (SELECT count(*) FROM passkey_alerts WHERE sent_at >= $1::timestamptz AND sent_at < $2::timestamptz)
          + (SELECT count(*) FROM email_code_alerts WHERE sent_at >= $1::timestamptz AND sent_at < $2::timestamptz) AS n`,
    [window.from, window.to],
  );
  return num(result.rows[0]?.n);
}

// --- Accounts ------------------------------------------------------------------------------

// The per-account operational facts the design allows (§3), computed in SQL from counts and
// flags only. `reference` is the first eight characters of the id — never an address. The
// Requests page (./requests.ts) shows the same facts beside each request.
export const ACCOUNT_FACT_COLUMNS = `
         u.id, u.role, u.created_at,
         EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id) AS has_passkey,
         EXISTS (SELECT 1 FROM totp_secrets t WHERE t.user_id = u.id) AS has_totp,
         (SELECT count(*) FROM agents a WHERE a.user_id = u.id AND a.status = 'connected') AS agents,
         (SELECT count(*) FROM connections c WHERE c.user_id = u.id) AS connections,
         (SELECT count(*) FROM connections c WHERE c.user_id = u.id AND c.status IN ('needs_reconnect', 'error')) AS failing,
         (SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_active_at,
         (SELECT count(*) FROM approvals ap WHERE ap.user_id = u.id AND ap.status = 'pending') AS pending,
         (SELECT m.role FROM household_members m WHERE m.user_id = u.id ORDER BY m.role LIMIT 1) AS household,
         (SELECT coalesce(sum(a.request_count), 0) FROM agents a WHERE a.user_id = u.id) AS requests`;
const ACCOUNT_SELECT = `SELECT ${ACCOUNT_FACT_COLUMNS} FROM users u`;

// Fixed predicates per filter (never user input); every one keeps the tombstone exclusion.
const FILTER_SQL: Readonly<Record<AccountFilter, string>> = {
  all: "",
  no_factor: " AND NOT EXISTS (SELECT 1 FROM passkeys p WHERE p.user_id = u.id) AND NOT EXISTS (SELECT 1 FROM totp_secrets t WHERE t.user_id = u.id)",
  no_agent: " AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.user_id = u.id AND a.status = 'connected')",
  no_service: " AND NOT EXISTS (SELECT 1 FROM connections c WHERE c.user_id = u.id)",
  no_request: " AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.user_id = u.id AND a.request_count > 0)",
  needs_reconnect: " AND EXISTS (SELECT 1 FROM connections c WHERE c.user_id = u.id AND c.status IN ('needs_reconnect', 'error'))",
};

export function toAccountRow(row: Row): AccountRow {
  const factors: ("passkey" | "totp")[] = [];
  if (row.has_passkey === true) factors.push("passkey");
  if (row.has_totp === true) factors.push("totp");
  const household = row.household == null ? null : row.household === "owner" ? "owner" : "member";
  return {
    reference: String(row.id).slice(0, 8),
    role: row.role as string,
    createdAt: isoOrNull(row.created_at),
    factors,
    agents: num(row.agents),
    connections: num(row.connections),
    failingConnections: num(row.failing),
    lastActiveAt: isoOrNull(row.last_active_at),
    pendingApprovals: num(row.pending),
    household,
  };
}

export const ACCOUNT_LIST_LIMIT = 200;

/** Live accounts matching the filter, newest first, capped. */
export async function listAccounts(db: Db, filter: AccountFilter, limit: number = ACCOUNT_LIST_LIMIT): Promise<AccountRow[]> {
  const result = await db.query(
    `${ACCOUNT_SELECT} WHERE u.wrapped_dek <> ''${FILTER_SQL[filter]}
      ORDER BY u.created_at DESC NULLS LAST, u.id ASC LIMIT $1`,
    [limit],
  );
  return result.rows.map(toAccountRow);
}

/** How many live accounts each filter would show. */
export async function accountFilterCounts(db: Db): Promise<Record<AccountFilter, number>> {
  const counts = {} as Record<AccountFilter, number>;
  for (const filter of ACCOUNT_FILTERS) {
    const result = await db.query(`SELECT count(*) AS n FROM users u WHERE u.wrapped_dek <> ''${FILTER_SQL[filter]}`);
    counts[filter] = num(result.rows[0]?.n);
  }
  return counts;
}

/** The one live account with exactly this address (normalised, bound), with its facts, or null. */
export async function lookupAccount(
  db: Db, address: string, deps: { recordMetric?: MetricSeam } = {},
): Promise<AccountFacts | null> {
  const result = await db.query(
    `${ACCOUNT_SELECT} WHERE u.wrapped_dek <> '' AND lower(email) = $1`,
    [normaliseEmail(address)],
  );
  const row = result.rows[0];
  await tryRecord(deps.recordMetric, {
    name: ADMIN_LOOKUP, value: 1, dimensions: { outcome: row ? ADMIN_LOOKUP_OUTCOMES.found : ADMIN_LOOKUP_OUTCOMES.none },
  });
  if (!row) return null;
  const userId = row.id as string;
  const platforms = await db.query(
    "SELECT platform, count(*) AS n FROM agents WHERE user_id = $1 AND status = 'connected' GROUP BY platform ORDER BY n DESC, platform ASC",
    [userId],
  );
  const connectors = await db.query(
    "SELECT connector_id, count(*) AS n FROM connections WHERE user_id = $1 GROUP BY connector_id ORDER BY n DESC, connector_id ASC",
    [userId],
  );
  return {
    ...toAccountRow(row),
    agentsByPlatform: platforms.rows.map((r) => ({ key: r.platform as string, label: r.platform as string, value: num(r.n), brand: r.platform as string })),
    connectionsByConnector: connectors.rows.map((r) => ({ key: r.connector_id as string, label: r.connector_id as string, value: num(r.n), brand: r.connector_id as string })),
    requestCount: num(row.requests),
  };
}
