// E08-S05 — Activity list read (list-all with filters) (design §4.1, §9,
// constitution principle 14 "Warthog writes the record").
//
// The ONE filtered "list-all" read the Activity page, the Home feed and the
// `get_context` agent tool share — distinct from the writer's unfiltered
// `readActivity`. It lists a person's entries NEWEST FIRST, filterable by agent,
// connected service, kind, outcome and an inclusive date range, and decrypts each
// payload summary IN-APP over the ALREADY-FILTERED set (so a row the filter excludes
// is never fetched or decrypted).
//
// Member-scoped and parameterized (INV-102): the user id and every filter value
// travel as BOUND values ($1, $2, …), never concatenated into the SQL text — only the
// column names (fixed literals, never from input) and the comparison operators are
// woven into the statement, so a value shaped like SQL is inert data that cannot alter
// the query. The user id is the SESSION's id the caller passes, never a client value,
// so one person never reads another's entries.
//
// Every read is BOUNDED: at most `limit` entries (default and ceiling MAX_LIST_LIMIT, the
// design's 5,000-rows-per-query cap), so no view decrypts a person's whole history. A
// caller pages on with a keyset cursor over the feed order (`before`, from `cursorAfter`),
// which the (user_id, occurred_at DESC, seq DESC) index serves without a sort. The filter
// dropdowns come from `listActivityFacets` — DISTINCT plaintext columns, no decryption.
//
// This module reads no `process.env` and holds no key (INV-103): the db and the
// per-person DEK are INJECTED. Decryption reuses the writer's OWN row→entry mapper
// (`toEntry` from `./writer`), so the envelope binding and the returned shape can
// never drift from how the record was written (constitution: one source of truth).

import { z } from "zod";

import { toEntry } from "./writer";
import type { ActivityEntry } from "./recorder";
import type { Db } from "../db/index";
import { parseParams } from "../http/validate";

// The filters a list read narrows by. Every field is optional; an omitted filter does
// not constrain, and filters COMBINE with AND. `from`/`to` are inclusive ISO-8601
// bounds on occurred_at; `agentId`/`connectorId` map to the entry's agent/service;
// `source` keeps only Warthog-written or only agent-reported entries.
export interface ActivityFilters {
  seq?: number;
  agentId?: string;
  connectorId?: string;
  kind?: string;
  outcome?: string;
  source?: "warthog" | "agent_reported";
  from?: string;
  to?: string;
}

// The most entries one read returns (design §4.1: at most 5,000 rows per query), and the
// default when a caller names no limit.
export const MAX_LIST_LIMIT = 5000;

// A position in the newest-first feed: the (occurred_at, seq) of the last entry a page
// returned. The next page starts strictly after it.
export interface ActivityCursor {
  occurredAt: string;
  seq: number;
}

// How much of the feed one read returns: at most `limit` entries (clamped to
// 1..MAX_LIST_LIMIT), starting strictly after `before` when given.
export interface ActivityPage {
  limit?: number;
  before?: ActivityCursor;
  beforeSeq?: number;
}

// The cursor that continues after a page (the last, i.e. oldest, entry it returned), or
// undefined for an empty page (there is nothing after it).
export function cursorAfter(page: readonly ActivityEntry[]): ActivityCursor | undefined {
  const last = page[page.length - 1];
  return last ? { occurredAt: last.occurredAt, seq: last.seq } : undefined;
}

// A date bound must be an ISO-8601 date or date-time: anything else would reach the
// timestamptz comparison and fail inside the database (a 500, OBS-049). Rejected at this
// boundary as a 4xx instead.
const dateBound = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const dateBoundsSchema = z.object({ from: dateBound.optional(), to: dateBound.optional() });

// The requested limit as a whole number within 1..MAX_LIST_LIMIT (absent or nonsense ⇒
// the ceiling), so every read is bounded whatever the caller passes.
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return MAX_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(limit)));
}

