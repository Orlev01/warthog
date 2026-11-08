// E11-S01 — Vault unlock-methods store (`src/server/db/vault-unlock-methods.ts`,
// `db/migrations/0021_vault_unlock_methods.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./vault-unlock-methods` throws and `freshDb()` has no `vault_unlock_methods` table —
// every test here fails until the builder adds them. That absence IS the point of
// test-first; do NOT implement anything to make these pass — the builder writes the
// module and the migration afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: what is stored and
// round-tripped, which methods a listing reports, that the per-person PRF salt is stable,
// that the recovery-auth value is a verifier and never the code, who may read/write what,
// what a handler rejects, that every value is bound as a parameter), never the source text
// of the module or the SQL file — a later rename that preserves behaviour must not redden
// them.
//
// WHY this exists (design §4.2 "Device-held vault"): the browser creates a random 256-bit
// VAULT KEY (VK) at first use; high-tier values and card data are encrypted in the browser
// with VK and the server stores ciphertext only. VK itself is stored server-side only
// WRAPPED, once per unlock method (`vault_unlock_methods`):
//   • Passkey PRF   — wrapping key = HKDF(prf output); a fixed per-person 32-byte PRF salt
//                     (`salt_v1`) is fed to the authenticator's PRF eval.
//   • Passphrase    — wrapping key = PBKDF2-SHA256(passphrase), 600,000 iterations, 16-byte salt.
//   • Recovery code — wrapping key = HKDF(code). The server SEPARATELY stores
//                     scrypt(HKDF(code, 'recovery-auth')) to verify a recovery unlock WITHOUT
//                     learning the wrapping key.
// The wrapping key (PRF output / passphrase / recovery code) and the VK never reach the
// server: it holds only the opaque WRAPPED key, the public salts/iterations, the per-person
// PRF salt, and the one-way recovery-auth hash. A leak of this table therefore reveals no
// vault key, passphrase or recovery code.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type UnlockMethod = "passkey_prf" | "passphrase" | "recovery";
//
//   // Public, method-specific params (salts, iteration counts) — NEVER a secret. Stored
//   // and handed back verbatim (e.g. passphrase: { pbkdf2Salt, iterations }).
//   type UnlockParams = Record<string, unknown>;
//
//   interface SaveWrappedKeyInput {
//     userId: string;            // the person (the session's id, NEVER a client value)
//     method: UnlockMethod;
//     wrappedKey: string;        // opaque ciphertext — VK wrapped by the method's wrapping key
//     params?: UnlockParams;     // public params for this method (omitted ⇒ {})
//   }
//
//   interface StoredWrappedKey {
//     wrappedKey: string;        // the opaque wrapped VK stored for this method
//     params: UnlockParams;      // the public params stored alongside it
//   }
//
//   getOrCreatePrfSalt(db, userId, deps: { random }): Promise<string>
//     • the person's FIXED 32-byte PRF salt (`salt_v1`), created once on first call and
//       returned STABLY on every later call; member-scoped (a different person's salt is
//       independent). Entropy is drawn through the `random` seam.
//   saveWrappedKey(db, input: SaveWrappedKeyInput): Promise<void>
//     • stores (upserts) the opaque wrapped VK + its public params for `userId`+`method`.
//       Saving the same method again REPLACES its wrapped key (one wrapped key per method).
//   listMethods(db, userId): Promise<UnlockMethod[]>
//     • which unlock methods have a saved wrapped key for `userId` (member-scoped: WHERE
//       user_id bound); never another person's, and NEVER the wrapped key itself. Empty
//       array when the person has saved none.
//   getWrappedKey(db, userId, method): Promise<StoredWrappedKey | null>
//     • the stored wrapped VK + params for `userId`+`method` (to hand the browser so it can
//       unwrap locally), or null when none is saved. Member-scoped.
//   saveRecoveryAuth(db, userId, code, deps: { random }): Promise<void>
//     • stores ONLY a slow one-way verifier of the recovery `code` (scrypt over a derived
//       value, with a fresh per-row salt) for `userId`; the plaintext code is written to no
//       column. Saving again REPLACES the prior verifier (a regenerate).
//   verifyRecoveryAuth(db, userId, code): Promise<boolean>
//     • true  — `code` is `userId`'s current recovery code (recomputed under the stored salt).
//     • false — any other code, a user with no recovery-auth, or a code belonging to a
//       DIFFERENT user. Never throws for a wrong/absent code.
//
// Acceptance criteria → tests:
//   AC1 "Saving a wrapped vault key for a method stores the ciphertext and its params, and
//        listMethods returns which methods exist for the session user without ever exposing
//        the vault key." — saveWrappedKey then getWrappedKey round-trips the ciphertext +
//        params; listMethods reports exactly the saved methods and never the wrapped key;
//        re-saving a method replaces its key (one per method).
//   AC2 "The per-person PRF salt is created once and returned stably across calls; the
//        recovery-auth value is stored only as a scrypt hash, never the recovery code." —
//        getOrCreatePrfSalt is stable per person and distinct across people; saveRecoveryAuth
//        stores a verifier the right code satisfies and the wrong one does not, and the
//        plaintext code never lands in a column.
//   AC3 "A user cannot read or write another user's unlock methods (filtered by session user
//        id)." — B never sees A's methods or wrapped keys, B's save under the same method
//        leaves A's untouched, and A's recovery code never verifies for B; the user id is
//        bound as a parameter.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed
//        input with a 4xx before any query runs; a SQL-injection probe routed through the
//        repo travels as a BOUND value (placeholders, never concatenation) and cannot drop
//        the table. The handler below is a test fixture (the intended usage), not an
//        implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — the repo takes `db`/`random` as
//        dependencies, reads no `process.env` and holds no key, so a decoy secret planted in
//        the environment never lands in the stored or returned data.
//   Migration: the `vault_unlock_methods` relation exists after the project migrations and a
//        second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state. Randomness is drawn through the `random` seam (systemRandom here, so
// two people genuinely get different salts, exactly as the recovery test does).

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  getOrCreatePrfSalt,
  saveWrappedKey,
  insertWrappedKeyIfAbsent,
  listMethods,
  getWrappedKey,
  saveRecoveryAuth,
  verifyRecoveryAuth,
  type UnlockMethod,
} from "./vault-unlock-methods";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db, type QueryResult } from "./index";
import { systemRandom } from "../seams/random";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

