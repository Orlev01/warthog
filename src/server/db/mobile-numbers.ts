// E12-S03 — the verified mobile-number store (design §10 Notifications, brief
// "SMS fallback"). The approval SMS fallback delivers only to a VERIFIED number.
//
// A person adds a mobile number: Warthog draws a 6-digit code, stores ONLY a keyed
// HMAC of it (`code_hmac`) with an expiry, and delivers the code in exactly one SMS
// (project rule: codes are stored only as an HMAC and appear in plain text nowhere
// except the single message that delivers a person their own code — here that
// message IS the SMS). The raw code is written to no column, returned to no caller
// and never reaches the query layer as a bound value: only its HMAC is stored and
// matched, so a leak of this table or the query log can never reveal a live code.
// The person presents the code back; a correct, unexpired code marks the number
// verified. A wrong code, or one for another person's number, is "invalid"; a code
// presented past its expiry is "expired" and does not verify.
//
// Abuse limits (review fix F5). Every add sends an SMS at the operator's cost, so sends are
// capped per person and per destination number (its digits, so formatting variations count as
// one number), and the cap check and the insert are ONE atomic step: an add over the cap
// throws a 429 `HttpError` before any row is written or SMS sent. A code allows
// MAX_CODE_ATTEMPTS presentations (counted atomically, before the comparison), after which it
// is dead and reported "expired" (send a new one); the verification it completes consumes it.
//
// Every statement is parameterized through the `Db` seam (INV-102): the id, user id,
// number and keyed digest travel as BOUND values, never concatenated into the SQL
// text, so a value shaped like SQL is stored as data and cannot alter the query.
// Each read/write is member-scoped by the `userId` the caller passes (the session's
// id, never a client value). Time enters through the injected Clock, never SQL
// now(), so the expiry window is deterministic and testable. This module reads no
// `process.env` and holds no key — db / hmacKey / clock / random / smsSender are all
// injected (INV-103), so no ambient env value can land in a stored or returned row.

import { randomUUID } from "node:crypto";

import { hmac, verifyHmac } from "../crypto/hmac";
import { HttpError } from "../http/validate";
import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";
import type { SmsSender } from "../notify/senders";
import { withTransaction, type Db, type Row } from "./index";

const CODE_DIGITS = 6;
const CODE_MODULUS = 10 ** CODE_DIGITS; // reduce entropy into [0, 999999]
const CODE_ENTROPY_BYTES = 4; // 32 bits, reduced to the 6-digit space

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const CODE_TTL_MS = 10 * MINUTE_MS; // a verification code lapses ten minutes after issue
const MAX_CODE_ATTEMPTS = 5; // presentations of one code before it is dead

// The SMS send caps, each over a sliding window ending now: per person, and per destination
// number across every person (so many accounts cannot pump one number).
const SEND_LIMITS = {
  perPersonHour: 3,
  perPersonDay: 10,
  perNumberHour: 3,
  perNumberDay: 5,
} as const;

// One fixed advisory-lock key serialises concurrent adds on a pooled pg connection, so two
// adds cannot both pass the cap check before either inserts.
const SEND_LOCK_KEY = "warthog.mobile_numbers.send";

// What addMobileNumber takes: the person (the SESSION's id, never a client value)
// and the mobile number to add.
export interface AddMobileNumberInput {
  readonly userId: string;
  readonly number: string;
}

// addMobileNumber draws and hashes a code and sends it by SMS, so it needs the
// clock (the issue instant), entropy for the code, the key the HMAC is stored under
// (INJECTED), and the SMS channel the code is delivered on.
export interface AddMobileNumberDeps {
  readonly clock: Clock;
  readonly random: Random;
  readonly hmacKey: Uint8Array;
  readonly smsSender: SmsSender;
}

// What verifyMobileNumber takes: the person (the SESSION's id), the number's id and
// the 6-digit code the person received by SMS.
export interface VerifyMobileNumberInput {
  readonly userId: string;
  readonly id: string;
  readonly code: string;
}

// verifyMobileNumber recomputes the keyed HMAC and checks the expiry, so it needs
// the clock (the verify instant) and the SAME key the code was stored under.
export interface VerifyMobileNumberDeps {
  readonly clock: Clock;
  readonly hmacKey: Uint8Array;
}

// A stored mobile number as handed back to callers. The raw code is never a field —
// it lives only in the delivered SMS.
export interface StoredMobileNumber {
  readonly id: string;
  readonly userId: string;
  readonly number: string;
  readonly verified: boolean;
  readonly createdAt: Date | string;
  readonly verifiedAt: Date | string | null;
}

// What verify reports back — a discriminated union on `ok`. A correct, unexpired
// code is accepted; a lapsed code is "expired"; a wrong code, or no pending code for
// this person+id, is "invalid".
export type VerifyMobileResult =
  | { ok: true }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "expired" };

// Draw a 6-digit code from the entropy seam: 32 random bits reduced into the
// [0, 999999] space, rendered as a zero-padded six-character string.
function drawCode(random: Random): string {
  const n = Buffer.from(random.randomBytes(CODE_ENTROPY_BYTES)).readUInt32BE(0) % CODE_MODULUS;
  return String(n).padStart(CODE_DIGITS, "0");
}

// Map a raw row to a StoredMobileNumber, translating snake_case columns to the
// module's camelCase fields.
function toStored(row: Row): StoredMobileNumber {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    number: row.number as string,
    verified: row.verified as boolean,
    createdAt: row.created_at as Date | string,
    verifiedAt: (row.verified_at as Date | string | null) ?? null,
  };
}

