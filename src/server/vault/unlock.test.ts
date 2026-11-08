// E11-S11 — Vault unlock server actions (`src/server/vault/unlock.ts`).
//
// RED-first: the module does not exist yet, so importing `./unlock`
// (`createVaultUnlockActions`) throws and EVERY test here fails until the builder
// writes it. That absence IS the point of test-first — as the TESTER I must NOT
// create or edit any implementation/source file to make these pass; the builder
// writes `unlock.ts` afterwards, to the contract these tests pin.
//
// These tests pin BEHAVIOUR (what the actions RETURN, what they CHANGE in the
// database — observed through the ALREADY-BUILT store seam and the REAL migrations —
// and what they REFUSE), never the source text of any module, so a later
// behaviour-preserving rename/refactor stays green. State is arranged against an
// isolated in-memory PGlite with every real migration (src/test/db). The passphrase
// interop test uses the REAL client-side vault crypto (src/client/vault) so the
// material getUnlockMaterial hands back is proven to actually unlock a VK, not merely
// to round-trip an opaque string. Tests never touch the network or Azure; every db
// handle is closed in a `finally`.
//
// WHY this exists (task E11-S11): the browser crypto (E11-S07..S10) needs a server
// seam to FETCH its PRF salt + the wrapped vault key for a method (so it can unlock
// VK locally) and to STORE a freshly wrapped VK when a new unlock method is added;
// and the account-shape rules must be enforced SERVER-SIDE, not trusted to the client
// (brief "Vault unlock methods": "An account that uses only an authenticator app must
// set a vault passphrase before adding high-tier details or cards. Changing or
// removing the passphrase requires unlocking first."; design §4.2 "Device-held
// vault"). This module COMPOSES the already-built data-access store
// (`src/server/db/vault-unlock-methods.ts`: getOrCreatePrfSalt / saveWrappedKey /
// getWrappedKey / listMethods) — it adds no SQL and no crypto of its own.
//
// ───────────────────────────────────────────────────────────────────────────────────
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type UnlockMethod = "passkey_prf" | "passphrase" | "recovery";   // = the store's
//   type UnlockParams = Record<string, unknown>;                      // public, never a secret
//
//   interface UnlockMaterial {
//     prfSalt: string;            // the person's FIXED per-person PRF-eval salt (hex), created
//                                 //   once and returned stably; fed to the authenticator's PRF eval.
//     method:  UnlockMethod;      // the requested method, echoed back.
//     wrapped: string | null;     // the opaque wrapped VK stored for that method, or null when none.
//     params:  UnlockParams;      // that method's public params (e.g. { pbkdf2Salt, iterations }); {} when none.
//   }
//
//   interface SaveUnlockMethodInput {
//     method:  UnlockMethod;
//     wrapped: string;            // opaque ciphertext — VK wrapped by the method's wrapping key
//     params?: UnlockParams;      // public params for this method (omitted ⇒ {})
//   }
//
//   type ActionResult = { ok: true } | { ok: false; reason: string };  // never a silent success
//
//   type VaultGate =
//     | { action: "save_protected" }                       // about to save a high-tier field or a card
//     | { action: "change_passphrase"; unlocked: boolean } // the person is changing their vault passphrase
//     | { action: "remove_passphrase"; unlocked: boolean };// … or removing it
//
//   createVaultUnlockActions(deps: { db: Db; random: Random }): {
//     getUnlockMaterial(userId, method):   Promise<UnlockMaterial>
//     saveUnlockMethod(userId, input):     Promise<ActionResult>
//     assertVaultUnlockable(userId, gate): Promise<ActionResult>
//   }
//
//   • Each method takes the member-scope `userId` — the SESSION's verified user id, which the
//     thin server-action wrapper derives from the session and passes here, NEVER a client value
//     (design §4.2: "every member-scoped query is filtered by the session's user id"). So one
//     person can never read or write another's unlock material, PRF salt, or gate verdict.
//   • getUnlockMaterial(userId, method): returns the person's PRF salt (created on first call,
//     stable thereafter) AND the wrapped VK + params for `method` (null/{} when none is saved).
//   • saveUnlockMethod(userId, input): persists (upserts) the wrapped VK + params for that person
//     + method — one wrapped key per method (a re-save replaces it). Returns { ok: true }. It does
//     NOT itself gate; the gate is a SEPARATE assertion the caller runs first.
//   • assertVaultUnlockable(userId, gate): the policy gate.
//       - { action: "save_protected" }: { ok: true } only when the person has a PRF-passkey OR a
//         passphrase unlock method; otherwise { ok: false, reason } — an account that can only use
//         an authenticator app (no PRF passkey, no passphrase) may NOT save high-tier fields or
//         cards. A recovery code ALONE is not enough.
//       - { action: "change_passphrase" | "remove_passphrase"; unlocked }: { ok: true } only when
//         `unlocked` is true (the person unlocked the vault first); otherwise { ok: false, reason }.
//   • STRUCTURAL input (a method not in the enum, a missing / empty / non-string / oversized
//     `wrapped`) is rejected at the validation boundary with a 4xx `HttpError` (INV-102) — never a
//     500, never a cast against a query. A SQL-shaped `wrapped` value travels as a BOUND parameter
//     through the store and is stored as data; it cannot alter a statement.
//   • The actions read NO `process.env` and hold no key: config flows only through the injected
//     `db` + `random` seams (INV-103), so a decoy env secret can never surface in material or state.
//
// Acceptance criteria → tests:
//   AC1 getUnlockMaterial returns the session user's PRF salt + the wrapped key for a method, and
//       saveUnlockMethod persists a wrapped key for that user only.                (§AC1)
//   AC2 assertVaultUnlockable refuses an account with neither a PRF passkey nor a passphrase (plain
//       reason), and refuses changing/removing the passphrase without a prior unlock. (§AC2)
//   AC3 a user cannot read or write another user's unlock material (session-user-scoped).  (§AC3)
//   AC4 [validate-and-parameterize-input] a handler rejects malformed/oversized input with a 4xx, and
//       a SQL-injection probe cannot alter a query (parameter binding).            (§AC4)
//   AC5 [secrets-from-env] no env secret surfaces in the returned material or stored state.  (§AC5)

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import { createVaultUnlockActions } from "./unlock";

