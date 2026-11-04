// The released-value fingerprint store's data access (design §4.2/§4.3).
//
// On a release the server records a keyed, one-way FINGERPRINT of the handed-over
// value and keeps it 90 days, never the value itself. Redaction (a later task)
// masks any later tool call containing a previously released value by computing the
// token's fingerprint and looking it up here. So this module is pure data access
// over fingerprint HEX DIGESTS: the crypto layer (`../crypto/hmac` `fingerprint`)
// computes them; this module only stores and returns them — the plaintext value is
// never passed to nor written by this repo, and this module holds no key and reads
// no `process.env` (the HMAC key lives in the crypto/config layers; INV-103).
//
// Every statement is parameterized through the `Db` seam (INV-102): the user id and
// fingerprint travel as BOUND values, never concatenated into the SQL text, so a
// value shaped like SQL is stored as data and cannot alter the query. Each lookup is
// member-scoped by the `user_id` the caller passes (the session's id, never a client
// value). Time enters through the injected Clock, never SQL now() (as `jobs.claim`
// does), so the 90-day expiry window is deterministic and testable.

import type { Clock } from "../seams/clock";
import type { Db } from "./index";

// A released value's fingerprint is kept for 90 days from the moment it is stored.
const FINGERPRINT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// What storeFingerprint needs: the person's id and the keyed one-way fingerprint
// (a hex HMAC digest) of the released value. The plaintext value is never taken.
export interface NewReleaseFingerprint {
  readonly userId: string;
  readonly fingerprint: string;
}

// Store a release fingerprint for a person, kept 90 days from clock.now()
// (expires_at = now + 90 days). The plaintext value is never passed here — only its
// already one-way digest.
export async function storeFingerprint(
  db: Db,
  { userId, fingerprint }: NewReleaseFingerprint,
  clock: Clock,
): Promise<void> {
  const expiresAt = new Date(clock.now().getTime() + FINGERPRINT_TTL_MS).toISOString();
  await db.query(
    `INSERT INTO release_fingerprints (user_id, fingerprint, expires_at)
     VALUES ($1, $2, $3::timestamptz)`,
    [userId, fingerprint, expiresAt],
  );
}

// Return this person's fingerprints whose 90-day window has NOT lapsed as of
// clock.now() (WHERE user_id = $1 AND expires_at > now) — only that user's rows,
// with the user id bound as a parameter (member-scoped; the caller passes the
// session user id, never a client value).
export async function lookupForUser(db: Db, userId: string, clock: Clock): Promise<string[]> {
  const result = await db.query(
    `SELECT fingerprint FROM release_fingerprints
      WHERE user_id = $1 AND expires_at > $2::timestamptz`,
    [userId, clock.now().toISOString()],
  );
  return result.rows.map((row) => row.fingerprint as string);
}
