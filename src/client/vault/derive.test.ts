// E11-S06 — client vault wrapping-key derivation (`src/client/vault/derive.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// here fails until the implementation lands. These pin BEHAVIOUR (what each
// derivation does with its inputs), never the source text of the module.
//
// Design §4.2 — VK is stored server-side only WRAPPED, once per unlock method,
// under a wrapping key that method derives. Each unlock method seals the SAME
// vault key, so a key wrapped under one method must unwrap on any device that can
// re-derive that method's wrapping key — the derivations are therefore fully
// deterministic in their inputs:
//
//   • Passkey PRF:  wrapping key = HKDF-SHA256(prf output, info `warthog/vault-wrap/v1`).
//   • Vault passphrase:  PBKDF2-SHA256, 600,000 iterations, 16-byte salt (WebCrypto).
//   • Recovery code:  wrapping key = HKDF(code, info `warthog/vault-wrap/v1`); and the
//     server separately stores scrypt(HKDF(code, info `warthog/recovery-auth/v1`)) to
//     verify a recovery sign-in WITHOUT learning the wrapping key — so the browser's
//     recovery-auth value is a DISTINCT HKDF output (different info) from the recovery
//     wrapping key the same code derives.
//
// The contract these tests define (the tester fixes the seam the builder fills):
//
//   deriveWrappingKeyFromPrf(prfOutput)        -> a 256-bit (32-byte) AES wrapping key.
//   deriveWrappingKeyFromPassphrase(passphrase, salt)
//                                              -> a 256-bit AES wrapping key, PBKDF2.
//   deriveWrappingKeyFromRecoveryCode(code)    -> a 256-bit AES wrapping key, HKDF.
//   deriveRecoveryAuthValue(code)              -> the recovery-auth value, HKDF
//                                                 (DISTINCT from the recovery wrapping key).
//
// Acceptance criteria exercised here:
//   • deriving from the SAME prf output / the SAME passphrase+salt / the SAME recovery
//     code twice yields the SAME wrapping key; DIFFERENT inputs yield DIFFERENT keys;
//   • the passphrase derivation is PBKDF2-SHA256 at 600,000 iterations (pinned by an
//     independent known-answer cross-check — the only behavioural way to see the count);
//   • the recovery-auth value is a distinct HKDF output from the recovery wrapping key.
//
// Everything is awaited so the tests pass whether a derivation is sync or async
// (WebCrypto's deriveBits is async, so the implementation will be). These are pure
// client-crypto unit tests: WebCrypto entropy only, no DOM, no network, no database.
// node:crypto is used ONLY to compute independent expected values to compare against.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";

import {
  deriveWrappingKeyFromPrf,
  deriveWrappingKeyFromPassphrase,
  deriveWrappingKeyFromRecoveryCode,
  deriveRecoveryAuthValue,
} from "./derive";
// The wrap/unwrap primitive the derived keys must interoperate with (E11-S05).
import { createVaultKey, wrapVaultKey, unwrapVaultKey } from "./key";

const KEY_BYTES = 32; // a 256-bit AES wrapping key (design §4.2)
const PBKDF2_ITERATIONS = 600_000; // design §4.2: the mandated passphrase work factor

// Normalise whatever raw-key representation a derivation returns (Uint8Array,
// ArrayBuffer, Node Buffer, or any ArrayBufferView) to a Uint8Array, so the tests
// assert on the BYTES, not on the exact JS wrapper type.
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

