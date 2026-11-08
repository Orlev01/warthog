// E04-S02 — Email one-time codes (`src/server/auth/email-code.ts`,
// `db/migrations/0005_email_codes.sql`).
//
// RED-first: neither the email-code module nor the migration exists yet, so importing
// `./email-code` throws and `freshDb()` has no `email_codes` table — every test here
// fails until the builder adds them. That absence IS the point of test-first; do not
// implement anything to make these pass.
//
// These tests pin BEHAVIOUR (what issue/verify DO, what the migration produces),
// never the source text of the module or the SQL file — a later rename that preserves
// behaviour must not redden them.
//
// The contract this task defines (design §5: "Email one-time codes: 6 digits,
// 10-minute expiry, stored as HMAC, max 5 attempts, then backoff"; the builder
// implements exactly this):
//
//   issueEmailCode(db, email, { clock, random, hmacKey, emailSender }): Promise<unknown>
//     • draws a 6-digit code from the `random` seam, stores it as HMAC(hmacKey, code)
//       with an expiry of clock.now() + 10 minutes, and delivers the code to `email`
//       via emailSender.sendEmail({ recipient: email, body: <contains the 6 digits>, … }).
//     • the raw code appears ONLY in that one delivered email — never in the value
//       issueEmailCode returns, and never in plaintext in the stored row (project rule:
//       codes are stored only as an HMAC and never appear in plain text anywhere except
//       the single message that delivers a person their own code).
//
//   verifyEmailCode(db, email, code, { clock, hmacKey, emailSender }): Promise<VerifyResult>
//     VerifyResult (a discriminated union on `ok`):
//       | { ok: true }                                             // accepted
//       | { ok: false; reason: "invalid" }                        // wrong code (a failure)
//       | { ok: false; reason: "expired" }                        // past the 10-minute expiry
//       | { ok: false; reason: "throttled"; retryAfterMs: number } // backoff in force
//     • a correct, unexpired code within the attempt budget → { ok: true }, and the code
//       is single-use (a second verify of the same code does NOT succeed).
//     • a wrong code → { ok: false, reason: "invalid" } and counts as a failed attempt.
//     • a code presented past its 10-minute expiry → { ok: false, reason: "expired" }.
//     • after 5 failed attempts within a 15-minute window, FURTHER attempts (even the
//       correct code) are slowed: { ok: false, reason: "throttled", retryAfterMs > 0 },
//       and the account holder is emailed an alert (which must not leak the code).
//
// Acceptance criteria → tests:
//   AC1 "Issues a 6-digit code stored as an HMAC with a 10-minute expiry and emails it
//        via the sender." — issueEmailCode sends exactly one email to the address whose
//        body carries a 6-digit code, and that emailed code verifies; the stored form is
//        a keyed HMAC (verifying with a DIFFERENT hmacKey fails, with the SAME key
//        succeeds — plaintext storage would verify under any key); the raw code is in no
//        stored column and not in issue's return value; the code verifies at +9 minutes
//        but is "expired" at +11 minutes.
//   AC2 "Verify accepts the correct code once; after 5 failures in 15 minutes further
//        attempts are slowed and the account holder is emailed." — a correct code is
//        accepted once and cannot be reused; a wrong code is "invalid"; four failures do
//        NOT lock the account (the correct code still works); after five failures the
//        next attempt — even with the correct code — is "throttled" with a positive
//        retryAfterMs, and an alert email (carrying no code) is sent to the holder.
//   INV-102 "parameterize every query." — a SQL-injection probe routed through
//        verifyEmailCode cannot drop the email_codes table, and a genuine code is
//        unaffected (the probe was bound as data, not interpreted).
//   Migration: 0005_email_codes applies, the `email_codes` relation exists, and a second
//        run of every migration changes nothing (idempotent).
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations) and a
// fresh `createOutbox()`, so tests share no state. Tests never touch the network or Azure.
import { test } from "node:test";
import assert from "node:assert/strict";

import { issueEmailCode, verifyEmailCode } from "./email-code";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "../db/index";
import { createOutbox, type Outbox, type SentMessage } from "../notify/outbox";
import { systemRandom, type Random } from "../seams/random";
import type { Clock } from "../seams/clock";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const T0 = new Date("2026-03-01T00:00:00.000Z");

