// E11-S12 — Vault page-data read (list-all) (`src/server/vault/page-data.ts`).
//
// RED-first: the module does not exist yet, so importing `./page-data` throws and every
// test here fails (and `tsc --noEmit` reddens on the missing module) until the builder
// writes the minimum code to pass. That absence IS the point of test-first; do NOT
// implement anything to make these pass — the builder writes `page-data.ts` afterwards.
//
// These tests pin BEHAVIOUR (what the read DOES: the four parts it assembles for the
// session person, whose data it reads, that high-tier VALUES and card NUMBERS never
// appear, what a handler rejects, that the person id reaches the db as a BOUND
// parameter), never the source text of the module — a later rename that preserves
// behaviour must not redden them.
//
// WHY this exists (task E11-S12; brief §"Identity vault"; design §4.1 low-tier +
// §4.2 device-held vault): the Vault pages need ONE owner-scoped read that sees every
// field and card regardless of tier — the low-tier values decrypted, the high-tier
// fields as metadata only (label/type, never the value), the saved cards as metadata
// only (brand + last four, never the number) and which unlock methods are set. This
// list-all read is distinct from any agent-facing filter and never returns another
// person's data. It composes the already-built stores — `identity-fields` (low tier,
// DEK-decrypted), `high-tier-fields` (metadata only), `cards` (metadata only) and
// `vault-unlock-methods` (`listMethods`) — adding no SQL and no crypto of its own.
// Like the agent-context loader it resolves the person's DEK through the injected
// `KeyWrapper` seam (from `users.wrapped_dek`) so it can decrypt the low-tier values;
// it reads no `process.env` and holds no key (INV-103). Every read is member-scoped by
// the session's `userId`, never a client value (INV-102; project rule: every
// member-scoped read takes userId from the session).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface VaultPageDataDeps {   // the injected seams — no process.env.
//     db: Db;                       // the parameterizing database seam.
//     keyWrapper: KeyWrapper;       // unwraps the person's DEK (from users.wrapped_dek)
//                                    // to decrypt the low-tier values.
//   }
//
//   interface VaultPageData {       // the owner-scoped list-all the Vault pages render.
//     lowTierFields: IdentityField[];        // the owner's low-tier fields, values
//                                             // DECRYPTED (exactly what listIdentityFields
//                                             // returns).
//     highTierFields: HighTierFieldMetadata[];// the owner's high-tier fields as METADATA
//                                             // ONLY — label + type + tier, NEVER the value
//                                             // or its ciphertext (exactly what
//                                             // listHighTierFields returns).
//     cards: CardMetadata[];                  // the owner's saved cards as METADATA ONLY —
//                                             // brand + last four (+ expiry, nickname,
//                                             // billing-address ref), NEVER the number or
//                                             // its ciphertext (exactly what listCards
//                                             // returns).
//     unlockMethods: UnlockMethod[];          // which unlock methods have a wrapped key set
//                                             // (exactly what listMethods returns) — never
//                                             // the wrapped key itself.
//   }
//
//   loadVaultPageData(deps: VaultPageDataDeps, userId: string): Promise<VaultPageData>
//     • resolves the person's DEK (users.wrapped_dek → keyWrapper.unwrap) and assembles
//       the four parts, every read member-scoped by `userId` (the session's id, NEVER a
//       client value), and returns them as one object.
//
// Acceptance criteria → tests:
//   AC1 "Returns the owner's low-tier field values (decrypted), the high-tier field
//        metadata without values, the card brand + last four, and the set of unlock
//        methods present." — the low-tier values round-trip DECRYPTED; the high-tier
//        fields come back as label+type with NO value/ciphertext; the cards come back as
//        brand+last-four with NO number/ciphertext; the unlock methods set is reported
//        with NO wrapped key.
//   AC2 "It reads data only for the session user (filtered by session user id)." — with
//        two people each holding fields, cards and methods, the read for one returns only
//        that person's data, never the other's and never the two combined.
//   AC3 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / mis-typed input with
//        a 4xx before the read runs, and takes the user id from the session, never the
//        body; a SQL-injection probe routed through the read travels as a BOUND value
//        (placeholders, never concatenation) and cannot alter a query or drop a table.
//        The handler below is a TEST FIXTURE (the intended usage), not an implementation
//        file.
//   AC4 [obligation:secrets-from-env] (INV-103) — the read runs purely from its injected
//        seams (db + keyWrapper + the session id) and reads no `process.env`, so a decoy
//        secret planted in the environment never lands in the assembled data.
//
// Database tests use `freshDb()` (an isolated in-memory PGlite with the real migrations)
// and a `recordingDb` that captures what reached the query layer; each real-db handle is
// closed in a `finally`. Tests touch no network and no Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { loadVaultPageData } from "./page-data";
import { createUser } from "../db/users";
import { saveIdentityField } from "../db/identity-fields";
import { saveHighTierField } from "../db/high-tier-fields";
import { addCard } from "../db/cards";
import { saveWrappedKey } from "../db/vault-unlock-methods";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { parseBody, HttpError } from "../http/validate";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // a 256-bit key-encryption key for the local AES wrapper

