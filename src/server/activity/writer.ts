// E08-S01 — DB-backed activity writer (design §9 "activity hash chain",
// constitution principle 14 "Warthog writes the record").
//
// The Postgres-backed `ActivityRecorder`: the drop-in production counterpart to the
// in-memory recorder (`./recorder`, E07-S02), reusing its EXACT shapes
// (`ActivityEntryInput`, `ActivityEntry`, `ActivityRecorder` — constitution:
// one-source-of-truth) so the agent pipeline and every write-through depend on the
// one contract. Each `record()`:
//   (a) redacts the payload (`../../domain/redaction/redact`, design §4.3) with the
//       per-user released-value matcher BEFORE anything is persisted — and the
//       PLAINTEXT text metadata an agent can supply (kind, tool, merchant) too, since
//       those land unencrypted in the hash chain;
//   (b) DEK-encrypts the redacted payload into a `v1:` envelope
//       (`../crypto/envelope`, design §4.1) — the readable payload never lands in a
//       column, so a card or released value never reaches the stored ciphertext in
//       clear;
//   (c) assigns a contiguous per-user `seq` (1, 2, 3, …) and chains `prev_hash` to
//       the previous entry's `entry_hash` (a genesis sentinel for the first) — safely
//       under concurrency: appends for one person share a transaction-scoped database lock, and an
//       insert that still loses the seq to another writer (another replica, or an entry
//       committed by an enclosing transaction) re-reads the head and retries, so a
//       parallel tool call never loses its entry or fails after it has run; and
//   (d) computes `entry_hash = SHA-256(prev_hash ‖ canonical(all other fields incl.
//       payload_ct))` over the CIPHERTEXT, so the daily integrity check recomputes
//       the chain from the stored row with no decryption, then inserts the row.
//
// Every statement is parameterized through the `Db` seam (INV-102): the user id and
// every value travel as BOUND values, never concatenated into the SQL text, so a
// value shaped like SQL is stored as inert data and cannot alter the query. Every
// read/write is member-scoped by the `userId` the caller passes — the session's id
// (or the agent connection's), never a client value. This module reads no
// `process.env` and holds no key (INV-103): the clock, the per-user DEK lookup and
// the released-value matcher are all INJECTED.

import { createHash } from "node:crypto";

import type { Clock } from "../seams/clock";
import { redact } from "../../domain/redaction/redact";
import { decrypt, encrypt } from "../crypto/envelope";
import { withTransaction, type Db, type Row } from "../db/index";
import type { ActivityEntry, ActivityEntryInput, ActivityRecorder } from "./recorder";

// The envelope's associated data binds each payload ciphertext to its exact
// location, so a row lifted into another row/column/table fails to decrypt.
const TABLE = "activity_entries";
const PAYLOAD_COLUMN = "payload_ct";

// The genesis sentinel a fresh per-user chain's first entry links back to. Matches
// the in-memory recorder's sentinel and is deliberately NOT a 64-hex string, so it
// can never collide with a real entry hash. Exported so the integrity check
// (`./integrity`, E08-S02) chains the first entry against the SAME sentinel.
export const GENESIS_PREV_HASH = "GENESIS";

// The payload envelope is bound to its exact row by (user_id, seq) — the row's
// natural identity in the per-user chain — so a ciphertext cannot be replayed into
// another position.
function payloadRowId(userId: string, seq: number): string {
  return `${userId}:${seq}`;
}

// How many times one append re-reads the chain head after losing its seq to another
// writer before it gives up. Cooperating appends hold the same database lock,
// so a retry only happens when another writer bypasses that lock and commits the
// same seq first; the cap turns a pathological
// livelock into a clear error instead of a hang.
const MAX_APPEND_ATTEMPTS = 10;

// Serialize in the database, inside the same transaction as the append. A JS
// queue can deadlock: an outside append owns the queue while waiting for the
// database, and an enclosing transaction owns the database while waiting for
// that queue. Transaction-scoped locking also covers independent Pg backends.
// Activity is written last after account/OAuth mutations; it never acquires an
// account or OAuth lock while holding this activity lock.
async function serialisePerUser<T>(db: Db, userId: string, append: (tx: Db) => Promise<T>): Promise<T> {
  const run = async (tx: Db) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`activity-chain:${userId}`]);
    return append(tx);
  };
  return db.inTransaction ? run(db) : withTransaction(db, run);
}

export interface DbRecorderOptions {
  // The parameterizing db seam (INV-102).
  db: Db;
  // Supplies occurred_at (constitution: take a clock, never Date.now()).
  clock: Clock;
  // The person's already-unwrapped DEK, resolved per user — the one-arg recorder
  // contract serves many users, so the DEK is looked up inside record() rather than
  // held. Injected, so this module holds no key (INV-103).
  dekFor: (userId: string) => Promise<Uint8Array>;
  // The per-user released-value fingerprint lookup (the release-fingerprint store
  // backs it a layer up). Omitted ⇒ only the released-value rule is inactive; cards
  // and secret field names are still redacted.
  matchesReleased?: (userId: string, normalisedToken: string) => boolean;
}

