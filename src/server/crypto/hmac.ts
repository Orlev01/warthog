// HMAC and keyed fingerprint helpers (design §4.2, §4.3, §5, §6.1).
//
//   - Codes and tokens are stored only as an HMAC, never in the clear. `hmac`
//     produces the storable digest; `verifyHmac` recomputes and compares it in
//     constant time, accepting only the correct value.
//   - A released high-tier value / card keeps only a keyed one-way fingerprint:
//       fingerprint(dek, value) = HMAC-SHA256(HKDF(DEK, "warthog/fp/v1"),
//                                              normalise(value))
//     stable for one person's DEK, distinct across persons, and folding trivial
//     surface differences so equivalent forms share one fingerprint.

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

import { normaliseValue } from "../../domain/redaction/luhn";

const HMAC_HASH = "sha256";
const FP_INFO = "warthog/fp/v1"; // HKDF context label for the fingerprint key (design §4.2)
const FP_KEY_BYTES = 32; // a 256-bit derived fingerprint key

// The storable one-way digest a code/token is kept as: HMAC-SHA256 as hex.
export function hmac(key: Uint8Array, value: string): string {
  return createHmac(HMAC_HASH, key).update(value, "utf8").digest("hex");
}

// Recompute the HMAC of `value` and compare it to `expected` in constant time,
// so only the value that produced `expected` verifies. A wrong-length (and so
// malformed) `expected` is rejected rather than throwing — node's
// timingSafeEqual throws on unequal lengths, so we guard the length first.
export function verifyHmac(key: Uint8Array, value: string, expected: string): boolean {
  const actual = Buffer.from(hmac(key, value), "utf8");
  const candidate = Buffer.from(expected, "utf8");
  if (actual.length !== candidate.length) {
    return false;
  }
  return timingSafeEqual(actual, candidate);
}

// The person's fingerprint key: HKDF of their DEK under the fixed context label.
function fingerprintKey(dek: Uint8Array): Buffer {
  return Buffer.from(hkdfSync(HMAC_HASH, dek, new Uint8Array(0), FP_INFO, FP_KEY_BYTES));
}

// The digest of an ALREADY-normalised value under a derived fingerprint key.
function digest(key: Buffer, normalised: string): string {
  return createHmac(HMAC_HASH, key).update(normalised, "utf8").digest("hex");
}

// A keyed, one-way fingerprint of a released value. The HMAC key is derived from
// the person's DEK via HKDF with a fixed context label, so the fingerprint is
// stable per person and differs across persons for the same value. The value is
// normalised with the SAME normaliser redaction applies to what it scans (letter case,
// spaces and punctuation fold away, design §4.3), so a released "AB-123-456" matches
// the value when it is seen later as "ab 123 456".
export function fingerprint(dek: Uint8Array, value: string): string {
  return digest(fingerprintKey(dek), normaliseValue(value));
}

// The released-value matcher redaction consults for one person (design §4.3 rule 3):
// true when an already-normalised candidate's fingerprint is one of `fingerprints` (the
// person's live release fingerprints). The key is derived once per matcher; with no
// fingerprints it never matches and does no HMAC work.
export function releasedValueMatcher(
  dek: Uint8Array,
  fingerprints: Iterable<string>,
): (normalisedToken: string) => boolean {
  const live = new Set(fingerprints);
  if (live.size === 0) return () => false;
  const key = fingerprintKey(dek);
  return (normalisedToken) => live.has(digest(key, normalisedToken));
}