// A real local KeyWrapper (dev/test), exactly the one a non-production composition root
// selects — so wrap/unwrap is genuine, not a stub.
function makeKeyWrapper(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose stored wrapped-DEK really unwraps (under `keyWrapper`) to the
// returned `dek`, so a low-tier value encrypted under `dek` round-trips through the read.
async function makeUserWithDek(
  db: Db,
  keyWrapper: KeyWrapper,
  who: string,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (a bound value vs. spliced text). It returns no
// rows and satisfies the `Db` shape structurally (query + close).
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
// relation name when it exists and NULL when it does not — a non-throwing probe scoped to
// the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Assert the probe reached the query layer as a BOUND value and never as spliced SQL
// text, scoped to each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// A structural view of the assembled data, so the helpers/assertions do not depend on the
// (absent) module's exported types at the point they run.
interface VaultPageDataLike {
  readonly lowTierFields: Array<{ userId?: string; kind?: string; value?: string }>;
  readonly highTierFields: Array<{ userId?: string; type?: string; label?: string }>;
  readonly cards: Array<{ userId?: string; brand?: string; lastFour?: string }>;
  readonly unlockMethods: string[];
}

function restoreEnv(name: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

// ===========================================================================
// AC1 — the read assembles the four owner-scoped parts: low-tier values decrypted,
// high-tier metadata (no values), card brand + last four (no number), unlock methods set.
// ===========================================================================

test("low-tier field values come back DECRYPTED under the DEK resolved from the person's wrapped DEK", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "ac1-low");
    await saveIdentityField(db, { userId, kind: "name", value: "Oren Levy" }, dek);
    await saveIdentityField(db, { userId, kind: "email", value: "oren@warthog.com.au" }, dek);

    const data = (await loadVaultPageData({ db, keyWrapper }, userId)) as VaultPageDataLike;

    const values = new Set(data.lowTierFields.map((f) => f.value));
    assert.equal(data.lowTierFields.length, 2, "both of the owner's low-tier fields are listed");
    assert.ok(values.has("Oren Levy"), "the name value is decrypted (not ciphertext, not dropped)");
    assert.ok(values.has("oren@warthog.com.au"), "the email value is decrypted");
    for (const field of data.lowTierFields) {
      assert.equal(field.userId, userId, "every low-tier field belongs to the owner");
    }
  } finally {
    await db.close();
  }
});

