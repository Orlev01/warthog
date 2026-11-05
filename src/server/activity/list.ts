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
// This module reads no `process.env` and holds no key (INV-103): the db and the
// per-person DEK are INJECTED. Decryption reuses the writer's OWN row→entry mapper
// (`toEntry` from `./writer`), so the envelope binding and the returned shape can
// never drift from how the record was written (constitution: one source of truth).

import { toEntry } from "./writer";
import type { ActivityEntry } from "./recorder";
import type { Db } from "../db/index";

// The filters a list read narrows by. Every field is optional; an omitted filter does
// not constrain, and filters COMBINE with AND. `from`/`to` are inclusive ISO-8601
// bounds on occurred_at; `agentId`/`connectorId` map to the entry's agent/service.
export interface ActivityFilters {
  agentId?: string;
  connectorId?: string;
  kind?: string;
  outcome?: string;
  from?: string;
  to?: string;
}

// List `userId`'s entries, newest first, narrowed by `filters`, each payload decrypted
// under `dek`. No filters ⇒ all the person's entries. A filter matching nothing ⇒ an
// empty list (not an error). A wrong DEK or a tampered ciphertext inside the filtered
// set fails the GCM tag and rejects.
export async function listActivity(
  db: Db,
  userId: string,
  filters: ActivityFilters,
  dek: Uint8Array,
): Promise<ActivityEntry[]> {
  // The member scope is always the first bound value; each present filter appends its
  // own bound value and a condition over a FIXED column name (never from input).
  const conditions: string[] = ["user_id = $1"];
  const values: unknown[] = [userId];
  const bind = (column: string, op: string, value: string): void => {
    values.push(value);
    conditions.push(`${column} ${op} $${values.length}`);
  };

  if (filters.agentId !== undefined) bind("agent_id", "=", filters.agentId);
  if (filters.connectorId !== undefined) bind("connector_id", "=", filters.connectorId);
  if (filters.kind !== undefined) bind("kind", "=", filters.kind);
  if (filters.outcome !== undefined) bind("outcome", "=", filters.outcome);
  if (filters.from !== undefined) bind("occurred_at", ">=", filters.from);
  if (filters.to !== undefined) bind("occurred_at", "<=", filters.to);

  const result = await db.query(
    `SELECT user_id, seq, occurred_at, kind, source, agent_id, connector_id, tool,
            outcome, merchant, payload_ct, prev_hash, entry_hash
       FROM activity_entries
      WHERE ${conditions.join(" AND ")}
      ORDER BY occurred_at DESC, seq DESC`,
    values,
  );

  // Decrypt ONLY the filtered rows — the WHERE already narrowed the set.
  return Promise.all(result.rows.map((row) => toEntry(row, dek)));
}
