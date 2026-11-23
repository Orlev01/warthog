// What a life-admin journal entry may say (docs/adr/life-admin-journal.md). An entry is one or two
// lines an agent (or the person) writes about an item — a decision and why, a note, the next step
// — that any later agent reads to carry on. Agents write it straight after reading email, so it is
// checked like a record's fields: no tax file numbers, secrets, bank or government ID numbers, or
// payment references; links are cut to their site name, card numbers masked, the text cut to 280
// characters at a word boundary.
//
// The check runs in the MCP input schema, so a refused entry is recorded without its parameters.
// A refusal names the place and the rule, never the text.
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.

import { forbiddenValue, linksToSiteNames, maskCards, type IdentifierRule } from "./identifiers";

export const JOURNAL_TEXT_MAX = 280;
// The longest text the schema accepts before cleaning; anything between the two is cut.
export const JOURNAL_TEXT_LIMIT = 600;

// A BPAY, biller or payment reference beside a run of digits: a fake bill's way to redirect money.
const PAYMENT_REFERENCE = /\b(bpay|biller|payment\s+ref(?:erence)?|crn|payid)\b[^\d]{0,20}\d{4,}/i;

/** The rule a piece of journal text breaks, or null. */
export function findForbiddenText(text: string, typeId: string | null = null): IdentifierRule | null {
  if (PAYMENT_REFERENCE.test(text)) return "payment_details";
  return forbiddenValue("text", text, typeId);
}

const INVISIBLE = /[\u0000-\u001f\u007f­​-‏‪-‮⁠-⁤﻿]/g;

/**
 * Journal text as it is kept: invisible and control characters removed, whitespace collapsed,
 * links cut to their site name, card numbers masked, and at most 280 characters, cut at a word
 * boundary (never through a "••••1234" mask). Empty after cleaning ⇒ null.
 */
export function cleanJournalText(text: string): { text: string; cut: boolean } | null {
  const tidy = text.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  if (tidy === "") return null;
  const masked = maskCards(linksToSiteNames(tidy).value).value;
  const chars = Array.from(masked);
  if (chars.length <= JOURNAL_TEXT_MAX) return { text: masked, cut: false };
  let cut = chars.slice(0, JOURNAL_TEXT_MAX).join("");
  const boundary = cut.lastIndexOf(" ");
  if (boundary > JOURNAL_TEXT_MAX / 2) cut = cut.slice(0, boundary);
  return { text: `${cut.trimEnd()}…`, cut: true };
}
