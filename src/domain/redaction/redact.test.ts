// E03-S02 — Redaction module (`src/domain/redaction/redact.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// below fails. That is intentional — the implementation is written afterwards to
// make these pass. The tests pin BEHAVIOUR (what `redact` returns for a given
// input and injected matcher), never the source text of the module, so a later
// rename that keeps behaviour leaves them untouched.
//
// This is a pure domain module (conventions: `src/domain/**` has no React, no DB,
// no fetch, no process.env, no Date.now). Redaction runs before anything is
// written to activity, logs or metrics; the activity writer and the logger both
// call it (design §4.3). It applies four rules:
//
//   1. Known secret FIELD NAMES (password, token, authorization, api_key, …) have
//      their value replaced with `[redacted]` — keyed on the key, not the value.
//   2. Luhn-valid card numbers (13–19 digits, spaces/dashes allowed) are masked to
//      reveal only the last four digits.
//   3. Every alphanumeric token of NORMALISED length ≥ 5 whose fingerprint matches
//      a released value — reported by the INJECTED matcher — becomes `[released value]`.
//   4. String values longer than 2,000 characters are truncated.
//
// A benign value (no secret name, no card, no match, ≤ 2000 chars) passes through
// unchanged, punctuation and spacing included.
//
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it):
//
//   redact(input: unknown, matchesReleased: (normalisedToken: string) => boolean): unknown
//
// `redact` dispatches by the shape of `input`: a string is scrubbed by rules 2–4;
// a plain record has rule 1 applied by key and each value scrubbed. The matcher is
// INJECTED so the module stays pure — the per-person, within-90-days lookup lives
// behind the matcher, never inside this module. A `[released value]` match is
// proven by handing in a fake matcher and observing the output, never by spying on
// internals.
//
// A note on the card mask glyph. Design §4.3 writes the masked form as
// `[card ••••1234]` (bullet characters); an ASCII rendering would write
// `[card ****1234]`. The two agree on the real contract — a `[card …]` wrapper
// whose only visible digits are the last four — and disagree only on the (cosmetic)
// masking glyph. These tests therefore assert the STRUCTURE (wrapper present, full
// number gone, exactly the last four digits shown) and accept either glyph, so a
// conforming implementation of either spelling passes and the suite never reddens
// over `•` vs `*`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { redact } from "./redact";

// ---------------------------------------------------------------------------
// Injected fingerprint-matchers (fakes). The real matcher consults a person's
// released-value fingerprints within 90 days; these stand in for it.
// ---------------------------------------------------------------------------

/** Never reports a match — isolates the non-released rules. */
const never = (): boolean => false;

/** Always reports a match — used to prove the length-≥5 guard runs regardless. */
const always = (): boolean => true;

/** Matches only the given normalised token(s) — the shape the real matcher has. */
const matches =
  (...targets: string[]) =>
  (normalisedToken: string): boolean =>
    targets.includes(normalisedToken);

// ---------------------------------------------------------------------------
// Small helpers to read the (typed `unknown`) results without ceremony.
// ---------------------------------------------------------------------------

/** Assert the value is a string and return it narrowed, for calling string methods. */
function str(value: unknown): string {
  assert.equal(typeof value, "string", "expected a string value");
  return value as string;
}

/** Treat a redaction result as a record of fields. */
function rec(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object", "expected a record result");
  assert.notEqual(value, null, "expected a non-null record result");
  return value as Record<string, unknown>;
}

// Assert `output` contains `pan` (bare digits) masked: the whole number is gone,
// the `[card …]` wrapper is present, and the masked token ends by showing only the
// last four digits. Scoped to the exact `pan` (never a whole-output absence check),
// because those last four digits legitimately reappear inside the masked token.
function assertCardMasked(output: string, pan: string): void {
  const last4 = pan.slice(-4);
  assert.ok(!output.includes(pan), "the full card number must not survive redaction");
  assert.ok(output.includes("[card "), "a masked card is wrapped as a [card …] token");
  assert.ok(
    output.includes(last4 + "]"),
    "the masked token ends by revealing exactly the last four digits",
  );
}

// ===========================================================================
// Rule 2 — Luhn card numbers are masked (AC1: "masks Luhn card numbers").
// ===========================================================================