test("high-tier fields come back as METADATA ONLY — label + type, never the value/ciphertext", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "ac1-high");
    // The browser produces the ciphertext; the server stores it verbatim. A unique
    // sentinel so any occurrence in the output is a genuine leak of the stored value.
    const PASSPORT_CT = "v1:HIGHTIER_CT_SENTINEL_9q7X_passport";
    const DOB_CT = "v1:HIGHTIER_CT_SENTINEL_9q7X_dob";
    await saveHighTierField(db, { userId, type: "passport", label: "AU passport", ciphertext: PASSPORT_CT });
    await saveHighTierField(db, { userId, type: "date_of_birth", label: "DOB", ciphertext: DOB_CT });

    const data = (await loadVaultPageData({ db, keyWrapper }, userId)) as VaultPageDataLike;

    assert.equal(data.highTierFields.length, 2, "both of the owner's high-tier fields are listed");
    const byLabel = new Map(data.highTierFields.map((f) => [f.label, f]));
    assert.equal(byLabel.get("AU passport")?.type, "passport", "the passport field's type is reported");
    assert.equal(byLabel.get("DOB")?.type, "date_of_birth", "the DOB field's type is reported");

    // The stored ciphertext MUST NOT be present anywhere in the high-tier portion of the
    // output — scoped to that array alone (the same bytes may legitimately persist,
    // encrypted, in storage; this read hands back metadata only).
    const highJson = JSON.stringify(data.highTierFields);
    assert.ok(!highJson.includes(PASSPORT_CT), "the passport ciphertext never appears in the metadata read");
    assert.ok(!highJson.includes(DOB_CT), "the DOB ciphertext never appears in the metadata read");
  } finally {
    await db.close();
  }
});

test("saved cards come back as brand + last four — never the number or its ciphertext", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "ac1-cards");
    const NUMBER_CT = "v1:CARD_NUMBER_CT_SENTINEL_4m2K";
    await addCard(db, {
      userId,
      brand: "visa",
      lastFour: "4242",
      expiryMonth: 11,
      expiryYear: 2029,
      nickname: "Everyday",
      billingAddressId: "addr-1",
      numberCiphertext: NUMBER_CT,
    });

    const data = (await loadVaultPageData({ db, keyWrapper }, userId)) as VaultPageDataLike;

    assert.equal(data.cards.length, 1, "the owner's one card is listed");
    assert.equal(data.cards[0]!.brand, "visa", "the card brand is reported");
    assert.equal(data.cards[0]!.lastFour, "4242", "the card's last four digits are reported");

    // The number ciphertext MUST NOT appear anywhere in the cards portion of the output —
    // scoped to that array alone.
    const cardsJson = JSON.stringify(data.cards);
    assert.ok(!cardsJson.includes(NUMBER_CT), "the card number ciphertext never appears in the cards read");
  } finally {
    await db.close();
  }
});

test("the set of unlock methods that are set is reported — never the wrapped key itself", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "ac1-methods");
    const PASSPHRASE_WRAPPED = "WRAPPED_VK_SENTINEL_passphrase_7h3L";
    const RECOVERY_WRAPPED = "WRAPPED_VK_SENTINEL_recovery_7h3L";
    await saveWrappedKey(db, { userId, method: "passphrase", wrappedKey: PASSPHRASE_WRAPPED });
    await saveWrappedKey(db, { userId, method: "recovery", wrappedKey: RECOVERY_WRAPPED });

    const data = (await loadVaultPageData({ db, keyWrapper }, userId)) as VaultPageDataLike;

    const methods = new Set(data.unlockMethods);
    assert.ok(methods.has("passphrase"), "a set passphrase unlock method is reported");
    assert.ok(methods.has("recovery"), "a set recovery unlock method is reported");
    assert.ok(!methods.has("passkey_prf"), "an unset method is not reported");

    // The opaque wrapped VK MUST NOT appear anywhere in the unlock-methods portion of the
    // output — scoped to that array alone (only which methods exist, never their keys).
    const methodsJson = JSON.stringify(data.unlockMethods);
    assert.ok(!methodsJson.includes(PASSPHRASE_WRAPPED), "the passphrase wrapped key never appears");
    assert.ok(!methodsJson.includes(RECOVERY_WRAPPED), "the recovery wrapped key never appears");
  } finally {
    await db.close();
  }
});

