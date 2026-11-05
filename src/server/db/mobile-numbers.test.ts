// E12-S03 — Verified mobile-number store and verification
// (`src/server/db/mobile-numbers.ts`, `db/migrations/0026_mobile_numbers.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so
// importing `./mobile-numbers` throws and `freshDb()` has no `mobile_numbers`
// table — every test here fails until the builder adds them. That absence IS the
// point of test-first; do NOT implement anything to make these pass — the builder
// writes the module and the migration afterwards.
//
// These tests pin BEHAVIOUR (what the functions DO: the stored + returned number,
// that a 6-digit code is delivered by SMS, that the code verifies and marks the
// number verified, who may add/verify/read what, that the RAW code is never stored
// or sent to the query layer, that every value is bound as a parameter, that the
// repo reads no secret from the environment), never the source text of the module
// or the SQL file — a later rename that preserves behaviour must not redden them.
//
// WHY this exists (design §10 Notifications / SMS fallback; brief SMS fallback):
// the approval SMS fallback delivers to a VERIFIED number. A person adds a mobile
// number; Warthog draws a 6-digit code, stores ONLY a keyed HMAC of it with an
// expiry (project rule: codes are stored only as an HMAC and appear in plain text
// nowhere except the single message that delivers a person their own code — here
// that single message is the SMS), and sends the code via the SMS sender. The
// person verifies with the code; a correct, unexpired code marks the number
// verified. The raw code is a credential: it is never stored, never returned, and
// never reaches the query layer as a bound value (only its HMAC does, or the stored
// HMAC is fetched and compared in the app) — so a leak of the table or the query
// log can never reveal a live code. An expired or wrong code fails verification.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface AddMobileNumberInput {
//     userId: string;   // the person (the SESSION's id, NEVER a client value)
//     number: string;   // the mobile number to add, e.g. "+61400111222"
//   }
//
//   interface AddMobileNumberDeps {
//     clock: Clock;        // the add instant / code issue time (never Date.now())
//     random: Random;      // entropy for the 6-digit code
//     hmacKey: Uint8Array; // keys the one-way HMAC the code is stored as (INJECTED)
//     smsSender: SmsSender;// the channel the code is delivered on
//   }
//
//   interface VerifyMobileNumberInput {
//     userId: string;   // the person (the SESSION's id, NEVER a client value)
//     id: string;       // the mobile number's id (returned by addMobileNumber)
//     code: string;     // the 6-digit code the person received by SMS
//   }
//
//   interface VerifyMobileNumberDeps {
//     clock: Clock;        // the verify instant, for the expiry check (never Date.now())
//     hmacKey: Uint8Array; // the SAME key the code was stored under (INJECTED)
//   }
//
//   interface StoredMobileNumber {
//     id: string;
//     userId: string;
//     number: string;
//     verified: boolean;                 // false until a correct code is presented
//     createdAt: Date | string;          // the injected clock's add instant
//     verifiedAt: Date | string | null;  // the verify instant once verified, else null
//   }
//
//   type VerifyMobileResult =
//     | { ok: true }
//     | { ok: false; reason: "invalid" }     // wrong code, or no pending code for this person+id
//     | { ok: false; reason: "expired" };    // the code lapsed before it was presented
//
//   addMobileNumber(db, input: AddMobileNumberInput, deps): Promise<StoredMobileNumber>
//     • stores an UNVERIFIED number for `userId`, draws a 6-digit code, stores ONLY
//       HMAC(hmacKey, code) with an expiry, and delivers the code in exactly one SMS
//       to `number`. Returns the StoredMobileNumber (carrying the generated id,
//       verified=false). Assembles the returned value from its inputs (it does not
//       depend on a RETURNING read). The raw code is returned to no caller.
//   verifyMobileNumber(db, input: VerifyMobileNumberInput, deps): Promise<VerifyMobileResult>
//     • member-scoped (id AND user_id both bound): matches the pending code for THIS
//       person's number by its keyed HMAC. A correct, unexpired code marks the number
//       verified (sets verifiedAt) and returns { ok: true }; a lapsed code returns
//       { ok: false, reason: "expired" } and does NOT verify; a wrong code, or no
//       pending code for this person+id, returns { ok: false, reason: "invalid" }.
//   listMobileNumbers(db, userId): Promise<StoredMobileNumber[]>
//     • ALL of `userId`'s numbers (member-scoped: WHERE user_id bound), with their
//       verified flag; never another person's. Empty array when the person has none.
//
// Acceptance criteria → tests:
//   AC1 "Adding a number sends a 6-digit code via the SMS sender and stores the code
//        only as an HMAC with an expiry; verifying with the correct code marks the
//        number verified." — addMobileNumber delivers exactly one SMS carrying a
//        6-digit code; the delivered code verifies and flips the number to verified.
//   AC2 "The raw code is never stored or logged, and an expired or wrong code fails
//        verification." — the raw code never appears in the mobile_numbers table and
//        never reaches the query layer as a bound value; it is returned to no caller;
//        a wrong code → invalid; a code presented past its expiry → expired; neither
//        verifies.
//   AC3 "A user cannot add or verify a number for another user (filtered by session
//        user id)." — a handler takes the user id from the SESSION, never the body; a
//        second person cannot verify another's number and cannot see it listed; the
//        user id is bound as a parameter.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed
//        input with a 4xx before any query runs; a SQL-injection probe routed through
//        the repo travels as a BOUND value (placeholders, never concatenation) and
//        cannot drop the table. The handlers below are test fixtures (the intended
//        usage), not implementation files.
//   AC5 [obligation:secrets-from-env] (INV-103) — the code is HMAC'd under the INJECTED
//        hmacKey, not a baked-in secret: a different key cannot verify it back. The repo
//        takes db / hmacKey / clock / random / smsSender as dependencies, reads no
//        `process.env` and holds no key, so a decoy secret planted in the environment
//        never lands in the stored or returned number.
//   Migration: the `mobile_numbers` relation exists after the project migrations and a
//        second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { addMobileNumber, verifyMobileNumber, listMobileNumbers } from "./mobile-numbers";
// Documentary type anchors — the exact names/shapes the implementation exports.
// Erased at runtime (and test files are excluded from `tsc`), so a rename cannot
// break these tests; the runtime assertions below are what actually gate behaviour.
import type {
  AddMobileNumberInput,
  AddMobileNumberDeps,
  VerifyMobileNumberInput,
  VerifyMobileNumberDeps,
  StoredMobileNumber,
  VerifyMobileResult,
} from "./mobile-numbers";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { fixedClock, type Clock } from "../seams/clock";
import { systemRandom, type Random } from "../seams/random";
import type { SmsSender, OutgoingMessage } from "../notify/senders";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

