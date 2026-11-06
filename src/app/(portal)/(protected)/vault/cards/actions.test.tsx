// E11-S16 — Vault cards page loader + actions
// (`src/app/(portal)/(protected)/vault/cards/actions.ts`, mounted by the thin
// `vault/cards/page.tsx`).
//
// RED-first: the vault cards actions seam does NOT exist yet, so importing
// `./actions` throws (ERR_MODULE_NOT_FOUND) under `npm test` — every test here
// fails until the builder writes it. That absence IS the point of test-first; do
// NOT implement anything to make these pass. The builder writes `actions.ts`
// afterwards to satisfy exactly this contract and wires the thin `page.tsx` over it.
//
// These tests pin BEHAVIOUR (what the loader RETURNS and the view it mounts; what
// addCard CHANGES in the database; what each one REFUSES) against an isolated
// in-memory PGlite with the REAL migrations (src/test/db) and the REAL already-built
// seams the actions compose — the saved-cards store (`cards`, opaque device
// ciphertext only + plaintext metadata), the low-tier identity store
// (`identity-fields`, DEK-encrypted — the source of the billing addresses), the
// unlock-methods store (`vault-unlock-methods`) and the already-render-tested
// CardsView (E11-S14). No test asserts on the source text of any module, so a later
// behaviour-preserving refactor (a rename, a moved import) stays green.
//
// Where the task names an entry/page file, the testable seam lives in the plain
// SIBLING module `actions.ts` (the convention's `createXActions(deps)` factory, as
// the sibling identity `vault/actions.ts`, `connectors/actions.ts` and
// `settings/security/actions.ts` do) — NEVER on the thin `page.tsx`, which may
// export only its framework fields (`next build` rejects any other export, OBS-025).
// These tests drive that factory directly with real seams; the page mounts a thin
// loader + `"use server"` wrappers over it. A server PAGE that reads the session
// cookie + database cannot be rendered without a live request scope, so — exactly
// like the sibling identity loader test — the loader's data assembly is pinned on
// the factory's `load`, and the SCREEN it mounts is pinned by feeding `load`'s
// output straight into <CardsView/>.
//
// WHY this exists (task E11-S16; brief §"Identity vault"; constitution §17 "No
// readable card numbers or security codes"; design §4.2 device-held vault;
// CLAUDE.md — card data is encrypted in the BROWSER, the server only ever stores
// its ciphertext and NEVER a security code in any form; every member-scoped
// read/write takes userId from the session, never a client value). The cards triad
// reads the person's cards server-side and mounts the view; addCard persists a new
// card with the number arriving ONLY as device ciphertext (plus brand + last four
// and the other plaintext metadata), gated by an unlock method existing, and never
// a security code; removeCard removes one of the session person's own cards.
//
// ─── The contract this task defines (the builder implements exactly this) ───────────
//
//   createCardsActions(deps: { db: Db; keyWrapper: KeyWrapper }): {
//     // the owner's cards + billing addresses, read member-scoped by session.userId
//     // and shaped into the two props <CardsView/> is mounted over: `cards` as
//     // METADATA ONLY (brand + last four + expiry + nickname + billing ref, never the
//     // number or its ciphertext), and `billingAddresses` ({ id, value }) drawn from
//     // the person's postal-address low-tier fields (DEK-decrypted via keyWrapper).
//     load(session): Promise<{ cards; billingAddresses }>
//
//     // store a NEW card for the session user. The number arrives ONLY as the
//     // device-produced `numberCiphertext` (the server holds no vault key); the
//     // server stores it verbatim plus the plaintext metadata (brand, lastFour,
//     // expiryMonth, expiryYear, nickname, billingAddressId). A security code is NEVER
//     // persisted in any form (§17). REFUSED (via the unlock gate) when the account
//     // has no unlock method set. Owner = session.userId, never a client value.
//     addCard(session, { brand; lastFour; expiryMonth; expiryYear; nickname;
//                        billingAddressId; numberCiphertext }): Promise<Result>
//
//     // remove ONE of the session user's own cards by id. Member-scoped (another
//     // person's / a nonexistent card id is refused and nothing is removed). cardId
//     // is validated at the boundary (a malformed id is a 4xx, not a raw cast).
//     removeCard(session, { cardId }): Promise<Result>
//   }
//
//   Result = { ok: true } | { ok: false; reason: string }   // never a silent success
//
//   • every read/write is member-scoped by session.userId (the project rule + INV-102):
//     another person's card is never read, added under, or removed by id.
//   • the card number arrives ONLY as device ciphertext (the server holds no vault key),
//     NO security code is ever persisted, and a save is refused when the account has no
//     unlock method set.
//   • input is validated at the boundary (zod → a 4xx HttpError) BEFORE anything is
//     written, so malformed / oversized input writes nothing (INV-102). A malformed
//     card id is rejected as a 4xx BEFORE it can reach `WHERE id = $1` as a cast
//     (OBS-049). Every value reaches storage bound as a query parameter, so a value
//     shaped like SQL is stored as data and cannot alter a query.
//   • the module reads no process.env and holds no secret (INV-103): config flows from
//     src/server/config.ts alone, so no ambient env value lands in any output.
//
// ─── NOTE on the acceptance-criterion wording vs. this codebase ──────────────────────
// AC2 says "a card id that is not a positive INTEGER is rejected with a 4xx". That
// phrasing is generic obligation boilerplate (serial catalogue ids); in Warthog
// `cards.id` is a `uuid` (db/migrations/0024_cards.sql — gen_random_uuid()), and the
// sibling actions validate ids with `z.uuid()`. The obligation here is OBS-049 /
// validate-and-parameterize-input: a MALFORMED id is rejected at the boundary with a
// 4xx before it can reach `WHERE id = $1` as a cast. We honour the obligation using
// the ACTUAL id shape — and the malformed probes below include a bare integer, a
// negative, a decimal and the empty string, so "not a positive integer is rejected"
// holds true as a special case of "not a well-formed uuid is rejected".
//
// ─── Acceptance criteria → tests ────────────────────────────────────────────────────
//   AC1  the loader reads ONLY the session user's cards and mounts CardsView over them;
//        addCard stores only the device ciphertext + brand + last four and never a
//        security code.
//   AC2  addCard is refused (via the unlock gate) when the account has no unlock method
//        set; a card id that is not a well-formed uuid is rejected with a 4xx (not a raw
//        cast); removeCard removes the session user's own card.
//   AC3  a signed-in user cannot ADD to or REMOVE from another user's cards by id
//        (filtered by session user id).
//   AC4  a handler rejects malformed / oversized input with a 4xx, and a SQL-injection
//        probe in an input field cannot alter a query (parameter binding).  [validate-and-parameterize-input]
//   AC5  no secret value lands in a loaded/saved result; config is read from env.      [secrets-from-env]
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// test uses its own freshDb(). The signed-in person is a REAL user row (cards.user_id
// is a foreign key to users(id)) whose stored wrapped DEK really unwraps under the
// test KeyWrapper, so a postal address round-trips decrypted into a billing address.
// We render CardsView with `react-dom/server` (no DOM/jsdom — React component / E2E
// testing is a per-job ADR), exactly as the sibling view + loader tests do.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createCardsActions } from "./actions";

