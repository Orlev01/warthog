// E11-S07 — client vault value encryption (`src/client/vault/values.ts`).
//
// These tests are RED-first: the module does not exist yet, so importing it
// fails and every test here fails until the implementation lands. They pin
// BEHAVIOUR (what encrypt/decrypt do with a value string and the stored
// ciphertext), never the source text of the module.
//
// Design §4.2: "High-tier values and card data are encrypted in the browser
// with VK (AES-256-GCM, WebCrypto). The server stores ciphertext only." On
// release the browser "decrypts the value with VK". So this module turns a
// high-tier identity value or a card number (a STRING) into a storable
// ciphertext under the vault key, and back again — the inverse pair that lets
// the server only ever hold and return that ciphertext.
//
// It mirrors the sibling key.ts seam (and the server DEK envelope): the vault
// key is raw 256-bit bytes, the ciphertext is a `v1:` versioned string, the
// nonce is random per call, and decrypt is always GCM-tag verified — a wrong
// key or a tampered blob REJECTS, never silently returns a value.
//
// The contract these tests define:
//
//   encryptValue(vaultKey, plaintext) -> a storable string envelope.
//     • vaultKey is a raw 256-bit AES key (32 bytes, as createVaultKey yields);
//       plaintext is the value string. AES-256-GCM under the vault key, a
//       RANDOM nonce, and a VERSION marker on the envelope. Never contains the
//       plaintext.
//
//   decryptValue(vaultKey, ciphertext) -> the exact original value string.
//     • round-trips the value under the SAME vault key;
//     • THROWS (never returns a value) under a wrong vault key, a tampered
//       envelope, or an unrecognised version — GCM-tag verified, no fallback.
//
// encrypt/decrypt are awaited everywhere so these tests pass whether an
// implementation is sync or async. Tests use only node:crypto for entropy and
// never touch the network, Azure, a DOM or a database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import { encryptValue, decryptValue } from "./values";

const KEY_BYTES = 32; // the vault key is a 256-bit = 32-byte AES key

