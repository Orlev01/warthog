// The admin portal's Requests (docs/adr/admin-portal.md, amendment of 20 November 2026): every
// request a person made of the operator in the app, newest first, with the person who asked.
// This is the one admin module that selects an address, and only beside that person's own
// request: they asked the operator for something, and the operator needs to answer them. It
// selects nothing else personal (no account labels, agent names, mobile numbers or encrypted
// content; a static test pins this) and imports nothing that can decrypt. It also holds the
// portal's one write: marking a request done, or waiting again.
//
// Requests from deleted accounts are left out: the person has gone, so neither their address
// nor their request is shown. Every value is bound (INV-102); time comes from the caller.

import type { Db, Row } from "../db/index";
import type { BreakdownRow, RequestKind } from "../../domain/admin/model";
import { ACCOUNT_FACT_COLUMNS, toAccountRow } from "./reads";
import type { AccountRow } from "../../domain/admin/model";

export const REQUEST_LIST_LIMIT = 200;

export interface RequestRecord {
  readonly id: string;
  readonly kind: RequestKind;
  readonly serviceName: string; // stored verbatim; the loader cleans it for display
  readonly connectorId: string | null;
  readonly matchedConnectorId: string | null;
  readonly requestedAt: string;
  readonly handledAt: string | null;
  readonly person: AccountRow & {
    readonly email: string;
    readonly agentRequests: number;
    readonly currency: string | null;
    readonly requestsMade: number;
    readonly agentsByPlatform: readonly BreakdownRow[];
    readonly connectionsByConnector: readonly (BreakdownRow & { readonly failing: number })[];
  };
}

function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

// Every live account that has made a request, keyed by account id: what it has connected.
async function breakdownsByPerson(db: Db): Promise<{
  agents: Map<string, BreakdownRow[]>;
  connections: Map<string, (BreakdownRow & { failing: number })[]>;
}> {
  const agents = new Map<string, BreakdownRow[]>();
  const connections = new Map<string, (BreakdownRow & { failing: number })[]>();
  const platforms = await db.query(
    `SELECT a.user_id, a.platform, count(*) AS n FROM agents a
      WHERE a.status = 'connected' AND a.user_id IN (SELECT r.user_id FROM connector_requests r)
      GROUP BY a.user_id, a.platform ORDER BY n DESC, a.platform ASC`,
  );
  for (const row of platforms.rows) {
    const key = row.user_id as string;
    const platform = row.platform as string;
    agents.set(key, [...(agents.get(key) ?? []), { key: platform, label: platform, value: num(row.n), brand: platform }]);
  }
  const connectors = await db.query(
    `SELECT c.user_id, c.connector_id, count(*) AS n,
            count(*) FILTER (WHERE c.status IN ('needs_reconnect', 'error')) AS failing
       FROM connections c
      WHERE c.user_id IN (SELECT r.user_id FROM connector_requests r)
      GROUP BY c.user_id, c.connector_id ORDER BY n DESC, c.connector_id ASC`,
  );
  for (const row of connectors.rows) {
    const key = row.user_id as string;
    const id = row.connector_id as string;
    connections.set(key, [...(connections.get(key) ?? []), { key: id, label: id, value: num(row.n), brand: id, failing: num(row.failing) }]);
  }
  return { agents, connections };
}

function toRecord(row: Row, breakdowns: Awaited<ReturnType<typeof breakdownsByPerson>>): RequestRecord {
  const userId = row.id as string;
  return {
    id: row.request_id as string,
    kind: row.kind === "google_early_access" ? "google_early_access" : "service",
    serviceName: String(row.service_name ?? ""),
    connectorId: (row.connector_id ?? null) as string | null,
    matchedConnectorId: row.status === "matched" ? ((row.matched_connector_id ?? null) as string | null) : null,
    requestedAt: iso(row.requested_at),
    handledAt: row.handled_at == null ? null : iso(row.handled_at),
    person: {
      ...toAccountRow(row),
      email: String(row.email ?? ""),
      agentRequests: num(row.requests),
      currency: (row.currency ?? null) as string | null,
      requestsMade: num(row.requests_made),
      agentsByPlatform: breakdowns.agents.get(userId) ?? [],
      connectionsByConnector: breakdowns.connections.get(userId) ?? [],
    },
  };
}

/** Requests from live accounts, newest first, capped, each with the person who asked. */
export async function listRequests(db: Db, limit: number = REQUEST_LIST_LIMIT): Promise<RequestRecord[]> {
  const result = await db.query(
    `SELECT r.id AS request_id, r.kind, r.service_name, r.connector_id, r.status, r.matched_connector_id,
            r.requested_at, r.handled_at, u.email,
            (SELECT ac.currency FROM account_currency ac WHERE ac.user_id = u.id) AS currency,
            (SELECT count(*) FROM connector_requests o WHERE o.user_id = u.id) AS requests_made,
            ${ACCOUNT_FACT_COLUMNS}
       FROM connector_requests r JOIN users u ON u.id = r.user_id
      WHERE u.wrapped_dek <> ''
      ORDER BY r.requested_at DESC, r.id ASC
      LIMIT $1`,
    [limit],
  );
  if (result.rows.length === 0) return [];
  const breakdowns = await breakdownsByPerson(db);
  return result.rows.map((row) => toRecord(row, breakdowns));
}

/**
 * Mark a live account's request done (`handledAt` an instant) or waiting again (null). Marking
 * an already-done request done keeps its first instant, so a double submit changes nothing.
 * Returns false for an unknown id or a deleted account's request.
 */
export async function setRequestHandled(db: Db, id: string, handledAt: Date | null): Promise<boolean> {
  const result = await db.query(
    `UPDATE connector_requests SET handled_at = CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE coalesce(handled_at, $2::timestamptz) END
      WHERE id = $1 AND user_id IN (SELECT u.id FROM users u WHERE u.wrapped_dek <> '')
      RETURNING id`,
    [id, handledAt ? handledAt.toISOString() : null],
  );
  return result.rows.length > 0;
}
