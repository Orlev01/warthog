// E16-S06 — device-protected import re-protection (`src/client/vault/import.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// here fails until the implementation lands. These pin BEHAVIOUR (what the module
// DOES with a plaintext deviceProtected section, the importing account's vault key,
// an unreadable value, an absent key, and the network/storage/console), never the
// source text of the module.
//
// Brief "Export and portability" / "Import"; design: data portability. An export's
// `deviceProtected` section carries the person's high-tier identity values and card
// numbers DECRYPTED — plaintext that exists on the device only during import. The
// server import service (`src/server/import/import.ts`) deliberately NEVER touches
// this section, because Warthog's servers must store nothing they can decrypt
// (constitution 17, 19; design §4.2). This module is the browser step that closes
// that gap: given the plaintext `deviceProtected` section and the IMPORTING
// account's unlocked vault key, it RE-ENCRYPTS each high-tier value and card number
// (AES-256-GCM, via the production `encryptValue` seam) so the server only ever
// receives ciphertext. It is the inverse of `src/client/vault/export.ts`.
//
// ── The contract these tests define (the tester fixes the seam the builder fills) ──
//
//   reprotectDeviceProtected(vaultKey, section) -> Promise<ReprotectResult>
//
//     vaultKey: the importing account's unlocked vault key as raw 256-bit bytes (as
//               unlockVault yields), OR null/undefined when the vault is not unlocked.
//     section:  the export's plaintext deviceProtected section (the E16-S01 schema
//               shape, `src/server/export/schema.ts`) —
//               { highTierFields: Array<{ type, label, value }>,   // value = plaintext
//                 cards:          Array<{ brand, lastFour, nickname, number }> } // number = plaintext
//
//     On success it RESOLVES with:
//       { sealed: { highTierFields: Array<{ type, label, ciphertext }>,        // UPLOAD shape
//                   cards:          Array<{ brand, lastFour, nickname, numberCiphertext }> },
//         failed: Array<{ kind: "highTierField" | "card", label: string }> }
//     — `sealed` is the ciphertext-only payload for upload: each readable value
//       re-encrypted under the IMPORTING vault key (via `encryptValue`), its plaintext
//       metadata (type/label, brand/lastFour/nickname) carried through unchanged, in the
//       same order. The server's own upload shapes are exactly these records (high-tier
//       `{ type, label, ciphertext }`, cards `{ brand, lastFour, nickname, numberCiphertext }`).
//
//     A value that CANNOT be read from the export (its `value`/`number` absent, null, or
//     not a string) is NOT re-encrypted and NOT included in `sealed`: it is reported in
//     `failed` and SKIPPED. One unreadable value never aborts the others, and its raw form
//     is NEVER posted as plaintext. (This differs from export, which rejects the whole
//     build: an import re-protects what it can and reports the rest.)
//
//     An ABSENT vault key (null/undefined) is a precondition failure — the vault must be
//     unlocked to re-protect anything — so it REJECTS and produces NO ciphertext, never a
//     plaintext fallback (mirrors the export seam's "the vault must be unlocked").
//
//     It NEVER includes a plaintext high-tier value or card number in `sealed` (what is
//     sent to the server), and leaks none to the network, client storage, or the console.
//
// These are pure client unit tests. Entropy comes from node:crypto; the produced
// ciphertext is verified with the real `decryptValue` seam (the production read path),
// so the module must emit genuine `v1:` AES-256-GCM envelopes under the importing key.
// The module reaches the WebCrypto globals (`crypto.subtle`) exactly like its siblings;
// no network, no DOM, no database, no Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import { reprotectDeviceProtected } from "./import";
import { decryptValue } from "./values";

const KEY_BYTES = 32; // the vault key is a 256-bit = 32-byte AES key
const VERSION_PREFIX = "v1:"; // the repo's versioned-envelope convention (values.ts)

// A fresh random 256-bit vault key, as raw bytes — stands in for the bytes the
// browser unlock recovers for the IMPORTING account.
function freshVaultKey(): Uint8Array<ArrayBuffer> {
  return webcrypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

// Robust across sync-throw and async-reject implementations AND against a
// non-throwing return: assert.rejects fails if the call RESOLVES, which is exactly
// the "reports failure and produces NO ciphertext" guarantee for an absent key.
async function assertReprotectRejects(
  vaultKey: unknown,
  section: unknown,
  message: string,
): Promise<void> {
  await assert.rejects(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await reprotectDeviceProtected(vaultKey as any, section as any);
  }, message);
}

