// E11-S04 — Saved cards store (`src/server/db/cards.ts`,
// `db/migrations/0024_cards.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./cards` throws and `freshDb()` has no `cards` table — every test here fails until the
// builder adds them. That absence IS the point of test-first; do NOT implement anything to
// make these pass — the builder writes the module and the migration afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: the metadata a save records,
// the metadata-only list read, the owner-only number-ciphertext read that round-trips the
// device blob verbatim, the owner-only remove, who may read/write/remove what, what a handler
// rejects, that every value is bound as a parameter, and — the headline card rule — that a card
// security code is never stored in any form), never the source text of the module or the SQL
// file. A later rename that preserves behaviour must not redden them.
//
// WHY this exists (task E11-S04; brief §"Identity vault" / §17 "No readable card numbers or
// security codes", design §4.2 "Device-held vault (high-tier details and cards)"). Cards are
// DEVICE-HELD, exactly like high-tier identity values (E11-S03): the card NUMBER is encrypted
// IN THE BROWSER with the device-held vault key (VK) BEFORE it leaves the device, and THE SERVER
// STORES CIPHERTEXT ONLY — it holds no vault key, never decrypts, and hands the number ciphertext
// back to the owner's own device solely so the device can decrypt it locally for a card release.
// The only PLAINTEXT a card row carries is metadata the interface shows and budgets need: brand,
// last four, expiry month/year, a nickname and a billing-address reference (design §4.1 lists
// "card brand + last four" among the plaintext metadata). The card SECURITY CODE (CVV) is NEVER
// stored in any form — there is no parameter to pass one and no column to hold one (constitution
// §17; design §4.2 "CVV / device unlock needs the person" at release time, never persisted). So
// this module takes NO `dek` and imports NO crypto — it is pure opaque-ciphertext storage plus
// plaintext metadata, exactly like the high-tier store and the wrapped-key store.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface NewCard {              // what addCard records
//     userId: string;               // the OWNER (the session's id, NEVER a client value)
//     brand: string;                // plaintext metadata, e.g. "visa" / "mastercard"
//     lastFour: string;             // plaintext metadata, the last four digits, e.g. "4242"
//     expiryMonth: number;          // plaintext metadata, 1–12
//     expiryYear: number;           // plaintext metadata, e.g. 2030
//     nickname: string;             // plaintext metadata, e.g. "Personal Visa"
//     billingAddressId: string;     // plaintext REFERENCE to one of the person's postal-address
//                                   //   identity fields; an opaque reference string, NOT a
//                                   //   foreign key (the card store enforces no referential
//                                   //   integrity to the identity store).
//     numberCiphertext: string;     // the OPAQUE device-produced ciphertext of the card NUMBER
//   }                               //   (VK-encrypted in the browser); stored verbatim, never
//                                   //   decrypted. NOTE: NO security-code / CVV field exists.
//
//   interface CardMetadata {         // what a read hands back — METADATA ONLY, NEVER the number
//     id: string;                   // the card id (generated on save)
//     userId: string;               // the owner
//     brand: string;
//     lastFour: string;
//     expiryMonth: number;
//     expiryYear: number;
//     nickname: string;
//     billingAddressId: string;
//   }                               //   (never the number / numberCiphertext, never a CVV)
//
//   addCard(db, input: NewCard): Promise<CardMetadata>
//     • generates the id up front, stores ONLY the opaque number ciphertext + the plaintext
//       metadata, and returns the card's METADATA (no ciphertext) assembled from its inputs. A
//       person may hold SEVERAL cards — each add is its own row with a distinct id.
//   listCards(db, userId): Promise<CardMetadata[]>
//     • ALL of `userId`'s cards as METADATA ONLY (id, brand, last four, expiry, nickname,
//       billing-address reference) — NEVER the number or its ciphertext. Member-scoped (WHERE
//       user_id bound); never another person's. Empty array when the person has none.
//   getCardCiphertext(db, userId, cardId): Promise<string | null>
//     • the stored number ciphertext for ONE card, returned ONLY to its owner (WHERE id AND
//       user_id both bound) so the owner's device can decrypt it locally for a release. `null`
//       when the card does not exist OR belongs to someone else — a non-owner learns nothing.
//   removeCard(db, userId, cardId): Promise<boolean>
//     • delete ONE owned card (WHERE id AND user_id both bound). `true` when a row was removed,
//       `false` when there was none for this user — so another user's remove is a no-op.
//
// Acceptance criteria → tests:
//   AC1 "Saving a card stores the number only as device ciphertext and the brand + last four as
//        plaintext metadata; no column ever holds a security code." — addCard returns metadata
//        (id, brand, last four, expiry, nickname, billing ref) and NO number; the opaque number
//        ciphertext is stored (round-trips verbatim via getCardCiphertext) while metadata reads
//        never expose it. The API accepts only `numberCiphertext` — there is no plaintext-number
//        and no security-code parameter, so neither can reach a column (shown behaviourally: a
//        CVV decoy pushed in is never written anywhere, and the cards table has no CVV column).
//   AC2 "listCards returns only id, brand, last four, expiry, nickname and billing-address
//        reference for the owner (never the number), and getCardCiphertext returns the number
//        ciphertext only to the owner." — the list carries the metadata and NO ciphertext/number
//        on any item; getCardCiphertext hands back the exact stored blob, and only to the owner.
//   AC3 "A user cannot read, add or remove another user's card (filtered by session user id)." —
//        B never sees A's cards in a list, getCardCiphertext for A's card under B returns null,
//        removeCard for A's card under B is a no-op (A's card survives); a handler takes the
//        owner from the SESSION, so a userId smuggled in the body never writes under another
//        person; the user id is bound as a param.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed / out-of-
//        range input with a 4xx before any query runs; a SQL-injection probe routed through the
//        repo travels as a BOUND value (placeholders, never concatenation) and cannot drop the
//        table. The handler below is a test fixture (the intended usage), not an implementation.
//   AC5 [obligation:secrets-from-env] (INV-103) — enforced by construction: the repo takes `db`
//        as an injected dependency, holds no key (it never encrypts — the browser does) and reads
//        no `process.env`. Shown behaviourally: the card reads/writes purely from the injected db
//        with no app env configured, and a decoy secret planted in the environment never lands in
//        the stored or returned card.
//   Migration: the `cards` relation exists after the project migrations, carries no security-code
//        column, and a second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { addCard, listCards, getCardCiphertext, removeCard } from "./cards";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { createDb, loadMigrations, runMigrations, type Db } from "./index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