// Copy a derived key into a fresh ArrayBuffer-backed Uint8Array — the exact shape
// the wrap/unwrap primitive takes — so interop tests feed it cleanly.
function wrappingBytes(key: unknown): Uint8Array<ArrayBuffer> {
  const bytes = toBytes(key);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

// A deterministic 32-byte "PRF output" for a given seed — byte-identical across
// calls with the same seed (so we test keying on BYTES, via two distinct objects),
// and different across seeds.
function prfOutput(seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (seed * 101 + i * 7 + 3) & 0xff;
  return bytes;
}

// A deterministic 16-byte salt for a given seed (design: the passphrase salt is 16 bytes).
function salt16(seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (seed * 37 + i * 13 + 5) & 0xff;
  return bytes;
}

// Representative inputs (ASCII passphrases so the WebCrypto UTF-8 encoding matches
// node's pbkdf2Sync string encoding exactly in the known-answer cross-check).
const PASSPHRASE = "correct horse battery staple";
const PASSPHRASE_OTHER = "an entirely different vault passphrase";
// 26-character RFC 4648 base32 recovery codes (design §4.2: 128 bits => 26 base32 chars).
const RECOVERY_CODE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const RECOVERY_CODE_OTHER = "234567QRSTUVWXYZABCDEFGHIJ";

// ---------------------------------------------------------------------------
// PRF output -> wrapping key: HKDF-SHA256(prf, info `warthog/vault-wrap/v1`)
// ---------------------------------------------------------------------------

test("PRF derivation is a 256-bit key, deterministic in the PRF bytes, and not pass-through", async () => {
  // Two distinct objects holding the SAME bytes — proves keying on bytes, not identity.
  const key1 = await deriveWrappingKeyFromPrf(prfOutput(1));
  const key2 = await deriveWrappingKeyFromPrf(prfOutput(1));

  assert.equal(toBytes(key1).length, KEY_BYTES, "a PRF wrapping key is 256 bits = 32 bytes");
  assert.equal(hex(key1), hex(key2), "the same PRF output must derive the same wrapping key");
  assert.notEqual(
    hex(key1),
    hex(prfOutput(1)),
    "the wrapping key must be a DERIVED key, never the raw PRF output passed straight through",
  );
});

test("different PRF outputs derive different wrapping keys", async () => {
  const keyA = await deriveWrappingKeyFromPrf(prfOutput(1));
  const keyB = await deriveWrappingKeyFromPrf(prfOutput(2));

  assert.notEqual(hex(keyA), hex(keyB), "distinct PRF outputs must derive distinct wrapping keys");
});

test("a PRF wrapping key seals a vault key that a re-derived key on another device unwraps", async () => {
  const vaultKey = await createVaultKey();

  // "This device": derive the wrapping key and seal the vault key under it.
  const here = wrappingBytes(await deriveWrappingKeyFromPrf(prfOutput(7)));
  const wrapped = await wrapVaultKey(here, vaultKey);

  // "Another device with the same passkey PRF": re-derive and unwrap.
  const there = wrappingBytes(await deriveWrappingKeyFromPrf(prfOutput(7)));
  const recovered = await unwrapVaultKey(there, wrapped);
  assert.equal(hex(recovered), hex(vaultKey), "a re-derived PRF key unwraps the same vault key byte-for-byte");

  // A key derived from a DIFFERENT PRF output must NOT unwrap it (keys are non-interoperable).
  const wrong = wrappingBytes(await deriveWrappingKeyFromPrf(prfOutput(8)));
  await assert.rejects(
    async () => unwrapVaultKey(wrong, wrapped),
    "a wrapping key from a different PRF output must fail the GCM tag, never silently unwrap",
  );
});

// ---------------------------------------------------------------------------
// Passphrase -> wrapping key: PBKDF2-SHA256, 600,000 iterations, 16-byte salt
// ---------------------------------------------------------------------------

test("passphrase derivation is deterministic, 256-bit, and is PBKDF2-SHA256 at 600,000 iterations (known-answer)", async () => {
  const salt = salt16(1);

  const key1 = await deriveWrappingKeyFromPassphrase(PASSPHRASE, salt);
  const key2 = await deriveWrappingKeyFromPassphrase(PASSPHRASE, salt);

  assert.equal(toBytes(key1).length, KEY_BYTES, "a passphrase wrapping key is 256 bits = 32 bytes");
  assert.equal(hex(key1), hex(key2), "the same passphrase + salt must derive the same wrapping key");

  // Independent known-answer: PBKDF2-SHA256 is a deterministic standard, so WebCrypto
  // and node:crypto agree byte-for-byte on the same password/salt/iterations/length.
  // This pins BOTH the algorithm (PBKDF2-SHA256, not a fast HKDF) and the 600,000 count:
  // a different iteration count or hash would make these bytes diverge.
  const expected = pbkdf2Sync(PASSPHRASE, Buffer.from(salt), PBKDF2_ITERATIONS, KEY_BYTES, "sha256");
  assert.equal(
    hex(key1),
    expected.toString("hex"),
    "the passphrase key must equal PBKDF2-SHA256(passphrase, salt, 600000, 32)",
  );
});

test("passphrase derivation depends on BOTH the passphrase and the salt", async () => {
  const base = await deriveWrappingKeyFromPassphrase(PASSPHRASE, salt16(1));
  const otherPassphrase = await deriveWrappingKeyFromPassphrase(PASSPHRASE_OTHER, salt16(1));
  const otherSalt = await deriveWrappingKeyFromPassphrase(PASSPHRASE, salt16(2));

  assert.notEqual(hex(base), hex(otherPassphrase), "a different passphrase (same salt) derives a different key");
  assert.notEqual(hex(base), hex(otherSalt), "a different salt (same passphrase) derives a different key");
});

test("a passphrase wrapping key seals a vault key that a re-derived key unwraps", async () => {
  const vaultKey = await createVaultKey();
  const salt = salt16(3);

  const here = wrappingBytes(await deriveWrappingKeyFromPassphrase(PASSPHRASE, salt));
  const wrapped = await wrapVaultKey(here, vaultKey);

  const there = wrappingBytes(await deriveWrappingKeyFromPassphrase(PASSPHRASE, salt));
  const recovered = await unwrapVaultKey(there, wrapped);
  assert.equal(hex(recovered), hex(vaultKey), "re-deriving from the same passphrase + salt unwraps the vault key exactly");
});

// ---------------------------------------------------------------------------
// Recovery code -> wrapping key: HKDF(code, info `warthog/vault-wrap/v1`)
// ---------------------------------------------------------------------------

test("recovery-code derivation is a 256-bit key and deterministic in the code", async () => {
  const key1 = await deriveWrappingKeyFromRecoveryCode(RECOVERY_CODE);
  const key2 = await deriveWrappingKeyFromRecoveryCode(RECOVERY_CODE);

  assert.equal(toBytes(key1).length, KEY_BYTES, "a recovery-code wrapping key is 256 bits = 32 bytes");
  assert.equal(hex(key1), hex(key2), "the same recovery code must derive the same wrapping key");
});

test("different recovery codes derive different wrapping keys", async () => {
  const keyA = await deriveWrappingKeyFromRecoveryCode(RECOVERY_CODE);
  const keyB = await deriveWrappingKeyFromRecoveryCode(RECOVERY_CODE_OTHER);

  assert.notEqual(hex(keyA), hex(keyB), "distinct recovery codes must derive distinct wrapping keys");
});

test("a recovery-code wrapping key seals a vault key that a re-derived key unwraps", async () => {
  const vaultKey = await createVaultKey();

  const here = wrappingBytes(await deriveWrappingKeyFromRecoveryCode(RECOVERY_CODE));
  const wrapped = await wrapVaultKey(here, vaultKey);

  const there = wrappingBytes(await deriveWrappingKeyFromRecoveryCode(RECOVERY_CODE));
  const recovered = await unwrapVaultKey(there, wrapped);
  assert.equal(hex(recovered), hex(vaultKey), "re-deriving from the same recovery code unwraps the vault key exactly");
});

// ---------------------------------------------------------------------------
// Recovery-auth value: HKDF(code, info `warthog/recovery-auth/v1`) — DISTINCT
// from the recovery wrapping key the SAME code derives.
// ---------------------------------------------------------------------------

test("recovery-auth value is deterministic in the code and differs across codes", async () => {
  const authA1 = await deriveRecoveryAuthValue(RECOVERY_CODE);
  const authA2 = await deriveRecoveryAuthValue(RECOVERY_CODE);
  const authB = await deriveRecoveryAuthValue(RECOVERY_CODE_OTHER);

  assert.ok(toBytes(authA1).length > 0, "the recovery-auth value is non-empty derived bytes");
  assert.equal(hex(authA1), hex(authA2), "the same recovery code must derive the same recovery-auth value");
  assert.notEqual(hex(authA1), hex(authB), "distinct recovery codes must derive distinct recovery-auth values");
});

test("the recovery-auth value is a DISTINCT HKDF output from the recovery wrapping key for the same code", async () => {
  // Both derive from the one recovery code but under different HKDF info labels
  // (`warthog/recovery-auth/v1` vs `warthog/vault-wrap/v1`), so the server's
  // recovery-sign-in verifier can never be used to recover the wrapping key.
  const wrappingKey = await deriveWrappingKeyFromRecoveryCode(RECOVERY_CODE);
  const authValue = await deriveRecoveryAuthValue(RECOVERY_CODE);

  assert.notEqual(
    hex(authValue),
    hex(wrappingKey),
    "the recovery-auth value must be domain-separated from the recovery wrapping key, never equal to it",
  );
});