const TABLE = "vault_unlock_methods";

// The three unlock methods (design §4.2). Named here so a drift in the accepted vocabulary
// surfaces as a failing test, not a silent mismatch.
const PASSKEY_PRF: UnlockMethod = "passkey_prf";
const PASSPHRASE: UnlockMethod = "passphrase";
const RECOVERY: UnlockMethod = "recovery";

// Entropy through the seam (never the crypto library directly). Real randomness so two
// people genuinely get different PRF salts / recovery-auth salts — the "distinct per person"
// and "replace" tests depend on distinct draws, exactly as the recovery test uses systemRandom.
const deps = { random: systemRandom };

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

// A recognisable OPAQUE wrapped VK. The server never unwraps it (it has no wrapping key); it
// only stores and hands it back. The token makes each value UNIQUE so an at-rest / leak scan
// for it is unambiguous.
function wrappedKeyFor(token: string): string {
  return `v1:WRAPPED-VK-CIPHERTEXT-${token}`;
}

// Realistic public passphrase params (design §4.2: PBKDF2-SHA256, 600,000 iterations, 16-byte
// salt). These are PUBLIC verification inputs, not secrets, and must round-trip verbatim.
function passphraseParams(token: string): { pbkdf2Salt: string; iterations: number } {
  return { pbkdf2Salt: `pbkdf2-salt-${token}`, iterations: 600000 };
}

// A plausible recovery code (26 base32 chars). Its exact form is the recovery flow's concern;
// here it only needs to be a UNIQUE, specific string so a leak scan for it is meaningful — a
// one-way verifier does not contain it as a substring, so any hit is a real plaintext leak.
function recoveryCodeFor(token: string): string {
  const base = `RECOVERYCODE${token}`.toUpperCase().replace(/[^A-Z2-7]/g, "7");
  return (base + "AAAAAAAAAAAAAAAAAAAAAAAAAA").slice(0, 26);
}