// A stand-in wrapped DEK for createUser (opaque base64; this module never reads it). The DEK
// belongs to the server-side store — the DEVICE-HELD card store never touches it, since the card
// number is encrypted on the device with the vault key, not the server DEK.
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

// A device-produced number ciphertext stand-in: an OPAQUE blob the browser made by encrypting the
// real card number with the vault key. The server stores it verbatim and cannot read it. A
// distinctive, unique token so a leak-scan can recognise it if it ever escapes into a metadata
// read.
function deviceCiphertext(tag: string): string {
  return `v1:vkgcm:CARDNUM_${tag}_${"A1b2C3d4E5f6".repeat(2)}==`;
}

// A structural view of a card save input, so these helpers do not depend on the (absent) module's
// exported `NewCard` type — a later rename of the type must not redden them.
interface CardInput {
  userId: string;
  brand: string;
  lastFour: string;
  expiryMonth: number;
  expiryYear: number;
  nickname: string;
  billingAddressId: string;
  numberCiphertext: string;
}

// A valid card save input for `userId`, with any field overridden. `billingAddressId` is a fresh
// uuid: whether the builder stores the reference as `text` or `uuid`, a uuid string is accepted,
// and — since it is a reference, not a foreign key — it need not exist in any other table.
function sampleCard(userId: string, overrides: Partial<CardInput> = {}): CardInput {
  return {
    userId,
    brand: "visa",
    lastFour: "4242",
    expiryMonth: 12,
    expiryYear: 2030,
    nickname: "Personal Visa",
    billingAddressId: randomUUID(),
    numberCiphertext: deviceCiphertext("sample"),
    ...overrides,
  };
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
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the relation
// name when it exists and NULL when it does not — a non-throwing probe scoped to the one table
// under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// The lower-cased column names of a table, read from the live migrated schema (behaviour of the
// applied migrations, not the source text of the SQL file).
async function columnNames(db: Db, table: string): Promise<string[]> {
  const result = await db.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = $1",
    [table],
  );
  return result.rows.map((r) => String(r.column_name).toLowerCase());
}