// Compare the moment, not the representation: createdAt / verifiedAt may come back as a
// Date or an ISO string — either is a reasonable choice and must not redden a test.
const ms = (value: Date | string | number): number => new Date(value as never).getTime();

// T0 is the add / issue instant; AT_ADD verifies at the same instant (well within any
// positive TTL); LONG_AFTER is a year later (past any reasonable code expiry).
const T0 = new Date("2026-02-01T09:00:00.000Z");
const AT_ADD = T0;
const LONG_AFTER = new Date("2027-02-01T09:00:00.000Z");

// A fixed 32-byte HMAC key (the real one is `config.hmacKey`, injected). A DIFFERENT
// key proves the code is keyed by the injected value, not a baked-in secret.
const HMAC_KEY: Uint8Array = Buffer.alloc(32, 7);
const OTHER_HMAC_KEY: Uint8Array = Buffer.alloc(32, 9);

// Distinct, obviously phone-shaped numbers so two people never collide on a value.
const NUMBER_A = "+61400111222";
const NUMBER_B = "+61400333444";

// A stand-in wrapped DEK for createUser (opaque base64; this module never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A recording SMS sender: records every send instead of dialling out, so a test can
// read back the recipient + body and extract the delivered code. Satisfies SmsSender.
interface RecordedSms {
  readonly recipient: string;
  readonly body: string;
  readonly link?: string;
}
function recordingSms(): { sent: RecordedSms[]; sender: SmsSender } {
  const sent: RecordedSms[] = [];
  const sender: SmsSender = {
    async sendSms(message: OutgoingMessage): Promise<void> {
      sent.push({ recipient: message.recipient, body: message.body, link: message.link });
    },
  };
  return { sent, sender };
}