// A db seam stand-in that records every call instead of running it, so a test can prove WHAT
// reached the query layer and HOW (bound value vs. spliced text). It returns no rows and
// satisfies the `Db` shape structurally (query + close).
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []): Promise<QueryResult> {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the
// relation name when it exists and NULL when it does not — a non-throwing probe scoped to the
// one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Assert the probe reached the query layer as a BOUND value and never as spliced SQL text,
// scoped to each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// ===========================================================================
// AC1 — saving a wrapped key stores the ciphertext + params; listMethods reports the saved
// methods for the owner without ever exposing the wrapped key.
// ===========================================================================

test("saveWrappedKey then getWrappedKey round-trips the opaque ciphertext and its params", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-roundtrip");
    const wrappedKey = wrappedKeyFor("PP1");
    const params = passphraseParams("PP1");

    await saveWrappedKey(db, { userId, method: PASSPHRASE, wrappedKey, params });

    const stored = await getWrappedKey(db, userId, PASSPHRASE);
    assert.ok(stored, "a wrapped key was saved for the passphrase method");
    assert.equal(stored.wrappedKey, wrappedKey, "the opaque wrapped VK round-trips verbatim");
    assert.deepEqual(stored.params, params, "the public params round-trip verbatim");
  } finally {
    await db.close();
  }
});

test("saveWrappedKey stores a method with no extra params (passkey PRF) and reads it back", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-noparams");
    const wrappedKey = wrappedKeyFor("PRF1");

    // Passkey PRF carries no per-method salt/iterations of its own (the per-person PRF salt
    // lives separately); an omitted params is stored as an empty object.
    await saveWrappedKey(db, { userId, method: PASSKEY_PRF, wrappedKey });

    const stored = await getWrappedKey(db, userId, PASSKEY_PRF);
    assert.ok(stored, "the passkey-PRF wrapped key was saved");
    assert.equal(stored.wrappedKey, wrappedKey, "the opaque wrapped VK round-trips verbatim");
    assert.deepEqual(stored.params, {}, "an omitted params reads back as an empty object");
  } finally {
    await db.close();
  }
});

test("listMethods returns exactly the methods that have a saved wrapped key for the owner", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-list");
    await saveWrappedKey(db, { userId, method: PASSKEY_PRF, wrappedKey: wrappedKeyFor("L-prf") });
    await saveWrappedKey(db, {
      userId,
      method: PASSPHRASE,
      wrappedKey: wrappedKeyFor("L-pp"),
      params: passphraseParams("L-pp"),
    });

    const methods = await listMethods(db, userId);
    // Order is not pinned (over-constraining); compare as a set.
    assert.deepEqual(
      [...methods].sort(),
      [PASSKEY_PRF, PASSPHRASE].sort(),
      "exactly the two saved methods are reported",
    );
    assert.ok(!methods.includes(RECOVERY), "a method with no saved wrapped key is not reported");
  } finally {
    await db.close();
  }
});

test("listMethods returns an empty array for a person who has saved no unlock methods", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-empty");
    assert.deepEqual(await listMethods(db, userId), [], "no saved methods ⇒ empty list");
  } finally {
    await db.close();
  }
});

test("listMethods never exposes the wrapped key (only which methods exist)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-noexpose");
    const wrappedKey = wrappedKeyFor("SECRET-WRAP-TOKEN-9x");
    await saveWrappedKey(db, { userId, method: PASSPHRASE, wrappedKey, params: passphraseParams("x") });

    const methods = await listMethods(db, userId);
    assert.ok(methods.includes(PASSPHRASE), "the saved method is listed");
    // The wrapped VK is the one value a listing must never hand out. Its token is unique, so
    // its appearance anywhere in the listing's output would be a real leak.
    assert.ok(
      !JSON.stringify(methods).includes(wrappedKey),
      "listMethods must report which methods exist WITHOUT returning the wrapped vault key",
    );
  } finally {
    await db.close();
  }
});

