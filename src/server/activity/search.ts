// E08-S06 — Activity search (design §4.1, §9, constitution principle 14
// "Warthog writes the record").
//
// The person searches their timeline. Warthog cannot match over encrypted summaries
// in SQL, so search DECRYPTS in-app within the ALREADY user-filtered set and matches
// the query over the decrypted summary text — "acceptable at v1 scale" (design §4.1).
//
// Like the sibling `listActivity` (`./list`, E08-S05), this is a member-scoped,
// newest-first read that decrypts each payload IN-APP over the scoped set, reusing the
// writer's OWN row→entry mapper (`toEntry` from `./writer`) so the envelope binding and
// the returned shape can never drift from how the record was written (constitution: one
// source of truth). The structured `filters` object becomes a free-text `query`:
//   • MEMBER-SCOPED: the user id is the SESSION's id the caller passes (never a client
//     value) and travels as a BOUND value ($1), so one person never reads another's
//     entries and a value shaped like SQL is inert data that cannot alter the query.
//   • CAPPED at 5,000 rows per query: the SELECT that feeds decryption carries a
//     `LIMIT 5000` over the most-recent rows (ORDER BY … DESC), so the number of
//     decryptions per search is bounded — the cap is a SQL LIMIT, not a post-fetch slice.
//   • DECRYPTS WITHIN THE SET: every row in the capped, scoped set is decrypted under
//     `dek` BEFORE matching, so a wrong DEK or a tampered ciphertext fails the GCM tag
//     and rejects (genuine decryption, never a plaintext read).
//   • The query is matched IN-APP against each decrypted summary — it never reaches the
//     SQL text at all (INV-102), so a SQL-injection probe in the query is inert data.
//
// This module reads no `process.env` and holds no key (INV-103): the db and the
// per-person DEK are INJECTED.

import { toEntry } from "./writer";
import type { ActivityEntry } from "./recorder";
import type { Db } from "../db/index";

// The per-query scan cap (design §4.1 "capped at 5,000 rows"): a fixed in-code
// constant, never external input, so interpolating it into the LIMIT is not a
// parameter-binding concern.
const SCAN_LIMIT = 5000;

// Search `userId`'s entries, returning the ones whose decrypted summary CONTAINS
// `query` as a case-insensitive substring, newest first. A query matching nothing ⇒ an
// empty list (not an error). A wrong DEK or a tampered ciphertext inside the scoped set
// fails the GCM tag and rejects.
export async function searchActivity(
  db: Db,
  userId: string,
  query: string,
  dek: Uint8Array,
): Promise<ActivityEntry[]> {
  // The member scope travels as a bound value; the LIMIT bounds the per-query scan to
  // the most-recent rows. The query text is NOT part of the statement — it is matched
  // in-app below.
  const result = await db.query(
    `SELECT user_id, seq, occurred_at, kind, source, agent_id, connector_id, tool,
            outcome, merchant, payload_ct, prev_hash, entry_hash
       FROM activity_entries
      WHERE user_id = $1
      ORDER BY occurred_at DESC, seq DESC
      LIMIT ${SCAN_LIMIT}`,
    [userId],
  );

  // Decrypt the WHOLE scoped set before matching: a corrupt ciphertext or a wrong DEK
  // anywhere in the set rejects here rather than being silently skipped.
  const entries = await Promise.all(result.rows.map((row) => toEntry(row, dek)));

  const needle = query.toLowerCase();
  return entries.filter((entry) => summaryText(entry.payload).toLowerCase().includes(needle));
}

// The readable text search matches over: the payload's `summary` string (as the
// list/home feed store it). A payload without a string `summary` contributes no text,
// so it simply never matches.
function summaryText(payload: unknown): string {
  if (payload !== null && typeof payload === "object") {
    const value = (payload as Record<string, unknown>).summary;
    if (typeof value === "string") return value;
  }
  return "";
}