// Assert no cell of the one table under test holds `needle` — scoped narrowly to `cards` (the
// same string could legitimately live elsewhere if it were a real datum, which here it is not).
async function assertNoCardsCellHolds(db: Db, needle: string): Promise<void> {
  const all = await db.query("SELECT * FROM cards");
  for (const row of all.rows) {
    for (const cell of Object.values(row)) {
      if (typeof cell === "string") {
        assert.ok(!cell.includes(needle), `no cards column may hold the forbidden value "${needle}"`);
      }
    }
  }
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

// A structural view of a returned metadata item, so the helpers below do not depend on the
// (absent) module's exported type at the point they run.
interface MetadataLike {
  readonly id: string;
  readonly userId: string;
  readonly brand: string;
  readonly lastFour: string;
  readonly expiryMonth: number;
  readonly expiryYear: number;
  readonly nickname: string;
  readonly billingAddressId: string;
}

// Find the one listed card with this exact nickname (the list order is not pinned).
function cardWithNickname(cards: MetadataLike[], nickname: string): MetadataLike | undefined {
  return cards.find((c) => c.nickname === nickname);
}

// Assert a metadata item carries ONLY the metadata and NO stored number or security code: no
// ciphertext/number under any plausible key, and no CVV key. Scoped to the one item — the number
// ciphertext legitimately exists elsewhere (via getCardCiphertext), just never in a metadata read.
// `lastFour` is legitimate metadata and is NOT one of the forbidden keys.
function assertNoNumberOrCvvOnMetadata(item: Record<string, unknown>): void {
  for (const forbidden of [
    "numberCiphertext",
    "ciphertext",
    "number",
    "cardNumber",
    "pan",
    "value",
    "cvv",
    "cvc",
    "securityCode",
  ]) {
    assert.ok(
      !(forbidden in item),
      `metadata must not carry the number or a security code (unexpected "${forbidden}" key)`,
    );
  }
}

// ===========================================================================
// AC1 — saving records metadata + stores only the opaque device number ciphertext (no number
// plaintext, no security code).
// ===========================================================================

test("addCard returns metadata (id, brand, last four, expiry, nickname, billing ref) — and no number", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const billingAddressId = randomUUID();

    const saved = await addCard(db, sampleCard(userId, {
      brand: "visa",
      lastFour: "4242",
      expiryMonth: 11,
      expiryYear: 2029,
      nickname: "Everyday card",
      billingAddressId,
      numberCiphertext: deviceCiphertext("ac1"),
    }));

    assert.equal(typeof saved.id, "string", "addCard returns an id string");
    assert.ok(saved.id.length > 0, "the returned id is non-empty");
    assert.equal(saved.userId, userId, "the card belongs to the saving person");
    assert.equal(saved.brand, "visa", "the brand is recorded as plaintext metadata");
    assert.equal(saved.lastFour, "4242", "the last four is recorded as plaintext metadata");
    assert.equal(saved.expiryMonth, 11, "the expiry month is recorded");
    assert.equal(saved.expiryYear, 2029, "the expiry year is recorded");
    assert.equal(saved.nickname, "Everyday card", "the nickname is recorded");
    assert.equal(saved.billingAddressId, billingAddressId, "the billing-address reference is recorded");

    // The save hands back METADATA ONLY — never the number or any security code.
    assertNoNumberOrCvvOnMetadata(saved as unknown as Record<string, unknown>);
  } finally {
    await db.close();
  }
});

test("addCard gives each card a distinct id (a person may hold several cards)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-ids");
    const one = await addCard(db, sampleCard(userId, { nickname: "Card one", numberCiphertext: deviceCiphertext("one") }));
    const two = await addCard(db, sampleCard(userId, { nickname: "Card two", numberCiphertext: deviceCiphertext("two") }));
    assert.notEqual(one.id, two.id, "two saved cards have different ids");
  } finally {
    await db.close();
  }
});