// Add an UNVERIFIED number for `userId`: draw a 6-digit code, store it as
// HMAC(hmacKey, code) with a ten-minute expiry, and deliver the code in exactly one
// SMS to `number`. The id is generated here and the returned number is assembled
// from the inputs (it does not depend on a RETURNING read). The raw code is written
// to no column and returned to no caller — it lives only in the delivered SMS.
export async function addMobileNumber(
  db: Db,
  input: AddMobileNumberInput,
  deps: AddMobileNumberDeps,
): Promise<StoredMobileNumber> {
  const id = randomUUID();
  const code = drawCode(deps.random);
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  const hourAgo = new Date(now.getTime() - HOUR_MS).toISOString();
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();

  // The cap check and the insert are one statement under one lock: the row is written only
  // when every window is under its cap, so concurrent adds can never overshoot.
  const inserted = await withTransaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [SEND_LOCK_KEY]);
    return tx.query(
      `INSERT INTO mobile_numbers (id, user_id, number, code_hmac, code_expires_at, created_at)
       SELECT $1::uuid, $2::uuid, $3::text, $4::text, $5::timestamptz, $6::timestamptz
        WHERE (SELECT count(*) FROM mobile_numbers
                WHERE user_id = $2::uuid AND created_at > $7::timestamptz) < $9::int
          AND (SELECT count(*) FROM mobile_numbers
                WHERE user_id = $2::uuid AND created_at > $8::timestamptz) < $10::int
          AND (SELECT count(*) FROM mobile_numbers
                WHERE regexp_replace(number, '[^0-9]', '', 'g') = regexp_replace($3::text, '[^0-9]', '', 'g')
                  AND created_at > $7::timestamptz) < $11::int
          AND (SELECT count(*) FROM mobile_numbers
                WHERE regexp_replace(number, '[^0-9]', '', 'g') = regexp_replace($3::text, '[^0-9]', '', 'g')
                  AND created_at > $8::timestamptz) < $12::int
       RETURNING id`,
      [
        id,
        input.userId,
        input.number,
        hmac(deps.hmacKey, code),
        expiresAt.toISOString(),
        now.toISOString(),
        hourAgo,
        dayAgo,
        SEND_LIMITS.perPersonHour,
        SEND_LIMITS.perPersonDay,
        SEND_LIMITS.perNumberHour,
        SEND_LIMITS.perNumberDay,
      ],
    );
  });
  if (inserted.rows.length === 0) {
    throw new HttpError(429, "Too many verification texts. Try again later.");
  }

  await deps.smsSender.sendSms({
    recipient: input.number,
    body:
      `Your Warthog verification code is ${code}. ` +
      `It expires in 10 minutes. If you did not request this, you can ignore this message.`,
  });

  return {
    id,
    userId: input.userId,
    number: input.number,
    verified: false,
    createdAt: now,
    verifiedAt: null,
  };
}

// Verify a presented code for this person's number. Member-scoped: the id AND the
// user id are both bound, so a number that is not this person's matches nothing.
//   1. The presentation is counted FIRST, atomically, and only while the code is pending and
//      under MAX_CODE_ATTEMPTS — so parallel guesses can never exceed the limit. No pending
//      code (none, consumed, or another person's) is "invalid"; a pending code whose attempts
//      are spent is dead and "expired" (send a new one).
//   2. The keyed digest is compared in constant time (the raw code never reaches the query
//      layer): a mismatch is "invalid"; a match past its expiry is "expired".
//   3. A matching, unexpired code is consumed by a compare-and-swap on its digest that also
//      marks the number verified, so it verifies exactly once even under a race.
export async function verifyMobileNumber(
  db: Db,
  input: VerifyMobileNumberInput,
  deps: VerifyMobileNumberDeps,
): Promise<VerifyMobileResult> {
  const now = deps.clock.now();

  const counted = await db.query(
    `UPDATE mobile_numbers
        SET code_attempts = code_attempts + 1
      WHERE id = $1 AND user_id = $2 AND code_hmac IS NOT NULL AND code_attempts < $3
      RETURNING code_hmac, code_expires_at`,
    [input.id, input.userId, MAX_CODE_ATTEMPTS],
  );
  const row = counted.rows[0];
  if (!row) {
    const pending = await db.query(
      "SELECT 1 FROM mobile_numbers WHERE id = $1 AND user_id = $2 AND code_hmac IS NOT NULL",
      [input.id, input.userId],
    );
    return pending.rows.length > 0 ? { ok: false, reason: "expired" } : { ok: false, reason: "invalid" };
  }

  const storedHmac = row.code_hmac as string;
  if (!verifyHmac(deps.hmacKey, input.code, storedHmac)) {
    return { ok: false, reason: "invalid" };
  }

  if (new Date(row.code_expires_at as string | number | Date).getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }

  const consumed = await db.query(
    `UPDATE mobile_numbers
        SET verified = true, verified_at = $3::timestamptz, code_hmac = NULL, code_expires_at = NULL
      WHERE id = $1 AND user_id = $2 AND code_hmac = $4
      RETURNING id`,
    [input.id, input.userId, now.toISOString(), storedHmac],
  );
  return consumed.rows.length > 0 ? { ok: true } : { ok: false, reason: "invalid" };
}

// All of `userId`'s numbers (member-scoped: WHERE user_id bound), with their
// verified flag — never another person's. An empty array when the person has none.
export async function listMobileNumbers(db: Db, userId: string): Promise<StoredMobileNumber[]> {
  const result = await db.query(
    `SELECT id, user_id, number, verified, created_at, verified_at
       FROM mobile_numbers
      WHERE user_id = $1
      ORDER BY created_at ASC`,
    [userId],
  );
  return result.rows.map(toStored);
}
