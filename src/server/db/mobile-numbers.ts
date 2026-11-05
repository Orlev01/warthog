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
// Every statement is parameterized through the `Db` seam (INV-102): the id, user id,
// number and keyed digest travel as BOUND values, never concatenated into the SQL
// text, so a value shaped like SQL is stored as data and cannot alter the query.
// Each read/write is member-scoped by the `userId` the caller passes (the session's
// id, never a client value). Time enters through the injected Clock, never SQL
// now(), so the expiry window is deterministic and testable. This module reads no
// `process.env` and holds no key — db / hmacKey / clock / random / smsSender are all
// injected (INV-103), so no ambient env value can land in a stored or returned row.

import { randomUUID } from "node:crypto";

import { hmac } from "../crypto/hmac";
import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";
import type { SmsSender } from "../notify/senders";
import type { Db, Row } from "./index";

const CODE_DIGITS = 6;
const CODE_MODULUS = 10 ** CODE_DIGITS; // reduce entropy into [0, 999999]
const CODE_ENTROPY_BYTES = 4; // 32 bits, reduced to the 6-digit space

const MINUTE_MS = 60 * 1000;
const CODE_TTL_MS = 10 * MINUTE_MS; // a verification code lapses ten minutes after issue

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

  await db.query(
    `INSERT INTO mobile_numbers (id, user_id, number, code_hmac, code_expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)`,
    [id, input.userId, input.number, hmac(deps.hmacKey, code), expiresAt.toISOString(), now.toISOString()],
  );

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
// user id are both bound, so a number that is not this person's matches nothing. The
// code is matched by its keyed digest (the raw code never reaches the query layer):
// no matching row is "invalid"; a matching row past its expiry is "expired" and does
// NOT verify; a matching, unexpired row marks the number verified at the clock's
// instant and returns { ok: true }.
export async function verifyMobileNumber(
  db: Db,
  input: VerifyMobileNumberInput,
  deps: VerifyMobileNumberDeps,
): Promise<VerifyMobileResult> {
  const now = deps.clock.now();

  const found = await db.query(
    `SELECT id, code_expires_at
       FROM mobile_numbers
      WHERE id = $1 AND user_id = $2 AND code_hmac = $3`,
    [input.id, input.userId, hmac(deps.hmacKey, input.code)],
  );
  const row = found.rows[0];
  if (!row) {
    return { ok: false, reason: "invalid" };
  }

  if (new Date(row.code_expires_at as string | number | Date).getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }

  await db.query(
    `UPDATE mobile_numbers
        SET verified = true, verified_at = $3::timestamptz
      WHERE id = $1 AND user_id = $2`,
    [input.id, input.userId, now.toISOString()],
  );
  return { ok: true };
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