// --- Representative plaintexts ---------------------------------------------
//
// Distinctive, non-substring markers so the no-leak checks are meaningful (a
// correct ciphertext/output can never coincidentally contain them), and a card
// number WITH spaces to prove byte-for-byte pass-through.
const PASSPORT_VALUE = "PA1234567DONOTLEAKmarker7f3a9c2bQ8";
const DOB_VALUE = "1988-02-29-DOB-DONOTLEAK-9e0f1122";
const CARD_NUMBER = "4111 1111 1111 1111";
const CARD_NUMBER_2 = "5555444433332222CARDLEAKCHECK";

interface PlainHighTier {
  type: string;
  label: string;
  value: string;
}
interface PlainCard {
  brand: string;
  lastFour: string;
  nickname: string;
  number: string;
}

const PASSPORT: PlainHighTier = { type: "passport", label: "Passport", value: PASSPORT_VALUE };
const DOB: PlainHighTier = { type: "date_of_birth", label: "Date of birth", value: DOB_VALUE };
const CARD_EVERYDAY: PlainCard = {
  brand: "visa",
  lastFour: "1111",
  nickname: "Everyday",
  number: CARD_NUMBER,
};
const CARD_TRAVEL: PlainCard = {
  brand: "mastercard",
  lastFour: "2222",
  nickname: "Travel",
  number: CARD_NUMBER_2,
};

// The plaintext deviceProtected section an export carries (the E16-S01 shape).
function section(
  highTierFields: PlainHighTier[],
  cards: PlainCard[],
): { highTierFields: PlainHighTier[]; cards: PlainCard[] } {
  return { highTierFields, cards };
}

// ---------------------------------------------------------------------------
// AC1: given a deviceProtected section and the importing account's unlocked vault
// key, each value is re-encrypted (AES-256-GCM) and only ciphertext is produced
// for upload.
// ---------------------------------------------------------------------------

test("re-encrypts a high-tier value under the importing key, carrying type and label through", async () => {
  const importingKey = freshVaultKey();

  const result = await reprotectDeviceProtected(importingKey, section([PASSPORT], []));

  assert.equal(result.sealed.highTierFields.length, 1, "one high-tier field in, one sealed out");
  const field = result.sealed.highTierFields[0]!;
  assert.equal(field.type, "passport", "the plaintext type metadata is carried through");
  assert.equal(field.label, "Passport", "the plaintext label metadata is carried through");
  assert.ok(
    field.ciphertext.startsWith(VERSION_PREFIX),
    "the value is produced as a versioned ciphertext envelope, not plaintext",
  );
  assert.notEqual(field.ciphertext, PASSPORT_VALUE, "what is produced is ciphertext, not the plaintext");
  // The re-encryption is AES-256-GCM under the IMPORTING key: it decrypts back to the
  // original plaintext with that key (the real read path), byte-for-byte.
  const recovered = await decryptValue(importingKey, field.ciphertext);
  assert.equal(recovered, PASSPORT_VALUE, "the sealed value decrypts back to its plaintext under the importing key");

  assert.deepEqual(result.sealed.cards, [], "no cards in → an empty cards array");
  assert.deepEqual(result.failed, [], "every value re-protected → nothing reported as failed");
});

test("re-encrypts a card number under the importing key, carrying brand/lastFour/nickname and spaces intact", async () => {
  const importingKey = freshVaultKey();

  const result = await reprotectDeviceProtected(importingKey, section([], [CARD_EVERYDAY]));

  assert.equal(result.sealed.cards.length, 1, "one card in, one sealed out");
  const card = result.sealed.cards[0]!;
  assert.equal(card.brand, "visa", "the plaintext brand metadata is carried through");
  assert.equal(card.lastFour, "1111", "the plaintext last-four metadata is carried through");
  assert.equal(card.nickname, "Everyday", "the plaintext nickname metadata is carried through");
  assert.ok(
    card.numberCiphertext.startsWith(VERSION_PREFIX),
    "the card number is produced as a versioned ciphertext envelope, not plaintext",
  );
  assert.notEqual(card.numberCiphertext, CARD_NUMBER, "what is produced is ciphertext, not the plaintext number");
  const recovered = await decryptValue(importingKey, card.numberCiphertext);
  assert.equal(recovered, CARD_NUMBER, "the sealed number decrypts back byte-for-byte, spaces and all");

  assert.deepEqual(result.sealed.highTierFields, [], "no high-tier fields in → an empty array");
  assert.deepEqual(result.failed, [], "every value re-protected → nothing reported as failed");
});