test("redact masks a bare Luhn card, revealing only the last four digits", () => {
  const output = str(redact("4242424242424242", never));

  // Only the final four digits may remain; every earlier digit is replaced by
  // non-digit mask characters. Accepts `••••` or `****` while forbidding any other
  // digit from leaking.
  assert.match(
    output,
    /^\[card [^0-9]+4242\]$/,
    "a masked bare card is `[card <mask>4242]` with only the last four digits shown",
  );
});

test("redact masks a spaced-out card embedded in text, keeping the surrounding text", () => {
  const output = str(redact("please charge 4242 4242 4242 4242 now", never));

  assertCardMasked(output, "4242424242424242");
  assert.ok(!output.includes("4242 4242 4242 4242"), "the spaced card form must not survive either");
  assert.ok(output.includes("please charge "), "text before the card is preserved");
  assert.ok(output.includes(" now"), "text after the card is preserved");
});

test("redact leaves a non-Luhn 16-digit number unchanged (not a card)", () => {
  assert.equal(
    redact("4242 4242 4242 4243", never),
    "4242 4242 4242 4243",
    "a 16-digit group that fails the Luhn check is not a card and must not be masked",
  );
});

// ===========================================================================
// Rule 1 — known secret field NAMES → [redacted] (AC1).
// Keyed on the field name, not the value.
// ===========================================================================

test("redact replaces known secret field values with [redacted]", () => {
  const out = rec(
    redact(
      {
        password: "hunter2",
        token: "xyz-abc-123",
        authorization: "Bearer deadbeef",
        api_key: "abc", // a benign-looking value: proves redaction keys on the NAME
        note: "nothing secret here", // a non-secret name: value must survive
      },
      never,
    ),
  );

  assert.equal(out.password, "[redacted]", "a `password` field is redacted");
  assert.equal(out.token, "[redacted]", "a `token` field is redacted");
  assert.equal(out.authorization, "[redacted]", "an `authorization` field is redacted");
  assert.equal(out.api_key, "[redacted]", "an `api_key` field is redacted regardless of its value");
  assert.equal(out.note, "nothing secret here", "a non-secret field's benign value passes through");
});

// ===========================================================================
// Rule 3 — fingerprint-matched tokens → [released value] (AC2).
// ===========================================================================

test("redact replaces a token the injected matcher reports as a released value", () => {
  assert.equal(
    redact("swordfish", matches("swordfish")),
    "[released value]",
    "a matched token is replaced with the released-value marker",
  );
});

test("redact normalises a token (case-fold) before asking the matcher", () => {
  // The matcher compares fingerprints of the NORMALISED value, so redaction must
  // normalise before matching. "Hunter2ABC" folds to "hunter2abc".
  assert.equal(
    redact("Hunter2ABC", matches("hunter2abc")),
    "[released value]",
    "the token is normalised (lowercased) before the matcher is consulted",
  );
});

test("redact leaves an unmatched token in its original surface form", () => {
  // No match → the original token is returned verbatim (case preserved); the
  // normalisation used for matching must not leak into the output.
  assert.equal(
    redact("Hunter2ABC", matches("somethingelse")),
    "Hunter2ABC",
    "an unmatched token keeps its original casing and is not normalised in the output",
  );
});

test("redact only considers tokens of normalised length 5 or more", () => {
  // `always` would match anything, so a surviving short token proves the length
  // guard runs first. The boundary is exactly 5.
  assert.equal(redact("cat", always), "cat", "a 3-char token is below the floor and is kept");
  assert.equal(redact("quad", always), "quad", "a 4-char token is below the floor and is kept");
  assert.equal(
    redact("hello", always),
    "[released value]",
    "a 5-char token is at the floor and, when matched, is replaced",
  );
});

test("redact replaces a matched token embedded in text, keeping the other words", () => {
  const output = str(redact("the value is swordfish here", matches("swordfish")));

  assert.ok(output.includes("[released value]"), "the matched token becomes the released marker");
  assert.ok(!output.includes("swordfish"), "the released value itself must not survive");
  assert.ok(output.includes("the value is"), "words before the matched token are preserved");
  assert.ok(output.includes("here"), "words after the matched token are preserved");
});