test("a person with nothing saved gets four empty collections, not an error", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "ac1-empty");

    const data = (await loadVaultPageData({ db, keyWrapper }, userId)) as VaultPageDataLike;

    assert.deepEqual(data.lowTierFields, [], "no low-tier fields");
    assert.deepEqual(data.highTierFields, [], "no high-tier fields");
    assert.deepEqual(data.cards, [], "no cards");
    assert.deepEqual(data.unlockMethods, [], "no unlock methods");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — member scope: the read returns ONLY the session person's data, across every part.
// ===========================================================================

test("the read returns only the session person's data, never another person's and never the two combined", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const a = await makeUserWithDek(db, keyWrapper, "owner-a");
    const b = await makeUserWithDek(db, keyWrapper, "owner-b");

    // A's data.
    await saveIdentityField(db, { userId: a.userId, kind: "name", value: "Alice A" }, a.dek);
    await saveHighTierField(db, { userId: a.userId, type: "passport", label: "A passport", ciphertext: "v1:a-ct" });
    await addCard(db, {
      userId: a.userId, brand: "visa", lastFour: "1111", expiryMonth: 1, expiryYear: 2030,
      nickname: "A card", billingAddressId: "a-addr", numberCiphertext: "v1:a-num",
    });
    await saveWrappedKey(db, { userId: a.userId, method: "passphrase", wrappedKey: "a-wrapped" });

    // B's data — DIFFERENT values, encrypted under B's own DEK.
    await saveIdentityField(db, { userId: b.userId, kind: "name", value: "Bob B" }, b.dek);
    await saveHighTierField(db, { userId: b.userId, type: "driver_licence", label: "B licence", ciphertext: "v1:b-ct" });
    await addCard(db, {
      userId: b.userId, brand: "mastercard", lastFour: "9999", expiryMonth: 2, expiryYear: 2031,
      nickname: "B card", billingAddressId: "b-addr", numberCiphertext: "v1:b-num",
    });
    await saveWrappedKey(db, { userId: b.userId, method: "recovery", wrappedKey: "b-wrapped" });

    const data = (await loadVaultPageData({ db, keyWrapper }, a.userId)) as VaultPageDataLike;

    // Only A's data, across every part.
    assert.equal(data.lowTierFields.length, 1, "only A's one low-tier field");
    assert.equal(data.lowTierFields[0]!.value, "Alice A", "A's value, decrypted");
    assert.equal(data.highTierFields.length, 1, "only A's one high-tier field");
    assert.equal(data.highTierFields[0]!.label, "A passport", "A's high-tier label");
    assert.equal(data.cards.length, 1, "only A's one card");
    assert.equal(data.cards[0]!.lastFour, "1111", "A's card");
    assert.deepEqual(data.unlockMethods, ["passphrase"], "only A's unlock method");

    // None of B's data leaked in.
    const whole = JSON.stringify(data);
    assert.ok(!whole.includes("Bob B"), "B's name never appears");
    assert.ok(!whole.includes("B licence"), "B's high-tier label never appears");
    assert.ok(!whole.includes("9999"), "B's card never appears");
    assert.ok(!data.unlockMethods.includes("recovery"), "B's unlock method never appears");

    // And every owned row names the session person.
    for (const f of data.lowTierFields) assert.equal(f.userId, a.userId, "A owns the low-tier field");
    for (const f of data.highTierFields) assert.equal(f.userId, a.userId, "A owns the high-tier field");
    for (const c of data.cards) assert.equal(c.userId, a.userId, "A owns the card");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 [validate-and-parameterize-input] — a handler on the validation boundary rejects
// bad input and takes the user id from the SESSION; the read binds the id as a parameter.
//
// The handler is a TEST FIXTURE (the intended usage) — not an implementation file.
// ===========================================================================

function vaultPageHandler(
  deps: { db: Db; keyWrapper: KeyWrapper },
  sessionUserId: string,
): (req: Request) => Promise<{ status: number; reached: boolean; data: VaultPageDataLike | null }> {
  // The list-all read takes no client filter, so the handler only validates the request
  // envelope: a well-formed JSON object within a size cap. An id smuggled in the body is
  // stripped and ignored — the owner is the SESSION's id, passed from the closure.
  const schema = z.object({});
  return async (req: Request) => {
    let reached = false;
    try {
      await parseBody(schema, req, { maxBytes: 4 * 1024 });
      reached = true;
      const data = (await loadVaultPageData(deps, sessionUserId)) as VaultPageDataLike;
      return { status: 200, reached, data };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, reached, data: null };
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test
      // sees the raw failure rather than a masked success.
      return { status: 500, reached, data: null };
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/vault", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("[validate-and-parameterize-input] the handler rejects malformed JSON with a 4xx before the read runs", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "vp-malformed");
    const handler = vaultPageHandler({ db, keyWrapper }, userId);
    const res = await handler(jsonRequest("{ not valid json"));
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.equal(res.reached, false, "malformed input never reaches the read");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] the handler rejects an oversized body with a 4xx before the read runs", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "vp-oversized");
    const handler = vaultPageHandler({ db, keyWrapper }, userId);
    // ~8 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
    const res = await handler(jsonRequest(JSON.stringify({ junk: "a".repeat(8 * 1024) })));
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.equal(res.reached, false, "an oversized body never reaches the read");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] the handler rejects a mis-typed body (not an object) with a 4xx", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "vp-mistyped");
    const handler = vaultPageHandler({ db, keyWrapper }, userId);
    // A bare number is not the expected object shape — a schema violation, rejected before
    // the read.
    const res = await handler(jsonRequest(JSON.stringify(42)));
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.equal(res.reached, false, "a mis-typed body never reaches the read");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] a well-formed request reaches the read and returns the session person's data", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "vp-ok");
    await saveIdentityField(db, { userId, kind: "name", value: "Session Owner" }, dek);
    const handler = vaultPageHandler({ db, keyWrapper }, userId);

    const res = await handler(jsonRequest(JSON.stringify({})));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    assert.equal(res.reached, true, "a valid body reaches the read");
    assert.equal(res.data!.lowTierFields[0]!.value, "Session Owner", "the session person's data is returned");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] the handler takes the owner from the session — a userId smuggled in the body is ignored", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const session = await makeUserWithDek(db, keyWrapper, "vp-session");
    const attacker = await makeUserWithDek(db, keyWrapper, "vp-attacker");
    await saveIdentityField(db, { userId: session.userId, kind: "name", value: "The Session User" }, session.dek);
    await saveIdentityField(db, { userId: attacker.userId, kind: "name", value: "The Other User" }, attacker.dek);

    const handler = vaultPageHandler({ db, keyWrapper }, session.userId);

    // The body tries to redirect the read at another person. The handler validates the
    // envelope, strips the unknown key, and reads for the SESSION's id regardless.
    const res = await handler(jsonRequest(JSON.stringify({ userId: attacker.userId })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    assert.equal(res.data!.lowTierFields.length, 1, "exactly the session user's fields");
    assert.equal(res.data!.lowTierFields[0]!.value, "The Session User", "the session user's data, not the body's");
    assert.ok(!JSON.stringify(res.data).includes("The Other User"), "the body-supplied user's data never appears");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] the person id reaches the db as a BOUND value, never spliced into the SQL", async () => {
  const db = recordingDb();
  const probe = "p'); DROP TABLE cards; --";
  // The recording db returns no rows, so the read short-circuits (no user ⇒ it reports the
  // failure) — but the member-scoped query it DID issue must have bound the probe.
  try {
    await loadVaultPageData({ db, keyWrapper: makeKeyWrapper() }, probe);
  } catch {
    /* no user row ⇒ the read reports a failure; we are asserting on HOW it queried */
  }
  assertBoundNotSpliced(db, probe);
});

