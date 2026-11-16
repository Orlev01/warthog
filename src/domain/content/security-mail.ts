// Read-side protection — recognising the emails that are as good as a key to an account:
// sign-in codes, password resets and sign-in links (docs/adr/read-side-protection.md).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.
//
// Warthog withholds these from agents (a short stub says one arrived and links the person
// to it). Recognition is deliberately narrow — strong subject wording only — so ordinary
// mail that merely mentions a password, a bank statement or a "new sign-in" alert (which the
// person may want an agent to ask them about) is read normally, with any code inside masked.

export type SecurityMailKind = "sign-in code" | "password reset" | "sign-in link";

// A code-shaped token in the subject ("123456 is your code", "G-482913").
const SUBJECT_DIGITS = /(?<![\p{L}\p{N}])(?:[A-Z]{1,3}-)?\d{4,8}(?![\p{L}\p{N}])/u;
// Wording that makes a subject a sign-in code, never a booking, presale or tax code.
const STRONG_CODE_SUBJECT = /\b(?:verification|security|sign[- ]?in|log[- ]?in|login|one[- ]?time|authentication|2fa|otp|2-step|two[- ]step|two[- ]factor)\s+(?:code|pin|passcode)\b/i;
// Weaker wording that counts only when the subject carries the code itself.
const CODE_WITH_DIGITS = [
  /\b(?:your|is your|is the)\b[^\n]{0,40}\b(?:code|passcode|otp|pin)\b/i,
  /\b(?:confirmation|access)\s+code\b/i,
  /\b(?:otp|one[- ]?time (?:password|passcode|pin))\b/i,
];
const CODE_EXCLUDE = /\b(?:booking|reservation|order|promo|promotion|discount|voucher|coupon|tracking|gift|referral|invite|presale|pre-sale|tax|door|lockbox|locker|parking|flight|trip|ticket|pr|pull request|changes|commit|dress code|post ?code|zip code|area code|qr code|code review|source code|code of conduct|coding|codebase|claude code|vs code)\b/i;
const RESET_SUBJECT = /\b(?:reset|recover|forgot(?:ten)?)\b[^\n]{0,30}\bpassword\b|\bpassword\b[^\n]{0,20}\b(?:reset|recovery)\b|\b(?:change|new) password request\b|\btemporary password\b/i;
const LINK_SUBJECT = /\b(?:magic|sign[- ]?in|log[- ]?in|login)\s+link\b|\b(?:sign|log)\s+in\s+to\b[^\n]{0,40}\bwith\s+this\s+link\b/i;

/**
 * What kind of account-key email a subject announces, or null for any other email. Only
 * the subject is read: it is what the person sees in their inbox, and strong wording there
 * is a far more reliable signal than anything in the body.
 */
export function classifySecurityMail(subject: string | undefined): SecurityMailKind | null {
  if (!subject) return null;
  const text = subject.normalize("NFKC");
  if (RESET_SUBJECT.test(text)) return "password reset";
  if (LINK_SUBJECT.test(text)) return "sign-in link";
  if (CODE_EXCLUDE.test(text)) return null;
  if (STRONG_CODE_SUBJECT.test(text)) return "sign-in code";
  if (SUBJECT_DIGITS.test(text) && CODE_WITH_DIGITS.some((pattern) => pattern.test(text))) return "sign-in code";
  return null;
}

/** The sentence an agent can pass on when Warthog withholds one of these emails. */
export function withheldSentence(kind: SecurityMailKind, from: string | undefined, openIn: string, link: string | undefined): string {
  const sender = from && from.trim() ? from.trim() : "a sender";
  const where = link ? `open it in ${openIn}: ${link}` : `open it in ${openIn}`;
  return `Warthog keeps sign-in codes and password links away from agents, so this ${kind} email from ${sender} isn't shown. Tell the person it arrived and that they can ${where}.`;
}