import { CardsView } from "@/components/vault/cards-view";
import { createUser } from "@/server/db/users";
import { saveIdentityField } from "@/server/db/identity-fields";
import {
  addCard as storeAddCard,
  listCards,
  getCardCiphertext,
  type CardMetadata,
} from "@/server/db/cards";
import { saveWrappedKey, listMethods } from "@/server/db/vault-unlock-methods";
import { HttpError } from "@/server/http/validate";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

// --- fixtures -----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // a 256-bit key-encryption key for the local AES wrapper
const NOW = new Date("2026-06-01T00:00:00.000Z");

// A real local KeyWrapper (dev/test), exactly the one a non-production composition
// root selects — so wrap/unwrap is genuine, not a stub.
function makeKeyWrapper(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose stored wrapped-DEK really unwraps (under `keyWrapper`) to the
// returned `dek`, so a postal address saved as a low-tier field round-trips decrypted
// into a billing address when the loader reads it back. Emails are uniquified so
// parallel test files never collide on users.email UNIQUE.
async function makeUserWithDek(
  db: Db,
  keyWrapper: KeyWrapper,
  who: string,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek,
  });
  return { userId: user.id, dek };
}

// A plain signed-in session for `userId` — the page resolves this from the
// `__Host-wh_session` cookie; the seam only needs its user id. Editing the vault is
// gated elsewhere (step-up on release), so stepped-up state is left null here.
function sessionFor(userId: string): Session {
  return {
    id: `sess-${userId}`,
    userId,
    createdAt: new Date(NOW.getTime() - 60_000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    steppedUpAt: null,
  };
}

// Build the cards actions under test with the real db + keyWrapper seams.
function makeActions(db: Db, keyWrapper: KeyWrapper) {
  return createCardsActions({ db, keyWrapper });
}

// Open the high-tier unlock gate for `userId` by giving the account a passphrase
// unlock method (an unambiguously valid unlock method — not "recovery", which the
// gate treats as insufficient). With a method set, saving a card is allowed.
async function seedUnlockMethod(db: Db, userId: string): Promise<void> {
  await saveWrappedKey(db, {
    userId,
    method: "passphrase",
    wrappedKey: `WRAPPED_VK_${userId}`,
  });
}

// Store a postal-address low-tier field for `userId` and return its id — the billing
// addresses the add-card picker offers are drawn from these, and `addCard` needs a
// billingAddressId that references one.
async function seedBillingAddress(
  db: Db,
  userId: string,
  dek: Uint8Array,
  value: string,
): Promise<string> {
  const field = await saveIdentityField(db, { userId, kind: "postal_address", value }, dek);
  return field.id;
}

// Seed a saved card directly through the store (no unlock gate needed) so the loader
// / ownership tests have cards to read without going through the gated action.
async function seedCard(
  db: Db,
  userId: string,
  overrides: Partial<Omit<CardMetadata, "id" | "userId">> & { numberCiphertext?: string } = {},
): Promise<CardMetadata> {
  const { numberCiphertext, ...meta } = overrides;
  return storeAddCard(db, {
    userId,
    brand: "Visa",
    lastFour: "4242",
    expiryMonth: 11,
    expiryYear: 2029,
    nickname: "Seeded card",
    billingAddressId: "addr-seed",
    numberCiphertext: numberCiphertext ?? "v1:seeded-ciphertext",
    ...meta,
  });
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields
// the relation name when it exists and NULL when it does not — a non-throwing probe
// scoped to the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Visible text with tags stripped: the words a sighted reader sees (no attributes).
function strip(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- types/casts derived from the factory (so tests don't hard-code a type NAME) ----
type Actions = ReturnType<typeof createCardsActions>;
type AddResult = Awaited<ReturnType<Actions["addCard"]>>;

// Cast a loose object (what an untrusted form body could carry) to a method's input
// type, so a test can pass a malformed value or a smuggled rogue key (a userId, a
// securityCode) without a type error — exactly what an untrusted body could carry.
const addInput = (o: Record<string, unknown>): Parameters<Actions["addCard"]>[1] =>
  o as unknown as Parameters<Actions["addCard"]>[1];
const removeInput = (o: Record<string, unknown>): Parameters<Actions["removeCard"]>[1] =>
  o as unknown as Parameters<Actions["removeCard"]>[1];

// A well-formed add-card submission (the CardSubmission the device-seal step produces),
// with a valid billing-address reference supplied by the caller.
function submission(
  billingAddressId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    brand: "Visa",
    lastFour: "4242",
    expiryMonth: 11,
    expiryYear: 2029,
    nickname: "Everyday spending",
    billingAddressId,
    numberCiphertext: "v1:CARD_CT_SENTINEL",
    ...overrides,
  };
}

// Assert that awaiting `fn()` rejects with a 4xx HttpError (the validation boundary).
async function assertRejects4xx(label: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    assert.ok(
      err instanceof HttpError,
      `${label}: must be rejected at the validation boundary (HttpError), got ${String(err)}`,
    );
    assert.ok(
      (err as HttpError).status >= 400 && (err as HttpError).status < 500,
      `${label}: the rejection must carry a 4xx status, got ${(err as HttpError).status}`,
    );
  }
  assert.ok(threw, `${label}: must be rejected (nothing was thrown)`);
}

// Assert a mutation is REJECTED — either a thrown 4xx HttpError or a reported
// { ok: false } refusal, never a silent success. (A refusal that depends on stored
// state — the unlock gate being closed, or a card that is not this person's — may
// legitimately be reported rather than thrown; this accepts both.)
async function assertRejected(
  label: string,
  fn: () => Promise<{ ok: boolean }>,
): Promise<void> {
  let result: { ok: boolean } | undefined;
  try {
    result = await fn();
  } catch (err) {
    assert.ok(
      err instanceof HttpError && err.status >= 400 && err.status < 500,
      `${label}: a thrown rejection must be a 4xx HttpError, got ${String(err)}`,
    );
    return;
  }
  assert.equal(
    result.ok,
    false,
    `${label}: the mutation must be refused (ok:false), not a silent success`,
  );
}

// =====================================================================================
// AC1 — the loader reads ONLY the session user's cards and mounts CardsView over them;
// addCard stores only the device ciphertext + brand + last four and never a security
// code.
// =====================================================================================

test("the loader returns the session user's cards + billing addresses and mounts CardsView over them", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "loader-ok");
    // A postal address (a billing option) and a NON-address low-tier field (a name,
    // which must NOT be offered as a billing address), plus a saved card whose number
    // ciphertext must never surface in the metadata the loader hands the screen.
    const POSTAL = "12 Banksia Street, Perth";
    const NAME = "Oren Quokka Levy";
    const CARD_CT = "v1:LOADER_CARD_CT_SENTINEL";
    const addrId = await seedBillingAddress(db, userId, dek, POSTAL);
    await saveIdentityField(db, { userId, kind: "name", value: NAME }, dek);
    await seedCard(db, userId, {
      brand: "Visa",
      lastFour: "4242",
      nickname: "Everyday spending",
      billingAddressId: addrId,
      numberCiphertext: CARD_CT,
    });

    const actions = makeActions(db, keyWrapper);
    const data = await actions.load(sessionFor(userId));

    // cards: the owner's card as METADATA (brand + last four + nickname), never the
    // number ciphertext.
    assert.ok(
      data.cards.some(
        (c: { brand?: string; lastFour?: string }) => c.brand === "Visa" && c.lastFour === "4242",
      ),
      `the loader returns the owner's card metadata; got ${JSON.stringify(data.cards)}`,
    );
    assert.ok(
      !JSON.stringify(data.cards).includes(CARD_CT),
      "the number ciphertext never appears in the loaded cards metadata (metadata only)",
    );

    // billingAddresses: the person's postal addresses only — the picker's choices, not
    // their name.
    assert.ok(
      data.billingAddresses.some((a: { value?: string }) => a.value === POSTAL),
      `the loader offers the person's postal address as a billing address; got ${JSON.stringify(data.billingAddresses)}`,
    );
    assert.ok(
      !data.billingAddresses.some((a: { value?: string }) => a.value === NAME),
      "a non-address low-tier field is not offered as a billing address",
    );

    // "mounts CardsView": the loader's output IS the screen's data — feeding it straight
    // into the already-render-tested view renders the owner's cards.
    const markup = renderToStaticMarkup(
      <CardsView cards={data.cards} billingAddresses={data.billingAddresses} />,
    );
    assert.ok(strip(markup).includes("Your cards"), "mounting CardsView renders the cards screen");
    assert.ok(markup.includes("Visa"), "the owner's card brand renders");
    assert.ok(markup.includes("4242"), "the owner's card last four renders");
    assert.ok(strip(markup).includes("Everyday spending"), "the owner's card nickname renders");
    assert.ok(!markup.includes(CARD_CT), "the number ciphertext is never rendered");
  } finally {
    await db.close();
  }
});

