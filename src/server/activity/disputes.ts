// E08-S03 — Activity disputes (append-only) (design §9 "activity hash chain",
// constitution principle 14 "Warthog writes the record").
//
// A person can dispute an activity entry. The record is APPEND-ONLY and hash-chained
// over ciphertext, so the ORIGINAL entry is NEVER changed; `fileDispute` adds the
// dispute ALONGSIDE it, as its own row in `activity_disputes` referencing the entry by
// (user_id, entry_seq). The disputed entry row — and its entry_hash — is left
// untouched, and the chain still verifies intact.
//
// The dispute note is PERSONAL CONTENT, so it is DEK-ENCRYPTED into a `v1:` envelope
// (`../crypto/envelope`, design §4.1) before it is stored — the readable note never
// lands in a column. The envelope's associated data binds each note to its exact row
// (table, column, the per-entry dispute seq), so a wrong DEK or a ciphertext lifted
// into another row fails to decrypt.
//
// Every statement is parameterized through the `Db` seam (INV-102): the user id and
// every value travel as BOUND values, never concatenated into the SQL text, so a value
// shaped like SQL is stored as inert data and cannot alter the query. Both reads and
// writes are member-scoped by the `userId` the caller passes — the session's id (or the
// agent connection's), never a client value — so a person can only dispute, and only
// read disputes on, their OWN entries. This module reads no `process.env` and holds no
// key (INV-103): the clock and the per-user DEK lookup are INJECTED.

import type { Clock } from "../seams/clock";
import { decrypt, encrypt } from "../crypto/envelope";
import type { Db, Row } from "../db/index";

// The envelope binds each note ciphertext to its exact location, so a row lifted into
// another row/column/table fails to decrypt.
const TABLE = "activity_disputes";
const NOTE_COLUMN = "note_ct";

// The note envelope is bound to its exact row by (user_id, entry_seq, dispute_seq) —
// the dispute's natural identity — so a ciphertext cannot be replayed into another
// position.
function noteRowId(userId: string, entrySeq: number, disputeSeq: number): string {
  return `${userId}:${entrySeq}:${disputeSeq}`;
}

// What the caller files: the person (the SESSION user id, the member scope), the
// disputed entry's seq within THAT person's chain, and the note (plaintext in).
export interface FileDisputeInput {
  readonly userId: string;
  readonly entrySeq: number;
  readonly note: string;
}

// A filed/read dispute, as handed back to callers. The note is in plaintext (decrypted
// on read); `createdAt` is the injected clock's instant as ISO-8601.
export interface FiledDispute {
  readonly userId: string;
  readonly entrySeq: number;
  readonly createdAt: string;
  readonly note: string;
}

export interface DisputeRepoOptions {
  // The parameterizing db seam (INV-102).
  db: Db;
  // Supplies created_at (constitution: take a clock, never Date.now()).
  clock: Clock;
  // The person's already-unwrapped DEK, resolved per user — looked up inside each call
  // rather than held, so this module holds no key (INV-103).
  dekFor: (userId: string) => Promise<Uint8Array>;
}

export interface DisputeRepo {
  // Attach a dispute to one of the CALLER'S OWN entries, identified by the caller's
  // userId + entrySeq. An entry the caller does not own (no such row for that userId)
  // is rejected; the referenced entry row is never altered. The note is DEK-encrypted
  // before it is stored.
  fileDispute(input: FileDisputeInput): Promise<FiledDispute>;
  // The caller's disputes on their OWN entry (userId bound, never a client value), each
  // note decrypted under the caller's DEK.
  readDisputes(userId: string, entrySeq: number): Promise<FiledDispute[]>;
}

// Map a stored dispute row to a FiledDispute, decrypting its note under `dek` bound to
// the row's (user_id, entry_seq, dispute_seq). Throws if the DEK is wrong or the
// ciphertext was tampered.
async function toDispute(row: Row, dek: Uint8Array): Promise<FiledDispute> {
  const userId = String(row.user_id);
  const entrySeq = Number(row.entry_seq);
  const disputeSeq = Number(row.dispute_seq);
  const note = await decrypt(
    dek,
    TABLE,
    NOTE_COLUMN,
    noteRowId(userId, entrySeq, disputeSeq),
    String(row.note_ct),
  );
  return {
    userId,
    entrySeq,
    createdAt: new Date(row.created_at as string | number | Date).toISOString(),
    note,
  };
}

// How many times one filing re-reads the next dispute seq after losing it to a dispute
// filed at the same moment, before giving up with a clear error.
const MAX_FILE_ATTEMPTS = 10;

export function createDisputeRepo(options: DisputeRepoOptions): DisputeRepo {
  const { db, clock, dekFor } = options;

  return {
    async fileDispute(input: FileDisputeInput): Promise<FiledDispute> {
      const { userId, entrySeq, note } = input;

      // Member-scoped ownership check: the dispute can only reference one of the
      // CALLER'S OWN entries (user_id bound to the caller, never a client value). An
      // entry the caller does not own has no such row → reject, never touch it.
      const entry = await db.query(
        "SELECT seq FROM activity_entries WHERE user_id = $1 AND seq = $2",
        [userId, entrySeq],
      );
      if (!entry.rows[0]) {
        throw new Error(`no activity entry at seq ${entrySeq} to dispute`);
      }

      const createdAt = clock.now().toISOString();
      const dek = await dekFor(userId);

      // The next per-entry dispute seq (1, 2, 3, …): the table is append-only, so
      // max+1 is contiguous. It gives each dispute its own identity for envelope
      // binding. Two disputes filed at once (a double-submitted form, a second device)
      // can read the same max: the insert is `ON CONFLICT DO NOTHING`, so the one that
      // loses simply re-reads the max and takes the next seq (re-encrypting, since the
      // envelope is bound to the seq) instead of failing.
      for (let attempt = 1; ; attempt += 1) {
        const head = await db.query(
          "SELECT max(dispute_seq) AS m FROM activity_disputes WHERE user_id = $1 AND entry_seq = $2",
          [userId, entrySeq],
        );
        const disputeSeq = Number(head.rows[0]?.m ?? 0) + 1;
        const noteCt = await encrypt(
          dek,
          TABLE,
          NOTE_COLUMN,
          noteRowId(userId, entrySeq, disputeSeq),
          note,
        );

        const inserted = await db.query(
          `INSERT INTO activity_disputes (user_id, entry_seq, dispute_seq, note_ct, created_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, entry_seq, dispute_seq) DO NOTHING
           RETURNING dispute_seq`,
          [userId, entrySeq, disputeSeq, noteCt, createdAt],
        );
        if (inserted.rows.length > 0) break;
        if (attempt >= MAX_FILE_ATTEMPTS) {
          throw new Error("The dispute could not be stored: other disputes kept arriving at once.");
        }
      }

      return { userId, entrySeq, createdAt, note };
    },

    async readDisputes(userId: string, entrySeq: number): Promise<FiledDispute[]> {
      const result = await db.query(
        `SELECT user_id, entry_seq, dispute_seq, note_ct, created_at
           FROM activity_disputes
          WHERE user_id = $1 AND entry_seq = $2
          ORDER BY dispute_seq ASC`,
        [userId, entrySeq],
      );
      if (result.rows.length === 0) return [];
      const dek = await dekFor(userId);
      return Promise.all(result.rows.map((row) => toDispute(row, dek)));
    },
  };
}
