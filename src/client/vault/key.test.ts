// E11-S05 — client vault key: create + wrap/unwrap primitive (`src/client/vault/key.ts`).
//
// These tests are RED-first: the module does not exist yet, so importing it
// fails and every test here fails until the implementation lands. They pin
// BEHAVIOUR (what create/wrap/unwrap do with bytes and the wrapped string),
// never the source text of the module.
//
// Design §4.2: the browser creates a random 256-bit **vault key (VK)** at first
// use (WebCrypto). VK is stored server-side only WRAPPED, once per unlock method,
// under a wrapping key derived from that method (PRF / passphrase / recovery
// code). The wrap is AES-256-GCM with a random nonce written as a versioned
// envelope; "Unwrap is always verified (GCM tag) ... never silently re-key" — so
// a wrong wrapping key or a tampered blob must fail loudly, not yield a bad key.
//
// The contract these tests define (mirrors the server DEK seam in
// src/server/crypto/{envelope,key-wrapper}.ts, which represent keys as raw bytes
// and the wrapped form as a string):
//
//   createVaultKey() -> the vault key as raw bytes (a 256-bit / 32-byte key).
//     • random: two calls return different keys.
//
//   wrapVaultKey(wrappingKey, vaultKey) -> a storable string envelope.
//     • wrappingKey is a raw 256-bit AES key (32 bytes); vaultKey is the bytes
//       from createVaultKey. AES-256-GCM under the wrapping key, a RANDOM nonce,
//       and a VERSION marker on the envelope.
//
//   unwrapVaultKey(wrappingKey, wrapped) -> the exact vault key bytes.
//     • round-trips the vault key byte-for-byte under the SAME wrapping key;
//     • THROWS (never returns a key) under a wrong wrapping key or a tampered
//       envelope — GCM-tag verification, no silent re-keying.
//
// create/wrap/unwrap are awaited everywhere so these tests pass whether an
// implementation is sync or async. Tests use only node:crypto for entropy and
// never touch the network, Azure, a DOM or a database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import { createVaultKey, wrapVaultKey, unwrapVaultKey } from "./key";

const KEY_BYTES = 32; // a 256-bit key (vault key and AES wrapping key alike)

// A fresh random AES-256 wrapping key, as raw bytes — stands in for the key a
// real unlock method derives (HKDF(PRF) / PBKDF2(passphrase) / HKDF(recovery)).
function freshWrappingKey(): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

// Normalise whatever raw-key representation the module returns (Uint8Array,
// ArrayBuffer, Node Buffer, or any ArrayBufferView) to a Uint8Array, so the
// tests assert on the BYTES, not on the exact JS wrapper type.
function toBytes(key: unknown): Uint8Array {
  if (key instanceof Uint8Array) return key;
  if (key instanceof ArrayBuffer) return new Uint8Array(key);
  if (ArrayBuffer.isView(key)) {
    return new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
  }
  throw new assert.AssertionError({
    message: `expected raw key bytes (Uint8Array/ArrayBuffer), got ${Object.prototype.toString.call(
      key,
    )}`,
  });
}

function hex(key: unknown): string {
  return Buffer.from(toBytes(key)).toString("hex");
}