// The already-built store this module composes — used ONLY to cross-check persistence
// at the data layer (never re-implemented here).
import { getOrCreatePrfSalt, getWrappedKey, type UnlockMethod } from "../db/vault-unlock-methods";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import { systemRandom } from "../seams/random";
import { parseBody, HttpError } from "../http/validate";
import type { Db } from "../db/index";

// The REAL client-side vault crypto — to BUILD a genuinely wrapped VK (as the browser
// would) and prove the fetched material unlocks it back to the original key.
import { createVaultKey, wrapVaultKey, unwrapVaultKey } from "../../client/vault/key";
import { deriveWrappingKeyFromPassphrase } from "../../client/vault/derive";

// --- fixtures -------------------------------------------------------------------------

const VAULT_UNLOCK_TABLE = "vault_unlock_methods";
const PRF_SALT_TABLE = "vault_prf_salts";

// A unique tag so accounts never collide on the users.email UNIQUE across tests.
function tag(): string {
  return randomBytes(6).toString("hex");
}

// A stand-in wrapped DEK for createUser (opaque base64; this flow never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}-${tag()}`).toString("base64");
}

// Create a person and return their id — the member scope every read/write filters by
// (the session's user id; here a real users row so the FK on vault tables is satisfied).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, { email: `${who}-${tag()}@warthog.com.au`, wrappedDek: wrappedDekFor(who) });
  return user.id;
}

// The actions under test, wired to the real db + the real randomness seam (so two
// people genuinely get different PRF salts, exactly as the store's own test does).
function makeActions(db: Db) {
  return createVaultUnlockActions({ db, random: systemRandom });
}

// A representative opaque `v1:` wrapped-VK envelope (the shape the browser stores). The
// server treats it as an opaque string, so a distinctive marker makes round-trips and
// no-leak checks meaningful without needing real crypto.
function sampleWrapped(seed: string): string {
  return `v1:${Buffer.from(`wrapped-vk-${seed}-${tag()}`).toString("base64")}`;
}

// Whether a relation of this exact name exists — a non-throwing probe for survival tests.
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Assert a call rejects with the validation boundary's own error — an HttpError whose
// status is always a 4xx (never a 500, never a raw cast).
async function assertHttp4xx(fn: () => Promise<unknown>, message: string): Promise<void> {
  await assert.rejects(
    fn,
    (err: unknown) => {
      assert.ok(err instanceof HttpError, `${message}: expected an HttpError, got ${String(err)}`);
      assert.ok(
        (err as HttpError).status >= 400 && (err as HttpError).status < 500,
        `${message}: expected a 4xx status, got ${(err as HttpError).status}`,
      );
      return true;
    },
    message,
  );
}

