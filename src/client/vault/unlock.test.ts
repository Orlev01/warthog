// E11-S08 — client vault unlock + seal helper (`src/client/vault/unlock.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// here fails until the implementation lands. These pin BEHAVIOUR (what unlock and
// seal DO with bytes, envelopes and value strings), never the source text of the
// module.
//
// Design §4.2: the only place the unwrapped vault key (VK) ever lives is this
// in-memory client helper. VK is stored server-side only WRAPPED, once per unlock
// method (`vault_unlock_methods`), under a wrapping key that method derives:
//   • Passkey PRF:   wrapping key = HKDF-SHA256(prf output, …)   — secret: prf bytes.
//   • Vault passphrase: PBKDF2-SHA256(passphrase, salt, 600000)  — secret: passphrase.
//   • Recovery code: wrapping key = HKDF(code, …)                — secret: the code.
// "Unwrap is always verified (GCM tag). If a PRF-derived key fails to unwrap …
// fall back to passphrase/recovery code — never silently re-key."
//
// unlock.ts COMPOSES the sibling seams (it adds no new crypto):
//   • derive.ts  — deriveWrappingKeyFrom{Prf,Passphrase,RecoveryCode}
//   • key.ts     — wrapVaultKey / unwrapVaultKey (the VK wrap primitive)
//   • values.ts  — encryptValue / decryptValue (the value seal primitive)
//
// ── The contract these tests define (the tester fixes the seam the builder fills) ──
//
//   unlockVault({ method, material, secret }) -> the vault key as raw bytes.
//     method:   "prf" | "passphrase" | "recovery" — the method to unlock with.
//     material: { wrapped: string; salt?: Uint8Array<ArrayBuffer> }
//               the STORED, non-secret unlock-method record — the `v1:` wrapped-VK
//               envelope (`wrapped`) plus, for a passphrase method, its 16-byte
//               PBKDF2 salt. (prf/recovery need no salt.)
//     secret:   the USER-SUPPLIED secret for the method — the PRF output bytes
//               (Uint8Array) for "prf", or the passphrase / recovery-code STRING
//               for "passphrase" / "recovery".
//     • derives the method's wrapping key, unwraps `material.wrapped`, and returns
//       the EXACT original VK bytes for a correct secret;
//     • THROWS a plain Error (never returns a key, never silently re-keys) for a
//       wrong secret, a wrong salt, a tampered envelope, or any failed GCM tag —
//       which is what lets a failed PRF fall back to passphrase/recovery safely.
//
//   sealForSave(vaultKey, value) -> a storable `v1:` ciphertext string.
//     • encrypts a high-tier value or a card number under the unlocked VK;
//     • the ciphertext round-trips back to the original under the SAME VK.
//
// Fixtures are built with the REAL derive.ts + key.ts (the server-side wrap each
// method would store), so these tests prove unlock RE-DERIVES the method's wrapping
// key and interoperates with the wrap primitive — not merely that it unwraps a raw
// key. Everything is awaited so the tests pass whether the impl is sync or async.
// Pure client-crypto unit tests: WebCrypto entropy only, no DOM, no network, no DB.
// node:crypto is used ONLY for independent entropy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import { unlockVault, sealForSave } from "./unlock";
// The sibling seams unlock.ts composes — used here to BUILD the stored material
// (as the real methods would) and to verify the sealed value round-trips.
import { createVaultKey, wrapVaultKey } from "./key";
import {
  deriveWrappingKeyFromPrf,
  deriveWrappingKeyFromPassphrase,
  deriveWrappingKeyFromRecoveryCode,
} from "./derive";
import { decryptValue } from "./values";

const KEY_BYTES = 32; // the vault key is a 256-bit = 32-byte AES key

// --- byte helpers (assert on BYTES, not on the exact JS wrapper type) ---

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