test("with an unlock method set, addCard stores ONLY the device ciphertext + metadata (the metadata read never exposes it; the ciphertext round-trips verbatim)", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "add-ok");
    await seedUnlockMethod(db, userId);
    const addrId = await seedBillingAddress(db, userId, dek, "9 Jarrah Road, Fremantle");
    const actions = makeActions(db, keyWrapper);

    // The browser produces the ciphertext; the server stores it verbatim. A unique
    // sentinel so any occurrence in a metadata read is an unambiguous leak.
    const CT = "v1:ADDCARD_CT_SENTINEL_9q7X";
    const result = await actions.addCard(
      sessionFor(userId),
      addInput(submission(addrId, { brand: "Mastercard", lastFour: "7781", nickname: "Travel backup", numberCiphertext: CT })),
    );
    assert.equal((result as { ok: boolean }).ok, true, "the card save succeeds with an unlock method set");

    // The metadata read exposes brand + last four + the other plaintext metadata only —
    // never the ciphertext.
    const cards = await listCards(db, userId);
    assert.equal(cards.length, 1, "exactly one card was stored");
    assert.equal(cards[0]!.brand, "Mastercard", "the brand is stored as plaintext metadata");
    assert.equal(cards[0]!.lastFour, "7781", "the last four is stored as plaintext metadata");
    assert.equal(cards[0]!.nickname, "Travel backup", "the nickname is stored as plaintext metadata");
    assert.ok(
      !JSON.stringify(cards).includes(CT),
      "the ciphertext never appears in the metadata read (stored as device ciphertext only)",
    );

    // …and the stored ciphertext round-trips verbatim to its owner (proving the device
    // ciphertext — and only it — was stored; the server never saw a plaintext number).
    const stored = await getCardCiphertext(db, userId, cards[0]!.id);
    assert.equal(stored, CT, "the device ciphertext is stored verbatim and returned to its owner");
  } finally {
    await db.close();
  }
});

