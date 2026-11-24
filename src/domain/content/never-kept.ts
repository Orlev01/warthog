// What Warthog never keeps, in the free text an agent saves to Warthog's own stores: memories and
// tasks (docs/adr/profile-build.md). Records and their journals already refuse these
// (src/domain/life-admin/identifiers.ts, journal-text.ts); a profile build reads a lot of other
// people's writing, so memories and tasks get the same check: no tax file numbers, passwords or
// codes, BSB and account numbers, government ID or Medicare numbers, or payment references.
// Card numbers are masked to their last four.
//
// The check runs in the MCP input schema, so a refused call is recorded without its parameters.
// A refusal names what was refused and the rule, never the text.
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.

import { maskCards, type IdentifierRule } from "../life-admin/identifiers";
import { findForbiddenText } from "../life-admin/journal-text";

/** The rule a piece of free text breaks, or null. */
export function neverKeptRule(text: string): IdentifierRule | null {
  return findForbiddenText(text);
}

const WHAT: Readonly<Record<IdentifierRule, string>> = {
  tax_file_number: "a tax file number. Warthog never keeps tax file numbers.",
  secret: "a password, PIN, security answer or code. Warthog never keeps these.",
  bank_account: "a BSB and account number. Keep only the bank and the last 4 digits.",
  government_id: "a passport, licence, visa or Centrelink number. Leave it out: the person keeps it in their Warthog Vault.",
  medicare: "a Medicare number. Leave it out: the person keeps it in their Warthog Vault.",
  payment_details: "payment details (a payee, a biller code or a payment reference). Warthog doesn't keep payment details.",
};

/** "The memory looks like it has a tax file number. …" */
export function neverKeptMessage(what: string, rule: IdentifierRule): string {
  return `${what} looks like it has ${WHAT[rule]}`;
}

/** The text as it is kept: card numbers masked to their last four. */
export function tidyKeptText(text: string): string {
  return maskCards(text).value;
}
