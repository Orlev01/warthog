// Email addresses in the sign-in code tables (review 2026-11-23, High: "the email-code tables
// keep plaintext addresses that the purge never touches"). The code flow runs before an
// account may exist, so `email_codes`, `email_code_attempts` and `email_code_alerts` are keyed
// by the address itself, outside the account's cascade. Two things remove those rows:
//
//   deleteEmailCodeRecords(db, email)  every row for one address (any case or spacing) — the
//                                      account purge calls it with the deleted person's address.
//   pruneEmailCodes(db, now)           the retention sweep: codes and attempts a day after they
//                                      were made (every window that reads them is an hour or
//                                      less), throttle alerts after 90 days (the admin portal's
//                                      longest range counts them).
//
// Pins behaviour against a real in-memory PGlite with the real migrations.

import { test } from "node:test";
import assert from "node:assert/strict";

import { deleteEmailCodeRecords, issueEmailCode, pruneEmailCodes } from "./email-code";
import { createOutbox } from "../notify/outbox";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date("2026-11-23T12:00:00.000Z");
const HMAC_KEY = new Uint8Array(Buffer.from("warthog-email-code-retention-hmac-key-0123456789", "utf8"));

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

async function seedAddress(db: Db, email: string, at: string): Promise<void> {
  await db.query(
    `INSERT INTO email_codes (email, code_hmac, created_at, expires_at, purpose)
     VALUES ($1, 'hmac', $2::timestamptz, $2::timestamptz + interval '10 minutes', 'signup')`,
    [email, at],
  );
  await db.query("INSERT INTO email_code_attempts (email, attempted_at) VALUES ($1, $2::timestamptz)", [email, at]);
  await db.query("INSERT INTO email_code_alerts (email, sent_at) VALUES ($1, $2::timestamptz)", [email, at]);
}

async function countsFor(db: Db, email: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ["email_codes", "email_code_attempts", "email_code_alerts"]) {
    const result = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE lower(btrim(email)) = lower(btrim($1))`, [email]);
    counts[table] = Number(result.rows[0]?.n ?? 0);
  }
  return counts;
}

test("deleteEmailCodeRecords removes every code, attempt and alert for one address, whatever its case", async () => {
  const db = await freshDb();
  try {
    await seedAddress(db, "leaving@example.com", ago(HOUR_MS));
    await seedAddress(db, " Leaving@Example.COM", ago(2 * HOUR_MS)); // a row written before addresses were normalised
    await seedAddress(db, "staying@example.com", ago(HOUR_MS));

    await deleteEmailCodeRecords(db, "Leaving@example.com ");

    assert.deepEqual(await countsFor(db, "leaving@example.com"), { email_codes: 0, email_code_attempts: 0, email_code_alerts: 0 });
    assert.deepEqual(await countsFor(db, "staying@example.com"), { email_codes: 1, email_code_attempts: 1, email_code_alerts: 1 },
      "another address is untouched");
  } finally {
    await db.close();
  }
});

test("deleteEmailCodeRecords binds the address as a value: a probe-shaped address drops nothing", async () => {
  const db = await freshDb();
  try {
    await seedAddress(db, "staying@example.com", ago(HOUR_MS));
    await deleteEmailCodeRecords(db, "x' OR '1'='1");
    assert.deepEqual(await countsFor(db, "staying@example.com"), { email_codes: 1, email_code_attempts: 1, email_code_alerts: 1 });
  } finally {
    await db.close();
  }
});

test("pruneEmailCodes keeps codes and attempts for a day and alerts for 90 days, then deletes them", async () => {
  const db = await freshDb();
  try {
    await seedAddress(db, "recent@example.com", ago(DAY_MS - HOUR_MS));
    await seedAddress(db, "old@example.com", ago(DAY_MS + HOUR_MS));
    await db.query("UPDATE email_code_alerts SET sent_at = $1::timestamptz WHERE email = 'old@example.com'", [ago(89 * DAY_MS)]);
    await db.query("INSERT INTO email_code_alerts (email, sent_at) VALUES ('ancient@example.com', $1::timestamptz)", [ago(91 * DAY_MS)]);

    await pruneEmailCodes(db, NOW);

    assert.deepEqual(await countsFor(db, "recent@example.com"), { email_codes: 1, email_code_attempts: 1, email_code_alerts: 1 },
      "less than a day old: kept");
    assert.deepEqual(await countsFor(db, "old@example.com"), { email_codes: 0, email_code_attempts: 0, email_code_alerts: 1 },
      "a code and an attempt over a day old are gone; an alert under 90 days stays");
    assert.deepEqual(await countsFor(db, "ancient@example.com"), { email_codes: 0, email_code_attempts: 0, email_code_alerts: 0 },
      "an alert over 90 days old is gone");
  } finally {
    await db.close();
  }
});

test("a prune never loosens the issue throttle: the hour's codes still count afterwards", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const deps = { purpose: "signup" as const, clock: fixedClock(NOW), random: systemRandom, hmacKey: HMAC_KEY, emailSender: outbox };
    assert.deepEqual(await issueEmailCode(db, "throttled@example.com", deps), { ok: true });
    await pruneEmailCodes(db, NOW);
    const again = await issueEmailCode(db, "throttled@example.com", deps);
    assert.equal(again.ok, false, "a second code inside the minute is still refused after a prune");
  } finally {
    await db.close();
  }
});