// Two distinct HMAC keys: proving the stored form is a KEYED function of the code means
// the same code must verify under KEY_A (the issuing key) and fail under KEY_B.
const HMAC_KEY_A = new Uint8Array(Buffer.from("warthog-email-code-hmac-key-A-0123456789", "utf8"));
const HMAC_KEY_B = new Uint8Array(Buffer.from("warthog-email-code-hmac-key-B-9876543210", "utf8"));

const EMAIL = "person@warthog.com.au";

// A clock the test drives, so the 10-minute expiry and 15-minute failure window are
// exercised deterministically with no wall-clock dependence (same shape as session.test.ts).
function mutableClock(start: Date): { clock: Clock; advance(ms: number): void } {
  let current = start.getTime();
  return {
    clock: {
      now(): Date {
        return new Date(current);
      },
    },
    advance(ms: number): void {
      current += ms;
    },
  };
}

// Deps builders, to keep call sites readable. issue needs entropy; verify does not.
function issueDeps(
  clock: Clock,
  emailSender: Outbox,
  hmacKey: Uint8Array = HMAC_KEY_A,
  random: Random = systemRandom,
) {
  return { clock, random, hmacKey, emailSender };
}
function verifyDeps(clock: Clock, emailSender: Outbox, hmacKey: Uint8Array = HMAC_KEY_A) {
  return { clock, hmacKey, emailSender };
}

// The emails delivered to a recipient, in send order (the outbox records every send).
function emailsTo(outbox: Outbox, recipient: string): SentMessage[] {
  return outbox.list().filter((m) => m.channel === "email" && m.recipient === recipient);
}

// Pull the 6-digit code out of a delivered email body. The code is exactly six digits,
// standalone (not part of a longer number), so this is robust to the surrounding copy.
function extractCode(body: string): string {
  const match = body.match(/(?<!\d)\d{6}(?!\d)/);
  assert.ok(match, `the email body must carry a standalone 6-digit code: ${JSON.stringify(body)}`);
  return match[0];
}

// A 6-digit string that differs from `code` in its first digit (a genuine wrong guess).
function wrongCode(code: string): string {
  const first = code[0] === "0" ? "1" : "0";
  return first + code.slice(1);
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the
// relation name when it exists and NULL otherwise — a non-throwing probe scoped to the
// one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// =====================================================================================
// AC1 — issue: a 6-digit code, emailed via the sender, stored as a 10-minute HMAC.
// =====================================================================================

test("issueEmailCode emails exactly one 6-digit code to the address, and that code verifies", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    await issueEmailCode(db, EMAIL, issueDeps(clock, outbox));

    // "emails it via the sender": one email, to the address, carrying a 6-digit code.
    const emails = emailsTo(outbox, EMAIL);
    assert.equal(emails.length, 1, "issuing a code sends exactly one email to the address");
    const code = extractCode(emails[0]!.body);
    assert.match(code, /^\d{6}$/, "the delivered code is six digits");

    // The emailed code is the live code: it verifies.
    const result = await verifyEmailCode(db, EMAIL, code, verifyDeps(clock, outbox));
    assert.equal(result.ok, true, "the code delivered by email verifies");
  } finally {
    await db.close();
  }
});

test("the code is stored as a KEYED HMAC: it verifies under the issuing key, not under a different key", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    // Issue under KEY_A and read the delivered code.
    await issueEmailCode(db, EMAIL, issueDeps(clock, outbox, HMAC_KEY_A));
    const code = extractCode(emailsTo(outbox, EMAIL)[0]!.body);

    // Under a DIFFERENT HMAC key the recomputed digest cannot match the stored one, so
    // the correct code does NOT verify. Were the code stored in plaintext it would
    // verify regardless of the key — so this failing proves the stored form is HMAC(key, code).
    const wrongKey = await verifyEmailCode(db, EMAIL, code, verifyDeps(clock, outbox, HMAC_KEY_B));
    assert.equal(wrongKey.ok, false, "the correct code must NOT verify under a different HMAC key");

    // Under the issuing key the same code verifies — confirming the only thing that
    // changed between the two calls (the key) is what the stored comparison turns on.
    const rightKey = await verifyEmailCode(db, EMAIL, code, verifyDeps(clock, outbox, HMAC_KEY_A));
    assert.equal(rightKey.ok, true, "the correct code verifies under the issuing HMAC key");
  } finally {
    await db.close();
  }
});

