// Client vault value encryption (design §4.2).
//
// High-tier identity values and card numbers are encrypted in the browser with
// the vault key (VK) before they leave the device; the server only ever stores
// and returns this ciphertext, and on release the browser decrypts it with VK.
// This module is that inverse pair for a value STRING — the string analogue of
// the key wrap/unwrap in src/client/vault/key.ts.
//
// The envelope is the repo's versioned-envelope convention, identical to the key
// seam and the server DEK (src/server/crypto/envelope.ts):
// `v1:base64(nonce || ciphertext || tag)`, AES-256-GCM under VK with a fresh
// random 96-bit nonce per call. Decrypt is always GCM-tag verified: an
// unrecognised version, a too-short envelope, a tampered blob or a wrong vault
// key makes WebCrypto's decrypt REJECT, so a bad value never silently comes
// back — there is no catch/fallback.
//
// This is browser code: it uses the WebCrypto globals (`crypto` / `crypto.subtle`),
// base64 via `btoa`/`atob`, and TextEncoder/TextDecoder for UTF-8 — never Node's
// `Buffer`, so every code point of the value round-trips exactly.

const NONCE_BYTES = 12; // 96-bit AES-GCM nonce
const TAG_BYTES = 16; // 128-bit AES-GCM tag (WebCrypto appends it to the ciphertext)
const TAG_BITS = TAG_BYTES * 8;
const VERSION = "v1";
const PREFIX = `${VERSION}:`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Import the raw 256-bit vault key for a single GCM operation; it is non-extractable.
function importVaultKey(vaultKey: Uint8Array<ArrayBuffer>, usage: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", vaultKey, { name: "AES-GCM" }, false, [usage]);
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

// Encrypt a value string under the vault key as a storable `v1:` envelope. The
// value is UTF-8 encoded, then AES-256-GCM sealed with a fresh random nonce — so
// the same value encrypted twice yields different strings, and the plaintext (in
// any form) never appears in the envelope.
export async function encryptValue(
  vaultKey: Uint8Array<ArrayBuffer>,
  plaintext: string,
): Promise<string> {
  const key = await importVaultKey(vaultKey, "encrypt");
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  // WebCrypto AES-GCM returns ciphertext || tag concatenated.
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: TAG_BITS },
      key,
      encoder.encode(plaintext),
    ),
  );
  const envelope = new Uint8Array(nonce.length + sealed.length);
  envelope.set(nonce, 0);
  envelope.set(sealed, nonce.length);
  return PREFIX + toBase64(envelope);
}

// Recover the exact original value string under the SAME vault key. Throws (never
// returns a value) if the version is unrecognised, the envelope is too short, or
// the GCM tag fails to verify — a wrong vault key or a tampered envelope.
export async function decryptValue(
  vaultKey: Uint8Array<ArrayBuffer>,
  ciphertext: string,
): Promise<string> {
  if (!ciphertext.startsWith(PREFIX)) {
    throw new Error(`unrecognised vault value envelope version, expected ${VERSION}`);
  }
  const bytes = fromBase64(ciphertext.slice(PREFIX.length));
  if (bytes.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error("vault value envelope too short to hold a nonce and a full tag");
  }
  const nonce = bytes.subarray(0, NONCE_BYTES);
  const sealed = bytes.subarray(NONCE_BYTES);
  const key = await importVaultKey(vaultKey, "decrypt");
  // decrypt REJECTS on a failed GCM tag (wrong key or tampered blob); no silent
  // fallback — the rejection propagates to the caller.
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, tagLength: TAG_BITS },
    key,
    sealed,
  );
  return decoder.decode(plaintext);
}
