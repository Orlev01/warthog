// E01-S08 — HMAC and keyed fingerprint helpers (`src/server/crypto/hmac.ts`).
//
// These tests are RED-first: the module does not exist yet. They pin BEHAVIOUR
// (what the helpers return / decide for given inputs), never the source text of
// the module — no assertion reads `hmac.ts`, so a later rename that preserves
// behaviour leaves them untouched.
//
// Two capabilities the task adds (design §4.2, §5, §6.1):
//
//   1. Constant-time HMAC verification. Codes and tokens are stored only as an
//      HMAC, never in the clear. `hmac(key, value)` produces the storable digest;
//      `verifyHmac(key, value, expected)` recomputes it and compares in constant
//      time, so it accepts ONLY the correct value and rejects everything else —
//      and a malformed/wrong-length `expected` is rejected (returns false), never
//      throws, which is the observable consequence of a length-safe constant-time
//      comparator.
//
//   2. A keyed one-way fingerprint of a released value (design §4.2):
//        fingerprint(dek, value) = HMAC(HKDF(DEK, "warthog/fp/v1"), normalise(value))
//      It is STABLE for the same value under the same person's DEK (so a value
//      fingerprinted at release time matches the same value seen later), DIFFERS
//      across persons (a different DEK yields a different fingerprint for the same
//      value), is one-way (never embeds the plaintext), and folds trivial surface
//      differences (surrounding whitespace, letter case) so equivalent forms of a
//      value share one fingerprint.
//
// All helper calls are awaited so these tests pass whether the implementation is
// synchronous (the natural choice — node:crypto HMAC/HKDF are sync) or async:
// `await` on a plain value yields the value unchanged. Tests use only node:crypto
// for key/DEK bytes and never touch the network, Azure or a database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { hmac, verifyHmac, fingerprint, releasedValueMatcher } from "./hmac";

const KEY_BYTES = 32; // a 256-bit server HMAC secret (design §2: session/HMAC secrets)
const DEK_BYTES = 32; // a 256-bit per-person data key (design §4.1)

function freshKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// Flip one character in the middle of a digest string, producing a value of the
// SAME length that is not the original — so a comparison that rejects it is
// rejecting on content, not on length.
function flipMiddle(digest: string): string {
  assert.ok(digest.length > 0, "cannot flip an empty digest");
  const i = Math.floor(digest.length / 2);
  const replacement = digest[i] === "a" ? "b" : "a";
  return digest.slice(0, i) + replacement + digest.slice(i + 1);
}

// ---------------------------------------------------------------------------
// hmac(key, value): the storable one-way digest a code/token is kept as.
// ---------------------------------------------------------------------------

test("hmac returns a non-empty, storable string", async () => {
  const key = freshKey();

  const digest = await hmac(key, "123456");

  assert.equal(typeof digest, "string", "the HMAC is a storable string");
  assert.ok(digest.length > 0, "the HMAC is non-empty");
});

test("hmac is deterministic: the same key and value give the same digest", async () => {
  const key = freshKey();

  const a = await hmac(key, "one-time-code-42");
  const b = await hmac(key, "one-time-code-42");

  assert.equal(a, b, "the same key and value must always hash to the same digest");
});

test("hmac keyed on the bytes, not the object: an equal-bytes key gives the same digest", async () => {
  const bytes = freshKey();
  const sameBytes = Uint8Array.from(bytes); // a distinct object, identical bytes

  assert.equal(
    await hmac(bytes, "session-token"),
    await hmac(sameBytes, "session-token"),
    "a key reconstructed from the same bytes must produce the same HMAC",
  );
});

test("hmac differs for different values under the same key", async () => {
  const key = freshKey();

  assert.notEqual(
    await hmac(key, "123456"),
    await hmac(key, "123457"),
    "distinct values must not collide to the same HMAC",
  );
});

test("hmac differs for the same value under different keys", async () => {
  const value = "123456";

  assert.notEqual(
    await hmac(freshKey(), value),
    await hmac(freshKey(), value),
    "the HMAC is keyed: a different secret must change the digest",
  );
});

test("hmac does not embed the plaintext value (one-way)", async () => {
  const key = freshKey();
  // Contains a space and '!' — outside the hex and base64 alphabets, so if this
  // exact string appeared in the digest it could only be the raw value leaking.
  const value = "sign in code !!";

  const digest = await hmac(key, value);

  assert.ok(
    !digest.includes(value),
    "the stored HMAC must not contain the value it was computed from",
  );
});

// ---------------------------------------------------------------------------
// verifyHmac(key, value, expected): constant-time, accepts ONLY the right value.
// (True timing cannot be unit-tested; we pin the observable contract — correct
//  value accepted, everything else rejected, and length-mismatched input
//  rejected rather than throwing, which a length-safe comparator guarantees.)
// ---------------------------------------------------------------------------

test("verifyHmac accepts the correct value against its own stored HMAC", async () => {
  const key = freshKey();
  const code = "654321";
  const stored = await hmac(key, code);

  assert.equal(
    await verifyHmac(key, code, stored),
    true,
    "the value that produced the stored HMAC must verify",
  );
});

test("verifyHmac rejects a wrong value under the right key", async () => {
  const key = freshKey();
  const stored = await hmac(key, "654321");

  assert.equal(
    await verifyHmac(key, "654320", stored),
    false,
    "a value that did not produce the stored HMAC must not verify",
  );
});