// Pull the single 6-digit code out of a delivered SMS body. Matches a run of EXACTLY
// six digits (not part of a longer number), so "10 minutes" or a 3-digit count never
// masquerade as the code. Asserts exactly one such run exists — the body carries the
// person their code and nothing else code-shaped.
function codeFromSms(body: string): string {
  const matches = body.match(/(?<!\d)\d{6}(?!\d)/g) ?? [];
  const distinct = [...new Set(matches)];
  assert.equal(distinct.length, 1, `the SMS body must carry exactly one 6-digit code (found ${distinct.length})`);
  return distinct[0]!;
}

// Default deps for adding / verifying. The code is captured from the recording SMS, so
// these do not assume HOW the code is drawn — any real entropy source is fine.
function addDeps(
  sms: SmsSender,
  over?: { clock?: Clock; random?: Random; hmacKey?: Uint8Array },
): AddMobileNumberDeps {
  return {
    clock: over?.clock ?? fixedClock(T0),
    random: over?.random ?? systemRandom,
    hmacKey: over?.hmacKey ?? HMAC_KEY,
    smsSender: sms,
  };
}
function verifyDeps(over?: { clock?: Clock; hmacKey?: Uint8Array }): VerifyMobileNumberDeps {
  return {
    clock: over?.clock ?? fixedClock(AT_ADD),
    hmacKey: over?.hmacKey ?? HMAC_KEY,
  };
}

// Add a number and hand back the stored number plus the code the SMS delivered.
async function addAndCapture(
  db: Db,
  input: AddMobileNumberInput,
  over?: { clock?: Clock; random?: Random; hmacKey?: Uint8Array },
): Promise<{ stored: StoredMobileNumber; code: string; sent: RecordedSms[] }> {
  const { sent, sender } = recordingSms();
  const stored = await addMobileNumber(db, input, addDeps(sender, over));
  assert.equal(sent.length, 1, "adding a number delivers exactly one SMS");
  const code = codeFromSms(sent[0]!.body);
  return { stored, code, sent };
}

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (bound value vs. spliced text). Returns no rows
// and satisfies the `Db` shape structurally (query + close).
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the
// relation name when it exists and NULL when it does not — a non-throwing probe scoped
// to the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Assert a probe reached the query layer as a BOUND value and never as spliced SQL text,
// scoped to each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// Assert a forbidden value (the raw code) never reached the query layer as any bound
// value — the code is hashed before it is bound, or the stored HMAC is fetched and
// compared in the app, so the plaintext code appears in no parameter list.
function assertNeverBound(db: RecordingDb, forbidden: string): void {
  for (const call of db.calls) {
    for (const value of call.values) {
      assert.notEqual(value, forbidden, "the raw code must never reach the query layer as a bound value");
    }
  }
}

// ===========================================================================
// AC1 — adding sends a 6-digit code by SMS and stores it only as an HMAC + expiry;
// the delivered code verifies and marks the number verified.
// ===========================================================================

test("addMobileNumber stores an UNVERIFIED number for the person and returns it", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-add");
    const { stored } = await addAndCapture(db, { userId, number: NUMBER_A });

    assert.equal(typeof stored.id, "string", "addMobileNumber returns an id string");
    assert.ok(stored.id.length > 0, "the returned id is non-empty");
    assert.equal(stored.userId, userId, "the number belongs to the adding person");
    assert.equal(stored.number, NUMBER_A, "the submitted number is recorded");
    assert.equal(stored.verified, false, "a freshly added number starts unverified");
    assert.equal(stored.verifiedAt ?? null, null, "an unverified number has no verified-at instant");
    assert.equal(ms(stored.createdAt), ms(T0), "createdAt is the injected clock instant");
  } finally {
    await db.close();
  }
});

test("addMobileNumber delivers exactly one SMS to the number carrying a 6-digit code", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-sms");
    const { sent, code } = await addAndCapture(db, { userId, number: NUMBER_A });

    assert.equal(sent.length, 1, "exactly one SMS is sent");
    assert.equal(sent[0]!.recipient, NUMBER_A, "the SMS is addressed to the number being added");
    assert.match(code, /^\d{6}$/, "the delivered code is six digits");
  } finally {
    await db.close();
  }
});