test("[validate-and-parameterize-input] a SQL-injection person id cannot alter a query, drop a table, or leak another person's data", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    // A real owner with a full vault; the probe must neither reach nor harm it.
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "probe-owner");
    await saveIdentityField(db, { userId, kind: "name", value: "Real Owner" }, dek);
    await saveHighTierField(db, { userId, type: "passport", label: "Real passport", ciphertext: "v1:real-ct" });
    await addCard(db, {
      userId, brand: "visa", lastFour: "4242", expiryMonth: 11, expiryYear: 2029,
      nickname: "Real", billingAddressId: "real-addr", numberCiphertext: "v1:real-num",
    });
    await saveWrappedKey(db, { userId, method: "passphrase", wrappedKey: "real-wrapped" });

    const probe = "p'); DROP TABLE cards; --";
    // Bound as a parameter, the probe is at worst a value the uuid-typed id column rejects
    // (OBS-049: an id-typed selector); it is NEVER executed as SQL. Either outcome — the DB
    // rejects it, or it simply matches nothing — proves the injection did not run.
    let rejectedOrEmpty = false;
    try {
      const data = (await loadVaultPageData({ db, keyWrapper }, probe)) as VaultPageDataLike;
      rejectedOrEmpty =
        data.lowTierFields.length === 0 &&
        data.highTierFields.length === 0 &&
        data.cards.length === 0 &&
        data.unlockMethods.length === 0;
    } catch {
      rejectedOrEmpty = true;
    }
    assert.ok(rejectedOrEmpty, "the probe is bound, not executed — it yields nothing or is rejected");

    // The decisive proof: every table and the real owner's whole vault are intact.
    for (const table of ["cards", "high_tier_fields", "identity_fields", "vault_unlock_methods", "users"]) {
      assert.equal(await tableExists(db, table), true, `the ${table} table is intact`);
    }
    const owned = (await loadVaultPageData({ db, keyWrapper }, userId)) as VaultPageDataLike;
    assert.equal(owned.lowTierFields[0]!.value, "Real Owner", "the real owner's low-tier value survived");
    assert.equal(owned.highTierFields.length, 1, "the real owner's high-tier field survived");
    assert.equal(owned.cards[0]!.lastFour, "4242", "the real owner's card survived");
    assert.deepEqual(owned.unlockMethods, ["passphrase"], "the real owner's unlock method survived");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 [secrets-from-env] — the read uses injected deps only; no ambient env value lands