test("the opaque number ciphertext is stored verbatim and round-trips to its owner", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-store");
    const numberCiphertext = deviceCiphertext("verbatim");

    const saved = await addCard(db, sampleCard(userId, { numberCiphertext }));

    // The server stores what the device handed it, byte for byte, and hands the SAME bytes back
    // to the owner for local decryption — it never transforms or decrypts (it holds no key).
    const stored = await getCardCiphertext(db, userId, saved.id);
    assert.equal(stored, numberCiphertext, "the stored number ciphertext round-trips verbatim to its owner");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 (headline) — the card SECURITY CODE (CVV) is never stored in any form.
// ===========================================================================

test("the cards table has no security-code / CVV column", async () => {
  const db = await freshDb();
  try {
    const cols = await columnNames(db, "cards");
    assert.ok(cols.length > 0, "the cards table exists and has columns");
    for (const col of cols) {
      for (const forbidden of ["cvv", "cvc", "csc", "cvn", "security_code", "securitycode", "card_security"]) {
        assert.ok(
          !col.includes(forbidden),
          `no column may hold a security code (found column "${col}")`,
        );
      }
    }
  } finally {
    await db.close();
  }
});

test("a security code pushed into addCard is ignored and never written to any cards column", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-cvv");
    const CVV_DECOY = "CVV_DECOY_SHOULD_NEVER_PERSIST_0007";

    // The API has no security-code parameter. Even if a caller smuggles one onto the input object,
    // addCard reads only its named fields, so the CVV reaches no column. (A plain variable, not an
    // object literal, so it is assignable to the parameter type by structural typing.)
    const withCvv = {
      ...sampleCard(userId, { numberCiphertext: deviceCiphertext("cvv") }),
      securityCode: CVV_DECOY,
      cvv: CVV_DECOY,
    };
    const saved = await addCard(db, withCvv);

    await assertNoCardsCellHolds(db, CVV_DECOY);

    // And the card itself still saved correctly (metadata + number), so the drop was of the CVV
    // only, not a wholesale rejection.
    assert.ok(saved.id.length > 0, "the card was still saved (its metadata and number)");
    assert.equal(
      (await listCards(db, userId)).length,
      1,
      "the card is listed — only the security code was dropped",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — list returns metadata only (never the number); getCardCiphertext returns the number
// ciphertext only, to the owner.
// ===========================================================================

test("listCards returns the card metadata and never the number or its ciphertext", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-meta");
    const numberCiphertext = deviceCiphertext("LEAKCHECK_number");
    const billingAddressId = randomUUID();

    await addCard(db, sampleCard(userId, {
      brand: "mastercard",
      lastFour: "5454",
      expiryMonth: 7,
      expiryYear: 2031,
      nickname: "Travel card",
      billingAddressId,
      numberCiphertext,
    }));

    const cards = await listCards(db, userId);
    assert.equal(cards.length, 1, "the owner's one card is listed");
    const item = cards[0]!;
    assert.equal(item.brand, "mastercard", "the brand is in the metadata");
    assert.equal(item.lastFour, "5454", "the last four is in the metadata");
    assert.equal(item.expiryMonth, 7, "the expiry month is in the metadata");
    assert.equal(item.expiryYear, 2031, "the expiry year is in the metadata");
    assert.equal(item.nickname, "Travel card", "the nickname is in the metadata");
    assert.equal(item.billingAddressId, billingAddressId, "the billing-address reference is in the metadata");

    // No number/CVV on the item under any plausible key …
    assertNoNumberOrCvvOnMetadata(item as unknown as Record<string, unknown>);
    // … and the distinctive number ciphertext token appears NOWHERE in the list output. Scoped to
    // the list's own serialisation — the ciphertext is legitimately reachable via
    // getCardCiphertext, just never through a metadata read.
    assert.ok(
      !JSON.stringify(cards).includes(numberCiphertext),
      "the number ciphertext must never appear in a metadata list",
    );
    assert.ok(
      !JSON.stringify(cards).includes("LEAKCHECK_number"),
      "no fragment of the stored number leaks into the list",
    );
  } finally {
    await db.close();
  }
});

test("listCards returns every one of the owner's cards", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-list");

    await addCard(db, sampleCard(userId, { brand: "visa", lastFour: "4242", nickname: "Visa", numberCiphertext: deviceCiphertext("v") }));
    await addCard(db, sampleCard(userId, { brand: "mastercard", lastFour: "5454", nickname: "Mastercard", numberCiphertext: deviceCiphertext("m") }));
    await addCard(db, sampleCard(userId, { brand: "amex", lastFour: "0005", nickname: "Amex", numberCiphertext: deviceCiphertext("a") }));

    const cards = await listCards(db, userId);
    assert.equal(cards.length, 3, "all three of the owner's cards are listed");
    for (const card of cards) {
      assert.equal(card.userId, userId, "every listed card belongs to the owner");
      assertNoNumberOrCvvOnMetadata(card as unknown as Record<string, unknown>);
    }

    const nicknames = new Set(cards.map((c) => c.nickname));
    for (const expected of ["Visa", "Mastercard", "Amex"]) {
      assert.ok(nicknames.has(expected), `the card "${expected}" is listed`);
    }
  } finally {
    await db.close();
  }
});