test("the code delivered by SMS verifies the number, flipping it to verified with a verified-at instant", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-verify");
    const { stored, code } = await addAndCapture(db, { userId, number: NUMBER_A });

    const result: VerifyMobileResult = await verifyMobileNumber(
      db,
      { userId, id: stored.id, code },
      verifyDeps({ clock: fixedClock(AT_ADD) }),
    );
    assert.deepEqual(result, { ok: true }, "the correct, unexpired code is accepted");

    const [listed] = await listMobileNumbers(db, userId);
    assert.ok(listed, "the number is still present after verification");
    assert.equal(listed!.id, stored.id, "it is the same number");
    assert.equal(listed!.verified, true, "the number is now verified (ready for SMS fallback)");
    assert.notEqual(listed!.verifiedAt ?? null, null, "a verified number carries a verified-at instant");
    assert.ok(
      ms(listed!.verifiedAt as Date | string) >= ms(AT_ADD),
      "the verified-at instant is the verify clock's moment, not earlier",
    );
  } finally {
    await db.close();
  }
});

test("listMobileNumbers returns an empty array for a person with no numbers", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-empty");
    assert.deepEqual(await listMobileNumbers(db, userId), [], "a person with no numbers gets an empty list");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — the raw code is never stored and never returned; a wrong or expired code fails.
// ===========================================================================

test("the raw code is never stored in the mobile_numbers table (only an HMAC is kept)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-atrest");
    const { code } = await addAndCapture(db, { userId, number: NUMBER_A });

    // Scan every cell of the one table under test. The code is a credential and must
    // live only as a keyed HMAC, so its exact plaintext appearing in any column is a
    // genuine leak. Exact-equality (not substring) avoids a coincidental hex-digit
    // overlap with the stored HMAC, and the scan is scoped to `mobile_numbers` alone
    // (the same six digits could legitimately occur elsewhere by chance).
    const all = await db.query("SELECT * FROM mobile_numbers");
    assert.ok(all.rows.length >= 1, "the number row was stored");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.notEqual(cell, code, "the plaintext code must never be written to a column");
        }
      }
    }
  } finally {
    await db.close();
  }
});

test("addMobileNumber returns the number WITHOUT the raw code anywhere in the result", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-noreturn");
    const { stored, code } = await addAndCapture(db, { userId, number: NUMBER_A });

    // No field of the returned number is the raw code (field-value equality, so a
    // coincidental digit overlap inside a uuid/timestamp cannot cause a false failure).
    assert.ok(
      !Object.values(stored).some((v) => v === code),
      "the raw code is returned to no caller — it lives only in the delivered SMS",
    );
    assert.notEqual(stored.number, code, "the number field is the phone number, not the code");
  } finally {
    await db.close();
  }
});

test("a wrong code fails verification and leaves the number unverified", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-wrong");
    const { stored, code } = await addAndCapture(db, { userId, number: NUMBER_A });

    // A different but well-formed 6-digit code — a genuine wrong guess, not a malformed value.
    const wrong = code === "000000" ? "111111" : "000000";
    const result: VerifyMobileResult = await verifyMobileNumber(
      db,
      { userId, id: stored.id, code: wrong },
      verifyDeps({ clock: fixedClock(AT_ADD) }),
    );
    assert.deepEqual(result, { ok: false, reason: "invalid" }, "a wrong code is rejected as invalid");

    const [listed] = await listMobileNumbers(db, userId);
    assert.equal(listed!.verified, false, "a wrong code never marks the number verified");
  } finally {
    await db.close();
  }
});

test("an expired code fails verification and leaves the number unverified", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-expired");
    const { stored, code } = await addAndCapture(db, { userId, number: NUMBER_A });

    // Present the correct code a year later — well past any reasonable code expiry.
    const result: VerifyMobileResult = await verifyMobileNumber(
      db,
      { userId, id: stored.id, code },
      verifyDeps({ clock: fixedClock(LONG_AFTER) }),
    );
    assert.deepEqual(result, { ok: false, reason: "expired" }, "a lapsed code is rejected as expired");

    const [listed] = await listMobileNumbers(db, userId);
    assert.equal(listed!.verified, false, "an expired code never marks the number verified");
  } finally {
    await db.close();
  }
});

test("the raw code never reaches the query layer as a bound value when adding", async () => {
  // A recording SMS makes the drawn code observable; a recording db captures every
  // bound value. The code is hashed before it is stored, so its plaintext must appear
  // in no parameter list.
  const db = recordingDb();
  const { sent, sender } = recordingSms();

  await addMobileNumber(db, { userId: "session-user", number: NUMBER_A }, addDeps(sender));

  assert.equal(sent.length, 1, "one SMS was sent");
  const code = codeFromSms(sent[0]!.body);
  assertNeverBound(db, code);
});