// --- byte helpers for the client-crypto interop test ---------------------------------

function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

// A 16-byte PBKDF2 salt as the exact Uint8Array<ArrayBuffer> the client derive takes.
function randomSalt16(): Uint8Array<ArrayBuffer> {
  const salt = new Uint8Array(16);
  salt.set(randomBytes(16));
  return salt;
}

// Rebuild a 16-byte salt from the hex the server round-trips back in `params`.
function salt16FromHex(hex: string): Uint8Array<ArrayBuffer> {
  const salt = new Uint8Array(16);
  salt.set(Buffer.from(hex, "hex"));
  return salt;
}

// =====================================================================================
// AC1 — getUnlockMaterial returns the person's PRF salt + the wrapped key for a method;
// saveUnlockMethod persists a wrapped key (for that user only).
// =====================================================================================

test("AC1: getUnlockMaterial returns the person's PRF salt, created once and stable across calls and methods", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "prf-salt");

    const first = await actions.getUnlockMaterial(userId, "passkey_prf");
    assert.equal(typeof first.prfSalt, "string", "the PRF salt is returned as a string");
    assert.ok(first.prfSalt.length > 0, "the PRF salt is non-empty");

    // Stable across repeated calls AND independent of the requested method.
    const again = await actions.getUnlockMaterial(userId, "passkey_prf");
    const viaOther = await actions.getUnlockMaterial(userId, "passphrase");
    assert.equal(again.prfSalt, first.prfSalt, "the PRF salt is stable across calls (created once)");
    assert.equal(viaOther.prfSalt, first.prfSalt, "the PRF salt does not depend on the requested method");

    // It IS the person's stored PRF salt — the same value the store's own reader returns.
    assert.equal(
      first.prfSalt,
      await getOrCreatePrfSalt(db, userId, { random: systemRandom }),
      "getUnlockMaterial returns the person's stored PRF salt",
    );
  } finally {
    await db.close();
  }
});

test("AC1: two different people get different PRF salts", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await makeUser(db, "salt-alice");
    const bob = await makeUser(db, "salt-bob");

    const a = await actions.getUnlockMaterial(alice, "passkey_prf");
    const b = await actions.getUnlockMaterial(bob, "passkey_prf");
    assert.notEqual(a.prfSalt, b.prfSalt, "each person's PRF salt is their own, independently drawn");
  } finally {
    await db.close();
  }
});

test("AC1: for a method with no saved key, getUnlockMaterial returns wrapped=null and params={} (but still the PRF salt)", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "no-method");

    const material = await actions.getUnlockMaterial(userId, "passphrase");
    assert.equal(material.method, "passphrase", "the requested method is echoed back");
    assert.equal(material.wrapped, null, "no wrapped key is reported when none is saved");
    assert.deepEqual(material.params, {}, "params default to an empty object when none is saved");
    assert.ok(material.prfSalt.length > 0, "the PRF salt is still returned for an unsaved method");
  } finally {
    await db.close();
  }
});

test("AC1: saveUnlockMethod persists a wrapped key + params, and getUnlockMaterial hands it back verbatim", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "save-get");

    const wrapped = sampleWrapped("passphrase");
    const params = { pbkdf2Salt: randomBytes(16).toString("hex"), iterations: 600000 };

    const saved = await actions.saveUnlockMethod(userId, { method: "passphrase", wrapped, params });
    assert.deepEqual(saved, { ok: true }, "saving reports success, never a silent outcome");

    const material = await actions.getUnlockMaterial(userId, "passphrase");
    assert.equal(material.wrapped, wrapped, "the wrapped VK round-trips verbatim");
    assert.deepEqual(material.params, params, "the public params round-trip verbatim");

    // Cross-check at the data layer: the same opaque key is stored in the store.
    const stored = await getWrappedKey(db, userId, "passphrase");
    assert.equal(stored?.wrappedKey, wrapped, "the store holds exactly the wrapped key that was saved");
    assert.deepEqual(stored?.params, params, "the store holds exactly the params that were saved");
  } finally {
    await db.close();
  }
});