test("saving the same method again REPLACES its wrapped key (one wrapped key per method)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-replace");
    await saveWrappedKey(db, {
      userId,
      method: PASSPHRASE,
      wrappedKey: wrappedKeyFor("old"),
      params: passphraseParams("old"),
    });
    await saveWrappedKey(db, {
      userId,
      method: PASSPHRASE,
      wrappedKey: wrappedKeyFor("new"),
      params: passphraseParams("new"),
    });

    const stored = await getWrappedKey(db, userId, PASSPHRASE);
    assert.ok(stored, "the passphrase method still has a wrapped key");
    assert.equal(stored.wrappedKey, wrappedKeyFor("new"), "the latest save replaces the prior wrapped key");
    assert.deepEqual(stored.params, passphraseParams("new"), "and its params");

    const methods = await listMethods(db, userId);
    assert.equal(
      methods.filter((m) => m === PASSPHRASE).length,
      1,
      "a re-save does not duplicate the method in the listing",
    );
  } finally {
    await db.close();
  }
});

// Review fix W1 — a first save must never overwrite: the unlock-method POST inserts only
// when the method is absent (an overwrite needs a fresh step-up), so two first-time saves
// racing each other keep exactly one vault key instead of silently replacing the other.
test("insertWrappedKeyIfAbsent stores a new method and reports it inserted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "insert-new");
    const inserted = await insertWrappedKeyIfAbsent(db, {
      userId,
      method: RECOVERY,
      wrappedKey: wrappedKeyFor("first"),
    });
    assert.equal(inserted, true, "a method the person had not saved is inserted");
    const stored = await getWrappedKey(db, userId, RECOVERY);
    assert.equal(stored?.wrappedKey, wrappedKeyFor("first"));
    assert.deepEqual(stored?.params, {}, "an omitted params is stored as an empty object");
  } finally {
    await db.close();
  }
});

test("insertWrappedKeyIfAbsent never replaces an existing method and reports it was not inserted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "insert-existing");
    await saveWrappedKey(db, { userId, method: PASSPHRASE, wrappedKey: wrappedKeyFor("kept"), params: passphraseParams("kept") });
    const inserted = await insertWrappedKeyIfAbsent(db, {
      userId,
      method: PASSPHRASE,
      wrappedKey: wrappedKeyFor("intruder"),
      params: passphraseParams("intruder"),
    });
    assert.equal(inserted, false, "an existing method is left alone");
    const stored = await getWrappedKey(db, userId, PASSPHRASE);
    assert.equal(stored?.wrappedKey, wrappedKeyFor("kept"), "the stored wrapped key is unchanged");
    assert.deepEqual(stored?.params, passphraseParams("kept"), "and so are its params");
  } finally {
    await db.close();
  }
});

test("insertWrappedKeyIfAbsent: two concurrent first saves keep exactly one wrapped key", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "insert-race");
    const results = await Promise.all(
      ["a", "b", "c", "d"].map((token) =>
        insertWrappedKeyIfAbsent(db, { userId, method: PASSKEY_PRF, wrappedKey: wrappedKeyFor(token) }),
      ),
    );
    assert.equal(results.filter(Boolean).length, 1, "exactly one concurrent first save wins");
    const stored = await getWrappedKey(db, userId, PASSKEY_PRF);
    const winner = ["a", "b", "c", "d"][results.indexOf(true)]!;
    assert.equal(stored?.wrappedKey, wrappedKeyFor(winner), "the stored key is the winner's");
  } finally {
    await db.close();
  }
});

test("insertWrappedKeyIfAbsent is member-scoped: another person's method never blocks this person's", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "insert-scope-a");
    const b = await makeUser(db, "insert-scope-b");
    await saveWrappedKey(db, { userId: a, method: RECOVERY, wrappedKey: wrappedKeyFor("a") });
    assert.equal(await insertWrappedKeyIfAbsent(db, { userId: b, method: RECOVERY, wrappedKey: wrappedKeyFor("b") }), true);
    assert.equal((await getWrappedKey(db, a, RECOVERY))?.wrappedKey, wrappedKeyFor("a"), "A's row is untouched");
  } finally {
    await db.close();
  }
});

test("insertWrappedKeyIfAbsent binds the user id and wrapped key as parameters", async () => {
  const db = recordingDb();
  const probe = "x'); DROP TABLE vault_unlock_methods; --";
  await insertWrappedKeyIfAbsent(db, { userId: probe, method: RECOVERY, wrappedKey: probe });
  assertBoundNotSpliced(db, probe);
});