test("the raw code never reaches the query layer as a bound value when verifying", async () => {
  const db = recordingDb();
  // The recording db returns no rows, so verify matches nothing and reports invalid —
  // but whatever statement it issued must NOT have bound the raw code.
  const code = "654321";
  const result = await verifyMobileNumber(db, { userId: "session-user", id: "some-id", code }, verifyDeps());
  assert.equal(result.ok, false, "no pending code matches on an empty recording db");
  assertNeverBound(db, code);
});

// ===========================================================================
// AC5 — the code is HMAC'd under the INJECTED key, not a baked-in secret.
// ===========================================================================

test("a code cannot be verified under a different HMAC key", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-key");
    const { stored, code } = await addAndCapture(db, { userId, number: NUMBER_A }, { hmacKey: HMAC_KEY });

    // Verifying the correct code under the WRONG key must fail: the stored digest was
    // keyed by the injected key, so a different key recomputes a different digest.
    const underWrong: VerifyMobileResult = await verifyMobileNumber(
      db,
      { userId, id: stored.id, code },
      verifyDeps({ clock: fixedClock(AT_ADD), hmacKey: OTHER_HMAC_KEY }),
    );
    assert.deepEqual(underWrong, { ok: false, reason: "invalid" }, "the code does not verify under a foreign key");

    // ...and the SAME injected key still verifies it — proving the failure above was the
    // key, not a broken code.
    const underRight: VerifyMobileResult = await verifyMobileNumber(
      db,
      { userId, id: stored.id, code },
      verifyDeps({ clock: fixedClock(AT_ADD), hmacKey: HMAC_KEY }),
    );
    assert.deepEqual(underRight, { ok: true }, "the code verifies under the key it was stored with");
  } finally {
    await db.close();
  }
});

test("the repo reads no process.env: a decoy secret in the environment never lands in the number", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-env");
    const { stored } = await addAndCapture(db, { userId, number: NUMBER_A });

    const listed = await listMobileNumbers(db, userId);
    assert.equal(listed.length, 1, "the number reads and writes purely from the injected db + deps — no app env needed");
    assert.ok(
      !JSON.stringify(stored).includes(DECOY) && !JSON.stringify(listed).includes(DECOY),
      "no ambient env value is folded into the stored or returned number",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly).
    const all = await db.query("SELECT * FROM mobile_numbers");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(DECOY), "no ambient env value is written to a column");
        }
      }
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===========================================================================
// AC3 — ownership: a second signed-in person can never add/verify/read another's number.
// The user id is bound from the session, never the client.
// ===========================================================================

test("a second person cannot verify another person's number, and it stays unverified", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "own-alice");
    const bob = await makeUser(db, "own-bob");
    const { stored: alices, code } = await addAndCapture(db, { userId: alice, number: NUMBER_A });

    // Bob presents Alice's number id and her correct code. Member-scoped (id AND
    // user_id both bound), there is no such pending number FOR BOB — so it fails and
    // Alice's number is untouched.
    const asBob: VerifyMobileResult = await verifyMobileNumber(
      db,
      { userId: bob, id: alices.id, code },
      verifyDeps({ clock: fixedClock(AT_ADD) }),
    );
    assert.deepEqual(asBob, { ok: false, reason: "invalid" }, "Bob cannot verify a number that is not his");

    const [alicesNow] = await listMobileNumbers(db, alice);
    assert.equal(alicesNow!.verified, false, "Alice's number is still unverified after Bob's attempt");

    // Alice herself can still verify it with her own code.
    const asAlice: VerifyMobileResult = await verifyMobileNumber(
      db,
      { userId: alice, id: alices.id, code },
      verifyDeps({ clock: fixedClock(AT_ADD) }),
    );
    assert.deepEqual(asAlice, { ok: true }, "the owner verifies her own number");
  } finally {
    await db.close();
  }
});

