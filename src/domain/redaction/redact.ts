// E03-S02 — Redaction module (design §4.3).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.
// Redaction runs before anything is written to activity, logs or metrics; the
// activity writer and the logger both call it. It applies four rules:
//
//   1. Known secret FIELD NAMES → `[redacted]` (keyed on the key, not the value).
//   2. Luhn-valid card numbers → masked, revealing only the last four digits.
//   3. Alphanumeric tokens — or runs of adjacent tokens joined only by a short run of
//      spaces, `-`, `.` or `/`, so a value written "AB-123-456" is caught whole — of
//      normalised length ≥ 5 whose fingerprint the INJECTED matcher reports as a
//      released value → `[released value]`.
//   4. String values longer than 2,000 characters are truncated with a marker.
//
// The fingerprint matcher is injected so this module stays pure: the per-person,
// within-90-days lookup lives behind the matcher, never inside here.

import { maskCardNumbers, normaliseValue } from "./luhn";

/** Longest string kept verbatim; anything longer is truncated to this length. */
const MAX_LENGTH = 2000;

/** Marker appended (within the length budget) to a truncated value. */
const TRUNCATION_MARKER = "…[truncated]";

/** Shortest normalised token the released-value matcher is consulted for. */
const MIN_TOKEN_LENGTH = 5;

/** A token: a run of letters and numbers. */
const TOKEN = /[\p{L}\p{N}]+/gu;

/**
 * What may sit between adjacent tokens that together spell ONE value written with spaces
 * or dashes ("AB-123-456", "2123 45678 1"): a short run of whitespace, `-`, `.` or `/`.
 */
const JOINER = /^[\s\-./]{1,3}$/u;

/** The most adjacent tokens offered to the matcher as one run. */
const MAX_RUN_TOKENS = 6;

/**
 * How far past the length budget an over-long value is still scanned, so a released
 * value straddling the cut is replaced, while a huge value is never scanned in full
 * (everything past the budget is truncated away anyway).
 */
const SCAN_MARGIN = 256;

interface Token {
  start: number;
  end: number;
  normalised: string;
}

/**
 * How many tokens, starting at `tokens[i]`, form a released value: the longest run of up
 * to MAX_RUN_TOKENS adjacent tokens (joined only by JOINER separators) whose concatenated
 * normal form the matcher reports, or 0 when none does.
 */
function releasedRunAt(
  text: string,
  tokens: readonly Token[],
  i: number,
  matchesReleased: (normalisedToken: string) => boolean,
): number {
  const runs: string[] = [tokens[i]!.normalised];
  for (let k = 1; k < MAX_RUN_TOKENS && i + k < tokens.length; k += 1) {
    const prev = tokens[i + k - 1]!;
    const next = tokens[i + k]!;
    if (!JOINER.test(text.slice(prev.end, next.start))) break;
    runs.push(runs[k - 1]! + next.normalised);
  }
  for (let k = runs.length; k >= 1; k -= 1) {
    const candidate = runs[k - 1]!;
    if (candidate.length >= MIN_TOKEN_LENGTH && matchesReleased(candidate)) return k;
  }
  return 0;
}

/**
 * Replace every released value in `text` with `[released value]`: a single token, or a
 * run of adjacent tokens joined by short separators, whose normal form the matcher
 * reports. Anything unmatched keeps its original surface form.
 */
function replaceReleased(
  text: string,
  matchesReleased: (normalisedToken: string) => boolean,
): string {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index;
    tokens.push({ start, end: start + match[0].length, normalised: normaliseValue(match[0]) });
  }

  let out = "";
  let cursor = 0;
  let i = 0;
  while (i < tokens.length) {
    const run = releasedRunAt(text, tokens, i, matchesReleased);
    if (run === 0) {
      i += 1;
      continue;
    }
    out += text.slice(cursor, tokens[i]!.start) + "[released value]";
    cursor = tokens[i + run - 1]!.end;
    i += run;
  }
  return out + text.slice(cursor);
}

// Field names (normalised) whose value is a secret regardless of its content
// (design §4.3: passwords, tokens, `authorization`, `api_key`, codes, keys …).
const SECRET_FIELD_NAMES = new Set<string>([
  "password",
  "passphrase",
  "passwd",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
  "linktoken",
  "bearertoken",
  "authorization",
  "apikey",
  "apisecret",
  "secret",
  "clientsecret",
  "credential",
  "credentials",
  "code",
  "securitycode",
  "recoverycode",
  "backupcode",
  "onetimecode",
  "otp",
  "totp",
  "cvv",
  "cvc",
  "csc",
  "key",
  "privatekey",
  "secretkey",
  "encryptionkey",
  "vaultkey",
  "datakey",
  "dek",
  "kek",
  "accesskey",
  "sessionid",
  "cardnumber",
  "pan",
]);

/** A field name is secret when its normalised form is a known secret name. */
function isSecretFieldName(name: string): boolean {
  return SECRET_FIELD_NAMES.has(normaliseValue(name));
}

/**
 * Scrub a single string value: mask Luhn cards, replace fingerprint-matched
 * tokens with `[released value]`, then truncate an over-long result. An
 * unmatched token is returned in its original surface form (casing preserved);
 * normalisation is used only to ask the matcher, never leaked into the output.
 */
function scrubString(
  value: string,
  matchesReleased: (normalisedToken: string) => boolean,
): string {
  const masked = maskCardNumbers(value);

  // Only the part that can survive truncation (plus a margin for a value straddling the
  // cut) is scanned for released values.
  const scanLimit = MAX_LENGTH + SCAN_MARGIN;
  const scanned = masked.length > scanLimit ? masked.slice(0, scanLimit) : masked;
  const released = replaceReleased(scanned, matchesReleased);

  if (released.length > MAX_LENGTH || scanned.length < masked.length) {
    return released.slice(0, MAX_LENGTH - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
  }
  return released;
}

/**
 * Redact a value before it is written to activity, logs or metrics. Dispatches
 * by the shape of `input`: a string is scrubbed by rules 2–4; a record has its
 * secret-named fields replaced with `[redacted]` (rule 1) and every other value
 * scrubbed; arrays are scrubbed element-wise. Any other value passes through.
 */
export function redact(
  input: unknown,
  matchesReleased: (normalisedToken: string) => boolean,
): unknown {
  if (typeof input === "string") {
    return scrubString(input, matchesReleased);
  }

  if (Array.isArray(input)) {
    return input.map((item) => redact(item, matchesReleased));
  }

  if (typeof input === "object" && input !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      out[key] = isSecretFieldName(key) ? "[redacted]" : redact(value, matchesReleased);
    }
    return out;
  }

  return input;
}