test("AC1: saveUnlockMethod with no params stores an empty params object", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "no-params");

    const wrapped = sampleWrapped("prf");
    await actions.saveUnlockMethod(userId, { method: "passkey_prf", wrapped });

    const material = await actions.getUnlockMaterial(userId, "passkey_prf");
    assert.equal(material.wrapped, wrapped, "the wrapped VK is stored");
    assert.deepEqual(material.params, {}, "an omitted params is stored as {}");
  } finally {
    await db.close();
  }
});

test("AC1: re-saving a method with `replace` (a fresh step-up) REPLACES its wrapped key (one wrapped key per method)", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "replace");

    const firstWrapped = sampleWrapped("first");
    const secondWrapped = sampleWrapped("second");
    assert.notEqual(firstWrapped, secondWrapped, "the two envelopes differ");

    await actions.saveUnlockMethod(userId, { method: "passphrase", wrapped: firstWrapped, params: { iterations: 600000 } });
    const replaced = await actions.saveUnlockMethod(
      userId,
      { method: "passphrase", wrapped: secondWrapped, params: { iterations: 700000 } },
      { replace: true },
    );
    assert.deepEqual(replaced, { ok: true });

    const material = await actions.getUnlockMaterial(userId, "passphrase");
    assert.equal(material.wrapped, secondWrapped, "the latest save replaces the prior wrapped key in place");
    assert.deepEqual(material.params, { iterations: 700000 }, "and replaces its params too");
  } finally {
    await db.close();
  }
});

// Review fix W1 — without `replace` a save is insert-only: an existing method is refused
// with step_up_required and keeps its envelope.
test("W1: re-saving a method WITHOUT `replace` is refused (step_up_required) and keeps the stored key", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "no-replace");
    const kept = sampleWrapped("kept");
    await actions.saveUnlockMethod(userId, { method: "recovery", wrapped: kept });
    const refused = await actions.saveUnlockMethod(userId, { method: "recovery", wrapped: sampleWrapped("other") });
    assert.deepEqual(refused, { ok: false, reason: "step_up_required" });
    assert.equal((await actions.getUnlockMaterial(userId, "recovery")).wrapped, kept);
  } finally {
    await db.close();
  }
});

test("AC1: saving one method leaves another method's material independent", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "independent");

    const prfWrapped = sampleWrapped("prf");
    const passWrapped = sampleWrapped("pass");
    await actions.saveUnlockMethod(userId, { method: "passkey_prf", wrapped: prfWrapped });
    await actions.saveUnlockMethod(userId, { method: "passphrase", wrapped: passWrapped });

    assert.equal((await actions.getUnlockMaterial(userId, "passkey_prf")).wrapped, prfWrapped, "the PRF method keeps its own key");
    assert.equal((await actions.getUnlockMaterial(userId, "passphrase")).wrapped, passWrapped, "the passphrase method keeps its own key");
    assert.equal((await actions.getUnlockMaterial(userId, "recovery")).wrapped, null, "an unsaved method is still null");
  } finally {
    await db.close();
  }
});

test("AC1: the material getUnlockMaterial returns actually unlocks a real VK (end-to-end passphrase interop)", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "interop");

    // The browser's side: a random VK sealed under a passphrase-derived wrapping key.
    const PASSPHRASE = "correct horse battery staple";
    const vaultKey = createVaultKey();
    const salt = randomSalt16();
    const wrappingKey = await deriveWrappingKeyFromPassphrase(PASSPHRASE, salt);
    const wrapped = await wrapVaultKey(wrappingKey, vaultKey);

    // Stored through the server seam, with the PBKDF2 salt as public params.
    await actions.saveUnlockMethod(userId, {
      method: "passphrase",
      wrapped,
      params: { pbkdf2Salt: hexOf(salt), iterations: 600000 },
    });

    // Fetched back and unlocked exactly as the browser would: re-derive from the
    // returned salt, unwrap the returned envelope, and recover the ORIGINAL VK.
    const material = await actions.getUnlockMaterial(userId, "passphrase");
    assert.equal(typeof material.wrapped, "string", "the wrapped VK comes back as a string");
    const reSalt = salt16FromHex(material.params.pbkdf2Salt as string);
    const reKey = await deriveWrappingKeyFromPassphrase(PASSPHRASE, reSalt);
    const recovered = await unwrapVaultKey(reKey, material.wrapped as string);

    assert.equal(hexOf(recovered), hexOf(vaultKey), "the fetched material re-derives and unwraps to the original vault key");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — assertVaultUnlockable: an account with neither a PRF passkey nor a passphrase
