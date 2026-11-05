// E08-S02 — Activity integrity check (design §9 "activity hash chain",
// constitution principle 14 "Warthog writes the record", INV-19 operators cannot
// read vault contents).
//
// The person and a daily job verify that the append-only activity record was not
// altered, removed or reordered. `checkIntegrity` recomputes the per-user hash chain
// FROM THE STORED ROW ALONE — over the CIPHERTEXT, with NO decryption — so tampering
// is detectable without any path to the vault contents (INV-19). It reports either
// all N entries intact or the seq of the first broken entry.
//
// For each entry (read in ascending seq order) it checks three things:
//   (1) `seq` is contiguous (1, 2, 3, … per user) — a deletion or insertion shows as
//       a gap;
//   (2) `prev_hash` chains to the previous entry's `entry_hash` (the genesis sentinel
//       for the first) — a reorder breaks the link; and
//   (3) `entry_hash` recomputes from the stored row via the writer's OWN digest
//       (`computeEntryHash`, from `./writer` — the single source of the formula, so
//       the verifier can never drift from the writer) — any mutation of a hashed
//       field, including the stored ciphertext, no longer matches.
//
// The digest is taken over the ciphertext bytes; this module receives no DEK and no
// key material (the `(db, userId)` signature carries none), so it cannot decrypt a
// payload even in principle (design §9, INV-19). It reads no `process.env` and holds
// no secret (INV-103): the db is INJECTED.
//
// Member-scoped (INV-102): the user id is BOUND as a parameter — the session's id (or
// the agent connection's), never a client value — so one person's check never reads
// or is affected by another's entries. The id is compared as text (`user_id::text`),
// so a value that is not a well-formed uuid simply matches no rows rather than
// erroring at the type boundary (OBS-049); a value shaped like SQL is stored/compared
// as inert data and cannot alter the query.

import { computeEntryHash, GENESIS_PREV_HASH } from "./writer";
import type { Db, Row } from "../db/index";

// What a check reports.
export interface IntegrityResult {
  // true ⇔ every stored entry verifies (all N intact).
  intact: boolean;
  // How many entries were examined.
  checked: number;
  // The seq of the FIRST broken entry; null when intact.
  brokenSeq: number | null;
}

// The canonical field set the entry hash is taken over, rebuilt from a STORED row —
// every column except prev_hash (prepended by `computeEntryHash`) and entry_hash (its
// output). It MUST mirror the writer's `hashedFields` exactly (same keys, same value
// shapes) or a sound chain would fail to recompute; `canonicalize` inside
// `computeEntryHash` sorts keys, so only the values must match, not their order.
function hashedFieldsFromRow(row: Row): Record<string, unknown> {
  return {
    user_id: String(row.user_id),
    seq: Number(row.seq),
    // The timestamptz back to the exact ISO-8601 string the writer hashed.
    occurred_at: new Date(row.occurred_at as string | number | Date).toISOString(),
    kind: String(row.kind),
    source: String(row.source),
    agent_id: row.agent_id == null ? null : String(row.agent_id),
    connector_id: row.connector_id == null ? null : String(row.connector_id),
    tool: row.tool == null ? null : String(row.tool),
    outcome: row.outcome == null ? null : String(row.outcome),
    amount: row.amount ?? null,
    currency: row.currency ?? null,
    merchant: row.merchant == null ? null : String(row.merchant),
    payload_ct: String(row.payload_ct),
  };
}

// Recompute the per-user hash chain over the stored ciphertext and report whether it
// is intact, or the seq of the first broken entry. Reads only the given user's
// entries (bound as a parameter) and never decrypts a payload.
export async function checkIntegrity(db: Db, userId: string): Promise<IntegrityResult> {
  const result = await db.query(
    `SELECT user_id, seq, occurred_at, kind, source, agent_id, connector_id, tool,
            outcome, amount, currency, merchant, payload_ct, prev_hash, entry_hash
       FROM activity_entries
      WHERE user_id::text = $1
      ORDER BY seq ASC`,
    [userId],
  );
  const rows = result.rows;

  let expectedSeq = 1;
  let expectedPrev = GENESIS_PREV_HASH;
  let examined = 0;
  for (const row of rows) {
    const seq = Number(row.seq);
    const prevHash = String(row.prev_hash);
    const entryHash = String(row.entry_hash);
    examined += 1;

    // (1) seq must be contiguous — a hole or an insertion shows here.
    if (seq !== expectedSeq) {
      return { intact: false, checked: examined, brokenSeq: seq };
    }
    // (2) prev_hash must chain to the previous entry's entry_hash (genesis first).
    if (prevHash !== expectedPrev) {
      return { intact: false, checked: examined, brokenSeq: seq };
    }
    // (3) entry_hash must recompute from the stored row — any altered hashed field,
    // including the ciphertext, breaks this (no decryption is attempted).
    if (computeEntryHash(prevHash, hashedFieldsFromRow(row)) !== entryHash) {
      return { intact: false, checked: examined, brokenSeq: seq };
    }

    expectedSeq = seq + 1;
    expectedPrev = entryHash;
  }

  return { intact: true, checked: rows.length, brokenSeq: null };
}
