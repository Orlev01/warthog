// Read-side protection — the few things in content where seeing is as good as doing
// (docs/adr/read-side-protection.md): sign-in and password-reset links, sign-in codes and
// temporary passwords, and card numbers. Everything else (booking references, tracking
// numbers, BPAY CRNs, Zoom passcodes, help-page, parcel and unsubscribe links) is left
// exactly as written, so agents stay useful.
//
// The person's level (read-levels.ts, amendment 24 November 2026) changes how much: "private"
// also hides the numbers that identify them or their accounts when the text names them, and
// "open" hides nothing (invisible characters are still removed).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now. Every
// pattern is linear (no nested or adjacent unbounded quantifiers that backtrack), and every
// context check reads a fixed-size window, so an adversarial message cannot stall it.

import { passesLuhn } from "../redaction/luhn";
import type { ReadLevel } from "./read-levels";
import { stripInvisible } from "./untrusted";

/** What the filters removed, by kind (counts only — never the values). */
export interface FilterCounts {
  hiddenCharacters: number;
  signInLinks: number;
  codes: number;
  cards: number;
  /** Tax file, Medicare, passport, licence, BSB, account and similar numbers (the private level). */
  identifiers: number;
}

export function emptyCounts(): FilterCounts {
  return { hiddenCharacters: 0, signInLinks: 0, codes: 0, cards: 0, identifiers: 0 };
}

export function addCounts(into: FilterCounts, from: FilterCounts): FilterCounts {
  into.hiddenCharacters += from.hiddenCharacters;
  into.signInLinks += from.signInLinks;
  into.codes += from.codes;
  into.cards += from.cards;
  into.identifiers += from.identifiers;
  return into;
}

export const SIGN_IN_LINK_MASK = "[sign-in link hidden by Warthog]";
export const SIGN_IN_CODE_MASK = "[sign-in code hidden by Warthog]";
export const PASSWORD_MASK = "[password hidden by Warthog]";
export const IDENTIFIER_MASK = "[number hidden by Warthog]";

export interface CleanOptions {
  /** The message is already known to be a sign-in or password email: "code", "PIN" and "password" count as strong words. */
  readonly signInMail?: boolean;
  /** Calendar content: meeting passcodes are joining details, not sign-in codes. */
  readonly calendar?: boolean;
  /** The person's level (read-levels.ts). Unset is the default, standard. */
  readonly level?: ReadLevel;
}

// --- links ---------------------------------------------------------------------------

// Wording in a link's path or parameters that only sign-in, recovery or verification uses.
// Substring tests (no word boundaries) so "loginwithemail" or "verifyEmail" are caught; the
// link is hidden only when it ALSO carries a secret, so help pages ("how-to-reset-your-router",
// "verify-your-identity") and plain sign-in pages stay.
const AUTH_WORDING = /(?:reset|recover|forgot|magic|otp|mfa|2fa|verif|activat|passw|passwd|signin|sign-in|sign_in|login|log-in|logon|auth|sso|session|callback|confirm-?email|emaillink)/;
const AUTH_HOST = /^(?:accounts?|auth|login|signin|id|identity|sso)\./;
const SECRET_PARAM = /^(?:token|access_token|id_token|code|otp|ticket|oobcode|sig|signature|hash|t|auth|magic|nonce|login_token|reset_token|verification_token|confirmation_token|apikey|key|k|upn|tk)$/i;
const AUTH_PARAM_VALUE = /^(?:login|signin|sign_in|magic|magiclink|reset|resetpassword|verify|verifyemail|recover)$/i;
const OPAQUE_SEGMENT = /^[A-Za-z0-9_.~-]{20,}$/;

/**
 * Whether a URL is a sign-in, password-reset or verification link: one that signs someone in
 * or proves they own the account. It needs both sign-in wording (in its path, host or a
 * parameter) and a secret-looking value (a token parameter, or a long opaque path segment).
 * Unsubscribe links never count. An unparseable URL doesn't either.
 */