test("addCard never persists a security code — a smuggled securityCode reaches no column", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "no-cvv");
    await seedUnlockMethod(db, userId);
    const addrId = await seedBillingAddress(db, userId, dek, "3 Wattle Way, Perth");
    const actions = makeActions(db, keyWrapper);

    // An untrusted body smuggles a security code (CVV) onto the submission. §17: the
    // server stores NO security code in any form — the field is ignored (the card still
    // saves its allowed fields), exactly as a smuggled userId is ignored elsewhere.
    const SECURITY_CODE = "SC-917-never-store";
    const CT = "v1:NO_CVV_CT_SENTINEL";
    const result = await actions.addCard(
      sessionFor(userId),
      addInput(submission(addrId, { numberCiphertext: CT, securityCode: SECURITY_CODE })),
    );
    assert.equal((result as { ok: boolean }).ok, true, "the card still saves; the smuggled security code is dropped");

    // The card was stored with its allowed fields…
    const cards = await listCards(db, userId);
    assert.equal(cards.length, 1, "exactly one card was stored");
    // …and the security code appears NOWHERE — not in the metadata read, not in the
    // stored number ciphertext (which is exactly the device ciphertext we supplied).
    assert.ok(
      !JSON.stringify(cards).includes(SECURITY_CODE),
      "the security code never appears in the stored card metadata",
    );
    assert.equal(
      await getCardCiphertext(db, userId, cards[0]!.id),
      CT,
      "the stored number ciphertext is exactly the device ciphertext — no security code was folded in",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — addCard is refused (via the unlock gate) when the account has no unlock method
// set; a malformed card id is rejected with a 4xx (OBS-049); removeCard removes the
// session user's own card.
// =====================================================================================

test("addCard is refused (via the unlock gate) when the account has no unlock method set — and nothing is stored", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "no-unlock");
    // A valid billing address, so the ONLY reason to refuse is the closed unlock gate.
    const addrId = await seedBillingAddress(db, userId, dek, "1 Gate Street, Perth");
    const actions = makeActions(db, keyWrapper);

    // Precondition: the account has no unlock method.
    assert.deepEqual(await listMethods(db, userId), [], "the account starts with no unlock method");

    await assertRejected("addCard(no unlock method)", () =>
      actions.addCard(sessionFor(userId), addInput(submission(addrId, { numberCiphertext: "v1:should-not-store" }))),
    );

    // Nothing was stored — the refusal is safe, not a silent partial write.
    assert.deepEqual(await listCards(db, userId), [], "a refused card save stores no card");
  } finally {
    await db.close();
  }
});