// ===========================================================================
// Rule 4 — values longer than 2000 characters are truncated (AC2).
// ===========================================================================

test("redact truncates a value longer than 2000 characters", () => {
  const long = "a".repeat(2001);
  const output = str(redact(long, never));

  assert.notEqual(output, long, "an over-long value must not be returned in full");
  assert.ok(output.length < long.length, "the truncated value is shorter than the input");
  assert.ok(output.length <= 2100, "truncation bounds the value at roughly 2000 chars (+ a marker)");
  assert.ok(output.startsWith("a".repeat(100)), "leading content is preserved, not discarded");
});

test("redact leaves a value of exactly 2000 characters unchanged (boundary)", () => {
  const exact = "a".repeat(2000);
  assert.equal(redact(exact, never), exact, "2000 chars is not *longer than* 2000 — left untouched");
});

// ===========================================================================
// AC3 — a benign value passes through unchanged.
// ===========================================================================

test("redact returns a benign string unchanged, preserving punctuation and spacing", () => {
  assert.equal(
    redact("Hello, world!", never),
    "Hello, world!",
    "no secret, card or match → the string is returned verbatim, punctuation included",
  );
  assert.equal(
    redact("just a normal note with several words", never),
    "just a normal note with several words",
    "a plain sentence with ≥5-char words but no match is unchanged",
  );
});

test("redact leaves short numbers and a non-card digit group unchanged", () => {
  assert.equal(redact("12345", never), "12345", "a 5-digit number is not a card and is kept");
  assert.equal(
    redact("call me on 55512345", never),
    "call me on 55512345",
    "an 8-digit number is below the 13-digit card floor and is kept",
  );
});

// ===========================================================================
// Composition — all four rules in one record (AC1 + AC2 + AC3 together).
// ===========================================================================

test("redact applies every rule across a record in a single pass", () => {
  const out = rec(
    redact(
      {
        password: "hunter2", // rule 1: secret name → [redacted]
        note: "charge 4242424242424242 now", // rule 2: card in value → masked
        memo: "swordfish", // rule 3: matched token → [released value]
        reason: "all good here", // benign → unchanged
      },
      matches("swordfish"),
    ),
  );

  assert.equal(out.password, "[redacted]", "the secret field is redacted");

  const note = str(out.note);
  assertCardMasked(note, "4242424242424242");
  assert.ok(note.includes("charge "), "text around the masked card survives");
  assert.ok(note.includes(" now"), "text around the masked card survives");

  assert.equal(out.memo, "[released value]", "the released value is replaced");
  assert.equal(out.reason, "all good here", "a benign field passes through untouched");
});

// Review fix D4 — a released value written with spaces or dashes spans several tokens
// ("AB-123-456", "2123 45678 1"); adjacent tokens joined only by short separators are also
// offered to the matcher as one run, so the whole value is replaced — and unrelated
// neighbouring words are left alone.
test("redact replaces a released value that spans several tokens", () => {
  const released = matches("ab123456", "2123456781");
  assert.equal(redact("licence AB-123-456, ok", released), "licence [released value], ok");
  assert.equal(redact("medicare 2123 45678 1 today", released), "medicare [released value] today");
  assert.equal(redact("medicare 2123-45678-1", released), "medicare [released value]");
});

test("redact does not swallow unrelated tokens next to a multi-token match", () => {
  const released = matches("ab123456");
  assert.equal(redact("AB 123 456 789", released), "[released value] 789");
  assert.equal(redact("XAB 123 456", released), "XAB 123 456", "a run is matched only as a whole");
  assert.equal(redact("AB, 123; 456", released), "AB, 123; 456", "tokens split by other punctuation are not joined");
});

test("redact still finds a released value past a long run of text before the cut", () => {
  const long = `${"word ".repeat(300)}PA1234567 ${"tail ".repeat(5000)}`;
  const out = str(redact(long, matches("pa1234567")));
  assert.ok(out.includes("[released value]"), "the value inside the kept prefix is replaced");
  assert.ok(!out.includes("PA1234567"));
  assert.ok(out.endsWith("…[truncated]"), "an over-long value is still truncated");
  assert.ok(out.length <= 2000);
});
