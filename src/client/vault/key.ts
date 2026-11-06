// Client vault key: create + wrap/unwrap primitive (design §4.2).
//
// The browser creates a random 256-bit **vault key (VK)** at first use with
// WebCrypto. VK is stored server-side only WRAPPED, once per unlock method, under
// a wrapping key that method derives (HKDF(PRF) / PBKDF2(passphrase) /
// HKDF(recovery code)). The wrap is AES-256-GCM with a random 96-bit nonce,
// written as a `v1:` versioned envelope — the same convention as the server DEK
// seam (src/server/crypto/envelope.ts): `v1:base64(nonce || ciphertext || tag)`.
//
// Unwrap is always GCM-tag verified: a wrong wrapping key or a tampered envelope
// makes WebCrypto's decrypt REJECT, so the failure propagates loudly and Warthog
// never silently hands back a bad or re-keyed value. There is no catch/fallback.
//
// This is browser code: it uses the WebCrypto globals (`crypto` / `crypto.subtle`)
// and base64 via `btoa`/`atob`, never Node's `Buffer`.

const KEY_BYTES = 32; // a 256-bit key (vault key and AES wrapping key alike)
const NONCE_BYTES = 12; // 96-bit AES-GCM nonce
const TAG_BYTES = 16; // 128-bit AES-GCM tag (WebCrypto appends it to the ciphertext)
const TAG_BITS = TAG_BYTES * 8;
const VERSION = "v1";
const PREFIX = `${VERSION}:`;

// WebCrypto key material is raw bytes backed by an ArrayBuffer (its BufferSource
// type excludes SharedArrayBuffer-backed views); getRandomValues / deriveBits
// yield exactly this, so the primitive speaks `Uint8Array<ArrayBuffer>` throughout.

// Create a fresh random 256-bit vault key as raw bytes. Each call is independent
// entropy from WebCrypto, so two keys never coincide.
export function createVaultKey(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

// Import a raw 256-bit AES key for a single GCM operation; it is non-extractable.
function importWrappingKey(
  wrappingKey: Uint8Array<ArrayBuffer>,
  usage: KeyUsage,
): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", wrappingKey, { name: "AES-GCM" }, false, [usage]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Seal the vault key under the wrapping key as a storable `v1:` envelope. A fresh
// random nonce per call means the same key wrapped twice yields different strings.
export async function wrapVaultKey(
  wrappingKey: Uint8Array<ArrayBuffer>,
  vaultKey: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const key = await importWrappingKey(wrappingKey, "encrypt");
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  // WebCrypto AES-GCM returns ciphertext || tag concatenated.
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: TAG_BITS }, key, vaultKey),
  );
  const envelope = new Uint8Array(nonce.length + sealed.length);
  envelope.set(nonce, 0);
  envelope.set(sealed, nonce.length);
  return PREFIX + toBase64(envelope);
}

// Recover the exact vault-key bytes under the SAME wrapping key. Throws (never
// returns a key) if the version is unrecognised, the envelope is too short, or the
// GCM tag fails to verify — a wrong wrapping key or a tampered envelope.
export async function unwrapVaultKey(
  wrappingKey: Uint8Array<ArrayBuffer>,
  wrapped: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!wrapped.startsWith(PREFIX)) {
    throw new Error(`unrecognised vault-key envelope version, expected ${VERSION}`);
  }
  const bytes = fromBase64(wrapped.slice(PREFIX.length));
  if (bytes.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error("vault-key envelope too short to hold a nonce and a full tag");
  }
  const nonce = bytes.subarray(0, NONCE_BYTES);
  const sealed = bytes.subarray(NONCE_BYTES);
  const key = await importWrappingKey(wrappingKey, "decrypt");
  // decrypt REJECTS on a failed GCM tag (wrong key or tampered blob); no silent
  // re-keying, no fallback — the rejection propagates to the caller.
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, tagLength: TAG_BITS },
    key,
    sealed,
  );
  return new Uint8Array(plaintext);
}