test("listCards returns an empty array for a person with no cards", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-empty");
    const cards = await listCards(db, userId);
    assert.deepEqual(cards, [], "a person with no cards gets an empty list");
  } finally {
    await db.close();
  }
});

test("getCardCiphertext returns a string ciphertext for the owner, and null for a missing card", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-cipher");
    const numberCiphertext = deviceCiphertext("cipher");
    const saved = await addCard(db, sampleCard(userId, { numberCiphertext }));

    const got = await getCardCiphertext(db, userId, saved.id);
    assert.equal(typeof got, "string", "the owner gets the number ciphertext as a string");
    assert.equal(got, numberCiphertext, "it is the exact stored blob");

    const missing = await getCardCiphertext(db, userId, "00000000-0000-0000-0000-000000000000");
    assert.equal(missing, null, "a non-existent card id yields null, not a throw");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: a second signed-in person can never read, add under, or remove another's
// cards. The user id is bound from the session, never the client.
// ===========================================================================

test("listCards never returns another person's cards", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-alice");
    const bob = await makeUser(db, "owner-bob");

    await addCard(db, sampleCard(alice, { nickname: "Alice visa", numberCiphertext: deviceCiphertext("a1") }));
    await addCard(db, sampleCard(alice, { nickname: "Alice amex", numberCiphertext: deviceCiphertext("a2") }));
    await addCard(db, sampleCard(bob, { nickname: "Bob visa", numberCiphertext: deviceCiphertext("b1") }));

    const aliceCards = await listCards(db, alice);
    assert.equal(aliceCards.length, 2, "Alice sees exactly her own two cards");
    assert.ok(aliceCards.every((c) => c.userId === alice), "every card in Alice's list is hers");
    assert.ok(!aliceCards.some((c) => c.nickname === "Bob visa"), "Bob's card never appears in Alice's list");

    const bobCards = await listCards(db, bob);
    assert.equal(bobCards.length, 1, "Bob sees exactly his own card");
    assert.equal(bobCards[0]!.nickname, "Bob visa", "Bob sees his own card");
  } finally {
    await db.close();
  }
});

test("getCardCiphertext will not hand one person's number ciphertext to another", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "cipher-alice");
    const bob = await makeUser(db, "cipher-bob");
    const aliceCiphertext = deviceCiphertext("alice-card");

    const aliceCard = await addCard(db, sampleCard(alice, { numberCiphertext: aliceCiphertext }));

    // The owner gets her own ciphertext back …
    assert.equal(
      await getCardCiphertext(db, alice, aliceCard.id),
      aliceCiphertext,
      "the owner can read her own number ciphertext",
    );
    // … but Bob, asking for Alice's card id, gets nothing (filtered by the session user id).
    assert.equal(
      await getCardCiphertext(db, bob, aliceCard.id),
      null,
      "another person cannot read the owner's number ciphertext",
    );
  } finally {
    await db.close();
  }
});

test("removeCard deletes an owned card and is idempotent after removal", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "remove-owner");
    const saved = await addCard(db, sampleCard(userId, { numberCiphertext: deviceCiphertext("rm") }));

    const removed = await removeCard(db, userId, saved.id);
    assert.equal(removed, true, "removeCard reports it removed the owned card");

    assert.deepEqual(await listCards(db, userId), [], "the card is gone from the owner's list");
    assert.equal(
      await getCardCiphertext(db, userId, saved.id),
      null,
      "the removed card's ciphertext is no longer readable",
    );

    const again = await removeCard(db, userId, saved.id);
    assert.equal(again, false, "removing an already-removed card is a no-op reported as false");
  } finally {
    await db.close();
  }
});