test("the raw code is never stored in plaintext — only its HMAC is persisted", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    await issueEmailCode(db, EMAIL, issueDeps(clock, outbox));
    const code = extractCode(emailsTo(outbox, EMAIL)[0]!.body);

    // Every byte the email_codes table holds, serialised. A stored HMAC is a long hex
    // run; the only legitimate place a 6-digit run may appear is INSIDE such a hash (or a
    // uuid/epoch), so strip every long hex/digit run first — a plaintext code (six
    // digits bounded by quotes/commas) is far shorter and survives the strip, so if it is
    // still present the code was stored in the clear.
    const stored = await db.query("SELECT * FROM email_codes");
    const withoutHashes = JSON.stringify(stored.rows).replace(/[0-9a-f]{8,}/gi, "");
    assert.ok(
      !withoutHashes.includes(code),
      "the plaintext code must never be stored; only its HMAC digest may be persisted",
    );
  } finally {
    await db.close();
  }
});

test("issueEmailCode does not return the raw code to its caller (the code lives only in the email)", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const returned = await issueEmailCode(db, EMAIL, issueDeps(clock, outbox));
    const code = extractCode(emailsTo(outbox, EMAIL)[0]!.body);

    // Whatever issue hands back (void, or non-secret metadata), it must not carry the code.
    const dump = JSON.stringify(returned) ?? "";
    assert.ok(
      !dump.includes(code),
      "the raw code must not appear in issueEmailCode's return value",
    );
  } finally {
    await db.close();
  }
});

test("a code verifies within its 10-minute window", async () => {
  const c = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    await issueEmailCode(db, EMAIL, issueDeps(c.clock, outbox));
    const code = extractCode(emailsTo(outbox, EMAIL)[0]!.body);

    // Nine minutes later — still inside the 10-minute expiry.
    c.advance(9 * MINUTE_MS);
    const result = await verifyEmailCode(db, EMAIL, code, verifyDeps(c.clock, outbox));
    assert.equal(result.ok, true, "a code presented within 10 minutes verifies");
  } finally {
    await db.close();
  }
});

test("a code presented after 10 minutes is expired, not accepted", async () => {
  const c = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    await issueEmailCode(db, EMAIL, issueDeps(c.clock, outbox));
    const code = extractCode(emailsTo(outbox, EMAIL)[0]!.body);

    // Eleven minutes later — past the 10-minute expiry.
    c.advance(11 * MINUTE_MS);
    const result = await verifyEmailCode(db, EMAIL, code, verifyDeps(c.clock, outbox));
    assert.equal(result.ok, false, "a code past its 10-minute expiry does not verify");
    assert.equal(result.reason, "expired", "an expired code reports reason 'expired'");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — verify: correct once, wrong is invalid, threshold of five then backoff + alert.
// =====================================================================================

test("verifyEmailCode accepts the correct code only once (it is single-use)", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    await issueEmailCode(db, EMAIL, issueDeps(clock, outbox));
    const code = extractCode(emailsTo(outbox, EMAIL)[0]!.body);

    const first = await verifyEmailCode(db, EMAIL, code, verifyDeps(clock, outbox));
    assert.equal(first.ok, true, "the first use of the correct code is accepted");

    const second = await verifyEmailCode(db, EMAIL, code, verifyDeps(clock, outbox));
    assert.equal(second.ok, false, "the same code cannot be used a second time");
  } finally {
    await db.close();
  }
});

test("a wrong code is reported invalid", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    await issueEmailCode(db, EMAIL, issueDeps(clock, outbox));
    const code = extractCode(emailsTo(outbox, EMAIL)[0]!.body);

    const result = await verifyEmailCode(db, EMAIL, wrongCode(code), verifyDeps(clock, outbox));
    assert.equal(result.ok, false, "a wrong code does not verify");
    assert.equal(result.reason, "invalid", "a wrong (but non-expired, non-throttled) code is 'invalid'");
  } finally {
    await db.close();
  }
});

test("four failures do not lock the account: the correct code still works", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    await issueEmailCode(db, EMAIL, issueDeps(clock, outbox));
    const code = extractCode(emailsTo(outbox, EMAIL)[0]!.body);
    const wrong = wrongCode(code);

    // Four failed attempts — one short of the five-failure threshold.
    for (let i = 0; i < 4; i += 1) {
      const miss = await verifyEmailCode(db, EMAIL, wrong, verifyDeps(clock, outbox));
      assert.equal(miss.ok, false, `wrong attempt ${i + 1} fails`);
      assert.notEqual(miss.reason, "throttled", `four failures must not throttle (attempt ${i + 1})`);
    }

    // The correct code is still accepted — four failures are below the lock threshold.
    const good = await verifyEmailCode(db, EMAIL, code, verifyDeps(clock, outbox));
    assert.equal(good.ok, true, "after four failures the correct code is still accepted");
  } finally {
    await db.close();
  }
});