test("listMobileNumbers never returns another person's numbers", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "list-alice");
    const bob = await makeUser(db, "list-bob");
    await addAndCapture(db, { userId: alice, number: NUMBER_A });
    await addAndCapture(db, { userId: bob, number: NUMBER_B });

    const aliceNumbers = await listMobileNumbers(db, alice);
    assert.equal(aliceNumbers.length, 1, "Alice sees exactly her own number");
    assert.equal(aliceNumbers[0]!.userId, alice, "the listed number is hers");
    assert.equal(aliceNumbers[0]!.number, NUMBER_A, "with her own value");
    assert.ok(!aliceNumbers.some((n) => n.number === NUMBER_B), "Bob's number never appears in Alice's list");

    const bobNumbers = await listMobileNumbers(db, bob);
    assert.equal(bobNumbers.length, 1, "Bob sees exactly his own number");
    assert.equal(bobNumbers[0]!.number, NUMBER_B, "Bob sees his own value");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL); a probe
// routed through the repo is stored as data and the table survives.
// ===========================================================================

test("addMobileNumber binds the member-scope user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const { sender } = recordingSms();
  const probe = "u'); DROP TABLE mobile_numbers; --";

  // The recording db returns no rows; addMobileNumber assembles its result from inputs,
  // so it does not throw on a no-row read — the binding is asserted below regardless.
  try {
    await addMobileNumber(db, { userId: probe, number: NUMBER_A }, addDeps(sender));
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }
  assertBoundNotSpliced(db, probe);
});

test("addMobileNumber binds the number as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const { sender } = recordingSms();
  const probe = "+61' ); DROP TABLE mobile_numbers; --";

  try {
    await addMobileNumber(db, { userId: "session-user", number: probe }, addDeps(sender));
  } catch {
    /* tolerate a no-row read */
  }
  assertBoundNotSpliced(db, probe);
});

test("verifyMobileNumber binds the id and user id as parameters, never splicing SQL", async () => {
  const db = recordingDb();
  const probe = "x'); DROP TABLE mobile_numbers; --";

  const result = await verifyMobileNumber(db, { userId: probe, id: probe, code: "123456" }, verifyDeps());
  assert.equal(result.ok, false, "nothing verifies when the recording db matches no row");
  assertBoundNotSpliced(db, probe);
});