test("getWrappedKey returns null for a method the person has not saved", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-null");
    await saveWrappedKey(db, { userId, method: PASSKEY_PRF, wrappedKey: wrappedKeyFor("only-prf") });

    assert.equal(
      await getWrappedKey(db, userId, RECOVERY),
      null,
      "an unsaved method yields null, not a throw or an empty shell",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — the per-person PRF salt is fixed (created once, stable); the recovery-auth value is
// a one-way verifier, never the recovery code.
// ===========================================================================

test("getOrCreatePrfSalt creates the salt once and returns the SAME value on every later call", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-prf-stable");

    const first = await getOrCreatePrfSalt(db, userId, deps);
    assert.equal(typeof first, "string", "the PRF salt is a string");
    assert.ok(first.length >= 32, "a 32-byte salt is at least 32 characters in any text encoding (real entropy)");

    const second = await getOrCreatePrfSalt(db, userId, deps);
    const third = await getOrCreatePrfSalt(db, userId, deps);
    assert.equal(second, first, "the second call returns the stored salt, not a fresh one");
    assert.equal(third, first, "the salt is fixed per person across any number of calls");
  } finally {
    await db.close();
  }
});

test("getOrCreatePrfSalt gives each person their own independent salt", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac2-prf-alice");
    const bob = await makeUser(db, "ac2-prf-bob");

    const aliceSalt = await getOrCreatePrfSalt(db, alice, deps);
    const bobSalt = await getOrCreatePrfSalt(db, bob, deps);
    assert.notEqual(aliceSalt, bobSalt, "two people do not share a PRF salt (it is per-person, freshly drawn)");

    // And each remains stable for its own owner.
    assert.equal(await getOrCreatePrfSalt(db, alice, deps), aliceSalt, "Alice's salt is stable");
    assert.equal(await getOrCreatePrfSalt(db, bob, deps), bobSalt, "Bob's salt is stable");
  } finally {
    await db.close();
  }
});

test("creating the PRF salt is NOT itself an unlock method (listMethods ignores it)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-prf-notmethod");

    await getOrCreatePrfSalt(db, userId, deps);

    // The PRF salt is a per-person prerequisite the browser needs BEFORE it can wrap VK; it
    // is not a saved unlock method. listMethods reports only methods with a saved wrapped key.
    assert.deepEqual(
      await listMethods(db, userId),
      [],
      "having a PRF salt but no saved wrapped key leaves the method listing empty",
    );
  } finally {
    await db.close();
  }
});

test("saveRecoveryAuth stores a verifier the right code satisfies and a wrong code does not", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-rauth");
    const code = recoveryCodeFor("ONE");

    await saveRecoveryAuth(db, userId, code, deps);

    assert.equal(await verifyRecoveryAuth(db, userId, code), true, "the stored verifier accepts the right code");
    assert.equal(
      await verifyRecoveryAuth(db, userId, recoveryCodeFor("TWO")),
      false,
      "a different code must not verify",
    );
  } finally {
    await db.close();
  }
});

test("verifyRecoveryAuth returns false (never throws) for a person with no recovery-auth", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-rauth-none");
    assert.equal(
      await verifyRecoveryAuth(db, userId, recoveryCodeFor("ANY")),
      false,
      "verifying when no recovery-auth exists is a plain false",
    );
  } finally {
    await db.close();
  }
});

test("the recovery-auth verifier is durable: the right code keeps verifying across uses", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-rauth-durable");
    const code = recoveryCodeFor("DURABLE");
    await saveRecoveryAuth(db, userId, code, deps);

    for (let i = 1; i <= 3; i += 1) {
      assert.equal(
        await verifyRecoveryAuth(db, userId, code),
        true,
        `use ${i} of the unchanged recovery code still verifies (it is not consumed on use)`,
      );
    }
  } finally {
    await db.close();
  }
});

