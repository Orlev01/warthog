// Client vault recovery phrase (review fix W1; design §4.2 "Recovery code" wrapping;
// brief "Vault unlock methods").
//
// Without it, a person who lost every passkey and set no vault passphrase could never
// unlock their vault again. The browser generates a VAULT RECOVERY PHRASE when the vault is
// first set up, shows it once, wraps the vault key (VK) under a key derived from it and
// saves that envelope as unlock method 'recovery'. The server only ever holds the envelope:
// the phrase never leaves the device.
//
//   • Entropy: 20 random bytes from WebCrypto = 160 bits (the bar is 128), shown as 32
//     RFC 4648 base32 characters in 8 groups of 4 ("ABCD-EFGH-…") — the same alphabet as
//     the sign-in recovery code, but longer, so the two are never confused.
//   • Wrapping key: HKDF-SHA256(canonical phrase, info `warthog/vault-wrap/v1`) through
//     derive.ts, then the AES-256-GCM wrap in key.ts. A 160-bit secret needs no slow KDF.
//   • Typing it back is forgiving: case, spaces, dashes and the look-alike digits 0 and 1
//     (read as O and I) do not matter. A phrase of the wrong length is refused before any
//     crypto runs.
//
// Browser code: WebCrypto globals only, never Node's Buffer, the DOM or the network.

import { deriveWrappingKeyFromRecoveryCode } from "./derive";
import { unwrapVaultKey, wrapVaultKey } from "./key";

const PHRASE_BYTES = 20; // 160 random bits
const PHRASE_CHARS = 32; // 160 bits / 5 bits per base32 character
const GROUP_SIZE = 4;
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// Encode raw bytes as RFC 4648 base32 (no padding). 20 bytes encode to exactly 32
// characters, with no partial trailing group.
function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// The readable grouped form of a canonical phrase: 8 groups of 4, joined by dashes.
function groupPhrase(canonical: string): string {
  const groups: string[] = [];
  for (let i = 0; i < canonical.length; i += GROUP_SIZE) groups.push(canonical.slice(i, i + GROUP_SIZE));
  return groups.join("-");
}

// A fresh recovery phrase in its grouped form. Each call is independent WebCrypto entropy.
export function generateRecoveryPhrase(): string {
  return groupPhrase(base32Encode(crypto.getRandomValues(new Uint8Array(PHRASE_BYTES))));
}

// A typed recovery secret's characters in canonical form: upper case, the look-alike
// digits 0 and 1 read as O and I (neither is in the alphabet), and everything outside the
// alphabet — spaces, dashes, any grouping — dropped. The unlock seam applies it too, so a
// phrase typed in any case or grouping derives the same wrapping key.
export function canonicalRecoveryCharacters(input: string): string {
  return input
    .toUpperCase()
    .replace(/0/g, "O")
    .replace(/1/g, "I")
    .replace(/[^A-Z2-7]/g, "");
}

// The canonical form of a typed phrase, or null when it is not a whole phrase.
export function normaliseRecoveryPhrase(input: string): string | null {
  const canonical = canonicalRecoveryCharacters(input);
  return canonical.length === PHRASE_CHARS ? canonical : null;
}

// The wrapping key a phrase derives, refusing a malformed phrase before any crypto runs.
function wrappingKeyFor(phrase: string): Promise<Uint8Array<ArrayBuffer>> {
  const canonical = normaliseRecoveryPhrase(phrase);
  if (canonical === null) return Promise.reject(new Error("that isn't a whole recovery phrase"));
  return deriveWrappingKeyFromRecoveryCode(canonical);
}

// Seal the vault key under the phrase as a storable `v1:` envelope (method 'recovery').
export async function wrapVaultKeyWithRecoveryPhrase(
  phrase: string,
  vaultKey: Uint8Array<ArrayBuffer>,
): Promise<string> {
  return wrapVaultKey(await wrappingKeyFor(phrase), vaultKey);
}

// Recover the vault key from the 'recovery' envelope with a typed phrase. Rejects (never
// returns a key, never re-keys) for a malformed phrase, a wrong one or a tampered envelope.
export async function unlockWithRecoveryPhrase(
  phrase: string,
  wrapped: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return unwrapVaultKey(await wrappingKeyFor(phrase), wrapped);
}

// The text of the "Download" copy: the grouped phrase with a few plain lines on what it is.
export function recoveryPhraseFileText(phrase: string): string {
  return [
    "Warthog vault recovery phrase",
    "",
    phrase,
    "",
    "This phrase unlocks your Warthog vault if you lose every passkey.",
    "Keep it somewhere safe and private. Warthog cannot see it or send it to you again.",
    "",
  ].join("\n");
}
