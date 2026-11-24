// E16-S03 — device-protected export section (`src/client/vault/export.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// here fails until the implementation lands. These pin BEHAVIOUR (what the module
// DOES with stored ciphertext, an unlocked vault key, a bad key, and the
// network/storage/console), never the source text of the module.
//
// Brief "Export and portability" / design data-portability: high-tier identity
// values and card numbers are encrypted ON THE PERSON'S OWN DEVICE with the vault
// key (VK) and Warthog cannot read them. The server-only export builder
// (`src/server/export/build.ts`) therefore OMITS the schema's optional
// `deviceProtected` block. The ONLY place those details can be added to an export
// is the browser, after a step-up and unlock — otherwise a portable backup would
// silently omit them. This module is that browser step: given the stored
// ciphertext and the unlocked VK, it decrypts the high-tier values and card
// numbers and returns them in the `deviceProtected` SECTION SHAPE of the E16-S01
// schema (`src/server/export/schema.ts`), ready to merge into the downloaded file.
//
// ── The contract these tests define (the tester fixes the seam the builder fills) ──
//
//   buildDeviceProtected(vaultKey, stored) -> Promise<DeviceProtected>
//
//     vaultKey: the unlocked vault key as raw 256-bit bytes (as unlockVault yields),
//               OR null/undefined when the vault is not unlocked ("absent").
//     stored:   the person's own stored ciphertext records —
//               { highTierFields: Array<{ type, label, ciphertext }>,   // high-tier-fields.ts
//                 cards:          Array<{ brand, lastFour, nickname, numberCiphertext }> } // cards.ts
//
//     On success it RESOLVES with the E16-S01 `deviceProtected` section:
//       { highTierFields: Array<{ type, label, value }>,            // value = decrypted
//         cards:          Array<{ brand, lastFour, nickname, number }> } // number = decrypted
//     — each stored ciphertext decrypted with VK (via the `decryptValue` seam),
//       its plaintext metadata (type/label, brand/lastFour/nickname) carried through
//       unchanged, in the same order; an empty vault yields two empty arrays.
//
//     On failure — the vault key is absent, OR any one value fails to unwrap (a GCM
//     tag mismatch from a wrong key or a tampered envelope) — it REJECTS and returns
//     NO plaintext at all (not even a partial section of the values that did
//     decrypt): it reports failure rather than guessing, mirroring the no-fallback
//     `decryptValue`/`unlockVault` seams.
//
//     It NEVER sends plaintext high-tier values or card numbers to the server: it is
//     a purely local transform and issues no network request; nothing is written to
//     client storage or the console.
//
// These are pure client unit tests. Entropy comes from node:crypto; stored
// ciphertext is produced with the real `encryptValue` seam (the production write
// path), so the module must decrypt genuine `v1:` envelopes. The module reaches the
// WebCrypto globals (`crypto.subtle`) exactly like its siblings; no network, no DOM,
// no database, no Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import { buildDeviceProtected } from "./export";
import { encryptValue } from "./values";
import { exportDocumentSchema } from "../../server/export/schema";

const KEY_BYTES = 32; // the vault key is a 256-bit = 32-byte AES key

// A fresh random 256-bit vault key, as raw bytes — stands in for the bytes the
// browser unlock recovers. Generated directly so these tests exercise export.ts.
function freshVaultKey(): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

// Produce a stored ciphertext envelope exactly as the browser save path does, so
// the module under test must decrypt a genuine `v1:` envelope.
function seal(vaultKey: Uint8Array, plaintext: string): Promise<string> {
  return encryptValue(vaultKey as Uint8Array<ArrayBuffer>, plaintext);
}

// Flip one character inside the ciphertext/tag region (after any "version:" prefix)
// so GCM-tag verification — not a version/format check — is what rejects it. A swap
// within the base64 alphabet keeps the string decodable.
function tamper(envelope: string): string {
  assert.ok(envelope.length > 0, "cannot tamper with an empty envelope");
  const colon = envelope.indexOf(":");
  const payloadStart = colon >= 0 ? colon + 1 : 0;
  const from = Math.max(payloadStart, Math.floor((payloadStart + envelope.length) / 2));
  for (let i = from; i < envelope.length; i += 1) {
    const c = envelope[i];
    if (c && c !== "=") {
      const replacement = c === "A" ? "B" : "A";
      return envelope.slice(0, i) + replacement + envelope.slice(i + 1);
    }
  }
  throw new assert.AssertionError({ message: "found no byte to tamper in the envelope" });
}