test("after five failures in 15 minutes the next attempt is throttled and the holder is emailed", async () => {
  const c = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    await issueEmailCode(db, EMAIL, issueDeps(c.clock, outbox));
    const code = extractCode(emailsTo(outbox, EMAIL)[0]!.body);
    const wrong = wrongCode(code);

    // Five failed attempts, all within the 15-minute window (one minute apart).
    for (let i = 0; i < 5; i += 1) {
      const miss = await verifyEmailCode(db, EMAIL, wrong, verifyDeps(c.clock, outbox));
      assert.equal(miss.ok, false, `wrong attempt ${i + 1} fails`);
      if (i === 0) {
        // The very first failure is an ordinary invalid attempt — throttling only begins
        // once the five-failure threshold has been crossed, never on the first miss.
        assert.equal(miss.reason, "invalid", "the first failure is 'invalid', not 'throttled'");
      }
      c.advance(MINUTE_MS);
    }

    // The sixth attempt — even with the CORRECT code — is slowed: five failures have
    // crossed the threshold, so further attempts back off regardless of correctness.
    const sixth = await verifyEmailCode(db, EMAIL, code, verifyDeps(c.clock, outbox));
    assert.equal(sixth.ok, false, "the sixth attempt is refused even with the correct code");
    assert.equal(sixth.reason, "throttled", "the sixth attempt reports reason 'throttled'");
    assert.equal(typeof sixth.retryAfterMs, "number", "a throttled result carries a retry-after");
    assert.ok(sixth.retryAfterMs > 0, "the backoff must ask the caller to wait a positive time");

    // The account holder is emailed an alert (beyond the original code email), and that
    // alert must not leak the code (project redaction rule).
    const emails = emailsTo(outbox, EMAIL);
    assert.ok(
      emails.length >= 2,
      "an alert email is sent to the account holder once attempts are throttled",
    );
    const alert = emails[emails.length - 1]!;
    assert.ok(
      !alert.body.includes(code),
      "the throttling alert must not contain the one-time code",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// INV-102 — parameterize every query (an injection probe cannot alter a query).
// =====================================================================================

test("a SQL-injection probe passed to verifyEmailCode cannot drop the email_codes table", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    await issueEmailCode(db, EMAIL, issueDeps(clock, outbox));
    const code = extractCode(emailsTo(outbox, EMAIL)[0]!.body);

    // The probe arrives as the lookup email; bound as a value it matches no row and is
    // never interpreted as SQL. (A separate email, so EMAIL's own attempt budget is untouched.)
    const probe = "robert'); DROP TABLE email_codes; --";
    const result = await verifyEmailCode(db, probe, "123456", verifyDeps(clock, outbox));
    assert.equal(result.ok, false, "the probe matches no code (it was bound as data, not interpreted)");

    // The table survived and the genuine code still verifies.
    assert.equal(await tableExists(db, "email_codes"), true, "the email_codes table must still exist");
    const good = await verifyEmailCode(db, EMAIL, code, verifyDeps(clock, outbox));
    assert.equal(good.ok, true, "the real code is unaffected by the probe");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Migration — 0005_email_codes applies and a second run changes nothing.
// =====================================================================================

test("the email_codes migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    // 0005_email_codes applied: the `email_codes` relation exists (a non-throwing
    // existence probe scoped to the one table under test — behaviour, not source text).
    assert.equal(
      await tableExists(db, "email_codes"),
      true,
      "the email_codes table must exist after the project migrations",
    );

    // The project migration set includes the email-codes migration (its recorded name is
    // the task's named deliverable, stable once applied).
    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0005_email_codes"),
      "db/migrations/0005_email_codes.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0005's CREATE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing (idempotent).
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix B1 — the attempt limit holds under concurrency, only the newest code
// verifies, and issuing codes is itself throttled per address.
// =====================================================================================

// A Random whose every byte is `value`: four bytes of 0x00 draw the code "000000",
// so a test knows the issued code without reading it back from the outbox.
function constantRandom(value: number): Random {
  return {
    randomBytes(n: number): Uint8Array {
      return new Uint8Array(n).fill(value);
    },
  };
}

// The 6-digit code constantRandom(value) draws (32 bits of `value` bytes mod 10^6).
function codeFor(value: number): string {
  const n = Buffer.from(new Uint8Array(4).fill(value)).readUInt32BE(0) % 1_000_000;
  return String(n).padStart(6, "0");
}

// The alert emails (every email to the address except code deliveries).
function alertsTo(outbox: Outbox, recipient: string): SentMessage[] {
  return emailsTo(outbox, recipient).filter((m) => !/verification code is \d{6}/.test(m.body));
}

async function countRows(db: Db, sql: string, values: unknown[]): Promise<number> {
  const result = await db.query(sql, values);
  return Number(result.rows[0]?.n ?? 0);
}

test("parallel guesses cannot beat the five-failure limit, and the holder gets exactly one alert", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    await issueEmailCode(db, EMAIL, issueDeps(clock, outbox, HMAC_KEY_A, constantRandom(0)));
    const code = codeFor(0);
    const wrong = wrongCode(code);

    // Twenty wrong guesses and the correct code, all in flight at once.
    const guesses = [...Array.from({ length: 20 }, () => wrong), code];
    const results = await Promise.all(
      guesses.map((g) => verifyEmailCode(db, EMAIL, g, verifyDeps(clock, outbox))),
    );

    const evaluated = results.filter((r) => !r.ok && r.reason === "invalid").length;
    assert.ok(evaluated <= 5, `at most five guesses may be judged in the window (judged ${evaluated})`);
    assert.equal(results[results.length - 1]!.ok, false, "the correct code sent in the burst is refused");
    assert.ok(
      (await countRows(db, "SELECT COUNT(*)::int AS n FROM email_code_attempts WHERE email = $1", [EMAIL])) <= 5,
      "no more than five failures are ever recorded for the window",
    );
    assert.equal(alertsTo(outbox, EMAIL).length, 1, "exactly one alert reaches the holder");
  } finally {
    await db.close();
  }
});

test("five failures sent in parallel throttle the next attempt and alert exactly once", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    await issueEmailCode(db, EMAIL, issueDeps(clock, outbox, HMAC_KEY_A, constantRandom(0)));
    const code = codeFor(0);
    const wrong = wrongCode(code);

    await Promise.all(
      Array.from({ length: 5 }, () => verifyEmailCode(db, EMAIL, wrong, verifyDeps(clock, outbox))),
    );
    const next = await verifyEmailCode(db, EMAIL, code, verifyDeps(clock, outbox));
    assert.equal(next.ok, false);
    assert.equal(next.ok === false && next.reason, "throttled");
    const again = await verifyEmailCode(db, EMAIL, code, verifyDeps(clock, outbox));
    assert.equal(again.ok === false && again.reason, "throttled");
    assert.equal(alertsTo(outbox, EMAIL).length, 1, "one alert per window, however many refusals follow");
  } finally {
    await db.close();
  }
});

test("issuing a new code retires every earlier one: only the newest code verifies", async () => {
  const c = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    await issueEmailCode(db, EMAIL, issueDeps(c.clock, outbox, HMAC_KEY_A, constantRandom(1)));
    c.advance(61 * SECOND_MS);
    await issueEmailCode(db, EMAIL, issueDeps(c.clock, outbox, HMAC_KEY_A, constantRandom(2)));

    const older = await verifyEmailCode(db, EMAIL, codeFor(1), verifyDeps(c.clock, outbox));
    assert.equal(older.ok, false, "the earlier code no longer verifies");
    const newer = await verifyEmailCode(db, EMAIL, codeFor(2), verifyDeps(c.clock, outbox));
    assert.equal(newer.ok, true, "the newest code verifies");
  } finally {
    await db.close();
  }
});

