// E03-S01 — Luhn, card detection and value normalisation (`src/domain/redaction/luhn.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// below fails. That is intentional — the implementation is written afterwards to
// make these pass. The tests pin BEHAVIOUR (what each pure function returns for a
// given input), never the source text of the module, so a later rename that keeps
// behaviour leaves them untouched.
//
// This is a pure domain module (conventions: `src/domain/**` has no React, no DB,
// no fetch, no process.env, no Date.now) — the functions are plain and synchronous.
//
// The task bundles three capabilities the redaction and fingerprinting layers both
// lean on (design §4.2, §4.3):
//
//   passesLuhn(digits)        — the Luhn checksum over a run of digits.
//   maskCardNumbers(text)     — replaces every 13–19 digit sequence (spaces or
//                               dashes allowed) that passes Luhn with a masked
//                               token that reveals only the last four digits;
//                               non-card / non-Luhn text is left untouched.
//   normaliseValue(value)     — deterministic normalisation: lowercases and strips
//                               punctuation so equivalent surface forms coincide.
//
// A note on the mask glyph. Design §4.3 writes the masked form as `[card ••••1234]`
// (bullet characters); this task's acceptance criterion writes it as the ASCII
// example `[card ****1234]`. The two agree on the real contract — a `[card …]`
// wrapper whose only visible digits are the last four — and disagree only on the
// masking glyph, which is cosmetic. These tests therefore assert the STRUCTURE
// (wrapper present, full number gone, exactly the last four digits shown) and
// deliberately accept either glyph, so a conforming implementation of either the
// design doc or the task example passes and the suite never reddens over `•` vs `*`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { passesLuhn, maskCardNumbers, normaliseValue } from "./luhn";

// A 19-digit card built so the suite verifies its own Luhn validity rather than
// trusting a hand-counted literal (checked below before it is used for masking).
const CARD_19 = "4" + "0".repeat(17) + "6";

// Assert `output` is `input` with the card `pan` (bare digits) masked: the whole
// number is gone, the `[card …]` wrapper is present, and the token ends by showing
// only the last four digits. Scoped to the exact `pan`, never a whole-output check,
// because the last four digits legitimately reappear in the masked token.
function assertMasked(output: string, input: string, pan: string): void {
  const last4 = pan.slice(-4);
  assert.notEqual(output, input, "a valid card must be replaced, not returned unchanged");
  assert.ok(!output.includes(pan), "the full card number must not survive in the masked output");
  assert.ok(output.includes("[card "), "the masked form is wrapped as a [card …] token");
  assert.ok(
    output.includes(last4 + "]"),
    "the masked token ends by revealing exactly the last four digits",
  );
}

// ---------------------------------------------------------------------------
// passesLuhn(digits): the Luhn checksum, the heart of card detection.
// ---------------------------------------------------------------------------

test("passesLuhn accepts known-valid card numbers across brands and lengths", () => {
  for (const digits of [
    "4242424242424242", // Visa, 16
    "4111111111111111", // Visa, 16
    "5555555555554444", // Mastercard, 16
    "378282246310005", // Amex, 15
    "6011111111111117", // Discover, 16
  ]) {
    assert.equal(passesLuhn(digits), true, `${digits} is a valid Luhn number`);
  }
});

test("passesLuhn accepts the canonical Luhn example 79927398713", () => {
  assert.equal(passesLuhn("79927398713"), true, "the textbook Luhn example checks out");
});

test("passesLuhn rejects numbers that fail the checksum", () => {
  for (const digits of [
    "4242424242424243", // last digit of a valid Visa tweaked
    "79927398714", // the canonical example with a bad check digit
    "1111111111111111", // sixteen ones — checksum 24, not a multiple of ten
  ]) {
    assert.equal(passesLuhn(digits), false, `${digits} must fail the Luhn check`);
  }
});

test("passesLuhn is a strict checksum: flipping one digit flips the result", () => {
  assert.equal(passesLuhn("4242424242424242"), true, "the unaltered number passes");
  assert.equal(
    passesLuhn("4242424242424242".slice(0, 15) + "3"),
    false,
    "changing the final digit must break the checksum",
  );
});

// ---------------------------------------------------------------------------
// maskCardNumbers(text): detect 13–19 digit Luhn-valid runs and mask them.
// ---------------------------------------------------------------------------

test("maskCardNumbers masks a bare 16-digit card, revealing only the last four", () => {
  const output = maskCardNumbers("4242424242424242");

  // The only digits left in the whole token are the final four; everything before
  // them is non-digit mask characters. This accepts `••••` or `****` (any count of
  // non-digit mask chars) while forbidding any other digit from leaking.
  assert.match(
    output,
    /^\[card [^0-9]+4242\]$/,
    "a masked bare card is `[card <mask>4242]` with only the last four digits shown",
  );
});

test("maskCardNumbers detects a card written with spaces between groups", () => {
  const output = maskCardNumbers("4242 4242 4242 4242");

  assertMasked(output, "4242 4242 4242 4242", "4242424242424242");
  assert.ok(
    !output.includes("4242 4242 4242 4242"),
    "the spaced-out card number must not survive either",
  );
});