// Robust across sync-throw and async-reject implementations AND against a
// non-throwing return: assert.rejects fails if the call RESOLVES, which is exactly
// the "reports failure and returns NO plaintext" guarantee — returning anything
// here fails the test.
async function assertBuildRejects(
  vaultKey: unknown,
  stored: unknown,
  message: string,
): Promise<void> {
  await assert.rejects(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await buildDeviceProtected(vaultKey as any, stored as any);
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

interface HighTierSpec {
  type: string;
  label: string;
  value: string;
}
interface CardSpec {
  brand: string;
  lastFour: string;
  nickname: string;
  number: string;
}

const PASSPORT: HighTierSpec = { type: "passport", label: "Passport", value: PASSPORT_VALUE };
const DOB: HighTierSpec = { type: "date_of_birth", label: "Date of birth", value: DOB_VALUE };
const CARD_EVERYDAY: CardSpec = {
  brand: "visa",
  lastFour: "1111",
  nickname: "Everyday",
  number: CARD_NUMBER,
};
const CARD_TRAVEL: CardSpec = {
  brand: "mastercard",
  lastFour: "2222",
  nickname: "Travel",
  number: CARD_NUMBER_2,
};

// Build a `stored` input (the opaque ciphertext records the browser holds) by
// sealing each spec's plaintext under the given vault key.
async function storedUnder(
  vaultKey: Uint8Array,
  highTier: HighTierSpec[],
  cards: CardSpec[],
): Promise<{
  highTierFields: Array<{ type: string; label: string; ciphertext: string }>;
  cards: Array<{ brand: string; lastFour: string; nickname: string; numberCiphertext: string }>;
}> {
  return {
    highTierFields: await Promise.all(
      highTier.map(async (f) => ({
        type: f.type,
        label: f.label,
        ciphertext: await seal(vaultKey, f.value),
      })),
    ),
    cards: await Promise.all(
      cards.map(async (c) => ({
        brand: c.brand,
        lastFour: c.lastFour,
        nickname: c.nickname,
        numberCiphertext: await seal(vaultKey, c.number),
      })),
    ),
  };
}

// ---------------------------------------------------------------------------
// AC1: given the stored ciphertext and an unlocked vault key, the module returns
// the decrypted high-tier values and card details in the deviceProtected shape.
// ---------------------------------------------------------------------------

test("decrypts a stored high-tier value, carrying its type and label through", async () => {
  const vaultKey = freshVaultKey();
  const stored = await storedUnder(vaultKey, [PASSPORT], []);

  const section = await buildDeviceProtected(vaultKey as Uint8Array<ArrayBuffer>, stored);

  assert.equal(section.highTierFields.length, 1, "one high-tier field in, one out");
  const field = section.highTierFields[0]!;
  assert.equal(field.value, PASSPORT_VALUE, "the stored ciphertext decrypts to its plaintext value");
  assert.equal(field.type, "passport", "the plaintext type metadata is carried through");
  assert.equal(field.label, "Passport", "the plaintext label metadata is carried through");
  assert.deepEqual(section.cards, [], "no cards stored → an empty cards array");
});

test("decrypts a stored card number, carrying brand/lastFour/nickname and spaces intact", async () => {
  const vaultKey = freshVaultKey();
  const stored = await storedUnder(vaultKey, [], [CARD_EVERYDAY]);

  const section = await buildDeviceProtected(vaultKey as Uint8Array<ArrayBuffer>, stored);

  assert.equal(section.cards.length, 1, "one card in, one out");
  const card = section.cards[0]!;
  assert.equal(card.number, CARD_NUMBER, "the card number round-trips byte-for-byte, spaces and all");
  assert.equal(card.brand, "visa", "the plaintext brand metadata is carried through");
  assert.equal(card.lastFour, "1111", "the plaintext last-four metadata is carried through");
  assert.equal(card.nickname, "Everyday", "the plaintext nickname metadata is carried through");
  assert.deepEqual(section.highTierFields, [], "no high-tier fields stored → an empty array");
});

test("returns every stored field and card, decrypted, in the order given", async () => {
  const vaultKey = freshVaultKey();
  const stored = await storedUnder(vaultKey, [PASSPORT, DOB], [CARD_EVERYDAY, CARD_TRAVEL]);

  const section = await buildDeviceProtected(vaultKey as Uint8Array<ArrayBuffer>, stored);

  assert.deepEqual(
    section.highTierFields.map((f) => [f.type, f.label, f.value]),
    [
      ["passport", "Passport", PASSPORT_VALUE],
      ["date_of_birth", "Date of birth", DOB_VALUE],
    ],
    "every high-tier field decrypts, with metadata and order preserved",
  );
  assert.deepEqual(
    section.cards.map((c) => [c.brand, c.lastFour, c.nickname, c.number]),
    [
      ["visa", "1111", "Everyday", CARD_NUMBER],
      ["mastercard", "2222", "Travel", CARD_NUMBER_2],
    ],
    "every card decrypts, with metadata and order preserved",
  );
});

// docs/adr/card-billing-addresses.md: a card's billing reference is either a postal address
// (billingAddressId) or a card-only address (billingEntryId), or none. Whichever it has must
// reach the export, or the importing account loses the card's billing address.
test("carries each card's billing reference through — postal, card-only or none", async () => {
  const vaultKey = freshVaultKey();
  const stored = await storedUnder(vaultKey, [], [CARD_EVERYDAY, CARD_TRAVEL, CARD_EVERYDAY]);
  const cards = [
    { ...stored.cards[0]!, billingAddressId: "postal-1" },
    { ...stored.cards[1]!, billingEntryId: "billing-1" },
    stored.cards[2]!,
  ];

  const section = await buildDeviceProtected(vaultKey as Uint8Array<ArrayBuffer>, { highTierFields: [], cards });

  assert.equal(section.cards[0]!.billingAddressId, "postal-1", "a postal reference is carried through");
  assert.equal("billingEntryId" in section.cards[0]!, false, "a postal card gains no card-only reference");
  assert.equal(section.cards[1]!.billingEntryId, "billing-1", "a card-only reference is carried through");
  assert.equal("billingAddressId" in section.cards[1]!, false, "a card-only card gains no postal reference");
  assert.equal("billingAddressId" in section.cards[2]! || "billingEntryId" in section.cards[2]!, false, "a card with no address carries no reference");
});

test("an empty vault yields a well-formed, empty device-protected section", async () => {
  const vaultKey = freshVaultKey();

  const section = await buildDeviceProtected(vaultKey as Uint8Array<ArrayBuffer>, {
    highTierFields: [],
    cards: [],
  });

  assert.deepEqual(section.highTierFields, [], "no high-tier fields → an empty array, not undefined");
  assert.deepEqual(section.cards, [], "no cards → an empty array, not undefined");
});

test("the returned section conforms to the E16-S01 export schema's deviceProtected shape", async () => {
  const vaultKey = freshVaultKey();
  const stored = await storedUnder(vaultKey, [PASSPORT, DOB], [CARD_EVERYDAY]);

  const section = await buildDeviceProtected(vaultKey as Uint8Array<ArrayBuffer>, stored);

  // Mount the section into an otherwise-minimal export document and parse it
  // against the SAME schema both export and import use. A shape that is not the
  // schema's deviceProtected block fails to parse here.
  const doc = {
    version: 1 as const,
    exportedAt: "2026-11-07T00:00:00.000Z",
    profile: {},
    preferences: {},
    skills: [],
    memory: [],
    rules: [],
    tasks: [],
    lifeAdmin: [],
    connections: [],
    activity: [],
    deviceProtected: section,
  };

  const parsed = exportDocumentSchema.parse(doc);
  assert.ok(parsed.deviceProtected, "the document validates and keeps a deviceProtected block");
  assert.deepEqual(
    parsed.deviceProtected,
    section,
    "the schema accepts the section's fields unchanged (it is the E16-S01 shape)",
  );
});

// ---------------------------------------------------------------------------
// AC2: an absent vault key, or any value that fails to unwrap (GCM tag mismatch),
// reports failure and returns NO plaintext rather than guessing.
// ---------------------------------------------------------------------------

test("reports failure when the vault key is absent — returns no plaintext", async () => {
  const realKey = freshVaultKey();
  const stored = await storedUnder(realKey, [PASSPORT], [CARD_EVERYDAY]);

  for (const absent of [null, undefined]) {
    await assertBuildRejects(
      absent,
      stored,
      `an absent vault key (${String(absent)}) must report failure, never return plaintext`,
    );
  }
});

test("reports failure under a WRONG vault key (GCM tag mismatch) — returns no plaintext", async () => {
  const realKey = freshVaultKey();
  const wrongKey = freshVaultKey();
  const stored = await storedUnder(realKey, [PASSPORT], [CARD_EVERYDAY]);

  await assertBuildRejects(
    wrongKey,
    stored,
    "a wrong vault key must fail the GCM tag and reject, never yield a (garbage) value",
  );
});

test("reports failure when a stored high-tier ciphertext is tampered — returns no plaintext", async () => {
  const vaultKey = freshVaultKey();
  const stored = await storedUnder(vaultKey, [PASSPORT], []);
  stored.highTierFields[0]!.ciphertext = tamper(stored.highTierFields[0]!.ciphertext);

  await assertBuildRejects(
    vaultKey,
    stored,
    "a tampered high-tier envelope must fail the GCM check, never silently decrypt",
  );
});

test("reports failure when a stored card ciphertext is tampered — returns no plaintext", async () => {
  const vaultKey = freshVaultKey();
  const stored = await storedUnder(vaultKey, [], [CARD_EVERYDAY]);
  stored.cards[0]!.numberCiphertext = tamper(stored.cards[0]!.numberCiphertext);

  await assertBuildRejects(
    vaultKey,
    stored,
    "a tampered card envelope must fail the GCM check, never silently decrypt",
  );
});

test("one unreadable value fails the WHOLE section — no partial plaintext, no guessing", async () => {
  const vaultKey = freshVaultKey();
  // A readable value and an unreadable one in the same request. "No guessing"
  // means the whole build fails rather than returning the readable one alone.
  const stored = await storedUnder(vaultKey, [PASSPORT, DOB], [CARD_EVERYDAY]);
  stored.highTierFields[1]!.ciphertext = tamper(stored.highTierFields[1]!.ciphertext);

  await assertBuildRejects(
    vaultKey,
    stored,
    "if any one value cannot be unwrapped the module must reject outright, returning no partial section",
  );
});

// ---------------------------------------------------------------------------
// AC3: the module never sends plaintext high-tier values or card numbers to the
// server — it is a purely local transform (no network, no storage, no console).
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string;
  bodyText: string;
}

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
// test can assert the plaintext reached NONE of them.
async function withCaptures<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; fetchCalls: RecordedRequest[]; stored: string[]; logged: string[] }> {
  const fetchCalls: RecordedRequest[] = [];
  const stored: string[] = [];
  const logged: string[] = [];

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const body = init?.body;
    const bodyText = typeof body === "string" ? body : body == null ? "" : String(body);
    fetchCalls.push({ url, bodyText });
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
    return { value, fetchCalls, stored, logged };
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

test("performs no network request — the device-protected section is built locally", async () => {
  const vaultKey = freshVaultKey();
  const stored = await storedUnder(vaultKey, [PASSPORT], [CARD_EVERYDAY]);

  const { value: section, fetchCalls } = await withCaptures(() =>
    buildDeviceProtected(vaultKey as Uint8Array<ArrayBuffer>, stored),
  );

  assert.equal(fetchCalls.length, 0, "building the section must issue no request to the server");
  // Sanity: the plaintext really was produced — so the only place it could have
  // gone is the returned value, which the next test confirms never leaks elsewhere.
  assert.equal(section.highTierFields[0]!.value, PASSPORT_VALUE);
  assert.equal(section.cards[0]!.number, CARD_NUMBER);
});

test("never leaks a plaintext value or card number to the network, storage, or the console", async () => {
  const vaultKey = freshVaultKey();
  const stored = await storedUnder(vaultKey, [PASSPORT, DOB], [CARD_EVERYDAY, CARD_TRAVEL]);
  const secrets = [PASSPORT_VALUE, DOB_VALUE, CARD_NUMBER, CARD_NUMBER_2];

  const { value: section, fetchCalls, stored: storedWrites, logged } = await withCaptures(() =>
    buildDeviceProtected(vaultKey as Uint8Array<ArrayBuffer>, stored),
  );

  // The ONLY place the plaintext is allowed to be is the returned section.
  assert.ok(
    section.highTierFields.some((f) => f.value === PASSPORT_VALUE),
    "the returned section carries the decrypted plaintext (it has to go somewhere)",
  );

  const outbound = fetchCalls.flatMap((c) => [c.url, c.bodyText]);
  for (const secret of secrets) {
    for (const line of outbound) {
      assert.ok(!line.includes(secret), `a plaintext value must never be sent to the server; saw: ${line}`);
    }
    for (const write of storedWrites) {
      assert.ok(!write.includes(secret), `a plaintext value must never be written to client storage; saw: ${write}`);
    }
    for (const line of logged) {
      assert.ok(!line.includes(secret), `a plaintext value must never be logged; saw: ${line}`);
    }
  }
});