test("issuing is throttled per address: one code a minute, five an hour, and a refused issue sends nothing", async () => {
  const c = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const first = await issueEmailCode(db, EMAIL, issueDeps(c.clock, outbox));
    assert.deepEqual(first, { ok: true });

    const tooSoon = await issueEmailCode(db, EMAIL, issueDeps(c.clock, outbox));
    assert.equal(tooSoon.ok, false, "a second code inside a minute is refused");
    assert.equal(tooSoon.ok === false && tooSoon.reason, "throttled");
    assert.ok(tooSoon.ok === false && tooSoon.retryAfterMs > 0, "the refusal says how long to wait");
    assert.equal(emailsTo(outbox, EMAIL).length, 1, "a refused issue sends no email");

    // Four more, each a minute apart, fill the hour's budget of five.
    for (let i = 0; i < 4; i += 1) {
      c.advance(61 * SECOND_MS);
      const ok = await issueEmailCode(db, EMAIL, issueDeps(c.clock, outbox));
      assert.deepEqual(ok, { ok: true }, `issue ${i + 2} inside the hour is allowed`);
    }
    c.advance(61 * SECOND_MS);
    const sixth = await issueEmailCode(db, EMAIL, issueDeps(c.clock, outbox));
    assert.equal(sixth.ok, false, "a sixth code inside the hour is refused");
    assert.equal(emailsTo(outbox, EMAIL).length, 5, "only five codes were ever sent");

    // A different address has its own budget.
    const other = await issueEmailCode(db, "someone.else@warthog.com.au", issueDeps(c.clock, outbox));
    assert.deepEqual(other, { ok: true });

    // Once the hour has passed, codes flow again.
    c.advance(60 * MINUTE_MS);
    assert.deepEqual(await issueEmailCode(db, EMAIL, issueDeps(c.clock, outbox)), { ok: true });
  } finally {
    await db.close();
  }
});