test("removeCard rejects a card id that is not a well-formed uuid with a 4xx before any query (OBS-049)", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "bad-id");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    // Not a well-formed uuid — including a bare integer, a negative, a decimal, the
    // empty string, whitespace and a SQL-shaped id. Each is rejected at the boundary
    // BEFORE it can reach `WHERE id = $1` as a cast (so it never surfaces as a 500, and
    // a SQL-shaped id never reaches a query). "A bare integer is rejected" subsumes the
    // criterion's "not a positive integer".
    const badIds = ["5", "-1", "1.5", "", "   ", "not-a-uuid", "x'; DROP TABLE cards; --"];
    for (const badId of badIds) {
      await assertRejects4xx(`removeCard(id=${JSON.stringify(badId)})`, () =>
        actions.removeCard(session, removeInput({ cardId: badId })),
      );
    }

    // The table is intact — no SQL-shaped id was ever executed.
    assert.equal(await tableExists(db, "cards"), true, "the cards table survives");
  } finally {
    await db.close();
  }
});

test("removeCard removes the session user's own card by id", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "remove-ok");
    const actions = makeActions(db, keyWrapper);

    const card = await seedCard(db, userId, { nickname: "Everyday spending" });
    assert.ok(
      (await listCards(db, userId)).some((c) => c.id === card.id),
      "precondition: the card exists before the remove",
    );

    const result = await actions.removeCard(sessionFor(userId), removeInput({ cardId: card.id }));
    assert.equal((result as { ok: boolean }).ok, true, "removing the owner's own card succeeds");
    assert.deepEqual(await listCards(db, userId), [], "the card is gone after removal");
  } finally {
    await db.close();
  }
});