// cannot save high-tier fields or cards (plain reason); changing/removing the passphrase
// is refused without a prior unlock.
// =====================================================================================

test("AC2: an account with no PRF passkey and no passphrase cannot save high-tier fields or cards", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "empty-vault");

    const result = await actions.assertVaultUnlockable(userId, { action: "save_protected" });
    assert.equal(result.ok, false, "a vault with no unlock method refuses protected saves");
    if (result.ok === false) {
      assert.equal(typeof result.reason, "string", "the refusal carries a plain reason");
      assert.ok(result.reason.length > 0, "the reason is not empty");
    }
  } finally {
    await db.close();
  }
});

test("AC2: a PRF passkey alone makes the account able to save protected data", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "has-prf");
    await actions.saveUnlockMethod(userId, { method: "passkey_prf", wrapped: sampleWrapped("prf") });

    assert.deepEqual(
      await actions.assertVaultUnlockable(userId, { action: "save_protected" }),
      { ok: true },
      "a PRF-passkey unlock method is enough to save protected data",
    );
  } finally {
    await db.close();
  }
});

test("AC2: a passphrase alone makes the account able to save protected data", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "has-pass");
    await actions.saveUnlockMethod(userId, { method: "passphrase", wrapped: sampleWrapped("pass") });

    assert.deepEqual(
      await actions.assertVaultUnlockable(userId, { action: "save_protected" }),
      { ok: true },
      "a vault passphrase is enough to save protected data",
    );
  } finally {
    await db.close();
  }
});

test("AC2: a recovery code ALONE is not enough to save protected data", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "only-recovery");
    await actions.saveUnlockMethod(userId, { method: "recovery", wrapped: sampleWrapped("rec") });

    const result = await actions.assertVaultUnlockable(userId, { action: "save_protected" });
    assert.equal(result.ok, false, "recovery is a backup, not a substitute for a passkey/passphrase");
  } finally {
    await db.close();
  }
});

test("AC2: an account with both a PRF passkey and a passphrase can save protected data", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "both");
    await actions.saveUnlockMethod(userId, { method: "passkey_prf", wrapped: sampleWrapped("prf") });
    await actions.saveUnlockMethod(userId, { method: "passphrase", wrapped: sampleWrapped("pass") });

    assert.deepEqual(await actions.assertVaultUnlockable(userId, { action: "save_protected" }), { ok: true });
  } finally {
    await db.close();
  }
});

test("AC2: changing the passphrase is refused without a prior unlock, and allowed with one", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "change-pass");

    const refused = await actions.assertVaultUnlockable(userId, { action: "change_passphrase", unlocked: false });
    assert.equal(refused.ok, false, "changing the passphrase without unlocking first is refused");
    if (refused.ok === false) {
      assert.equal(typeof refused.reason, "string", "the refusal carries a plain reason");
      assert.ok(refused.reason.length > 0, "the reason is not empty");
    }

    assert.deepEqual(
      await actions.assertVaultUnlockable(userId, { action: "change_passphrase", unlocked: true }),
      { ok: true },
      "changing the passphrase is allowed once the person has unlocked the vault",
    );
  } finally {
    await db.close();
  }
});

test("AC2: removing the passphrase is refused without a prior unlock, and allowed with one", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "remove-pass");

    const refused = await actions.assertVaultUnlockable(userId, { action: "remove_passphrase", unlocked: false });
    assert.equal(refused.ok, false, "removing the passphrase without unlocking first is refused");

    assert.deepEqual(
      await actions.assertVaultUnlockable(userId, { action: "remove_passphrase", unlocked: true }),
      { ok: true },
      "removing the passphrase is allowed once the person has unlocked the vault",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — member scope: a user can never read or write another user's unlock material,
// PRF salt, or gate verdict (filtered by the session's user id).
// =====================================================================================

test("AC3: getUnlockMaterial never returns another person's wrapped key", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await makeUser(db, "owner-alice");
    const bob = await makeUser(db, "intruder-bob");

    const aliceWrapped = sampleWrapped("alice-pass");
    await actions.saveUnlockMethod(alice, { method: "passphrase", wrapped: aliceWrapped });

    // Bob asks for the passphrase material under HIS id — he gets nothing of Alice's.
    const bobView = await actions.getUnlockMaterial(bob, "passphrase");
    assert.equal(bobView.wrapped, null, "Bob never sees Alice's wrapped key");
    assert.notEqual(bobView.prfSalt, (await actions.getUnlockMaterial(alice, "passphrase")).prfSalt, "and his PRF salt is his own");
  } finally {
    await db.close();
  }
});