test("concurrent issues for one address send at most one code", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    await Promise.all(
      Array.from({ length: 10 }, () => issueEmailCode(db, EMAIL, issueDeps(clock, outbox))),
    );
    assert.ok(emailsTo(outbox, EMAIL).length <= 1, "a burst of issues sends at most one code");
    assert.ok(
      (await countRows(
        db,
        "SELECT COUNT(*)::int AS n FROM email_codes WHERE email = $1 AND consumed_at IS NULL",
        [EMAIL],
      )) <= 1,
      "at most one live code exists for the address",
    );
  } finally {
    await db.close();
  }
});

test("a code whose email could not be sent is never left usable", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const failing = {
    async sendEmail(): Promise<void> {
      throw new Error("email provider down");
    },
  };
  const db = await freshDb();
  try {
    await assert.rejects(
      issueEmailCode(db, EMAIL, { clock, random: constantRandom(0), hmacKey: HMAC_KEY_A, emailSender: failing }),
    );
    assert.equal(
      await countRows(
        db,
        "SELECT COUNT(*)::int AS n FROM email_codes WHERE email = $1 AND consumed_at IS NULL",
        [EMAIL],
      ),
      0,
      "no live code remains after a failed send",
    );
    const result = await verifyEmailCode(db, EMAIL, codeFor(0), verifyDeps(clock, outbox));
    assert.equal(result.ok, false, "the undelivered code does not verify");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix B8 — an address is one address whatever its case or spacing: one code, one
// attempt budget, one issue budget.
// =====================================================================================

test("case and spacing variants of an address share one code and one budget", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const issued = await issueEmailCode(db, " Person@Warthog.com.au ", issueDeps(clock, outbox, HMAC_KEY_A, constantRandom(0)));
    assert.deepEqual(issued, { ok: true });
    assert.equal(emailsTo(outbox, EMAIL).length, 1, "the code goes to the normalised address");

    const again = await issueEmailCode(db, "PERSON@WARTHOG.COM.AU", issueDeps(clock, outbox));
    assert.equal(again.ok, false, "a case variant shares the issue budget");

    // Failures under different spellings count against the same window.
    for (const variant of ["Person@Warthog.com.au", "PERSON@warthog.com.au", " person@warthog.com.au", "person@WARTHOG.com.au", "Person@warthog.COM.au"]) {
      await verifyEmailCode(db, variant, wrongCode(codeFor(0)), verifyDeps(clock, outbox));
    }
    const sixth = await verifyEmailCode(db, EMAIL, codeFor(0), verifyDeps(clock, outbox));
    assert.equal(sixth.ok === false && sixth.reason, "throttled", "five variant failures throttle the address");
  } finally {
    await db.close();
  }
});

test("a code issued to one spelling verifies under another", async () => {
  const { clock } = mutableClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    await issueEmailCode(db, "Person@Warthog.com.au", issueDeps(clock, outbox, HMAC_KEY_A, constantRandom(0)));
    const ok = await verifyEmailCode(db, "  person@warthog.com.au", codeFor(0), verifyDeps(clock, outbox));
    assert.equal(ok.ok, true);
  } finally {
    await db.close();
  }
});