test("re-saving recovery-auth replaces the verifier: the old code stops verifying and the new one works", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-rauth-replace");
    const oldCode = recoveryCodeFor("OLD");
    const newCode = recoveryCodeFor("NEW");

    await saveRecoveryAuth(db, userId, oldCode, deps);
    assert.equal(await verifyRecoveryAuth(db, userId, oldCode), true, "the first code verifies before regenerating");

    await saveRecoveryAuth(db, userId, newCode, deps);
    assert.equal(await verifyRecoveryAuth(db, userId, oldCode), false, "after a regenerate the OLD code no longer verifies");
    assert.equal(await verifyRecoveryAuth(db, userId, newCode), true, "after a regenerate the NEW code verifies");
  } finally {
    await db.close();
  }
});

test("the plaintext recovery code is never written to a column — only its one-way verifier", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-rauth-atrest");
    const code = recoveryCodeFor("LEAKCHECK");

    await saveRecoveryAuth(db, userId, code, deps);

    // Non-vacuous: the verifier WAS stored (the right code verifies), so the scan below is
    // checking a real row, not an empty table.
    assert.equal(await verifyRecoveryAuth(db, userId, code), true, "the verifier was stored");

    // Scan every cell of the one table under test. The recovery code is a unique, specific
    // string that lives nowhere legitimately except as the INPUT to a one-way verifier, so
    // any raw occurrence is a genuine plaintext leak (project rule: codes are stored only as
    // a hash). Scoped to `vault_unlock_methods` alone.
    const all = await db.query(`SELECT * FROM ${TABLE}`);
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(code), "the plaintext recovery code must never be stored; only its verifier may be");
        }
      }
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: a second signed-in person can never read or write another's unlock
// methods. The user id is bound from the session, never the client.
// ===========================================================================

test("listMethods and getWrappedKey never return another person's unlock methods", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "own-alice");
    const bob = await makeUser(db, "own-bob");
    await saveWrappedKey(db, { userId: alice, method: PASSPHRASE, wrappedKey: wrappedKeyFor("alice-pp"), params: passphraseParams("a") });
    await saveWrappedKey(db, { userId: alice, method: PASSKEY_PRF, wrappedKey: wrappedKeyFor("alice-prf") });
    await saveWrappedKey(db, { userId: bob, method: RECOVERY, wrappedKey: wrappedKeyFor("bob-rec") });

    const aliceMethods = await listMethods(db, alice);
    assert.deepEqual([...aliceMethods].sort(), [PASSKEY_PRF, PASSPHRASE].sort(), "Alice sees only her own methods");
    assert.ok(!aliceMethods.includes(RECOVERY), "Bob's method never appears in Alice's listing");

    const bobMethods = await listMethods(db, bob);
    assert.deepEqual(bobMethods, [RECOVERY], "Bob sees only his own method");

    // Bob cannot read Alice's wrapped key by asking for her method against his own id.
    assert.equal(await getWrappedKey(db, bob, PASSPHRASE), null, "Bob has no passphrase wrapped key of his own");
  } finally {
    await db.close();
  }
});

test("saveWrappedKey is member-scoped: B saving the same method leaves A's untouched", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "write-alice");
    const bob = await makeUser(db, "write-bob");
    await saveWrappedKey(db, { userId: alice, method: PASSPHRASE, wrappedKey: wrappedKeyFor("A"), params: passphraseParams("A") });

    // Bob saves HIS passphrase wrapped key: it must not overwrite Alice's (keyed by user id).
    await saveWrappedKey(db, { userId: bob, method: PASSPHRASE, wrappedKey: wrappedKeyFor("B"), params: passphraseParams("B") });

    assert.equal((await getWrappedKey(db, alice, PASSPHRASE))!.wrappedKey, wrappedKeyFor("A"), "Alice's wrapped key is unchanged");
    assert.equal((await getWrappedKey(db, bob, PASSPHRASE))!.wrappedKey, wrappedKeyFor("B"), "Bob's own wrapped key is his");
  } finally {
    await db.close();
  }
});