test("maskCardNumbers detects a card written with dashes between groups", () => {
  const output = maskCardNumbers("4242-4242-4242-4242");

  assertMasked(output, "4242-4242-4242-4242", "4242424242424242");
  assert.ok(
    !output.includes("4242-4242-4242-4242"),
    "the dashed card number must not survive either",
  );
});

test("maskCardNumbers masks a card embedded in surrounding text, keeping the text", () => {
  const output = maskCardNumbers("please charge 4242424242424242 now");

  assertMasked(output, "please charge 4242424242424242 now", "4242424242424242");
  assert.ok(output.startsWith("please charge "), "text before the card is preserved");
  assert.ok(output.endsWith(" now"), "text after the card is preserved");
});

test("maskCardNumbers masks a 13-digit card (lower boundary of the range)", () => {
  const card = "4222222222222"; // 13 digits
  assert.equal(card.length, 13, "boundary fixture is exactly 13 digits");
  assert.equal(passesLuhn(card), true, "the 13-digit fixture is Luhn-valid");

  assertMasked(maskCardNumbers(card), card, card);
});

test("maskCardNumbers masks a 19-digit card (upper boundary of the range)", () => {
  assert.equal(CARD_19.length, 19, "boundary fixture is exactly 19 digits");
  assert.equal(passesLuhn(CARD_19), true, "the 19-digit fixture is Luhn-valid");

  assertMasked(maskCardNumbers(CARD_19), CARD_19, CARD_19);
});

test("maskCardNumbers leaves a non-Luhn 16-digit number untouched", () => {
  // The acceptance criterion: a non-Luhn number is not masked.
  assert.equal(passesLuhn("1111111111111111"), false, "fixture is genuinely non-Luhn");
  assert.equal(
    maskCardNumbers("1111111111111111"),
    "1111111111111111",
    "a 16-digit number that fails Luhn is returned unchanged",
  );
});

test("maskCardNumbers leaves a non-Luhn number untouched even when nicely grouped", () => {
  assert.equal(
    maskCardNumbers("4242 4242 4242 4243"),
    "4242 4242 4242 4243",
    "a spaced-out number that fails Luhn is not a card and must not be masked",
  );
});

test("maskCardNumbers leaves a short Luhn-valid number (11 digits) untouched", () => {
  // Below the 13-digit floor of the 13–19 range: valid Luhn, but not a card number.
  assert.equal(passesLuhn("79927398713"), true, "fixture passes Luhn but is only 11 digits");
  assert.equal(
    maskCardNumbers("79927398713"),
    "79927398713",
    "a sub-13-digit sequence is outside the card range and must not be masked",
  );
});

test("maskCardNumbers masks every card when a string contains several", () => {
  const output = maskCardNumbers("one 4242424242424242 two 5555555555554444 three");

  assertMasked(output, "one 4242424242424242 two 5555555555554444 three", "4242424242424242");
  assert.ok(!output.includes("5555555555554444"), "the second card number is masked too");
  assert.ok(output.includes("4444]"), "the second card's last four digits are shown");
  assert.ok(output.startsWith("one "), "leading text survives");
  assert.ok(output.endsWith(" three"), "trailing text survives");
});

test("maskCardNumbers masks the valid card but leaves an invalid number beside it", () => {
  const output = maskCardNumbers("good 4242424242424242 bad 1111111111111111 end");

  assert.ok(!output.includes("4242424242424242"), "the Luhn-valid card is masked");
  assert.ok(output.includes("4242]"), "the valid card's last four digits are shown");
  assert.ok(
    output.includes("1111111111111111"),
    "the non-Luhn number is left exactly as it was",
  );
});

// ---------------------------------------------------------------------------
// normaliseValue(value): deterministic — lowercases and strips punctuation.
// ---------------------------------------------------------------------------

test("normaliseValue lowercases letters while preserving alphanumerics", () => {
  assert.equal(
    normaliseValue("ABCdef123"),
    "abcdef123",
    "letters fold to lower case; letters and digits are kept",
  );
});

test("normaliseValue strips dashes between digit groups", () => {
  assert.equal(
    normaliseValue("4111-1111-1111-1111"),
    "4111111111111111",
    "dashes are punctuation and are removed, leaving the digits",
  );
});

test("normaliseValue strips assorted punctuation marks", () => {
  assert.equal(
    normaliseValue("a.b:c/d,e(f)"),
    "abcdef",
    "dots, colons, slashes, commas and parentheses are all stripped",
  );
});

test("normaliseValue folds surface variants to one normal form", () => {
  // Case and punctuation differences must not produce different normal forms —
  // this is what lets a released value match a later, differently-typed sighting.
  assert.equal(normaliseValue("AB-12-CD"), normaliseValue("ab12cd"), "variants coincide");
  assert.equal(normaliseValue("AB-12-CD"), "ab12cd", "and resolve to the lowercased, stripped form");
});

test("normaliseValue is deterministic and leaves an already-normalised value alone", () => {
  assert.equal(
    normaliseValue("abc123"),
    normaliseValue("abc123"),
    "the same input always yields the same output (no hidden state)",
  );
  assert.equal(
    normaliseValue("abc123"),
    "abc123",
    "a value that is already lower-case and punctuation-free is unchanged",
  );
});