test("removeCard refuses a well-formed but NONEXISTENT card id and removes nothing", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "remove-missing");
    const actions = makeActions(db, keyWrapper);
    const kept = await seedCard(db, userId, { nickname: "Keep me" });

    // A syntactically valid uuid that is nobody's card — there is nothing to remove.
    await assertRejected("removeCard(nonexistent card)", () =>
      actions.removeCard(sessionFor(userId), removeInput({ cardId: randomUUID() })),
    );

    // The person's real card is untouched.
    assert.ok(
      (await listCards(db, userId)).some((c) => c.id === kept.id),
      "a refused remove of a nonexistent id leaves the person's own card in place",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a signed-in user cannot ADD to or REMOVE from another user's cards by id
// (filtered by session user id).
// =====================================================================================

test("the loader reads ONLY the session user's cards — another person's cards never appear", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const alice = await makeUserWithDek(db, keyWrapper, "read-victim");
    const bob = await makeUserWithDek(db, keyWrapper, "read-other");
    const actions = makeActions(db, keyWrapper);

    await seedCard(db, alice.userId, {
      brand: "Amex",
      lastFour: "1111",
      nickname: "Alice secret card",
      numberCiphertext: "v1:alice-ct",
    });
    await seedCard(db, bob.userId, {
      brand: "Visa",
      lastFour: "2222",
      nickname: "Bob everyday",
      numberCiphertext: "v1:bob-ct",
    });

    const bobsScreen = await actions.load(sessionFor(bob.userId));

    // Bob sees only Bob.
    assert.ok(
      bobsScreen.cards.some((c: { nickname?: string }) => c.nickname === "Bob everyday"),
      "Bob sees his own card",
    );
    assert.ok(
      bobsScreen.cards.every((c: { userId?: string }) => c.userId === bob.userId),
      "every card the loader returns belongs to the session user",
    );
    const whole = JSON.stringify(bobsScreen);
    assert.ok(!whole.includes("Alice secret card"), "Alice's card nickname never appears on Bob's screen");
    assert.ok(!whole.includes("v1:alice-ct"), "Alice's card ciphertext never appears on Bob's screen");
  } finally {
    await db.close();
  }
});