test("a recovery code verifies only for the person it was saved for (member-scoped)", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "rauth-own-alice");
    const bob = await makeUser(db, "rauth-own-bob");
    const aliceCode = recoveryCodeFor("ALICE");
    const bobCode = recoveryCodeFor("BOB");
    await saveRecoveryAuth(db, alice, aliceCode, deps);
    await saveRecoveryAuth(db, bob, bobCode, deps);

    // Bob holds a valid code of his own, yet Alice's code must NOT verify as Bob.
    assert.equal(await verifyRecoveryAuth(db, bob, aliceCode), false, "one person's recovery code must not authenticate another");
    assert.equal(await verifyRecoveryAuth(db, alice, aliceCode), true, "Alice's code verifies for Alice");
    assert.equal(await verifyRecoveryAuth(db, bob, bobCode), true, "Bob's code verifies for Bob");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("saveWrappedKey binds the member-scope user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE vault_unlock_methods; --";
  // The recording db returns no rows; tolerate a no-row read-back (if the impl confirms its
  // write with a RETURNING read) — the binding is asserted below regardless.
  try {
    await saveWrappedKey(db, { userId: probe, method: PASSPHRASE, wrappedKey: wrappedKeyFor("bind"), params: passphraseParams("bind") });
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }
  assertBoundNotSpliced(db, probe);
});

test("listMethods binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "p'); DROP TABLE vault_unlock_methods; --";
  const result = await listMethods(db, probe);
  assert.deepEqual(result, [], "the recording db returns no rows, so the listing is empty");
  assertBoundNotSpliced(db, probe);
});

test("getWrappedKey binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "g'); DROP TABLE vault_unlock_methods; --";
  const result = await getWrappedKey(db, probe, PASSPHRASE);
  assert.equal(result, null, "the recording db returns no rows, so no wrapped key is found");
  assertBoundNotSpliced(db, probe);
});

test("getOrCreatePrfSalt binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "s'); DROP TABLE vault_unlock_methods; --";
  // The recording db returns no rows, so getOrCreatePrfSalt takes its create path; tolerate a
  // no-row read-back (if the impl reads the salt back after inserting it) — the binding is
  // asserted regardless.
  try {
    await getOrCreatePrfSalt(db, probe, deps);
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }
  assertBoundNotSpliced(db, probe);
});

test("saveRecoveryAuth binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "r'); DROP TABLE vault_unlock_methods; --";
  // The recording db returns no rows; tolerate a no-row read-back — the binding is asserted
  // below regardless.
  try {
    await saveRecoveryAuth(db, probe, recoveryCodeFor("BIND"), deps);
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }
  assertBoundNotSpliced(db, probe);
});