test("re-protects every field and card, in the order given, each decrypting back under the importing key", async () => {
  const importingKey = freshVaultKey();

  const result = await reprotectDeviceProtected(
    importingKey,
    section([PASSPORT, DOB], [CARD_EVERYDAY, CARD_TRAVEL]),
  );

  assert.deepEqual(
    result.sealed.highTierFields.map((f) => [f.type, f.label]),
    [
      ["passport", "Passport"],
      ["date_of_birth", "Date of birth"],
    ],
    "every high-tier field is sealed, with metadata and order preserved",
  );
  assert.deepEqual(
    result.sealed.cards.map((c) => [c.brand, c.lastFour, c.nickname]),
    [
      ["visa", "1111", "Everyday"],
      ["mastercard", "2222", "Travel"],
    ],
    "every card is sealed, with metadata and order preserved",
  );

  // Each sealed envelope decrypts back to the right plaintext under the importing key.
  const fieldPlain = await Promise.all(
    result.sealed.highTierFields.map((f) => decryptValue(importingKey, f.ciphertext)),
  );
  assert.deepEqual(fieldPlain, [PASSPORT_VALUE, DOB_VALUE], "high-tier ciphertexts decrypt back in order");
  const cardPlain = await Promise.all(
    result.sealed.cards.map((c) => decryptValue(importingKey, c.numberCiphertext)),
  );
  assert.deepEqual(cardPlain, [CARD_NUMBER, CARD_NUMBER_2], "card ciphertexts decrypt back in order");

  assert.deepEqual(result.failed, [], "every value re-protected → nothing reported as failed");
});

test("uses a fresh nonce per value — the same plaintext seals to DIFFERENT ciphertext each time (AES-256-GCM)", async () => {
  const importingKey = freshVaultKey();
  // Two high-tier fields carrying the SAME value; AES-GCM with a fresh random nonce
  // per call must produce two distinct envelopes, both decrypting to that value.
  const twin: PlainHighTier = { type: "note", label: "Note", value: PASSPORT_VALUE };

  const result = await reprotectDeviceProtected(importingKey, section([twin, { ...twin }], []));

  const a = result.sealed.highTierFields[0]!.ciphertext;
  const b = result.sealed.highTierFields[1]!.ciphertext;
  assert.notEqual(a, b, "the same plaintext must not seal to an identical envelope (fresh per-value nonce)");
  assert.equal(await decryptValue(importingKey, a), PASSPORT_VALUE, "the first envelope still decrypts to the value");
  assert.equal(await decryptValue(importingKey, b), PASSPORT_VALUE, "the second envelope still decrypts to the value");
});

test("seals under the IMPORTING key specifically — a different account's key cannot decrypt it", async () => {
  const importingKey = freshVaultKey();
  const otherAccountKey = freshVaultKey();

  const result = await reprotectDeviceProtected(importingKey, section([PASSPORT], [CARD_EVERYDAY]));

  // Re-sealed under the importing account's key only: the exporting (or any other)
  // account's key fails the GCM tag and cannot recover the value.
  await assert.rejects(
    () => decryptValue(otherAccountKey, result.sealed.highTierFields[0]!.ciphertext),
    "a value sealed under the importing key must not decrypt under a different account's key",
  );
  await assert.rejects(
    () => decryptValue(otherAccountKey, result.sealed.cards[0]!.numberCiphertext),
    "a card sealed under the importing key must not decrypt under a different account's key",
  );
});

test("an empty deviceProtected section yields an empty sealed payload and no failures", async () => {
  const importingKey = freshVaultKey();

  const result = await reprotectDeviceProtected(importingKey, section([], []));

  assert.deepEqual(result.sealed.highTierFields, [], "no high-tier fields → an empty array, not undefined");
  assert.deepEqual(result.sealed.cards, [], "no cards → an empty array, not undefined");
  assert.deepEqual(result.failed, [], "nothing to re-protect → nothing failed");
});

// ---------------------------------------------------------------------------
// AC2: a value that cannot be read from the export is reported as failed and
// skipped, never uploaded as plaintext. (Per-value: one bad value never aborts
// the others, and the whole section is never rejected for it.)
// ---------------------------------------------------------------------------

