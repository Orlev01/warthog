// Client vault wrapping-key derivation (design §4.2).
//
// VK is stored server-side only WRAPPED, once per unlock method, under a wrapping
// key that method derives. Each method seals the SAME vault key, so a key wrapped
// under one method must unwrap on any device that can re-derive that method's
// wrapping key — every derivation here is therefore fully deterministic in its
// inputs:
//
//   • Passkey PRF:      HKDF-SHA256(prf output, info `warthog/vault-wrap/v1`).
//   • Vault passphrase:  PBKDF2-SHA256, 600,000 iterations, 16-byte salt.
//   • Recovery code:     HKDF-SHA256(code, info `warthog/vault-wrap/v1`); the server
//     separately stores scrypt(HKDF(code, info `warthog/recovery-auth/v1`)) to verify
//     a recovery sign-in WITHOUT learning the wrapping key, so the browser's
//     recovery-auth value is a DISTINCT HKDF output (different info label) from the
//     recovery wrapping key the same code derives.
//
// This is browser code: it uses the WebCrypto globals (`crypto.subtle`), never
// Node's `Buffer`. The HKDF here matches the server's node:crypto HKDF (empty salt,
// info label as bytes — the design names only the info) so the recovery-auth value
// derived here equals the value the server verifies.

const KEY_BYTES = 32; // a 256-bit AES wrapping key (design §4.2)
const KEY_BITS = KEY_BYTES * 8;
const PBKDF2_ITERATIONS = 600_000; // design §4.2: the mandated passphrase work factor

const WRAP_INFO = "warthog/vault-wrap/v1"; // HKDF context label for every wrapping key
const RECOVERY_AUTH_INFO = "warthog/recovery-auth/v1"; // distinct label for the recovery-auth value

const encoder = new TextEncoder();

// HKDF-SHA256 with an empty salt (the design names only the info), domain-separated
// by `info`, producing a 256-bit output as raw bytes. Deterministic in (ikm, info).
async function deriveHkdf(ikm: BufferSource, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(info) },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

// Passkey PRF output -> 256-bit AES wrapping key, HKDF-SHA256 under the vault-wrap label.
export function deriveWrappingKeyFromPrf(
  prfOutput: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return deriveHkdf(prfOutput, WRAP_INFO);
}

// Recovery code -> 256-bit AES wrapping key, HKDF-SHA256 under the vault-wrap label.
export function deriveWrappingKeyFromRecoveryCode(code: string): Promise<Uint8Array<ArrayBuffer>> {
  return deriveHkdf(encoder.encode(code), WRAP_INFO);
}

// Recovery code -> the recovery-auth value, HKDF-SHA256 under the recovery-auth label —
// a DISTINCT output from the recovery wrapping key the same code derives, so the
// server's recovery-sign-in verifier can never be used to recover the wrapping key.
export function deriveRecoveryAuthValue(code: string): Promise<Uint8Array<ArrayBuffer>> {
  return deriveHkdf(encoder.encode(code), RECOVERY_AUTH_INFO);
}

// Vault passphrase + 16-byte salt -> 256-bit AES wrapping key, PBKDF2-SHA256 at the
// mandated 600,000 iterations. Deterministic in (passphrase, salt).
export async function deriveWrappingKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}