// Change exactly one character in the ciphertext/tag region of the envelope (the
// payload after any "version:" prefix) so GCM-tag verification — not a version or
// format check — is what rejects it. A single swap within the base64 alphabet
// keeps the string decodable, so unwrap must still fail on the authentication tag.
function tamper(envelope: string): string {
  assert.ok(envelope.length > 0, "cannot tamper with an empty envelope");
  const colon = envelope.indexOf(":");
  const payloadStart = colon >= 0 ? colon + 1 : 0;
  // Start in the second half of the payload and flip the first non-padding
  // character we find — comfortably inside the ciphertext/tag, never the version.
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

// Robust across sync-throw and async-reject implementations: the async wrapper
// turns a synchronous throw into a rejection, and — crucially — a NON-throwing
// return into a resolution, which assert.rejects then fails on. That is the
// "never silently returns a key" guarantee: returning any key here fails the test.
async function assertUnwrapRejects(
  wrappingKey: Uint8Array,
  wrapped: string,
  message: string,
): Promise<void> {
  await assert.rejects(async () => {
    await unwrapVaultKey(wrappingKey, wrapped);
  }, message);
}

// --- AC: createVaultKey returns a random 256-bit key ---

test("createVaultKey returns a 256-bit (32-byte) key", async () => {
  const vaultKey = await createVaultKey();

  assert.equal(toBytes(vaultKey).length, KEY_BYTES, "a vault key is 256 bits = 32 bytes");
});

test("createVaultKey is random: two keys differ", async () => {
  const a = await createVaultKey();
  const b = await createVaultKey();

  assert.notEqual(hex(a), hex(b), "each vault key must be freshly random, not fixed");
});

// --- AC: wrap then unwrap with the SAME wrapping key round-trips exactly ---

test("wrap then unwrap under the same wrapping key round-trips the vault key exactly", async () => {
  const wrappingKey = freshWrappingKey();
  const vaultKey = await createVaultKey();

  const wrapped = await wrapVaultKey(wrappingKey, vaultKey);
  const recovered = await unwrapVaultKey(wrappingKey, wrapped);

  assert.equal(hex(recovered), hex(vaultKey), "the recovered vault key equals the original byte-for-byte");
});

test("many distinct vault keys round-trip under one wrapping key", async () => {
  const wrappingKey = freshWrappingKey();

  for (let i = 0; i < 10; i += 1) {
    const vaultKey = await createVaultKey();
    const recovered = await unwrapVaultKey(wrappingKey, await wrapVaultKey(wrappingKey, vaultKey));
    assert.equal(hex(recovered), hex(vaultKey), `vault key #${i} must round-trip exactly`);
  }
});

// --- AC: the wrapped form carries a version marker and a random nonce ---

test("the wrapped form is a non-empty, versioned string", async () => {
  const wrappingKey = freshWrappingKey();
  const vaultKey = await createVaultKey();

  const wrapped = await wrapVaultKey(wrappingKey, vaultKey);

  assert.equal(typeof wrapped, "string", "the wrapped vault key is a storable string");
  assert.ok(wrapped.length > 0, "the wrapped form is non-empty");
  // The repo's versioned-envelope convention is a "v1" marker (design §4.1/§4.2,
  // src/server/crypto/envelope.ts). Carrying it lets the format evolve later.
  assert.ok(
    wrapped.startsWith("v1"),
    `the wrapped form must carry its version marker, saw: ${wrapped.slice(0, 8)}`,
  );
});

test("the wrapped form does not leak the vault key in clear", async () => {
  const wrappingKey = freshWrappingKey();
  const vaultKey = await createVaultKey();

  const wrapped = await wrapVaultKey(wrappingKey, vaultKey);

  // The raw vault-key bytes (hex and base64) must not appear verbatim in the
  // wrapped envelope — it is ciphertext, not the key in the clear.
  const bytes = toBytes(vaultKey);
  assert.ok(
    !wrapped.includes(Buffer.from(bytes).toString("hex")),
    "the vault key must not appear as hex inside the wrapped form",
  );
  assert.ok(
    !wrapped.includes(Buffer.from(bytes).toString("base64")),
    "the vault key must not appear as base64 inside the wrapped form",
  );
});

test("wrap uses a random nonce: the same key wrapped twice differs, and both unwrap", async () => {
  const wrappingKey = freshWrappingKey();
  const vaultKey = await createVaultKey();

  const a = await wrapVaultKey(wrappingKey, vaultKey);
  const b = await wrapVaultKey(wrappingKey, vaultKey);

  assert.notEqual(a, b, "a random nonce must make repeat wraps of the same key differ");
  assert.equal(hex(await unwrapVaultKey(wrappingKey, a)), hex(vaultKey));
  assert.equal(hex(await unwrapVaultKey(wrappingKey, b)), hex(vaultKey));
});

// --- AC: a wrong wrapping key or a tampered blob throws (never returns a key) ---

test("unwrap under a WRONG wrapping key throws, never returns a (re-keyed) key", async () => {
  const wrappingKey = freshWrappingKey();
  const wrongKey = freshWrappingKey();
  const vaultKey = await createVaultKey();

  const wrapped = await wrapVaultKey(wrappingKey, vaultKey);

  await assertUnwrapRejects(
    wrongKey,
    wrapped,
    "a wrong wrapping key must fail the GCM tag, never silently yield a key",
  );
});

test("unwrap of a TAMPERED envelope throws, never returns garbage bytes", async () => {
  const wrappingKey = freshWrappingKey();
  const vaultKey = await createVaultKey();

  const wrapped = await wrapVaultKey(wrappingKey, vaultKey);

  await assertUnwrapRejects(
    wrappingKey,
    tamper(wrapped),
    "a one-character change to the ciphertext/tag must be rejected, never silently unwrapped",
  );
});