test("a signed-in user cannot REMOVE another person's card by id — the other person's card survives", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const alice = await makeUserWithDek(db, keyWrapper, "remove-victim");
    const bob = await makeUserWithDek(db, keyWrapper, "remove-attacker");
    const actions = makeActions(db, keyWrapper);

    const alicesCard = await seedCard(db, alice.userId, { nickname: "Alice card" });

    // Bob, holding Alice's real card id, tries to remove it. Refused (member-scoped by
    // Bob's session id).
    await assertRejected("removeCard(bob → alice's card)", () =>
      actions.removeCard(sessionFor(bob.userId), removeInput({ cardId: alicesCard.id })),
    );

    // Alice's card is untouched.
    assert.ok(
      (await listCards(db, alice.userId)).some((c) => c.id === alicesCard.id),
      "Alice's card survives Bob's attempt to remove it by id",
    );
  } finally {
    await db.close();
  }
});

test("addCard takes the owner from the session — a userId smuggled in the input is ignored", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const bob = await makeUserWithDek(db, keyWrapper, "scope-session");
    const alice = await makeUserWithDek(db, keyWrapper, "scope-victim");
    await seedUnlockMethod(db, bob.userId); // Bob's gate is open — only ownership scoping matters
    const addrId = await seedBillingAddress(db, bob.userId, bob.dek, "7 Session Street, Perth");
    const actions = makeActions(db, keyWrapper);

    // The input tries to write the card under Alice's id.
    const result = await actions.addCard(
      sessionFor(bob.userId),
      addInput(submission(addrId, { nickname: "Smuggled card", userId: alice.userId })),
    );
    assert.equal((result as { ok: boolean }).ok, true, "the save succeeds under the session user");

    // The card landed under the SESSION user (Bob), never the smuggled victim id (Alice).
    assert.ok(
      (await listCards(db, bob.userId)).some((c) => c.nickname === "Smuggled card"),
      "the card is stored under the session user",
    );
    assert.ok(
      !(await listCards(db, alice.userId)).some((c) => c.nickname === "Smuggled card"),
      "the smuggled userId never redirected the write to another person",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — a handler rejects malformed / oversized input with a 4xx, and a SQL-injection
// probe in an input field is bound as data (parameter binding).
// [obligation:validate-and-parameterize-input]
// =====================================================================================

test("malformed input is rejected with a 4xx and nothing is persisted", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "malformed");
    await seedUnlockMethod(db, userId); // open the gate so the ONLY rejection reason is the bad shape
    const addrId = await seedBillingAddress(db, userId, dek, "4 Malformed Lane, Perth");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    // addCard: an empty body, a missing number ciphertext, and a brand that is not a
    // string — each rejected at the boundary before any write.
    await assertRejects4xx("addCard(empty body)", () => actions.addCard(session, addInput({})));
    await assertRejects4xx("addCard(missing numberCiphertext)", () => {
      const withoutCt = submission(addrId);
      delete withoutCt.numberCiphertext;
      return actions.addCard(session, addInput(withoutCt));
    });
    await assertRejects4xx("addCard(brand not a string)", () =>
      actions.addCard(session, addInput(submission(addrId, { brand: 42 }))),
    );

    // removeCard: a missing card id.
    await assertRejects4xx("removeCard(missing cardId)", () => actions.removeCard(session, removeInput({})));

    // Nothing was persisted by any rejected call.
    assert.deepEqual(await listCards(db, userId), [], "no malformed card was stored");
  } finally {
    await db.close();
  }
});