test("verifyRecoveryAuth binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "v'); DROP TABLE vault_unlock_methods; --";
  const ok = await verifyRecoveryAuth(db, probe, recoveryCodeFor("BIND"));
  assert.equal(ok, false, "no row comes back, so verification is false");
  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe in the wrapped key is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const probe = "v1:grace'); DROP TABLE vault_unlock_methods; --";

    await saveWrappedKey(db, { userId, method: PASSPHRASE, wrappedKey: probe, params: passphraseParams("inject") });

    assert.equal(
      await tableExists(db, TABLE),
      true,
      "the vault_unlock_methods table must still exist (the probe was stored as data, not run as SQL)",
    );

    const stored = await getWrappedKey(db, userId, PASSPHRASE);
    assert.ok(stored, "the wrapped key is read back");
    assert.equal(stored.wrappedKey, probe, "the probe round-trips verbatim as data");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input and binds probes.
//
// A route handler validates external input HERE (`parseBody`), then calls this task's
// parameterized data-access with the SESSION's user id (NEVER a body value). A rejected input
// maps to a 4xx Response and never reaches a query. This handler is a test fixture that
// EXERCISES the modules — it is not an implementation file.
// ===========================================================================

function saveWrappedKeyHandler(db: Db, sessionUserId: string): (req: Request) => Promise<Response> {
  // The body carries the method, the opaque wrapped VK and the public params; the user id
  // comes from the session, never the body. Lengths are capped so an absurd value is rejected,
  // but generous enough that a probe can still REACH the query to prove it is bound. The method
  // is a closed enum, so a bogus method is rejected at the boundary before any query.
  const schema = z.object({
    method: z.enum(["passkey_prf", "passphrase", "recovery"]),
    wrappedKey: z.string().min(1).max(4096),
    params: z.record(z.string(), z.unknown()).optional(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      await saveWrappedKey(db, {
        userId: sessionUserId,
        method: body.method,
        wrappedKey: body.wrappedKey,
        params: body.params ?? {},
      });
      return new Response(JSON.stringify({ method: body.method }), { status: 201 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test sees
      // the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/vault/unlock-methods", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveWrappedKeyHandler(db, "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveWrappedKeyHandler(db, "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest(JSON.stringify({ method: PASSPHRASE, wrappedKey: "a".repeat(10 * 1024) })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing the method with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveWrappedKeyHandler(db, "session-user");

  const res = await handler(jsonRequest(JSON.stringify({ wrappedKey: wrappedKeyFor("nomethod") })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects an unknown method value with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveWrappedKeyHandler(db, "session-user");

  // The method is a closed set; a value outside it is rejected at the boundary.
  const res = await handler(jsonRequest(JSON.stringify({ method: "root_backdoor", wrappedKey: wrappedKeyFor("bad") })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an out-of-vocabulary method must never reach a query");
});

test("the handler rejects a mis-typed wrapped key with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveWrappedKeyHandler(db, "session-user");

  // wrappedKey must be a string — a number there is a schema violation, rejected before any query.
  const res = await handler(jsonRequest(JSON.stringify({ method: PASSPHRASE, wrappedKey: 123 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler accepts a well-formed body and saves the wrapped key for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const handler = saveWrappedKeyHandler(db, userId);

    const res = await handler(
      jsonRequest(JSON.stringify({ method: PASSPHRASE, wrappedKey: wrappedKeyFor("ok"), params: passphraseParams("ok") })),
    );

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    const stored = await getWrappedKey(db, userId, PASSPHRASE);
    assert.ok(stored, "a valid body is persisted for the session user");
    assert.equal(stored.wrappedKey, wrappedKeyFor("ok"), "with the submitted wrapped key");
    assert.deepEqual(stored.params, passphraseParams("ok"), "and the submitted params");
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const handler = saveWrappedKeyHandler(db, sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(
      jsonRequest(JSON.stringify({ userId: attacker, method: PASSKEY_PRF, wrappedKey: wrappedKeyFor("smuggle") })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.deepEqual(
      await listMethods(db, sessionUser),
      [PASSKEY_PRF],
      "the wrapped key is recorded under the SESSION user",
    );
    assert.deepEqual(
      await listMethods(db, attacker),
      [],
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe wrapped key is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const handler = saveWrappedKeyHandler(db, userId);
    const probe = "v1:grace'); DROP TABLE vault_unlock_methods; --";

    const res = await handler(jsonRequest(JSON.stringify({ method: PASSPHRASE, wrappedKey: probe })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, TABLE), true, "the vault_unlock_methods table must still exist");

    const stored = await getWrappedKey(db, userId, PASSPHRASE);
    assert.ok(stored, "the wrapped key was stored");
    assert.equal(stored.wrappedKey, probe, "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the repo reads no process.env and holds no secret (INV-103). Enforced by
// construction; shown behaviourally: a decoy secret in the environment never lands in the
// stored or returned data, and the repo reads/writes from the injected db + random alone.
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in the store", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-env");

    await saveWrappedKey(db, { userId, method: PASSPHRASE, wrappedKey: wrappedKeyFor("env"), params: passphraseParams("env") });
    await getOrCreatePrfSalt(db, userId, deps);
    await saveRecoveryAuth(db, userId, recoveryCodeFor("ENV"), deps);

    const stored = await getWrappedKey(db, userId, PASSPHRASE);
    const methods = await listMethods(db, userId);
    assert.ok(stored, "the wrapped key reads and writes purely from the injected db — no app env needed");
    assert.ok(
      !JSON.stringify(stored).includes(DECOY) && !JSON.stringify(methods).includes(DECOY),
      "no ambient env value is folded into the stored or returned data",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the same
    // value could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query(`SELECT * FROM ${TABLE}`);
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
// Migration — the table applies and a second run changes nothing.
// ===========================================================================

test("the vault_unlock_methods migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, TABLE),
      true,
      "the vault_unlock_methods table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0021_vault_unlock_methods"),
      "db/migrations/0021_vault_unlock_methods.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw — re-executing
    // 0021's CREATE would throw "already exists", so an empty result AND no throw together prove
    // the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