test("listMobileNumbers binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "p'); DROP TABLE mobile_numbers; --";

  const result = await listMobileNumbers(db, probe);
  assert.deepEqual(result, [], "the recording db returns no rows, so the list is empty");
  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe in the number is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const probe = "+61' ); DROP TABLE mobile_numbers; --";

    const { stored } = await addAndCapture(db, { userId, number: probe });

    assert.equal(
      await tableExists(db, "mobile_numbers"),
      true,
      "the mobile_numbers table must still exist (the probe was stored as data, not run as SQL)",
    );

    const [listed] = await listMobileNumbers(db, userId);
    assert.equal(listed!.id, stored.id, "the same number is read back");
    assert.equal(listed!.number, probe, "the probe round-trips verbatim as data");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 / AC4 — handlers on the validation boundary. A route handler validates external
// input HERE (`parseBody`), then calls this task's parameterized data-access with the
// SESSION's user id (NEVER a body value). A rejected input maps to a 4xx Response and
// never reaches a query. These handlers are test fixtures that EXERCISE the modules —
// they are not implementation files.
// ===========================================================================

function addMobileNumberHandler(
  db: Db,
  deps: AddMobileNumberDeps,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries only the number; the user id comes from the session, never the
  // body. A lenient phone shape rejects obvious junk while staying generous on length.
  const schema = z.object({
    number: z.string().min(5).max(32).regex(/^\+?[0-9][0-9 ()-]*[0-9]$/),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const stored = await addMobileNumber(db, { userId: sessionUserId, number: body.number }, deps);
      return new Response(JSON.stringify({ id: stored.id }), { status: 201 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

function verifyMobileNumberHandler(
  db: Db,
  deps: VerifyMobileNumberDeps,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries the number id and the 6-digit code; the user id comes from the
  // session, never the body.
  const schema = z.object({
    id: z.string().min(1).max(100),
    code: z.string().regex(/^\d{6}$/),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const result = await verifyMobileNumber(db, { userId: sessionUserId, id: body.id, code: body.code }, deps);
      return new Response(JSON.stringify(result), { status: result.ok ? 200 : 400 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(path: string, body: string): Request {
  return new Request(`https://warthog.com.au${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the add handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const { sender } = recordingSms();
  const handler = addMobileNumberHandler(db, addDeps(sender), "session-user");

  const res = await handler(jsonRequest("/api/mobile-numbers", "{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the add handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const { sender } = recordingSms();
  const handler = addMobileNumberHandler(db, addDeps(sender), "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest("/api/mobile-numbers", JSON.stringify({ number: "+61" + "0".repeat(10 * 1024) })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the add handler rejects a body missing the number with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const { sender } = recordingSms();
  const handler = addMobileNumberHandler(db, addDeps(sender), "session-user");

  const res = await handler(jsonRequest("/api/mobile-numbers", JSON.stringify({})));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the add handler rejects a malformed number with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const { sender } = recordingSms();
  const handler = addMobileNumberHandler(db, addDeps(sender), "session-user");

  const res = await handler(jsonRequest("/api/mobile-numbers", JSON.stringify({ number: "definitely not a phone ☎" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a malformed number must never reach a query");
});

test("the add handler rejects a mis-typed number with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const { sender } = recordingSms();
  const handler = addMobileNumberHandler(db, addDeps(sender), "session-user");

  // number must be a string — a nested object is a schema violation, rejected before any query.
  const res = await handler(jsonRequest("/api/mobile-numbers", JSON.stringify({ number: { oops: true } })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the add handler accepts a well-formed body and adds the number for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-add-ok");
    const { sent, sender } = recordingSms();
    const handler = addMobileNumberHandler(db, addDeps(sender), userId);

    const res = await handler(jsonRequest("/api/mobile-numbers", JSON.stringify({ number: NUMBER_A })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };

    const listed = await listMobileNumbers(db, userId);
    assert.equal(listed.length, 1, "a valid body is persisted for the session user");
    assert.equal(listed[0]!.id, id, "the stored number matches the returned id");
    assert.equal(listed[0]!.number, NUMBER_A, "with the submitted number");
    assert.equal(listed[0]!.verified, false, "and it starts unverified");
    assert.equal(sent.length, 1, "a code was delivered by SMS");
  } finally {
    await db.close();
  }
});

test("the add handler takes the user id from the session, not the body", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const { sender } = recordingSms();
    const handler = addMobileNumberHandler(db, addDeps(sender), sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(
      jsonRequest("/api/mobile-numbers", JSON.stringify({ userId: attacker, number: NUMBER_A })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal((await listMobileNumbers(db, sessionUser)).length, 1, "the number is recorded under the SESSION user");
    assert.deepEqual(
      await listMobileNumbers(db, attacker),
      [],
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("the verify handler rejects input missing the code with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = verifyMobileNumberHandler(db, verifyDeps(), "session-user");

  const res = await handler(jsonRequest("/api/mobile-numbers/verify", JSON.stringify({ id: "some-id" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the verify handler rejects a mis-shaped (non 6-digit) code with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = verifyMobileNumberHandler(db, verifyDeps(), "session-user");

  const res = await handler(
    jsonRequest("/api/mobile-numbers/verify", JSON.stringify({ id: "some-id", code: "not-a-code" })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-shaped code must never reach a query");
});

test("the verify handler verifies the number for the SESSION user, not a body user id", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "verify-session");
    const attacker = await makeUser(db, "verify-attacker");
    const { stored, code } = await addAndCapture(db, { userId: sessionUser, number: NUMBER_A });
    const handler = verifyMobileNumberHandler(db, verifyDeps({ clock: fixedClock(AT_ADD) }), sessionUser);

    // The body smuggles a userId; the handler must ignore it and verify under the session's.
    const res = await handler(
      jsonRequest(
        "/api/mobile-numbers/verify",
        JSON.stringify({ userId: attacker, id: stored.id, code }),
      ),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const result = (await res.json()) as VerifyMobileResult;
    assert.deepEqual(result, { ok: true }, "the owner's number verifies");

    const [listed] = await listMobileNumbers(db, sessionUser);
    assert.equal(listed!.verified, true, "the number is marked verified under the session user");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Migration — the table applies and a second run changes nothing.
// ===========================================================================

test("the mobile_numbers migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "mobile_numbers"),
      true,
      "the mobile_numbers table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0026_mobile_numbers"),
      "db/migrations/0026_mobile_numbers.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0026's CREATE would throw "already exists", so an empty result AND
    // no throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});