// A deterministic serialisation that sorts object keys recursively, so the hash is
// reproducible (the integrity check must recompute it) and independent of the order
// fields happen to be enumerated in.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

// entry_hash = SHA-256(prev_hash ‖ canonical(all other fields incl. payload_ct)).
// `fields` is every stored column except prev_hash (prepended) and entry_hash (the
// output), so recomputation from the stored row reproduces exactly this digest.
// Exported as the ONE definition of the chain digest: the integrity check
// (`./integrity`, E08-S02) recomputes with this same function, so the writer and the
// verifier can never drift (constitution: one source of truth).
export function computeEntryHash(prevHash: string, fields: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${prevHash}\n${canonicalJson(fields)}`, "utf8")
    .digest("hex");
}

// An optional text column as the module's camelCase field: null/absent ⇒ undefined.
function optionalText(value: unknown): string | undefined {
  return value == null ? undefined : String(value);
}

// A timestamptz column back as an ISO-8601 string (the shape ActivityEntry carries).
function toIso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

// The stored identity of one appended entry.
interface AppendedEntry {
  seq: number;
  occurredAt: string;
  prevHash: string;
  entryHash: string;
}

// Append one (already redacted) entry at the head of the person's chain. The insert is
// `ON CONFLICT DO NOTHING`: if another writer committed this seq first, nothing is
// inserted (and, unlike a raised duplicate-key error, an enclosing transaction is NOT
// aborted — on Postgres the insert waits for a conflicting uncommitted row to commit or
// roll back first), so the append re-reads the new head and tries again. The payload is
// re-encrypted and the hash recomputed on every attempt because both are bound to the
// seq. Member-scoped — the user id is bound on every statement.
async function appendEntry(
  db: Db,
  clock: Clock,
  dek: Uint8Array,
  input: ActivityEntryInput,
  payload: unknown,
): Promise<AppendedEntry> {
  const { userId } = input;
  for (let attempt = 1; ; attempt += 1) {
    // The head of THIS user's chain: the previous seq and entry_hash, or the
    // genesis for a fresh chain.
    const head = await db.query(
      "SELECT seq, entry_hash FROM activity_entries WHERE user_id = $1 ORDER BY seq DESC LIMIT 1",
      [userId],
    );
    const prev = head.rows[0];
    const seq = prev ? Number(prev.seq) + 1 : 1;
    const prevHash = prev ? String(prev.entry_hash) : GENESIS_PREV_HASH;

    const occurredAt = clock.now().toISOString();
    const payloadCt = await encrypt(
      dek,
      TABLE,
      PAYLOAD_COLUMN,
      payloadRowId(userId, seq),
      JSON.stringify(payload),
    );

    // The canonical field set the entry hash is taken over (every column but
    // prev_hash and entry_hash), including the ciphertext.
    const hashedFields: Record<string, unknown> = {
      user_id: userId,
      seq,
      occurred_at: occurredAt,
      kind: input.kind,
      source: input.source,
      agent_id: input.agentId ?? null,
      connector_id: input.connectorId ?? null,
      tool: input.tool ?? null,
      outcome: input.outcome ?? null,
      amount: null,
      currency: null,
      merchant: input.merchant ?? null,
      payload_ct: payloadCt,
    };
    const entryHash = computeEntryHash(prevHash, hashedFields);

    const inserted = await db.query(
      `INSERT INTO activity_entries
         (user_id, seq, occurred_at, kind, source, agent_id, connector_id, tool,
          outcome, amount, currency, merchant, payload_ct, prev_hash, entry_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (user_id, seq) DO NOTHING
       RETURNING seq`,
      [
        userId,
        seq,
        occurredAt,
        input.kind,
        input.source,
        input.agentId ?? null,
        input.connectorId ?? null,
        input.tool ?? null,
        input.outcome ?? null,
        null,
        null,
        input.merchant ?? null,
        payloadCt,
        prevHash,
        entryHash,
      ],
    );
    if (inserted.rows.length > 0) {
      return { seq, occurredAt, prevHash, entryHash };
    }
    if (attempt >= MAX_APPEND_ATTEMPTS) {
      throw new Error("The activity entry could not be appended: the chain head kept moving.");
    }
  }
}

export function createDbRecorder(options: DbRecorderOptions): ActivityRecorder {
  const { db, clock, dekFor, matchesReleased } = options;

  return {
    forTransaction: (tx, transactionKey) => createDbRecorder({ ...options, db: tx, dekFor: transactionKey }),
    async record(input: ActivityEntryInput): Promise<ActivityEntry> {
      const { userId } = input;
      const dek = await dekFor(userId);

      // Redact the payload with the per-user matcher BEFORE it is encrypted. An omitted
      // payload is stored as null (JSON has no `undefined`, so it could not be encrypted).
      const perUser = (token: string): boolean =>
        matchesReleased ? matchesReleased(userId, token) : false;
      const payload = redact(input.payload ?? null, perUser);

      // The plaintext columns an agent's text can reach — the kind (log_activity), the tool
      // name and the card merchant (request_card) — are stored readable for filtering and
      // budgets, so they get the same card / released-value / length rules first: a card
      // number or released value an agent (or a prompt injection) puts there never lands
      // in clear. Ids and outcomes are Warthog's own values and are stored as given.
      const text = (value: string): string => String(redact(value, perUser));
      const stored: ActivityEntryInput = {
        ...input,
        kind: text(input.kind),
        tool: input.tool === undefined ? undefined : text(input.tool),
        merchant: input.merchant === undefined ? undefined : text(input.merchant),
      };

      const { seq, occurredAt, prevHash, entryHash } = await serialisePerUser(db, userId, async (tx) => {
        const appended = await appendEntry(tx, clock, dek, stored, payload);
        // The run link is written in the same transaction as the entry, so an entry is never
        // left half-linked, and only to one of the same person's runs: a run that isn't
        // theirs (or no longer exists) leaves the entry unlinked rather than losing it.
        if (input.runId !== undefined) {
          await tx.query(
            `INSERT INTO activity_entry_runs (user_id, entry_seq, run_id)
             SELECT $1, $2, id FROM agent_runs WHERE user_id = $1 AND id::text = $3`,
            [userId, appended.seq, input.runId],
          );
        }
        return appended;
      });

      return {
        userId,
        seq,
        occurredAt,
        kind: stored.kind,
        source: stored.source,
        agentId: stored.agentId,
        connectorId: stored.connectorId,
        tool: stored.tool,
        outcome: stored.outcome,
        merchant: stored.merchant,
        payload,
        prevHash,
        entryHash,
      };
    },
  };
}

// The person's entries in ascending seq order, each payload DECRYPTED under `dek`.
// Member-scoped: the user id is bound (the session's id, never a client value), so
// one person never reads another's entries. A wrong DEK or a tampered ciphertext
// fails the GCM tag and rejects, rather than returning other bytes.
export async function readActivity(
  db: Db,
  userId: string,
  dek: Uint8Array,
): Promise<ActivityEntry[]> {
  const result = await db.query(
    `SELECT user_id, seq, occurred_at, kind, source, agent_id, connector_id, tool,
            outcome, merchant, payload_ct, prev_hash, entry_hash
       FROM activity_entries
      WHERE user_id = $1
      ORDER BY seq ASC`,
    [userId],
  );
  return Promise.all(result.rows.map((row) => toEntry(row, dek)));
}

// A BOUNDED batch of the person's entries in ascending seq order, starting STRICTLY
// AFTER `afterSeq` (pass 0 for the first batch) and at most `limit` rows, each payload
// DECRYPTED under `dek`. Member-scoped (the user id is bound, never a client value) and
// keyset-paginated by seq, so a caller can page through the WHOLE chain in
// memory-bounded batches — decrypting at most `limit` payloads at a time — without ever
// holding the entire history in one query (the export builder reads the full activity
// history this way). Reuses the writer's OWN `toEntry` mapper, so the envelope binding
// and the returned shape never drift from how the record was written (constitution: one
// source of truth). A wrong DEK or a tampered ciphertext fails the GCM tag and rejects.
export async function readActivityBatch(
  db: Db,
  userId: string,
  dek: Uint8Array,
  afterSeq: number,
  limit: number,
): Promise<ActivityEntry[]> {
  const result = await db.query(
    `SELECT user_id, seq, occurred_at, kind, source, agent_id, connector_id, tool,
            outcome, merchant, payload_ct, prev_hash, entry_hash
       FROM activity_entries
      WHERE user_id = $1 AND seq > $2
      ORDER BY seq ASC
      LIMIT $3`,
    [userId, afterSeq, limit],
  );
  return Promise.all(result.rows.map((row) => toEntry(row, dek)));
}

// Map a raw row to an ActivityEntry, decrypting its payload under `dek` bound to the
// row's (user_id, seq). Throws if the DEK is wrong or the ciphertext was tampered.
// Exported as the ONE row→entry decryption mapper: the filtered list read
// (`./list`, E08-S05) reuses it so the envelope binding and the shape can never drift
// from the writer (constitution: one source of truth) — mirroring how `./integrity`
// reuses `computeEntryHash` from here.
export async function toEntry(row: Row, dek: Uint8Array): Promise<ActivityEntry> {
  const userId = String(row.user_id);
  const seq = Number(row.seq);
  const plaintext = await decrypt(
    dek,
    TABLE,
    PAYLOAD_COLUMN,
    payloadRowId(userId, seq),
    String(row.payload_ct),
  );
  return {
    userId,
    seq,
    occurredAt: toIso(row.occurred_at),
    kind: String(row.kind),
    source: row.source as "warthog" | "agent_reported",
    agentId: optionalText(row.agent_id),
    connectorId: optionalText(row.connector_id),
    tool: optionalText(row.tool),
    outcome: optionalText(row.outcome),
    merchant: optionalText(row.merchant),
    payload: JSON.parse(plaintext),
    prevHash: String(row.prev_hash),
    entryHash: String(row.entry_hash),
  };
}