test("a high-tier field with no value is reported as failed and skipped, not sealed", async () => {
  const importingKey = freshVaultKey();
  // `value` absent entirely — nothing to re-encrypt. A naive encrypt of an absent
  // value would seal a bogus string; the module must instead report + skip it.
  const bad = { type: "medicare", label: "Medicare" }; // no `value`

  const result = await reprotectDeviceProtected(
    importingKey,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { highTierFields: [PASSPORT, bad], cards: [] } as any,
  );

  // The readable one is sealed and decrypts back; the unreadable one is skipped.
  assert.equal(result.sealed.highTierFields.length, 1, "only the readable field is sealed");
  assert.equal(result.sealed.highTierFields[0]!.label, "Passport", "the readable field survived");
  assert.equal(
    await decryptValue(importingKey, result.sealed.highTierFields[0]!.ciphertext),
    PASSPORT_VALUE,
    "the readable field re-protected correctly despite its unreadable neighbour",
  );

  // The unreadable one is reported as failed, identifying which field it was.
  assert.equal(result.failed.length, 1, "the unreadable field is reported exactly once");
  assert.equal(result.failed[0]!.kind, "highTierField", "the failure is tagged as a high-tier field");
  assert.equal(result.failed[0]!.label, "Medicare", "the failure identifies the field by its label");
});

test("a card with no number is reported as failed and skipped, not sealed", async () => {
  const importingKey = freshVaultKey();
  const bad = { brand: "amex", lastFour: "0005", nickname: "Broken" }; // no `number`

  const result = await reprotectDeviceProtected(
    importingKey,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { highTierFields: [], cards: [CARD_EVERYDAY, bad] } as any,
  );

  assert.equal(result.sealed.cards.length, 1, "only the readable card is sealed");
  assert.equal(result.sealed.cards[0]!.nickname, "Everyday", "the readable card survived");
  assert.equal(
    await decryptValue(importingKey, result.sealed.cards[0]!.numberCiphertext),
    CARD_NUMBER,
    "the readable card re-protected correctly despite its unreadable neighbour",
  );

  assert.equal(result.failed.length, 1, "the unreadable card is reported exactly once");
  assert.equal(result.failed[0]!.kind, "card", "the failure is tagged as a card");
  assert.equal(typeof result.failed[0]!.label, "string", "the failure carries a human label for the card");
});

test("a non-string / null value is treated as unreadable — reported and skipped, never sealed as a bogus value", async () => {
  const importingKey = freshVaultKey();
  // A null value and a numeric (non-string) value: both are "cannot be read". A
  // naive `encryptValue(key, value)` would coerce these to the strings "null"/"123"
  // and seal them — the module must instead report + skip them.
  const nullValue = { type: "passport", label: "Passport-null", value: null };
  const numberValue = { type: "tfn", label: "TFN-number", value: 123 };

  const result = await reprotectDeviceProtected(
    importingKey,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { highTierFields: [nullValue, numberValue], cards: [] } as any,
  );

  assert.deepEqual(result.sealed.highTierFields, [], "no readable string value → nothing sealed");
  assert.equal(result.failed.length, 2, "both unreadable values are reported");
  assert.deepEqual(
    result.failed.map((f) => f.kind),
    ["highTierField", "highTierField"],
    "both failures are tagged as high-tier fields",
  );
});

test("failures and successes mix across both sections without aborting the readable ones", async () => {
  const importingKey = freshVaultKey();
  const badField = { type: "medicare", label: "Medicare" }; // no value
  const badCard = { brand: "amex", lastFour: "0005", nickname: "Broken" }; // no number

  const result = await reprotectDeviceProtected(
    importingKey,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { highTierFields: [PASSPORT, badField, DOB], cards: [badCard, CARD_EVERYDAY] } as any,
  );

  // Both readable high-tier fields survive, in order; the bad one is dropped.
  assert.deepEqual(
    result.sealed.highTierFields.map((f) => f.label),
    ["Passport", "Date of birth"],
    "readable high-tier fields are sealed in order; the unreadable one is skipped",
  );
  assert.deepEqual(
    result.sealed.cards.map((c) => c.nickname),
    ["Everyday"],
    "the readable card is sealed; the unreadable one is skipped",
  );
  // Two failures reported (one per section), never a whole-section abort.
  assert.equal(result.failed.length, 2, "exactly the two unreadable values are reported");
  assert.deepEqual(
    result.failed.map((f) => f.kind).sort(),
    ["card", "highTierField"],
    "one high-tier and one card failure are reported",
  );
});

// ---------------------------------------------------------------------------
// Absent vault key: a precondition failure. With no unlocked key nothing can be
// re-protected, and the module must NEVER fall back to a plaintext upload — so it
// rejects and produces no ciphertext.
// ---------------------------------------------------------------------------

test("rejects when the importing vault key is absent — produces no ciphertext, never plaintext", async () => {
  const theSection = section([PASSPORT], [CARD_EVERYDAY]);
  for (const absent of [null, undefined]) {
    await assertReprotectRejects(
      absent,
      theSection,
      `an absent vault key (${String(absent)}) must reject, never re-protect or fall back to plaintext`,
    );
  }
});

