// E03-S02 — Redaction module (design §4.3).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.
// Redaction runs before anything is written to activity, logs or metrics; the
// activity writer and the logger both call it. It applies four rules:
//
//   1. Known secret FIELD NAMES → `[redacted]` (keyed on the key, not the value).
//   2. Luhn-valid card numbers → masked, revealing only the last four digits.
//   3. Alphanumeric tokens of normalised length ≥ 5 whose fingerprint the INJECTED
//      matcher reports as a released value → `[released value]`.
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

  const released = masked.replace(/[\p{L}\p{N}]+/gu, (token) => {
    const normalised = normaliseValue(token);
    if (normalised.length >= MIN_TOKEN_LENGTH && matchesReleased(normalised)) {
      return "[released value]";
    }
    return token;
  });

  if (released.length > MAX_LENGTH) {
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