// Copy derived/key bytes into a fresh ArrayBuffer-backed Uint8Array — the exact
// shape the wrap primitive takes — so building the fixture material feeds cleanly.
function wrappingBytes(key: unknown): Uint8Array<ArrayBuffer> {
  const bytes = toBytes(key);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

// A deterministic 32-byte "PRF output" for a seed — byte-identical across calls
// with the same seed (keying on BYTES), different across seeds. Stands in for the
// `results.first` a WebAuthn get() returns.
function prfOutput(seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (seed * 101 + i * 7 + 3) & 0xff;
  return bytes;
}

// A deterministic 16-byte passphrase salt for a seed (design §4.2: salt is 16 bytes).
function salt16(seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (seed * 37 + i * 13 + 5) & 0xff;
  return bytes;
}

// Representative secrets (ASCII passphrase; 26-char base32 recovery code per §4.2).
const PASSPHRASE = "correct horse battery staple";
const PASSPHRASE_WRONG = "an entirely different vault passphrase";
const RECOVERY_CODE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const RECOVERY_CODE_WRONG = "234567QRSTUVWXYZABCDEFGHIJ";

// Representative plaintexts to seal: a high-tier identity value and a card number.
// The high-tier marker is long and distinctive so the no-leak check is meaningful.
const HIGH_TIER_VALUE = "PA1234567DONOTLEAKmarker7f3a9c2bQ8";
const CARD_NUMBER = "4111 1111 1111 1111";

// The per-method stored material (wrapped-VK envelope + passphrase salt) all sealing
// the SAME vault key — exactly what `vault_unlock_methods` would hold for a person.
interface StoredMaterial {
  prf: { wrapped: string };
  passphrase: { wrapped: string; salt: Uint8Array<ArrayBuffer> };
  recovery: { wrapped: string };
}

// Seal one VK under each method's REAL wrapping-key derivation, as the server stores it.
async function sealVaultKeyForAllMethods(
  vaultKey: Uint8Array<ArrayBuffer>,
  opts: {
    prf: Uint8Array<ArrayBuffer>;
    passphrase: string;
    salt: Uint8Array<ArrayBuffer>;
    recovery: string;
  },
): Promise<StoredMaterial> {
  const prfKey = wrappingBytes(await deriveWrappingKeyFromPrf(opts.prf));
  const passKey = wrappingBytes(await deriveWrappingKeyFromPassphrase(opts.passphrase, opts.salt));
  const recKey = wrappingBytes(await deriveWrappingKeyFromRecoveryCode(opts.recovery));
  return {
    prf: { wrapped: await wrapVaultKey(prfKey, vaultKey) },
    passphrase: { wrapped: await wrapVaultKey(passKey, vaultKey), salt: opts.salt },
    recovery: { wrapped: await wrapVaultKey(recKey, vaultKey) },
  };
}

// Change exactly one character in the ciphertext/tag region of the envelope (the
// payload after the "v1:" prefix) so GCM-tag verification — not a version/format
// check — is what rejects it. A single swap in the base64 alphabet keeps it
// decodable, so unwrap must still fail on the authentication tag.
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

// Robust across sync-throw and async-reject implementations: the async wrapper
// turns a synchronous throw into a rejection and — crucially — a NON-throwing
// return into a resolution, which assert.rejects then fails on. That is the
// "never silently returns a key / never re-keys" guarantee: resolving to ANY key
// here fails the test. Also asserts the thrown thing is a plain Error.
async function assertUnlockRejects(
  request: Parameters<typeof unlockVault>[0],
  message: string,
): Promise<void> {
  await assert.rejects(
    async () => {
      await unlockVault(request);
    },
    (err: unknown) => {
      assert.ok(err instanceof Error, "unlockVault must throw a plain Error, not re-key or return");
      return true;
    },
    message,
  );
}

// ---------------------------------------------------------------------------
// AC: unlockVault returns the vault key for a correct PRF / passphrase / recovery
// ---------------------------------------------------------------------------

test("unlocks with the correct PRF output and returns the original vault key", async () => {
  const vaultKey = await createVaultKey();
  const material = await sealVaultKeyForAllMethods(vaultKey, {
    prf: prfOutput(1),
    passphrase: PASSPHRASE,
    salt: salt16(1),
    recovery: RECOVERY_CODE,
  });

  const unlocked = await unlockVault({
    method: "prf",
    material: material.prf,
    secret: prfOutput(1),
  });

  assert.equal(toBytes(unlocked).length, KEY_BYTES, "the unlocked vault key is 256 bits");
  assert.equal(hex(unlocked), hex(vaultKey), "PRF unlock recovers the original vault key exactly");
});

test("unlocks with the correct passphrase + salt and returns the original vault key", async () => {
  const vaultKey = await createVaultKey();
  const material = await sealVaultKeyForAllMethods(vaultKey, {
    prf: prfOutput(2),
    passphrase: PASSPHRASE,
    salt: salt16(2),
    recovery: RECOVERY_CODE,
  });

  const unlocked = await unlockVault({
    method: "passphrase",
    material: material.passphrase,
    secret: PASSPHRASE,
  });

  assert.equal(hex(unlocked), hex(vaultKey), "passphrase unlock recovers the original vault key exactly");
});

test("unlocks with the correct recovery code and returns the original vault key", async () => {
  const vaultKey = await createVaultKey();
  const material = await sealVaultKeyForAllMethods(vaultKey, {
    prf: prfOutput(3),
    passphrase: PASSPHRASE,
    salt: salt16(3),
    recovery: RECOVERY_CODE,
  });

  const unlocked = await unlockVault({
    method: "recovery",
    material: material.recovery,
    secret: RECOVERY_CODE,
  });

  assert.equal(hex(unlocked), hex(vaultKey), "recovery unlock recovers the original vault key exactly");
});

test("every method unlocks to the SAME vault key (one VK sealed per method)", async () => {
  const vaultKey = await createVaultKey();
  const salt = salt16(4);
  const material = await sealVaultKeyForAllMethods(vaultKey, {
    prf: prfOutput(4),
    passphrase: PASSPHRASE,
    salt,
    recovery: RECOVERY_CODE,
  });

  const viaPrf = await unlockVault({ method: "prf", material: material.prf, secret: prfOutput(4) });
  const viaPass = await unlockVault({
    method: "passphrase",
    material: material.passphrase,
    secret: PASSPHRASE,
  });
  const viaRec = await unlockVault({
    method: "recovery",
    material: material.recovery,
    secret: RECOVERY_CODE,
  });

  assert.equal(hex(viaPrf), hex(vaultKey), "PRF yields the shared vault key");
  assert.equal(hex(viaPass), hex(vaultKey), "passphrase yields the shared vault key");
  assert.equal(hex(viaRec), hex(vaultKey), "recovery yields the shared vault key");
});

// ---------------------------------------------------------------------------
// AC: a wrong secret / wrong salt / tampered envelope / failed tag THROWS and
// never returns a key (never silently re-keys)
// ---------------------------------------------------------------------------

test("a WRONG passphrase throws and returns no key", async () => {
  const vaultKey = await createVaultKey();
  const material = await sealVaultKeyForAllMethods(vaultKey, {
    prf: prfOutput(5),
    passphrase: PASSPHRASE,
    salt: salt16(5),
    recovery: RECOVERY_CODE,
  });

  await assertUnlockRejects(
    { method: "passphrase", material: material.passphrase, secret: PASSPHRASE_WRONG },
    "a wrong passphrase must fail the GCM tag, never silently yield a key",
  );
});

test("a WRONG salt (right passphrase) throws — the salt is part of the derivation", async () => {
  const vaultKey = await createVaultKey();
  const material = await sealVaultKeyForAllMethods(vaultKey, {
    prf: prfOutput(6),
    passphrase: PASSPHRASE,
    salt: salt16(6),
    recovery: RECOVERY_CODE,
  });

  await assertUnlockRejects(
    { method: "passphrase", material: { wrapped: material.passphrase.wrapped, salt: salt16(99) }, secret: PASSPHRASE },
    "a different salt derives a different wrapping key, so unwrap must fail",
  );
});

test("a WRONG recovery code throws and returns no key", async () => {
  const vaultKey = await createVaultKey();
  const material = await sealVaultKeyForAllMethods(vaultKey, {
    prf: prfOutput(7),
    passphrase: PASSPHRASE,
    salt: salt16(7),
    recovery: RECOVERY_CODE,
  });

  await assertUnlockRejects(
    { method: "recovery", material: material.recovery, secret: RECOVERY_CODE_WRONG },
    "a wrong recovery code must fail the GCM tag, never silently yield a key",
  );
});

test("a VARIANT PRF output (wrong bytes) throws — never re-keys", async () => {
  // Apple has acknowledged occasional PRF output differences across devices: the
  // device reports prfOutput(9) but the VK was sealed under prfOutput(8).
  const vaultKey = await createVaultKey();
  const material = await sealVaultKeyForAllMethods(vaultKey, {
    prf: prfOutput(8),
    passphrase: PASSPHRASE,
    salt: salt16(8),
    recovery: RECOVERY_CODE,
  });

  await assertUnlockRejects(
    { method: "prf", material: material.prf, secret: prfOutput(9) },
    "a PRF output that does not re-derive the wrapping key must throw, never re-key",
  );
});

test("a TAMPERED wrapped envelope throws (GCM tag), never returns garbage bytes", async () => {
  const vaultKey = await createVaultKey();
  const material = await sealVaultKeyForAllMethods(vaultKey, {
    prf: prfOutput(10),
    passphrase: PASSPHRASE,
    salt: salt16(10),
    recovery: RECOVERY_CODE,
  });

  await assertUnlockRejects(
    { method: "recovery", material: { wrapped: tamper(material.recovery.wrapped) }, secret: RECOVERY_CODE },
    "a one-character change to the ciphertext/tag must be rejected, never silently unwrapped",
  );
});

// ---------------------------------------------------------------------------
// AC: a failed PRF unwrap FALLS BACK to passphrase/recovery rather than silently
// creating a NEW vault key — the fallback recovers the ORIGINAL VK.
// ---------------------------------------------------------------------------

test("after a failed PRF, a passphrase unlock recovers the ORIGINAL vault key (no silent re-key)", async () => {
  const vaultKey = await createVaultKey();
  const salt = salt16(11);
  const material = await sealVaultKeyForAllMethods(vaultKey, {
    prf: prfOutput(11),
    passphrase: PASSPHRASE,
    salt,
    recovery: RECOVERY_CODE,
  });

  // PRF comes back, but its derived key does NOT unwrap the PRF material (variance).
  await assertUnlockRejects(
    { method: "prf", material: material.prf, secret: prfOutput(12) },
    "the failed PRF must throw, not return a (new) key",
  );

  // The React layer then falls back to the passphrase — and gets the SAME VK back.
  const recovered = await unlockVault({
    method: "passphrase",
    material: material.passphrase,
    secret: PASSPHRASE,
  });
  assert.equal(
    hex(recovered),
    hex(vaultKey),
    "the passphrase fallback must recover the ORIGINAL vault key, not a silently-created new one",
  );
});

test("after a failed PRF, a recovery unlock recovers the ORIGINAL vault key (no silent re-key)", async () => {
  const vaultKey = await createVaultKey();
  const material = await sealVaultKeyForAllMethods(vaultKey, {
    prf: prfOutput(13),
    passphrase: PASSPHRASE,
    salt: salt16(13),
    recovery: RECOVERY_CODE,
  });

  await assertUnlockRejects(
    { method: "prf", material: material.prf, secret: prfOutput(14) },
    "the failed PRF must throw, not return a (new) key",
  );

  const recovered = await unlockVault({
    method: "recovery",
    material: material.recovery,
    secret: RECOVERY_CODE,
  });
  assert.equal(
    hex(recovered),
    hex(vaultKey),
    "the recovery fallback must recover the ORIGINAL vault key, not a silently-created new one",
  );
});

test("a value sealed earlier still opens under the fallback vault key (the fallback VK is the real one)", async () => {
  const vaultKey = await createVaultKey();
  const material = await sealVaultKeyForAllMethods(vaultKey, {
    prf: prfOutput(15),
    passphrase: PASSPHRASE,
    salt: salt16(15),
    recovery: RECOVERY_CODE,
  });

  // A card was sealed before this unlock session, under the real VK.
  const savedCipher = await sealForSave(vaultKey, CARD_NUMBER);

  // PRF fails; fall back to the passphrase.
  await assertUnlockRejects(
    { method: "prf", material: material.prf, secret: prfOutput(16) },
    "the failed PRF must throw",
  );
  const fallbackKey = await unlockVault({
    method: "passphrase",
    material: material.passphrase,
    secret: PASSPHRASE,
  });

  // If the fallback had silently re-keyed, the earlier ciphertext could not open.
  assert.equal(
    await decryptValue(fallbackKey, savedCipher),
    CARD_NUMBER,
    "a value sealed before the fallback must still decrypt under the fallback VK",
  );
});

// ---------------------------------------------------------------------------
// AC: sealForSave encrypts a value under the unlocked VK; the ciphertext
// round-trips back to the original.
// ---------------------------------------------------------------------------

test("sealForSave then decrypt returns a high-tier value unchanged", async () => {
  const vaultKey = await createVaultKey();

  const ciphertext = await sealForSave(vaultKey, HIGH_TIER_VALUE);
  const recovered = await decryptValue(vaultKey, ciphertext);

  assert.equal(typeof ciphertext, "string", "sealForSave returns a storable string");
  assert.ok(ciphertext.startsWith("v1"), `the sealed form carries its version marker, saw: ${ciphertext.slice(0, 8)}`);
  assert.equal(recovered, HIGH_TIER_VALUE, "the sealed high-tier value round-trips exactly");
});

test("sealForSave then decrypt returns a card number unchanged (spaces intact)", async () => {
  const vaultKey = await createVaultKey();

  const ciphertext = await sealForSave(vaultKey, CARD_NUMBER);
  const recovered = await decryptValue(vaultKey, ciphertext);

  assert.equal(recovered, CARD_NUMBER, "the sealed card number round-trips byte-for-byte");
});

test("sealForSave's ciphertext does not contain the plaintext in the clear", async () => {
  const vaultKey = await createVaultKey();

  // Scoped narrowly to the sealForSave OUTPUT (the unit under test): the stored
  // form is ciphertext, so the value must not appear verbatim, nor as the base64
  // of its UTF-8 bytes.
  const ciphertext = await sealForSave(vaultKey, HIGH_TIER_VALUE);

  assert.ok(!ciphertext.includes(HIGH_TIER_VALUE), "the value must not appear in the clear");
  assert.ok(
    !ciphertext.includes(Buffer.from(HIGH_TIER_VALUE, "utf8").toString("base64")),
    "the value's bytes must not appear as base64 in the sealed form",
  );
});

test("seal under a method's VK, then decrypt under another method's VK (same VK) returns the original", async () => {
  // End-to-end composition: unlock via PRF, seal a value, and open it with the VK
  // a passphrase unlock yields — proving every method unlocks to the one VK the
  // value was sealed under, and that seal/unlock compose cleanly.
  const vaultKey = await createVaultKey();
  const material = await sealVaultKeyForAllMethods(vaultKey, {
    prf: prfOutput(17),
    passphrase: PASSPHRASE,
    salt: salt16(17),
    recovery: RECOVERY_CODE,
  });

  const prfKey = await unlockVault({ method: "prf", material: material.prf, secret: prfOutput(17) });
  const sealed = await sealForSave(prfKey, HIGH_TIER_VALUE);

  const passKey = await unlockVault({
    method: "passphrase",
    material: material.passphrase,
    secret: PASSPHRASE,
  });
  assert.equal(
    await decryptValue(passKey, sealed),
    HIGH_TIER_VALUE,
    "a value sealed under the PRF-unlocked VK opens under the passphrase-unlocked VK (one shared VK)",
  );
});

test("the vault key sealForSave uses is the unlocked one: round-trips distinct values", async () => {
  const vaultKey = await createVaultKey();
  const material = await sealVaultKeyForAllMethods(vaultKey, {
    prf: prfOutput(18),
    passphrase: PASSPHRASE,
    salt: salt16(18),
    recovery: RECOVERY_CODE,
  });
  const unlocked = await unlockVault({ method: "prf", material: material.prf, secret: prfOutput(18) });

  for (let i = 0; i < 5; i += 1) {
    const value = `high-tier-detail-#${i}-${webcrypto.randomUUID()}`;
    const recovered = await decryptValue(unlocked, await sealForSave(unlocked, value));
    assert.equal(recovered, value, `value #${i} sealed under the unlocked VK must round-trip exactly`);
  }
});