export function isSignInUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const path = parsed.pathname.toLowerCase();
  if (path.includes("unsub") || parsed.search.toLowerCase().includes("unsub")) return false;
  let wording = AUTH_WORDING.test(path) || AUTH_HOST.test(parsed.hostname.toLowerCase());
  let secret = false;
  for (const [key, value] of parsed.searchParams) {
    if (AUTH_PARAM_VALUE.test(value) || AUTH_WORDING.test(key.toLowerCase())) wording = true;
    if ((SECRET_PARAM.test(key) || /token|secret|nonce/i.test(key)) && value.length >= 8) secret = true;
  }
  if (!secret) secret = path.split("/").some((segment) => OPAQUE_SEGMENT.test(segment) && /\d/.test(segment) && /[a-z]/i.test(segment));
  return wording && secret;
}

// Link text that says the link signs someone in (used for click-tracking wrappers, whose own
// address says nothing).
const SIGN_IN_LINK_TEXT = /\b(?:sign[- ]?in|log[- ]?in|reset (?:your |my )?password|set (?:a |your )?(?:new )?password|verify (?:your |my )?(?:email|account|identity|address)|confirm (?:your |my )?(?:email|account|address)|magic link|activate (?:your |my )?account|continue to sign in)\b/i;

/** Whether an anchor's visible text says it signs someone in or resets a password. */
export function isSignInLinkText(text: string): boolean {
  return text.length <= 200 && SIGN_IN_LINK_TEXT.test(text);
}