// List `userId`'s entries, newest first, narrowed by `filters`, each payload decrypted
// under `dek` — at most `page.limit` of them (default MAX_LIST_LIMIT), after `page.before`
// when given. No filters ⇒ the person's newest entries. A filter matching nothing ⇒ an
// empty list (not an error); a malformed date bound ⇒ a 4xx HttpError. A wrong DEK or a
// tampered ciphertext inside the returned page fails the GCM tag and rejects.
export async function listActivity(
  db: Db,
  userId: string,
  filters: ActivityFilters,
  dek: Uint8Array,
  page: ActivityPage = {},
): Promise<ActivityEntry[]> {
  parseParams(dateBoundsSchema, { from: filters.from, to: filters.to });

  // The member scope is always the first bound value; each present filter appends its
  // own bound value and a condition over a FIXED column name (never from input).
  const conditions: string[] = ["user_id = $1"];
  const values: unknown[] = [userId];
  const bind = (column: string, op: string, value: string): void => {
    values.push(value);
    conditions.push(`${column} ${op} $${values.length}`);
  };

  if (filters.seq !== undefined) bind("seq", "=", String(filters.seq));
  if (filters.agentId !== undefined) bind("agent_id", "=", filters.agentId);
  if (filters.connectorId !== undefined) bind("connector_id", "=", filters.connectorId);
  if (filters.kind !== undefined) bind("kind", "=", filters.kind);
  if (filters.outcome !== undefined) bind("outcome", "=", filters.outcome);
  if (filters.source !== undefined) bind("source", "=", filters.source);
  if (filters.from !== undefined) bind("occurred_at", ">=", filters.from);
  if (filters.to !== undefined) bind("occurred_at", "<=", filters.to);
  if (page.before !== undefined) {
    // Strictly after the cursor in feed order (occurred_at DESC, seq DESC).
    values.push(page.before.occurredAt, page.before.seq);
    conditions.push(`(occurred_at, seq) < ($${values.length - 1}::timestamptz, $${values.length})`);
  }
  if (page.beforeSeq !== undefined) {
    values.push(page.beforeSeq);
    conditions.push(`(occurred_at, seq) < (SELECT occurred_at, seq FROM activity_entries WHERE user_id = $1 AND seq = $${values.length})`);
  }
  values.push(clampLimit(page.limit));

  const result = await db.query(
    `SELECT user_id, seq, occurred_at, kind, source, agent_id, connector_id, tool,
            outcome, merchant, payload_ct, prev_hash, entry_hash
       FROM activity_entries
      WHERE ${conditions.join(" AND ")}
      ORDER BY occurred_at DESC, seq DESC
      LIMIT $${values.length}`,
    values,
  );

  // Decrypt ONLY the returned page — the WHERE and LIMIT already narrowed the set.
  return Promise.all(result.rows.map((row) => toEntry(row, dek)));
}

// The distinct filterable values in the person's own entries — the agents, connected
// services, kinds and outcomes the Activity filters offer — read from the PLAINTEXT
// metadata columns, so building the dropdowns decrypts nothing and never depends on how
// much of the feed a page shows. Member-scoped (the user id is bound).
export interface ActivityFacets {
  agents: string[];
  services: string[];
  kinds: string[];
  outcomes: string[];
}

export async function listActivityFacets(db: Db, userId: string): Promise<ActivityFacets> {
  const result = await db.query(
    `SELECT 'agent' AS facet, agent_id AS value FROM activity_entries
      WHERE user_id = $1 AND agent_id IS NOT NULL GROUP BY agent_id
     UNION ALL
     SELECT 'service', connector_id FROM activity_entries
      WHERE user_id = $1 AND connector_id IS NOT NULL GROUP BY connector_id
     UNION ALL
     SELECT 'kind', kind FROM activity_entries
      WHERE user_id = $1 GROUP BY kind
     UNION ALL
     SELECT 'outcome', outcome FROM activity_entries
      WHERE user_id = $1 AND outcome IS NOT NULL GROUP BY outcome`,
    [userId],
  );
  const facets: ActivityFacets = { agents: [], services: [], kinds: [], outcomes: [] };
  const into: Record<string, string[]> = {
    agent: facets.agents,
    service: facets.services,
    kind: facets.kinds,
    outcome: facets.outcomes,
  };
  for (const row of result.rows) {
    const value = String(row.value);
    if (value !== "") into[String(row.facet)]?.push(value);
  }
  return facets;
}