test("verifyHmac rejects the right value under the wrong key", async () => {
  const stored = await hmac(freshKey(), "654321");

  assert.equal(
    await verifyHmac(freshKey(), "654321", stored),
    false,
    "verification is keyed: the wrong secret must not verify",
  );
});

test("verifyHmac rejects a tampered expected digest of the same length", async () => {
  const key = freshKey();
  const code = "654321";
  const stored = await hmac(key, code);

  assert.equal(
    await verifyHmac(key, code, flipMiddle(stored)),
    false,
    "a one-character change to the stored digest must fail verification",
  );
});

test("verifyHmac returns false (never throws) for a malformed, wrong-length expected", async () => {
  const key = freshKey();

  // A length-safe constant-time comparator must handle a mismatched-length
  // candidate by returning false, not by throwing (node's timingSafeEqual throws
  // on unequal lengths — a correct verifier guards against that).
  assert.equal(
    await verifyHmac(key, "654321", "not-a-real-digest"),
    false,
    "a garbage expected digest must be rejected, not crash verification",
  );
  assert.equal(
    await verifyHmac(key, "654321", ""),
    false,
    "an empty expected digest must be rejected, not crash verification",
  );
});

// ---------------------------------------------------------------------------
// fingerprint(dek, value): keyed, one-way, stable per person, distinct per person.
//   fingerprint(dek, value) = HMAC(HKDF(DEK, "warthog/fp/v1"), normalise(value))
// ---------------------------------------------------------------------------

test("fingerprint returns a non-empty, storable string", async () => {
  const dek = freshDek();

  const fp = await fingerprint(dek, "4111111111111111");

  assert.equal(typeof fp, "string", "the fingerprint is a storable string");
  assert.ok(fp.length > 0, "the fingerprint is non-empty");
});

test("fingerprint is stable for the same value under the same person's DEK", async () => {
  const dek = freshDek();
  const value = "passport-X1234567";

  // Two independent calls — e.g. one at release time, one when later matching a
  // tool-call parameter — must agree, or redaction could never match a release.
  assert.equal(
    await fingerprint(dek, value),
    await fingerprint(dek, value),
    "the same value under the same DEK must always fingerprint to the same digest",
  );
});

test("fingerprint is keyed on the DEK bytes, not the object identity", async () => {
  const bytes = freshDek();
  const sameBytes = Uint8Array.from(bytes); // the person's DEK, unwrapped afresh
  const value = "passport-X1234567";

  assert.equal(
    await fingerprint(bytes, value),
    await fingerprint(sameBytes, value),
    "a DEK reconstructed from the same bytes must give the same fingerprint",
  );
});

test("fingerprint differs across persons: a different DEK changes the digest for the same value", async () => {
  const value = "4111111111111111";

  assert.notEqual(
    await fingerprint(freshDek(), value),
    await fingerprint(freshDek(), value),
    "one person's fingerprint of a value must not equal another person's",
  );
});

test("fingerprint differs for different values under the same DEK", async () => {
  const dek = freshDek();

  assert.notEqual(
    await fingerprint(dek, "4111111111111111"),
    await fingerprint(dek, "4111111111111112"),
    "distinct values must not collide to the same fingerprint",
  );
});

test("fingerprint does not embed the plaintext value (one-way)", async () => {
  const dek = freshDek();
  const value = "tax file no. 123 456 789"; // spaces are outside hex/base64 alphabets

  const fp = await fingerprint(dek, value);

  assert.ok(
    !fp.includes(value),
    "the keyed fingerprint must never contain the value it was derived from",
  );
});

// --- normalisation: equivalent surface forms of a value share one fingerprint ---
// The design computes the fingerprint over the NORMALISED value (§4.2, §4.3), so a
// value seen later in a different surface form still matches its release.

test("fingerprint ignores surrounding whitespace on the value", async () => {
  const dek = freshDek();

  assert.equal(
    await fingerprint(dek, "  AB12CD34  "),
    await fingerprint(dek, "AB12CD34"),
    "leading/trailing whitespace must be normalised away before fingerprinting",
  );
});

test("fingerprint folds letter case on the value", async () => {
  const dek = freshDek();

  assert.equal(
    await fingerprint(dek, "AB12CD34"),
    await fingerprint(dek, "ab12cd34"),
    "letter case must be normalised so case variants share one fingerprint",
  );
});

// Review fix D4 — the fingerprint normalises exactly as redaction does (case, spaces and
// punctuation fold away), so a released "AB-123-456" matches the same value seen later as
// "ab 123 456"; and the matcher redaction consults derives the key once and answers for
// already-normalised tokens.
test("fingerprint folds spaces and punctuation the way redaction normalises a value", async () => {
  const dek = freshDek();
  const canonical = fingerprint(dek, "ab123456");
  assert.equal(fingerprint(dek, "AB-123-456"), canonical);
  assert.equal(fingerprint(dek, "AB 123 456"), canonical);
  assert.equal(fingerprint(dek, " ab.123/456 "), canonical);
});

test("releasedValueMatcher matches a normalised token whose fingerprint is stored, and nothing else", () => {
  const dek = freshDek();
  const matches = releasedValueMatcher(dek, [fingerprint(dek, "PA1234567"), fingerprint(dek, "AB-123-456")]);
  assert.equal(matches("pa1234567"), true);
  assert.equal(matches("ab123456"), true);
  assert.equal(matches("pa7654321"), false);
  assert.equal(releasedValueMatcher(freshDek(), [fingerprint(dek, "PA1234567")])("pa1234567"), false, "keyed per person");
  assert.equal(releasedValueMatcher(dek, [])("pa1234567"), false, "no fingerprints never match");
});
