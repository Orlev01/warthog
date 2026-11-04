// E04-S06 — Recovery code (`src/server/auth/recovery.ts`, `db/migrations/0007_recovery.sql`).
//
// RED-first: neither the recovery module nor the migration exists yet, so importing
// `./recovery` throws and `freshDb()` has no recovery schema — every test here fails
// until the builder adds them. That absence IS the point of test-first; do NOT
// implement anything to make these pass.
//
// These tests pin BEHAVIOUR (what issue returns, what is stored, and what verify
// accepts/rejects), never the source text of the module or the SQL file — a later
// rename that preserves behaviour must not redden them. There is no network and no
// Azure here: issue draws entropy through the `random` seam and both functions run
// against an isolated in-memory PGlite with the real migrations (src/test/db).
//
// Why a recovery code exists (brief + design §4.2, §5): a one-time recovery code is
// shown once at sign-up and restores access / unlocks the vault if every passkey is
// lost. The server verifies a presented code against a stored, slow one-way auth hash
// — scrypt(HKDF(code, info `warthog/recovery-auth/v1`)) — so it can authenticate a
// recovery sign-in WITHOUT ever holding the code (or the vault wrapping key the same
// code separately derives). The code is durable: it keeps verifying (the brief: a
// no-passkey device enters "the recovery code each time they unlock there") until a
// REGENERATE replaces it, at which point the old code stops verifying and a fresh one
// takes over (brief: after recovery the person "receives a new recovery code that
// replaces the old one").
//
// The contract this task defines (the builder implements exactly this):
//
//   issueRecoveryCode(
//     db: Db,
//     userId: string,                 // the account id from the session (member-scoped)
//     deps: { random: Random },
//   ): Promise<{ code: string }>
//     • draws 128 random bits and renders them as a 26-character RFC 4648 base32 code
//       (alphabet A–Z 2–7).
//     • stores ONLY the auth hash scrypt(HKDF(code, …)) for `userId`, REPLACING any
//       prior code that user had (a regenerate) — the table never holds the plaintext.
//     • returns `{ code }` — the single place the plaintext is ever handed out (shown
//       once to the person). It is returned to no other caller and written to no column.
//
//   verifyRecoveryCode(
//     db: Db,
//     userId: string,                 // from the session, NEVER from the client
//     code: string,
//   ): Promise<boolean>
//     • true  — `code` is `userId`'s CURRENT recovery code.
//     • false — any other code, a user with no recovery code, or a code that belongs to
//       a DIFFERENT user. verify never throws for a wrong/absent code.
//
// The schema this task defines: `db/migrations/0007_recovery.sql` creates a
// `recovery_codes` table (one current code per person, hung off `users(id)`), applied
// by the shared migration runner. Two tests below touch that table by name — that is
// the schema contract this task pins, the same way the email-code and passkey tests
// name the tables their migrations create.
//
// Acceptance criteria → tests:
//   AC1 "Issues a 26-character base32 code shown once and stores only
//        scrypt(HKDF(code, 'recovery-auth'))." — issue returns a 26-char RFC 4648
//        base32 code carrying ≥128 bits; two issues draw different codes (it is freshly
//        random); the stored row holds no plaintext (the returned code appears verbatim
//        nowhere in it — only a derived hash may be persisted); and the returned code
//        verifies (so a hash of the SAME code is what was stored).
//   AC2 "Verify accepts the code once and a regenerate replaces the old code so the old
//        no longer verifies." — the current code is accepted; a wrong code is rejected;
//        the code is durable (it keeps verifying — it is not consumed on use); a user
//        with no code verifies to false (not a throw); and after a regenerate the OLD
//        code no longer verifies while the NEW (different) code does.
//   Ownership: a code verifies only for the user it was issued to — presenting user A's
//        code as user B fails even when B has a (different) valid code of their own.
//   Migration: 0007_recovery applies and a second run of every migration changes
//        nothing (idempotent).
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";

import { issueRecoveryCode, verifyRecoveryCode } from "./recovery";
import { freshDb } from "../../test/db";
import { createUser, type User } from "../db/users";
import { systemRandom } from "../seams/random";
import { loadMigrations, runMigrations, type Db } from "../db/index";

// issue needs entropy (through the seam, never the crypto library directly). Real
// randomness so two issues genuinely differ — the "freshly random" and "regenerate"
// tests depend on distinct draws, exactly as the TOTP test uses systemRandom.
const deps = { random: systemRandom };