// A bare URL in text: up to the first character that cannot be part of one.
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`{}|\\^[\]]+/gi;
const TRAILING = new Set([".", ",", ";", ":", "!", "?", ")"]);

/** Replace each sign-in link written out in text with a marker. */
export function hideSignInLinks(text: string, counts: FilterCounts): string {
  return text.replace(URL_IN_TEXT, (match) => {
    // Trailing punctuation belongs to the sentence, not the link (a backwards loop: linear).
    let end = match.length;
    while (end > 0 && TRAILING.has(match[end - 1]!)) end -= 1;
    const url = match.slice(0, end);
    if (!isSignInUrl(url)) return match;
    counts.signInLinks += 1;
    return SIGN_IN_LINK_MASK + match.slice(end);
  });
}

// --- codes ---------------------------------------------------------------------------

// A code-shaped token: 4–8 digits (optionally "G-" style prefixed), or a 3+3 digit pair. A
// colon may sit right before it when a letter precedes the colon ("code:482913"), never in a
// time ("10:42"). A code stands on its own: never part of a longer spaced digit group, so the
// "417 273" in an account number "7126 417 273" isn't one (24 November 2026).
const CODE_CANDIDATE = /(?<![\p{L}\p{N}$€£¥#.,/-])(?<!\d:)(?<!\d[ -])(?:[A-Z]{1,3}-)?(?:\d{3}[ -]\d{3}|\d{4,8})(?![\p{L}\p{N}%]|[.,]\d|[ -]\d{3})/gu;

// Words that, near a number, mean "this unlocks an account".
const STRONG_WORDS = /\b(?:verification|verify|security code|one[- ]?time|otp|2fa|two[- ]?factor|two[- ]?step|2[- ]step|sign[- ]?in|signing in|log[- ]?in|logging in|login|authentication|auth code|access code|passcode)\b/;
// "123456 is your Instagram code" / "your WhatsApp code: 482-913" / "Your code is 4821".
const IS_YOUR_CODE_AFTER = /^\s*(?:is|=)\s+(?:your|the)\b[^\n]{0,30}\b(?:code|pin|otp)\b/;
const YOUR_CODE_BEFORE = /\byour\b[^\n]{0,30}\b(?:code|pin|otp)\b(?:\s+is)?\s*:?\s*$/;
const SIGN_IN_MAIL_WORDS = /\b(?:code|pin|password|passcode)\b/;
// Words right before a number (with nothing strong in between) that mean it's a reference.
const REFERENCE_WORDS = /\b(?:booking|reservation|confirmation|order|tracking|track|collection|pickup|pick-up|promo|promotion|discount|voucher|coupon|gift|presale|pre-sale|reference|ref|crn|bpay|biller|invoice|meeting|webinar|acct|bsb|phone|mobile|tel|abn|acn|postcode|post code|zip|flight|seat|gate|room|door|locker|lockbox|parking|ticket|policy|membership|claim|case|parcel|consignment|item|sku|serial|model|receipt|transaction|lot|unit|call|fax|quote|job|table|pnr)\b[^\n]{0,12}$/;
const MEETING_CONTEXT = /\b(?:zoom|meeting|webinar|teams|webex|google meet|conference|dial[- ]in)\b/;

// "temporary password is Xk82!qPz", "one-time password: 9fKq…": the value after "is" or ":".
// Only a value with a digit or symbol counts, so "new password requirements:" is left alone.
const TEMP_PASSWORD = /\b(?:temporary|temp|one[- ]time|initial|new)\s+(?:password|passcode)(?:\s+is\s*:?|\s*:)\s*([^\s<>"']{6,64})/gi;

/** Mask sign-in codes: a code-shaped number next to sign-in wording, never right after a reference word. */
export function maskSignInCodes(text: string, counts: FilterCounts, options: CleanOptions = {}): string {
  const masked = text.replace(CODE_CANDIDATE, (match, offset: number) => {
    const digits = match.replace(/\D/g, "");
    // Fixed-size windows around each candidate, lower-cased on their own: the scan stays linear.
    const before = text.slice(Math.max(0, offset - 60), offset).toLowerCase();
    const after = text.slice(offset + match.length, offset + match.length + 40).toLowerCase();
    if (REFERENCE_WORDS.test(before.slice(-30))) return match;
    const window = `${before} ${after}`;
    let strong = STRONG_WORDS.test(window) || IS_YOUR_CODE_AFTER.test(after) || YOUR_CODE_BEFORE.test(before);
    if (strong && /\bpasscode\b/.test(window) && !/\b(?:verification|one[- ]?time|otp|sign[- ]?in|log[- ]?in|login|security code|authentication)\b/.test(window)) {
      // A passcode beside meeting details joins a call; it unlocks no account.
      if (options.calendar || MEETING_CONTEXT.test(text.slice(Math.max(0, offset - 150), offset).toLowerCase())) strong = false;
    }
    if (!strong && options.signInMail) strong = SIGN_IN_MAIL_WORDS.test(window) || digits.length >= 6;
    if (!strong) return match;
    // A bare 4- or 5-digit number is a year, a time or a PIN only when the wording says so.
    if (digits.length < 6 && !/\b(?:code|pin|passcode|otp)\b/.test(`${before.slice(-20)} ${after.slice(0, 30)}`)) return match;
    counts.codes += 1;
    return SIGN_IN_CODE_MASK;
  });
  return masked.replace(TEMP_PASSWORD, (whole, value: string) => {
    if (!/[\d!@#$%^&*?_~+=-]/.test(value) || value.startsWith("[")) return whole;
    counts.codes += 1;
    return whole.slice(0, whole.length - value.length) + PASSWORD_MASK;
  });
}

// --- cards ---------------------------------------------------------------------------

// 13–19 digits with optional single spaces or dashes, bounded by non-digits.
const CARD_CANDIDATE = /(?<![\p{N}])\d(?:[ -]?\d){12,18}(?![\p{N}])/gu;
// Issuer prefixes of the card schemes Warthog's people use (Visa, Mastercard incl. 2-series,
// Amex, Discover, JCB, Diners). A reference number rarely starts with these AND passes Luhn.
export const CARD_PREFIX = /^(?:4|5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720|3[47]|6011|65|64[4-9]|35(?:2[89]|[3-8]\d)|30[0-5]|3[68])/;
const CARD_REFERENCE_WORDS = /\b(?:reference|ref|crn|bpay|biller|tracking|track|ticket|e-ticket|eticket|order|invoice|account|acct|member|policy|insurance|ctp|green slip|booking|consignment|parcel|item|serial|barcode|imei|phone|customer|receipt|transaction)\b/;

/**
 * Whether a run of digits is grouped the way a card is printed: run together, in fours (the last
 * group 1–4 digits), or Amex's 4-6-5 and Diners' 4-6-4. A policy number printed "36-0107901349-8"
 * can pass a card's checks, but no card is printed that way.
 */
export function cardGrouped(run: string): boolean {
  const sizes = run.split(/[ -]/).map((group) => group.length);
  if (sizes.length === 1) return true;
  const last = sizes[sizes.length - 1]!;
  if (sizes.slice(0, -1).every((size) => size === 4) && last >= 1 && last <= 4) return true;
  return sizes.length === 3 && sizes[0] === 4 && sizes[1] === 6 && (sizes[2] === 5 || sizes[2] === 4);
}

/** Mask what is very likely a full card number: a card-scheme prefix, a valid Luhn check, and no reference wording just before it. */
export function maskLikelyCards(text: string, counts: FilterCounts): string {
  return text.replace(CARD_CANDIDATE, (match, offset: number) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) return match;
    if (!CARD_PREFIX.test(digits) || !passesLuhn(digits) || !cardGrouped(match)) return match;
    const before = text.slice(Math.max(0, offset - 30), offset).toLowerCase();
    if (CARD_REFERENCE_WORDS.test(before)) return match;
    counts.cards += 1;
    return `[card ••••${digits.slice(-4)}]`;
  });
}

// --- identifying numbers (the private level) -----------------------------------------

// Words that name a number identifying the person or one of their accounts, written right
// before it. The number must follow on the same line, with at most a few joining words
// ("number", "no.", "#", ":", "is"), so "account balance $1,234", "account ending in 1234" and
// "Medicare rebate $39.10" are left alone. Member, policy, customer and card need "number"
// (or "no.", "#", "ID") too: "member since 2019" is not a membership number.
const JOINING = String.raw`(?:[ \t]{0,3}(?:number|no\.|no\b|num\.|num\b|#|:|-|is\b|id\b))`;
const NAMES_ALONE = String.raw`tax file|tfn|medicare(?: card)?|passport|licen[cs]e|bsb|account|acct|a\/c`;
const NAMES_WITH_NUMBER = String.raw`(?:member(?:ship)?|policy|customer|card)[ \t]{0,3}(?:number|no\.|no\b|num\.|num\b|#|id\b)`;
// The number: at least three digits, in groups split by single spaces or dashes, with up to
// four letters in front ("PA1234567", "POL-00123456"). Every quantifier is bounded.
const IDENTIFIER = new RegExp(
  String.raw`\b((?:${NAMES_ALONE}|${NAMES_WITH_NUMBER})${JOINING}{0,3}[ \t]{0,3})((?:[a-z]{1,4}-?)?\d(?:[ -]?\d){2,24})(?![\p{L}\p{N}])`,
  "giu",
);

/** Mask a number that identifies the person or one of their accounts, when the text names it just before. Only the number is masked. */
export function maskIdentifiers(text: string, counts: FilterCounts): string {
  return text.replace(IDENTIFIER, (_whole, named: string) => {
    counts.identifiers += 1;
    return named + IDENTIFIER_MASK;
  });
}

// --- all together --------------------------------------------------------------------

/**
 * Clean one piece of text an agent will read, at the person's level: invisible characters
 * always; sign-in links, sign-in codes and card numbers unless the level is open; and, at
 * the private level, the numbers that identify the person or their accounts.
 */
export function cleanText(text: string, counts: FilterCounts, options: CleanOptions = {}): string {
  const stripped = stripInvisible(text);
  counts.hiddenCharacters += stripped.removed;
  if (options.level === "open") return stripped.text;
  let out = hideSignInLinks(stripped.text, counts);
  out = maskSignInCodes(out, counts, options);
  out = maskLikelyCards(out, counts);
  if (options.level === "private") out = maskIdentifiers(out, counts);
  return out;
}

/** Whether anything was hidden or masked (invisible characters don't count: they were never seen). */
export function anythingHidden(counts: FilterCounts): boolean {
  return counts.signInLinks + counts.codes + counts.cards + counts.identifiers > 0;
}