test("AC3: saveUnlockMethod writes only the acting person's row, leaving another person's untouched", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await makeUser(db, "write-alice");
    const bob = await makeUser(db, "write-bob");

    const aliceWrapped = sampleWrapped("alice");
    const bobWrapped = sampleWrapped("bob");
    assert.notEqual(aliceWrapped, bobWrapped, "the two people's envelopes differ");

    await actions.saveUnlockMethod(alice, { method: "passphrase", wrapped: aliceWrapped });
    // Bob saves the SAME method; this must write Bob's own row, not touch Alice's.
    await actions.saveUnlockMethod(bob, { method: "passphrase", wrapped: bobWrapped });

    assert.equal((await getWrappedKey(db, alice, "passphrase"))?.wrappedKey, aliceWrapped, "Alice's wrapped key is unchanged by Bob's save");
    assert.equal((await getWrappedKey(db, bob, "passphrase"))?.wrappedKey, bobWrapped, "Bob's save wrote his own row");
  } finally {
    await db.close();
  }
});

test("AC3: one person's unlock method does not satisfy another person's save gate", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await makeUser(db, "gate-alice");
    const bob = await makeUser(db, "gate-bob");

    // Alice has a passphrase; Bob has nothing.
    await actions.saveUnlockMethod(alice, { method: "passphrase", wrapped: sampleWrapped("alice") });

    assert.deepEqual(await actions.assertVaultUnlockable(alice, { action: "save_protected" }), { ok: true }, "Alice may save");
    const bobGate = await actions.assertVaultUnlockable(bob, { action: "save_protected" });
    assert.equal(bobGate.ok, false, "Bob's own (empty) vault still refuses — Alice's methods are not his");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 [obligation:validate-and-parameterize-input] (INV-102) — malformed / oversized /
// mis-shaped input is a 4xx (never a 500); a SQL-shaped value travels bound and cannot
// alter a query.
// =====================================================================================

test("[validate-and-parameterize-input] getUnlockMaterial rejects a method not in the enum with a 4xx", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "bad-method");

    await assertHttp4xx(
      () => actions.getUnlockMaterial(userId, "not_a_method" as unknown as UnlockMethod),
      "an unknown method must be a 4xx, never a 500",
    );
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] saveUnlockMethod rejects malformed input with a 4xx and persists nothing", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "bad-save");

    const badInputs: Array<unknown> = [
      { method: "not_a_method", wrapped: sampleWrapped("x") }, // method outside the enum
      { method: "passphrase" }, // missing wrapped
      { method: "passphrase", wrapped: "" }, // empty wrapped
      { method: "passphrase", wrapped: 123 }, // non-string wrapped
      { method: "passphrase", wrapped: null }, // null wrapped
      { wrapped: sampleWrapped("x") }, // missing method
    ];
    for (const bad of badInputs) {
      await assertHttp4xx(
        () => actions.saveUnlockMethod(userId, bad as never),
        `malformed save input ${JSON.stringify(bad)} must be a 4xx`,
      );
    }

    // None of the refused saves persisted anything.
    assert.equal((await actions.getUnlockMaterial(userId, "passphrase")).wrapped, null, "no malformed save persisted a key");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] saveUnlockMethod rejects an oversized wrapped value with a 4xx and persists nothing", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "oversize");

    const huge = "v1:" + "A".repeat(2 * 1024 * 1024); // ~2 MiB, far beyond any real envelope
    await assertHttp4xx(
      () => actions.saveUnlockMethod(userId, { method: "passphrase", wrapped: huge }),
      "an oversized wrapped value must be a 4xx",
    );
    assert.equal((await actions.getUnlockMaterial(userId, "passphrase")).wrapped, null, "the oversized value persisted nothing");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] a SQL-shaped wrapped value is stored as data, round-trips verbatim, and the table survives", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "sql-probe");

    // A classic injection payload. Bound as a parameter through the store, it is stored
    // as data and cannot run as SQL.
    const VALUE = "v1:robert'); DROP TABLE vault_unlock_methods; --";
    const saved = await actions.saveUnlockMethod(userId, { method: "passphrase", wrapped: VALUE });
    assert.deepEqual(saved, { ok: true }, "a SQL-shaped value is a valid opaque string and is saved");

    await db.query(`SELECT 1 FROM ${VAULT_UNLOCK_TABLE} LIMIT 1`);
    assert.equal(await tableExists(db, VAULT_UNLOCK_TABLE), true, "the vault_unlock_methods table survives the probe");
    assert.equal(
      (await actions.getUnlockMaterial(userId, "passphrase")).wrapped,
      VALUE,
      "the SQL-shaped value round-trips verbatim as data",
    );
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] a handler rejects malformed/oversized/mis-shaped input with a 4xx and scopes by the session user id", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const sessionUserId = await makeUser(db, "handler-session");
    const attackerId = await makeUser(db, "handler-attacker");

    // A thin HTTP handler fixture (TEST CODE, not an implementation file): it validates the
    // body at the real `parseBody` boundary and scopes the save by the SESSION user id,
    // never a body-supplied id — the intended usage of the action behind a route.
    const schema = z.object({
      method: z.enum(["passkey_prf", "passphrase", "recovery"]),
      wrapped: z.string().min(1).max(64 * 1024),
    });
    const handler = async (req: Request): Promise<Response> => {
      try {
        const body = await parseBody(schema, req, { maxBytes: 16 * 1024 });
        const result = await actions.saveUnlockMethod(sessionUserId, { method: body.method, wrapped: body.wrapped });
        return new Response(JSON.stringify(result), { status: 200 });
      } catch (err) {
        if (err instanceof HttpError) return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
        return new Response("internal error", { status: 500 });
      }
    };
    const post = (body: string): Request =>
      new Request("https://warthog.com.au/api/vault/unlock-method", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

    // Malformed JSON, an oversized body, and a mis-shaped field are each a 4xx (never a 500).
    const malformed = await handler(post("{ not valid json"));
    assert.ok(malformed.status >= 400 && malformed.status < 500, `malformed JSON is a 4xx, got ${malformed.status}`);

    const oversized = await handler(post(JSON.stringify({ method: "passphrase", wrapped: "A".repeat(2 * 1024 * 1024) })));
    assert.ok(oversized.status >= 400 && oversized.status < 500, `an oversized body is a 4xx, got ${oversized.status}`);

    const misshaped = await handler(post(JSON.stringify({ method: "nope", wrapped: sampleWrapped("x") })));
    assert.ok(misshaped.status >= 400 && misshaped.status < 500, `a mis-shaped field is a 4xx, got ${misshaped.status}`);

    // A well-formed body that smuggles a victim's userId: the handler ignores it and writes
    // under the SESSION user id.
    const wrapped = sampleWrapped("legit");
    const ok = await handler(post(JSON.stringify({ method: "passphrase", wrapped, userId: attackerId })));
    assert.ok(ok.status >= 200 && ok.status < 300, `a well-formed save is a 2xx, got ${ok.status}`);
    assert.equal((await getWrappedKey(db, sessionUserId, "passphrase"))?.wrappedKey, wrapped, "the save is scoped to the session user id");
    assert.equal(await getWrappedKey(db, attackerId, "passphrase"), null, "the body-supplied id never becomes the write scope");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC5 [obligation:secrets-from-env] (INV-103) — the actions run purely from their
// injected db + random seams; no ambient env secret surfaces in material or state.
// =====================================================================================

test("[secrets-from-env] a decoy env secret never surfaces in returned material or stored rows", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "secrets");

    const wrapped = sampleWrapped("secret-check");
    await actions.saveUnlockMethod(userId, { method: "passphrase", wrapped, params: { iterations: 600000 } });
    const material = await actions.getUnlockMaterial(userId, "passphrase");

    // The returned material is built from the injected seams only — no env value leaks in.
    assert.ok(!JSON.stringify(material).includes(DECOY), "no ambient env secret appears in the returned material");

    // Nor is any decoy folded into the stored rows (scoped narrowly to this module's tables).
    for (const tableRows of [
      (await db.query(`SELECT * FROM ${VAULT_UNLOCK_TABLE} WHERE user_id = $1`, [userId])).rows,
      (await db.query(`SELECT * FROM ${PRF_SALT_TABLE} WHERE user_id = $1`, [userId])).rows,
    ]) {
      for (const row of tableRows) {
        for (const value of Object.values(row)) {
          assert.ok(
            !(typeof value === "string" && value.includes(DECOY)),
            "no ambient env secret is folded into a stored vault row",
          );
        }
      }
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