// A fresh random 256-bit vault key, as raw bytes — stands in for the bytes
// createVaultKey() produces in the browser. Generated here directly so these
// tests exercise values.ts alone, independent of the key.ts seam.
function freshVaultKey(): Uint8Array {
  return webcrypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

// Change exactly one character in the ciphertext/tag region of the envelope
// (the payload after any "version:" prefix) so GCM-tag verification — not a
// version or format check — is what rejects it. A single swap within the
// base64 alphabet keeps the string decodable, so decrypt must still fail on the
// authentication tag.
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
// "never silently returns a value" guarantee: returning anything here fails.
async function assertDecryptRejects(
  vaultKey: Uint8Array,
  ciphertext: string,
  message: string,
): Promise<void> {
  await assert.rejects(async () => {
    await decryptValue(vaultKey, ciphertext);
  }, message);
}

// Representative plaintexts: a high-tier identity value and a card number. The
// alphanumeric high-tier marker is long and distinctive so the no-leak check is
// meaningful (a correct ciphertext can never coincidentally contain it).
const HIGH_TIER_VALUE = "PA1234567DONOTLEAKmarker7f3a9c2bQ8";
const CARD_NUMBER = "4111 1111 1111 1111";

// --- AC: encrypt then decrypt with the SAME vault key returns the original ---

test("encrypt then decrypt a high-tier value under the same key returns the original", async () => {
  const vaultKey = freshVaultKey();

  const ciphertext = await encryptValue(vaultKey, HIGH_TIER_VALUE);
  const recovered = await decryptValue(vaultKey, ciphertext);

  assert.equal(recovered, HIGH_TIER_VALUE, "the decrypted value equals the original exactly");
});

test("encrypt then decrypt a card number under the same key returns it with spaces intact", async () => {
  const vaultKey = freshVaultKey();

  const ciphertext = await encryptValue(vaultKey, CARD_NUMBER);
  const recovered = await decryptValue(vaultKey, ciphertext);

  assert.equal(recovered, CARD_NUMBER, "the card number round-trips byte-for-byte, spaces and all");
});

test("encrypt/decrypt preserves unicode, punctuation and whitespace exactly", async () => {
  const vaultKey = freshVaultKey();
  // A value with non-ASCII, an em dash and a newline — proper UTF-8 handling,
  // not a naive one-byte-per-character encoding.
  const value = "Passé — こんにちは 12345\n(unit 7/9)";

  const recovered = await decryptValue(vaultKey, await encryptValue(vaultKey, value));

  assert.equal(recovered, value, "every code point survives the round trip");
});

test("the empty string round-trips (encrypting an empty value is well defined)", async () => {
  const vaultKey = freshVaultKey();

  const recovered = await decryptValue(vaultKey, await encryptValue(vaultKey, ""));

  assert.equal(recovered, "", "an empty value decrypts back to the empty string");
});

test("many distinct values round-trip under one vault key", async () => {
  const vaultKey = freshVaultKey();

  for (let i = 0; i < 10; i += 1) {
    const value = `high-tier-detail-#${i}-${webcrypto.randomUUID()}`;
    const recovered = await decryptValue(vaultKey, await encryptValue(vaultKey, value));
    assert.equal(recovered, value, `value #${i} must round-trip exactly`);
  }
});

// --- AC: the ciphertext carries a version marker ---

test("the ciphertext is a non-empty, versioned string", async () => {
  const vaultKey = freshVaultKey();

  const ciphertext = await encryptValue(vaultKey, HIGH_TIER_VALUE);

  assert.equal(typeof ciphertext, "string", "the stored form is a string");
  assert.ok(ciphertext.length > 0, "the ciphertext is non-empty");
  // The repo's versioned-envelope convention is a "v1" marker (design §4.1/§4.2,
  // mirrored by src/client/vault/key.ts and src/server/crypto). Carrying it lets
  // the format evolve later.
  assert.ok(
    ciphertext.startsWith("v1"),
    `the ciphertext must carry its version marker, saw: ${ciphertext.slice(0, 8)}`,
  );
});

// --- AC: the ciphertext never contains the plaintext ---

test("the ciphertext never contains the plaintext value", async () => {
  const vaultKey = freshVaultKey();

  for (const value of [HIGH_TIER_VALUE, CARD_NUMBER, CARD_NUMBER.replaceAll(" ", "")]) {
    const ciphertext = await encryptValue(vaultKey, value);

    // The value must not appear verbatim, nor as the base64/hex of its UTF-8
    // bytes — the envelope is ciphertext, not the value in the clear.
    assert.ok(!ciphertext.includes(value), `the value must not appear in clear: ${value}`);
    const bytes = Buffer.from(value, "utf8");
    assert.ok(
      bytes.length === 0 || !ciphertext.includes(bytes.toString("base64")),
      `the value's bytes must not appear as base64: ${value}`,
    );
    assert.ok(
      bytes.length === 0 || !ciphertext.includes(bytes.toString("hex")),
      `the value's bytes must not appear as hex: ${value}`,
    );
  }
});

test("a random nonce makes the same value encrypt to different ciphertexts, both decryptable", async () => {
  const vaultKey = freshVaultKey();

  const a = await encryptValue(vaultKey, HIGH_TIER_VALUE);
  const b = await encryptValue(vaultKey, HIGH_TIER_VALUE);

  assert.notEqual(a, b, "a random nonce must make repeat encryptions of the same value differ");
  assert.equal(await decryptValue(vaultKey, a), HIGH_TIER_VALUE);
  assert.equal(await decryptValue(vaultKey, b), HIGH_TIER_VALUE);
});

// --- AC: a tampered ciphertext fails the GCM check and throws ---

test("decrypt of a TAMPERED ciphertext throws, never returns a value", async () => {
  const vaultKey = freshVaultKey();

  const ciphertext = await encryptValue(vaultKey, HIGH_TIER_VALUE);

  await assertDecryptRejects(
    vaultKey,
    tamper(ciphertext),
    "a one-character change to the ciphertext/tag must fail the GCM check, never silently decrypt",
  );
});

test("decrypt under a WRONG vault key throws, never returns a (garbage) value", async () => {
  const vaultKey = freshVaultKey();
  const wrongKey = freshVaultKey();

  const ciphertext = await encryptValue(vaultKey, HIGH_TIER_VALUE);

  await assertDecryptRejects(
    wrongKey,
    ciphertext,
    "a wrong vault key must fail the GCM tag, never silently yield a value",
  );
});

test("decrypt of an unrecognised-version envelope throws", async () => {
  const vaultKey = freshVaultKey();

  const ciphertext = await encryptValue(vaultKey, HIGH_TIER_VALUE);
  // Re-label the payload with a version this module does not recognise; the
  // version marker is validated, so a future/unknown format is rejected rather
  // than mis-decoded.
  const colon = ciphertext.indexOf(":");
  assert.ok(colon > 0, "the versioned envelope separates its marker with a colon");
  const relabelled = "v2" + ciphertext.slice(colon);

  await assertDecryptRejects(
    vaultKey,
    relabelled,
    "an unrecognised version marker must be rejected, never mis-decoded as v1",
  );
});