test("oversized input is rejected with a 4xx and nothing is persisted", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "oversized");
    await seedUnlockMethod(db, userId);
    const addrId = await seedBillingAddress(db, userId, dek, "6 Oversized Avenue, Perth");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    // A number ciphertext far larger than any genuine `v1:` envelope is malformed input
    // and is rejected at the boundary (INV-102) rather than reaching a column.
    const HUGE = "v1:" + "x".repeat(200_000);
    await assertRejects4xx("addCard(oversized numberCiphertext)", () =>
      actions.addCard(session, addInput(submission(addrId, { numberCiphertext: HUGE }))),
    );

    assert.deepEqual(await listCards(db, userId), [], "no oversized card was stored");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in a card field is bound as data: the table survives and the values round-trip", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "sqli");
    await seedUnlockMethod(db, userId);
    const addrId = await seedBillingAddress(db, userId, dek, "8 Injection Street, Perth");
    const actions = makeActions(db, keyWrapper);

    // If a value were concatenated into the statement text it would corrupt the query
    // (or run the trailing statement); bound as a parameter it is inert — stored as data.
    const probeNickname = "Robert'); DROP TABLE cards; --";
    const probeCt = "v1:robert'); DROP TABLE cards; --";
    const result = await actions.addCard(
      sessionFor(userId),
      addInput(submission(addrId, { nickname: probeNickname, numberCiphertext: probeCt })),
    );
    assert.equal((result as { ok: boolean }).ok, true, "SQL-shaped nickname/ciphertext are accepted and stored as data");

    assert.equal(await tableExists(db, "cards"), true, "the cards table survives the probe");
    const cards = await listCards(db, userId);
    assert.equal(cards.length, 1, "exactly one card was stored");
    assert.equal(cards[0]!.nickname, probeNickname, "the SQL-shaped nickname round-trips verbatim as data");
    assert.equal(
      await getCardCiphertext(db, userId, cards[0]!.id),
      probeCt,
      "the SQL-shaped ciphertext round-trips verbatim as data",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC5 — no secret value lands in a loaded/saved result; config is read from env.
// [obligation:secrets-from-env] — the module reads no process.env and holds no secret,
// so no ambient env value can leak into what it stores or the screen it loads.
// =====================================================================================

test("no ambient env secret leaks into any stored row or the loaded screen; the actions run from their injected seams alone", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prevDecoy = process.env.WARTHOG_DECOY_SECRET;
  const prevDbUrl = process.env.DATABASE_URL;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  // Prove the actions do not reach for an ambient database URL: point it at a decoy and
  // rely solely on the injected db seam.
  process.env.DATABASE_URL = `postgres://decoy:${DECOY}@127.0.0.1:1/decoy`;

  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "env-user");
    await seedUnlockMethod(db, userId);
    const addrId = await seedBillingAddress(db, userId, dek, "2 Env Street, Perth");
    const actions = makeActions(db, keyWrapper);

    const added = await actions.addCard(
      sessionFor(userId),
      addInput(submission(addrId, { nickname: "Env card", numberCiphertext: "v1:env-ct" })),
    );
    assert.equal((added as { ok: boolean }).ok, true, "the card save works from the injected seams with a decoy env present");

    // The decoy appears in neither the loaded screen…
    const data = await actions.load(sessionFor(userId));
    assert.ok(
      data.cards.some((c: { nickname?: string }) => c.nickname === "Env card"),
      "the loader works from its injected inputs alone",
    );
    assert.ok(!JSON.stringify(data).includes(DECOY), "no ambient env value is folded into the loaded screen");

    // …nor the stored rows.
    assert.ok(
      !JSON.stringify(await listCards(db, userId)).includes(DECOY),
      "no ambient env value is folded into the stored card metadata",
    );
  } finally {
    await db.close();
    if (prevDecoy === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prevDecoy;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
  }
});