test("removeCard will not remove another person's card", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "rm-alice");
    const bob = await makeUser(db, "rm-bob");
    const aliceCiphertext = deviceCiphertext("rm-alice");
    const aliceCard = await addCard(db, sampleCard(alice, { nickname: "Alice card", numberCiphertext: aliceCiphertext }));

    // Bob tries to remove Alice's card by id …
    const removed = await removeCard(db, bob, aliceCard.id);
    assert.equal(removed, false, "another person's remove is a no-op reported as false");

    // … and Alice's card is untouched.
    const aliceCards = await listCards(db, alice);
    assert.equal(aliceCards.length, 1, "Alice's card survives another person's remove attempt");
    assert.equal(
      await getCardCiphertext(db, alice, aliceCard.id),
      aliceCiphertext,
      "and its number ciphertext is still readable by its owner",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("addCard binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "nick'); DROP TABLE cards; --";

  // The recording db returns no rows; addCard may read back a row — either way the INSERT it
  // issued must have BOUND the probe (here the nickname), which is checked below.
  try {
    await addCard(db, sampleCard("session-user", { nickname: probe }));
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("listCards binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "l'); DROP TABLE cards; --";

  const result = await listCards(db, probe);
  assert.deepEqual(result, [], "the recording db returns no rows, so the list is empty");

  assertBoundNotSpliced(db, probe);
});

test("getCardCiphertext binds the user id and card id as parameters", async () => {
  const db = recordingDb();
  const userProbe = "g'); DROP TABLE cards; --";
  const idProbe = "id'); DROP TABLE cards; --";

  const result = await getCardCiphertext(db, userProbe, idProbe);
  assert.equal(result, null, "the recording db returns no rows, so no ciphertext is found");

  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(userProbe)), "the user id travels as a bound value");
  assert.ok(db.calls.some((c) => c.values.includes(idProbe)), "the card id travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(userProbe), "the user id is bound, never concatenated");
    assert.ok(!call.text.includes(idProbe), "the card id is bound, never concatenated");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("removeCard binds the user id and card id as parameters", async () => {
  const db = recordingDb();
  const userProbe = "r'); DROP TABLE cards; --";
  const idProbe = "rid'); DROP TABLE cards; --";

  const result = await removeCard(db, userProbe, idProbe);
  assert.equal(result, false, "the recording db removes nothing, so removeCard reports false");

  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(userProbe)), "the user id travels as a bound value");
  assert.ok(db.calls.some((c) => c.values.includes(idProbe)), "the card id travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(userProbe), "the user id is bound, never concatenated");
    assert.ok(!call.text.includes(idProbe), "the card id is bound, never concatenated");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("a SQL-injection probe in the nickname is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const probeNickname = "Grace'); DROP TABLE cards; --";
    const numberCiphertext = deviceCiphertext("inject");

    const saved = await addCard(db, sampleCard(userId, { nickname: probeNickname, numberCiphertext }));

    assert.equal(
      await tableExists(db, "cards"),
      true,
      "the cards table must still exist (the probe was stored as data, not run as SQL)",
    );

    const cards = await listCards(db, userId);
    assert.ok(cardWithNickname(cards, probeNickname), "the probe nickname round-trips verbatim as data");
    assert.equal(
      await getCardCiphertext(db, userId, saved.id),
      numberCiphertext,
      "and the number ciphertext is still readable, unaffected",
    );
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

function addCardHandler(
  db: Db,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries the plaintext metadata and the device number ciphertext; the user id comes
  // from the session, never the body, and there is NO security-code field (the CVV is never
  // stored). Lengths/ranges are bounded so an absurd body is rejected, but generous enough that a
  // device ciphertext fits and a probe can still REACH the query to prove binding.
  const schema = z.object({
    brand: z.string().min(1).max(64),
    lastFour: z.string().regex(/^\d{4}$/),
    expiryMonth: z.number().int().min(1).max(12),
    expiryYear: z.number().int().min(2000).max(2099),
    nickname: z.string().min(1).max(256),
    billingAddressId: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    numberCiphertext: z.string().min(1).max(16 * 1024),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 64 * 1024 });
      const saved = await addCard(db, {
        userId: sessionUserId,
        brand: body.brand,
        lastFour: body.lastFour,
        expiryMonth: body.expiryMonth,
        expiryYear: body.expiryYear,
        nickname: body.nickname,
        billingAddressId: body.billingAddressId,
        numberCiphertext: body.numberCiphertext,
      });
      return new Response(JSON.stringify({ id: saved.id }), { status: 201 });
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
  return new Request("https://warthog.com.au/api/cards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

// A well-formed body (the fields the handler accepts — no userId, no security code).
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    brand: "visa",
    lastFour: "4242",
    expiryMonth: 12,
    expiryYear: 2030,
    nickname: "Personal Visa",
    billingAddressId: randomUUID(),
    numberCiphertext: deviceCiphertext("handler"),
    ...overrides,
  };
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = addCardHandler(db, "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = addCardHandler(db, "session-user");

  // ~100 KiB ciphertext, well over the handler's 64 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify(validBody({ numberCiphertext: "a".repeat(100 * 1024) }))));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = addCardHandler(db, "session-user");

  // No numberCiphertext — a card must carry the device ciphertext it stores.
  const body = validBody();
  delete body.numberCiphertext;
  const res = await handler(jsonRequest(JSON.stringify(body)));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = addCardHandler(db, "session-user");

  // nickname must be a string — a number is a schema violation, rejected before any query.
  const res = await handler(jsonRequest(JSON.stringify(validBody({ nickname: 42 }))));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler rejects a last four that is not exactly four digits with a 4xx", async () => {
  const db = recordingDb();
  const handler = addCardHandler(db, "session-user");

  const res = await handler(jsonRequest(JSON.stringify(validBody({ lastFour: "42" }))));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an invalid last-four must never reach a query");
});

test("the handler rejects an out-of-range expiry month with a 4xx", async () => {
  const db = recordingDb();
  const handler = addCardHandler(db, "session-user");

  const res = await handler(jsonRequest(JSON.stringify(validBody({ expiryMonth: 13 }))));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an out-of-range expiry month must never reach a query");
});

test("the handler rejects a malformed billing-address reference with a 4xx", async () => {
  const db = recordingDb();
  const handler = addCardHandler(db, "session-user");

  const res = await handler(jsonRequest(JSON.stringify(validBody({ billingAddressId: "not-a-reference" }))));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a malformed billing reference must never reach a query");
});

test("the handler accepts a well-formed body and records the card for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const handler = addCardHandler(db, userId);
    const numberCiphertext = deviceCiphertext("handler-ok");
    const billingAddressId = randomUUID();

    const res = await handler(jsonRequest(JSON.stringify(validBody({
      brand: "mastercard",
      lastFour: "5454",
      expiryMonth: 7,
      expiryYear: 2031,
      nickname: "Work card",
      billingAddressId,
      numberCiphertext,
    }))));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };
    assert.ok(typeof id === "string" && id.length > 0, "the handler returns the stored card id");

    const cards = await listCards(db, userId);
    assert.equal(cards.length, 1, "a valid body is persisted for the session user");
    assert.equal(cards[0]!.id, id, "the stored card matches the returned id");
    assert.equal(cards[0]!.brand, "mastercard", "with the submitted brand");
    assert.equal(cards[0]!.lastFour, "5454", "and the submitted last four");
    assert.equal(cards[0]!.expiryMonth, 7, "and the submitted expiry month");
    assert.equal(cards[0]!.expiryYear, 2031, "and the submitted expiry year");
    assert.equal(cards[0]!.nickname, "Work card", "and the submitted nickname");
    assert.equal(cards[0]!.billingAddressId, billingAddressId, "and the submitted billing reference");
    assert.equal(
      await getCardCiphertext(db, userId, id),
      numberCiphertext,
      "and the submitted number ciphertext is stored for the owner",
    );
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body (no cross-user write)", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const handler = addCardHandler(db, sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(jsonRequest(JSON.stringify(validBody({ userId: attacker, nickname: "Smuggled" }))));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal(
      (await listCards(db, sessionUser)).length,
      1,
      "the card is recorded under the SESSION user",
    );
    assert.deepEqual(
      await listCards(db, attacker),
      [],
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("a security code posted to the handler is stripped and never stored", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-cvv");
    const handler = addCardHandler(db, userId);
    const CVV_DECOY = "CVV_DECOY_123_NEVER_STORED";

    // A client POSTs a CVV alongside the card. The handler's schema has no such field, so the
    // value is stripped at the boundary and never reaches the repo or a column.
    const res = await handler(jsonRequest(JSON.stringify(validBody({ securityCode: CVV_DECOY, cvv: CVV_DECOY }))));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx (extra field dropped), got ${res.status}`);
    assert.equal((await listCards(db, userId)).length, 1, "the card itself was still stored");
    await assertNoCardsCellHolds(db, CVV_DECOY);
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe nickname is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const handler = addCardHandler(db, userId);
    const probeNickname = "oren'); DROP TABLE cards; --";

    const res = await handler(jsonRequest(JSON.stringify(validBody({ nickname: probeNickname }))));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) nickname is accepted");
    assert.equal(await tableExists(db, "cards"), true, "the cards table must still exist");

    const cards = await listCards(db, userId);
    assert.ok(cardWithNickname(cards, probeNickname), "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the module reads no process.env and holds no key (INV-103), shown behaviourally with a
// decoy secret in the environment. (The module never encrypts — the browser does — so it has no
// key at all, a stronger position than the server-side store.)
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in a card", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5");
    await addCard(db, sampleCard(userId, { numberCiphertext: deviceCiphertext("ac5") }));

    const cards = await listCards(db, userId);
    assert.equal(cards.length, 1, "the card reads and writes purely from the injected db — no app env needed");
    assert.ok(
      !JSON.stringify(cards).includes(DECOY),
      "no ambient env value is folded into the returned metadata",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the same value
    // could legitimately live elsewhere if it were a real datum, which it is not).
    await assertNoCardsCellHolds(db, DECOY);
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===========================================================================
// Migration — the table applies, carries no security-code column, and a second run changes
// nothing.
// ===========================================================================

test("the cards migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "cards"),
      true,
      "the cards table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0024_cards"),
      "db/migrations/0024_cards.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw — re-executing
    // 0024's CREATE would throw "already exists", so an empty result AND no throw together prove
    // the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Review fix W6 — the name on the card. A checkout needs the cardholder name, so a card keeps
// it as plaintext metadata (it is printed on the card, not secret — the same as the expiry).
// Migration 0090 adds the column, nullable, so cards saved before it keep working (their name
// falls back to the person's saved name at release time).
// ===========================================================================

test("a card keeps its cardholder name as plaintext metadata; a card saved without one reads back null", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "w6-name");
    const named = await addCard(db, {
      ...sampleCard(userId, { nickname: "Named card", numberCiphertext: deviceCiphertext("named") }),
      cardholderName: "Oren Q Levy",
    });
    assert.equal(named.cardholderName, "Oren Q Levy", "the save hands back the cardholder name");
    const unnamed = await addCard(db, sampleCard(userId, { nickname: "Older card", numberCiphertext: deviceCiphertext("older") }));
    assert.equal(unnamed.cardholderName, null, "a card saved without a name has none");

    const cards = await listCards(db, userId);
    assert.equal(
      (cards.find((c) => c.nickname === "Named card") as unknown as { cardholderName: unknown }).cardholderName,
      "Oren Q Levy",
      "the list carries the cardholder name",
    );
    assert.equal(
      (cards.find((c) => c.nickname === "Older card") as unknown as { cardholderName: unknown }).cardholderName,
      null,
      "an unnamed card lists with a null name",
    );
    for (const item of cards) assertNoNumberOrCvvOnMetadata(item as unknown as Record<string, unknown>);
  } finally {
    await db.close();
  }
});

test("migration 0090 adds a nullable cardholder_name column without touching existing cards", async () => {
  // A bare in-memory database with no migrations yet, so the test can stop before 0090.
  const db = await createDb("pglite:memory");
  try {
    const all = await loadMigrations();
    assert.ok(all.some((m) => m.name.startsWith("0090_")), "a migration numbered 0090 is part of the project");
    const before = all.filter((m) => m.name < "0090");
    await runMigrations(db, before);

    // A card saved before the migration (no cardholder name column yet).
    const userId = await makeUser(db, "w6-migrate");
    const id = randomUUID();
    await db.query(
      `INSERT INTO cards (id, user_id, brand, last_four, expiry_month, expiry_year, nickname,
                          billing_address_id, number_ciphertext)
       VALUES ($1, $2, 'visa', '4242', 12, 2030, 'Before 0090', $3, $4)`,
      [id, userId, randomUUID(), deviceCiphertext("before")],
    );

    const applied = await runMigrations(db, all);
    assert.ok(applied.some((name) => name.startsWith("0090_")), "0090 applies over the existing schema");

    const column = await db.query(
      "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'cards' AND column_name = 'cardholder_name'",
    );
    assert.equal(column.rows.length, 1, "cards has a cardholder_name column");
    assert.equal(column.rows[0]!.data_type, "text", "the name is text");
    assert.equal(column.rows[0]!.is_nullable, "YES", "the column is nullable, so existing cards stay valid");

    const cards = await listCards(db, userId);
    assert.equal(cards.length, 1, "the existing card survives the migration");
    assert.equal(cards[0]!.nickname, "Before 0090");
    assert.equal((cards[0] as unknown as { cardholderName: unknown }).cardholderName, null, "and has no name yet");
  } finally {
    await db.close();
  }
});