// in the assembled data, and it runs with no app env configured.
// ===========================================================================

test("[secrets-from-env] no ambient env secret appears in the assembled data; the read runs from its injected seams alone", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prevDecoy = process.env.WARTHOG_DECOY_SECRET;
  const prevDbUrl = process.env.DATABASE_URL;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  // Prove the read does not reach for an ambient database URL: point it at a decoy and rely
  // solely on the injected db seam.
  process.env.DATABASE_URL = `postgres://decoy:${DECOY}@127.0.0.1:1/decoy`;

  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "env-user");
    await saveIdentityField(db, { userId, kind: "name", value: "Env User" }, dek);
    await saveHighTierField(db, { userId, type: "passport", label: "Env passport", ciphertext: "v1:env-ct" });
    await addCard(db, {
      userId, brand: "visa", lastFour: "4242", expiryMonth: 11, expiryYear: 2029,
      nickname: "Env", billingAddressId: "env-addr", numberCiphertext: "v1:env-num",
    });
    await saveWrappedKey(db, { userId, method: "passphrase", wrappedKey: "env-wrapped" });

    const data = (await loadVaultPageData({ db, keyWrapper }, userId)) as VaultPageDataLike;

    // The read worked purely from the injected db + keyWrapper + session id.
    assert.equal(data.lowTierFields[0]!.value, "Env User", "the read works from its injected inputs alone");
    assert.equal(data.cards.length, 1, "the injected db supplied the card, not an ambient one");
    assert.ok(!JSON.stringify(data).includes(DECOY), "no ambient env secret appears in the assembled data");
  } finally {
    await db.close();
    restoreEnv("WARTHOG_DECOY_SECRET", prevDecoy);
    restoreEnv("DATABASE_URL", prevDbUrl);
  }
});
