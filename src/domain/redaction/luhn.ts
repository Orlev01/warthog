// E03-S01 — Luhn, card detection and value normalisation (design §4.2, §4.3).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.
// Redaction masks card numbers it finds in free text; fingerprinting leans on
// the same Luhn detector and a stable normaliser so equivalent surface forms of
// a value coincide.

/** Characters shown in place of a masked card's hidden digits (design §4.3). */
const MASK = "••••";

// A run of 13–19 digits with optional single spaces or dashes between digits,
// so grouped forms like "4242 4242 4242 4242" are caught. The run opens and
// closes on a digit; the first digit plus 12–18 more gives the 13–19 total.
const CARD_RUN = /[0-9](?:[ \-]?[0-9]){12,18}/g;

// A canonical UUID (8-4-4-4-12 hex). Its digits can form a Luhn-valid run across the
// hyphens (about 0.2% of random ids), so UUIDs are set aside before card detection.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The Luhn checksum over a run of decimal digits. Returns true only when the
 * digits form a valid Luhn number; any non-digit character makes it false.
 */
export function passesLuhn(digits: string): boolean {
  if (!/^[0-9]+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Replaces every 13–19 digit sequence (spaces or dashes allowed between digits)
 * that passes Luhn with a `[card ••••1234]` token revealing only the last four
 * digits. Text that is not a Luhn-valid card number, and any canonical UUID, is left
 * untouched.
 */
export function maskCardNumbers(text: string): string {
  // Mask only the text between UUIDs; each UUID is kept verbatim.
  let out = "";
  let from = 0;
  for (const match of text.matchAll(UUID)) {
    out += maskRuns(text.slice(from, match.index)) + match[0];
    from = match.index + match[0].length;
  }
  return out + maskRuns(text.slice(from));
}

function maskRuns(text: string): string {
  return text.replace(CARD_RUN, (run) => {
    const digits = run.replace(/[^0-9]/g, "");
    if (!passesLuhn(digits)) return run;
    return `[card ${MASK}${digits.slice(-4)}]`;
  });
}

/**
 * Deterministic value normalisation: lowercases, then strips every character
 * that is not a letter or a number, so case and punctuation differences fold to
 * one normal form (e.g. "AB-12-CD" and "ab12cd" coincide).
 */
export function normaliseValue(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