// A placeholder wrapped-DEK reference: `createUser` stores it verbatim (opaque to the
// app). Its value is irrelevant here — we only need a real `users` row so a recovery
// code can hang off a genuine userId (the account id every member-scoped row filters by).
const WRAPPED_DEK = "wrapped-dek-placeholder";

// Create a genuine person row and return it. Distinct labels give distinct (unique)
// emails within a test, so two users never collide on the users.email UNIQUE.
async function freshUser(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}@warthog.com.au`, wrappedDek: WRAPPED_DEK });
}

// ---------------------------------------------------------------------------------
// An independent RFC 4648 base32 decoder, so the test owns the entropy check without
// importing anything from the module under test — the same discipline the TOTP test
// uses with its own reference decoder. Padding / stray characters are ignored.
// ---------------------------------------------------------------------------------
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

// A genuinely different code of the SAME 26-char base32 shape: flip the first
// character to another base32 letter. It stays well-formed, so verify exercises the
// hash comparison (a real wrong guess), not an input-format rejection.
function wrongVariant(code: string): string {
  const first = code[0] === "A" ? "B" : "A";
  return first + code.slice(1);
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields
// the relation name when it exists and NULL otherwise — a non-throwing probe scoped to
// the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// =====================================================================================
// AC1 — issue: a 26-character base32 code, shown once, stored only as a derived hash.
// =====================================================================================

test("issueRecoveryCode returns a 26-character RFC 4648 base32 code carrying ≥128 bits", async () => {
  const db = await freshDb();
  try {
    const user = await freshUser(db, "issue-shape");
    const { code } = await issueRecoveryCode(db, user.id, deps);

    // Exactly 26 characters of the RFC 4648 base32 alphabet (A–Z, 2–7), no padding —
    // the "26 base32 characters" of design §4.2. This is the canonical code the caller
    // shows once; any display grouping is the UI's concern, not this value's.
    assert.match(code, /^[A-Z2-7]{26}$/, `expected a 26-char base32 code, got ${JSON.stringify(code)}`);

    // 26 base32 chars decode to 16 bytes = 128 bits: a recovery code must not be
    // trivially small (design §4.2: "128 random bits").
    assert.ok(
      base32Decode(code).length >= 16,
      `the recovery code must carry ≥128 bits of entropy (got ${base32Decode(code).length} bytes)`,
    );
  } finally {
    await db.close();
  }
});

test("two issues draw different codes (the code is freshly random, not a fixed constant)", async () => {
  const db = await freshDb();
  try {
    const a = await freshUser(db, "issue-rand-a");
    const b = await freshUser(db, "issue-rand-b");
    const first = await issueRecoveryCode(db, a.id, deps);
    const second = await issueRecoveryCode(db, b.id, deps);
    assert.notEqual(first.code, second.code, "each issue draws a fresh random code");
  } finally {
    await db.close();
  }
});

test("issueRecoveryCode stores ONLY a derived hash — the plaintext code never appears in the stored row", async () => {
  const db = await freshDb();
  try {
    const user = await freshUser(db, "issue-stored");
    const { code } = await issueRecoveryCode(db, user.id, deps);

    // The recovery row this task's migration (0007_recovery.sql) persists. A row MUST
    // exist (otherwise the absence check below would pass vacuously), and the returned
    // 26-char code — a long, specific string — must not appear verbatim anywhere in it.
    // Only scrypt(HKDF(code, …)) (and its salt) may be stored; a one-way hash does not
    // contain the code as a substring, so its presence would mean the code was stored
    // in the clear (project rule: codes are stored only as a hash and appear in plain
    // text nowhere except the single message that hands a person their own code).
    const stored = await db.query("SELECT * FROM recovery_codes");
    assert.ok(stored.rows.length >= 1, "issuing a code must persist a recovery row");
    assert.ok(
      !JSON.stringify(stored.rows).includes(code),
      "the plaintext recovery code must never be stored; only its derived hash may be persisted",
    );
  } finally {
    await db.close();
  }
});

test("the code returned by issue verifies (a hash of the SAME code is what was stored)", async () => {
  const db = await freshDb();
  try {
    const user = await freshUser(db, "issue-verifies");
    const { code } = await issueRecoveryCode(db, user.id, deps);

    assert.equal(
      await verifyRecoveryCode(db, user.id, code),
      true,
      "the issued recovery code verifies for the user it was issued to",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — verify: accept the current code (durably), reject a wrong/absent one, and a
// regenerate replaces the old code.
// =====================================================================================

test("verifyRecoveryCode rejects a wrong code", async () => {
  const db = await freshDb();
  try {
    const user = await freshUser(db, "verify-wrong");
    const { code } = await issueRecoveryCode(db, user.id, deps);

    assert.equal(
      await verifyRecoveryCode(db, user.id, wrongVariant(code)),
      false,
      "a code that is not the stored one must not verify",
    );
  } finally {
    await db.close();
  }
});

test("the current code is durable: it keeps verifying across repeated uses (it is not consumed on use)", async () => {
  const db = await freshDb();
  try {
    const user = await freshUser(db, "verify-durable");
    const { code } = await issueRecoveryCode(db, user.id, deps);

    // The recovery code is invalidated only by a regenerate (next test), never by being
    // used — a no-passkey device enters it "each time they unlock there" (brief). So the
    // same correct code verifies again and again.
    for (let i = 1; i <= 3; i += 1) {
      assert.equal(
        await verifyRecoveryCode(db, user.id, code),
        true,
        `use ${i} of the unchanged recovery code must still verify (it is not single-use)`,
      );
    }
  } finally {
    await db.close();
  }
});

test("verifyRecoveryCode returns false for a user with no recovery code (it does not throw)", async () => {
  const db = await freshDb();
  try {
    const user = await freshUser(db, "verify-none");
    // No code was ever issued for this user — verify must report false, not throw.
    assert.equal(
      await verifyRecoveryCode(db, user.id, "AAAAAAAAAAAAAAAAAAAAAAAAAA"),
      false,
      "verifying when no recovery code exists for the user is a plain false",
    );
  } finally {
    await db.close();
  }
});

test("a regenerate replaces the old code: the old no longer verifies and the new one does", async () => {
  const db = await freshDb();
  try {
    const user = await freshUser(db, "regenerate");
    const { code: oldCode } = await issueRecoveryCode(db, user.id, deps);
    assert.equal(await verifyRecoveryCode(db, user.id, oldCode), true, "the first code verifies before regenerating");

    // Regenerate: issuing again for the same user replaces the stored code.
    const { code: newCode } = await issueRecoveryCode(db, user.id, deps);
    assert.notEqual(newCode, oldCode, "a regenerate produces a different code");

    // The old code is now dead, the new one is live — exactly one code is active at a time.
    assert.equal(
      await verifyRecoveryCode(db, user.id, oldCode),
      false,
      "after a regenerate the OLD recovery code must no longer verify",
    );
    assert.equal(
      await verifyRecoveryCode(db, user.id, newCode),
      true,
      "after a regenerate the NEW recovery code verifies",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Ownership — a recovery code is member-scoped: it verifies only for its own user.
// =====================================================================================

test("a recovery code verifies only for the user it was issued to (member-scoped by userId)", async () => {
  const db = await freshDb();
  try {
    const alice = await freshUser(db, "owner-alice");
    const bob = await freshUser(db, "owner-bob");

    const { code: aliceCode } = await issueRecoveryCode(db, alice.id, deps);
    const { code: bobCode } = await issueRecoveryCode(db, bob.id, deps);

    // Bob holds a valid code of his own, yet Alice's code must NOT verify as Bob — the
    // lookup is scoped by the session's userId, never matched across accounts.
    assert.equal(
      await verifyRecoveryCode(db, bob.id, aliceCode),
      false,
      "one person's recovery code must not authenticate another person",
    );

    // Each person's own code still verifies for themselves.
    assert.equal(await verifyRecoveryCode(db, alice.id, aliceCode), true, "Alice's code verifies for Alice");
    assert.equal(await verifyRecoveryCode(db, bob.id, bobCode), true, "Bob's code verifies for Bob");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Migration — 0007_recovery applies and a second run changes nothing.
// =====================================================================================

test("the recovery migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    // The project migration set includes the recovery migration (its recorded name is
    // the task's named deliverable, stable once applied), and freshDb applied it.
    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0007_recovery"),
      "db/migrations/0007_recovery.sql must be part of the project migrations",
    );
    assert.ok(await tableExists(db, "recovery_codes"), "the recovery migration must create the recovery_codes table");

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0007's CREATE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing (idempotent).
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