// ---------------------------------------------------------------------------
// AC3: no plaintext high-tier value or card number is included in what is sent to
// the server (the `sealed` payload), nor leaked to the network, storage or console.
// ---------------------------------------------------------------------------

test("the sealed upload payload contains no plaintext high-tier value or card number", async () => {
  const importingKey = freshVaultKey();

  const result = await reprotectDeviceProtected(
    importingKey,
    section([PASSPORT, DOB], [CARD_EVERYDAY, CARD_TRAVEL]),
  );

  // Scope the absence check to exactly what gets posted to the server: the sealed
  // payload. (The plaintext legitimately exists in the caller's input section and in
  // the decrypted round-trips above — only the upload payload must be ciphertext-only.)
  const uploadText = JSON.stringify(result.sealed);
  for (const secret of [PASSPORT_VALUE, DOB_VALUE, CARD_NUMBER, CARD_NUMBER_2]) {
    assert.ok(
      !uploadText.includes(secret),
      `a plaintext value/number must never appear in the sealed upload payload; saw: ${secret}`,
    );
  }
  // Sanity: the payload really is the re-protected values (ciphertext that decrypts back),
  // so the absence above is "re-encrypted", not "dropped everything".
  assert.equal(result.sealed.highTierFields.length, 2);
  assert.equal(result.sealed.cards.length, 2);
  assert.equal(await decryptValue(importingKey, result.sealed.highTierFields[0]!.ciphertext), PASSPORT_VALUE);
});

// --- side-channel capture: no plaintext to network / storage / console ----------

function recordingStorage(sink: string[]): Storage {
  return {
    length: 0,
    clear() {},
    getItem() {
      return null;
    },
    key() {
      return null;
    },
    removeItem() {},
    setItem(k: string, v: string) {
      sink.push(`${k}=${v}`);
    },
  } as unknown as Storage;
}

function stringifyArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a) ?? String(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

// Run `fn` with the network, both web-storage globals and every console channel
// captured for its duration, then restore them. Returns everything observed so a
// test can assert the plaintext reached NONE of them. Design-agnostic: whether the
// module posts the ciphertext itself or stays a pure transform, no PLAINTEXT secret
// may appear in any captured channel.
async function withCaptures<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; outbound: string[]; stored: string[]; logged: string[] }> {
  const outbound: string[] = [];
  const stored: string[] = [];
  const logged: string[] = [];

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const body = init?.body;
    const bodyText = typeof body === "string" ? body : body == null ? "" : String(body);
    outbound.push(url, bodyText);
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  const consoleMethods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const realConsole: Record<string, unknown> = {};
  for (const m of consoleMethods) {
    realConsole[m] = (console as unknown as Record<string, unknown>)[m];
    (console as unknown as Record<string, (...a: unknown[]) => void>)[m] = (...args) => {
      logged.push(stringifyArgs(args));
    };
  }

  const realFetch = globalThis.fetch;
  const realLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const realSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  globalThis.fetch = fakeFetch;
  Object.defineProperty(globalThis, "localStorage", {
    value: recordingStorage(stored),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: recordingStorage(stored),
    configurable: true,
    writable: true,
  });

  try {
    const value = await fn();
    return { value, outbound, stored, logged };
  } finally {
    globalThis.fetch = realFetch;
    for (const m of consoleMethods) {
      (console as unknown as Record<string, unknown>)[m] = realConsole[m];
    }
    if (realLocal) Object.defineProperty(globalThis, "localStorage", realLocal);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
    if (realSession) Object.defineProperty(globalThis, "sessionStorage", realSession);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
}

test("never leaks a plaintext value or card number to the network, storage, or the console", async () => {
  const importingKey = freshVaultKey();
  const secrets = [PASSPORT_VALUE, DOB_VALUE, CARD_NUMBER, CARD_NUMBER_2];

  const { value: result, outbound, stored, logged } = await withCaptures(() =>
    reprotectDeviceProtected(importingKey, section([PASSPORT, DOB], [CARD_EVERYDAY, CARD_TRAVEL])),
  );

  // The re-protection really happened (ciphertext produced) — so this is a genuine
  // no-leak result, not an empty run.
  assert.equal(result.sealed.highTierFields.length, 2, "the values were re-protected");

  for (const secret of secrets) {
    for (const line of outbound) {
      assert.ok(!line.includes(secret), `a plaintext value must never be sent to the server; saw: ${line}`);
    }
    for (const write of stored) {
      assert.ok(!write.includes(secret), `a plaintext value must never be written to client storage; saw: ${write}`);
    }
    for (const line of logged) {
      assert.ok(!line.includes(secret), `a plaintext value must never be logged; saw: ${line}`);
    }
  }
});
