// What a life-admin record must never hold (docs/adr/life-admin-profile.md, "Never kept").
//
// Records are encrypted under the person's server-held data key and shared with the agents
// they allow, so they are no place for a value that unlocks an account or proves an identity:
//   • never kept anywhere: tax file numbers (the TFN Rule binds anyone holding one),
//     passwords, PINs, security answers, one-time and recovery codes, bank logins, BSB +
//     account numbers, telco port-out PINs, alarm codes, healthcare identifiers;
//   • kept only in the device-held Vault: passport, driver licence (and licence card),
//     Medicare, visa grant and Centrelink numbers — they enable identity takeover, so the
//     person adds them there themselves and releases them per request.
// Card numbers are masked to their last four, as everywhere else in Warthog.
//
// The checks are deterministic (no model): a forbidden field NAME, or a value SHAPE together
// with the words around it. A finding names the field and the rule, never the value, so the
// refusal itself carries nothing sensitive. Run at the tool's input schema, a refused call is
// recorded without its parameters, so a refused value never reaches the activity record.
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.

import { normaliseValue, passesLuhn } from "../redaction/luhn";
import { BUILT_IN_TYPES } from "./record-types";

export type IdentifierRule =
  | "tax_file_number"
  | "secret"
  | "bank_account"
  | "government_id"
  | "medicare"
  | "payment_details";

export interface IdentifierFinding {
  readonly field: string;
  readonly rule: IdentifierRule;
}

// Exact field names (normalised: lower case, letters and digits only) that are refused.
const FORBIDDEN_NAMES: ReadonlyMap<string, IdentifierRule> = new Map<string, IdentifierRule>([
  ...["tfn", "taxfilenumber", "taxfileno", "taxfile"].map((name) => [name, "tax_file_number"] as const),
  ...[
    "password", "passwd", "passphrase", "passcode", "pin", "pincode", "cvv", "cvc", "cvn", "securitycode",
    "securityanswer", "secretanswer", "securityquestion", "memorableword", "otp", "mfa", "mfacode",
    "recoverycode", "backupcode", "onetimecode", "cardnumber", "creditcardnumber", "pan", "portoutpin",
    "portingpin", "alarmcode", "safecode", "seedphrase", "recoveryphrase", "privatekey", "login",
    "banklogin", "netbankid", "ihi", "individualhealthcareidentifier",
  ].map((name) => [name, "secret"] as const),
  ...["bsb", "bankaccountnumber", "bsbaccount", "bsbandaccount"].map((name) => [name, "bank_account"] as const),
  ...[
    "passportnumber", "passportno", "licencenumber", "licenceno", "licensenumber", "licenseno",
    "driverlicencenumber", "driverslicencenumber", "driverlicensenumber", "licencecardnumber",
    "licensecardnumber", "cardnumberlicence", "visagrantnumber", "grantnumber", "centrelinkcrn",
    "centrelinknumber", "dvanumber",
  ].map((name) => [name, "government_id"] as const),
  ...["medicarenumber", "medicareno", "medicarecardnumber", "irn"].map((name) => [name, "medicare"] as const),
  // A biller code or BPAY reference read from an email is how a fake bill redirects a payment.
  // So is a "how to pay" instruction or payee lifted from one (red line: nothing from an email is
  // ever kept as how to pay).
  ...["bpay", "billercode", "bpaybillercode", "bpayref", "bpayreference", "bpaycrn", "crn", "payid",
    "howtopay", "payat", "payto", "paylink", "paymentlink", "paymenturl", "paymentinstructions",
    "payee", "payeedetails", "payeeaccount"].map((name) => [name, "payment_details"] as const),
]);

// Name endings that are refused whatever comes first ("account_pin", "portal_password").
const FORBIDDEN_ENDINGS: readonly (readonly [string, IdentifierRule])[] = [
  ["password", "secret"],
  ["passcode", "secret"],
  ["pin", "secret"],
  ["securitycode", "secret"],
  ["securityanswer", "secret"],
  ["recoverycode", "secret"],
  ["verificationcode", "secret"],
  ["accesscode", "secret"],
  ["authcode", "secret"],
  ["authenticationcode", "secret"],
  ["gatecode", "secret"],
  ["doorcode", "secret"],
  ["tfn", "tax_file_number"],
  ["taxfilenumber", "tax_file_number"],
];

export function forbiddenFieldName(name: string): IdentifierRule | null {
  const key = normaliseValue(name);
  const exact = FORBIDDEN_NAMES.get(key);
  if (exact) return exact;
  for (const [ending, rule] of FORBIDDEN_ENDINGS) if (key.endsWith(ending)) return rule;
  return null;
}

// ---- value shapes, each refused only with the words that say what it is -------------------

const TFN_WORDS = /\b(tfn|tax\s*file)\b/i;
const NINE_DIGITS = /(?<![\d])\d{3}[ -]?\d{3}[ -]?\d{2,3}(?![\d])/;
const SECRET_STATEMENT = /\b(password|passcode|pin|security\s+answer|secret\s+answer|one[- ]time\s+code|recovery\s+code)\b\s*(?:is|was|:|=|-)\s*\S+/i;
const BSB_WORDS = /\bbsb\b/i;
const BSB_SHAPE = /(?<![\d])\d{3}[ -]?\d{3}(?![\d])/;
const PASSPORT_WORDS = /\bpassport\b/i;
const PASSPORT_SHAPE = /\b[A-Z]{1,2}\d{7}\b/i;
const LICENCE_WORDS = /\blicen[cs]e\s*(?:no\b|number|#|card)|\bcard\s*number\b/i;
const MEDICARE_WORDS = /\bmedicare\b/i;
const CENTRELINK_WORDS = /\b(centrelink|visa\s+grant|grant\s+number)\b/i;
const DOCUMENT_TOKEN = /[A-Za-z0-9]{6,}/g;

// The Medicare card number check digit: digits 1–8 weighted 1,3,7,9,1,3,7,9, mod 10, is digit 9.
// The first digit is 2–6. A ten-digit card may carry an eleventh (the issue number).
function looksLikeMedicare(digits: string): boolean {
  if (!/^[2-6]\d{9,10}$/.test(digits)) return false;
  const weights = [1, 3, 7, 9, 1, 3, 7, 9];
  const sum = weights.reduce((total, weight, index) => total + weight * Number(digits[index]), 0);
  return sum % 10 === Number(digits[8]);
}

// Digit runs (spaces and dashes allowed between digits), returned as bare digits.
function digitRuns(text: string): string[] {
  return [...text.matchAll(/\d(?:[ -]?\d)*/g)].map((match) => match[0].replace(/[^\d]/g, ""));
}

// The identifier-heavy ID document kinds (marked documentLike in the catalogue), where any
// document-number-shaped token is refused whatever it is called.
const DOCUMENT_TYPES = new Set(BUILT_IN_TYPES.filter((type) => type.documentLike).map((type) => type.id));

// Fields whose values legitimately look like long numbers: a meter id (NMI and MIRN start
// 2–6 like a Medicare number), and the record's own reference numbers.
const NUMBER_FIELDS = new Set(["meter_id", "nmi", "mirn", "reference", "order_number", "serial_number", "vin", "usi", "fund_abn", "microchip", "contact", "claims_phone", "emergency_phone", "phone_number", "phone"]);

/** The rule a single value breaks, given its field name and record type; null when it is fine. */
export function forbiddenValue(field: string, value: string, typeId: string | null): IdentifierRule | null {
  const context = `${field.replace(/[_-]+/g, " ")} ${value}`;
  if (TFN_WORDS.test(context) && NINE_DIGITS.test(value)) return "tax_file_number";
  if (SECRET_STATEMENT.test(value)) return "secret";
  if (BSB_WORDS.test(context) && BSB_SHAPE.test(value)) return "bank_account";
  if (PASSPORT_WORDS.test(context) && PASSPORT_SHAPE.test(value)) return "government_id";
  if (LICENCE_WORDS.test(context) && /\d{5,}/.test(value.replace(/[ -]/g, ""))) return "government_id";
  if (CENTRELINK_WORDS.test(context) && /\d{6,}/.test(value.replace(/[ -]/g, ""))) return "government_id";
  const numberField = NUMBER_FIELDS.has(normaliseField(field));
  // A phone number can share a Medicare number's shape, so only the word, or the Medicare
  // card's own record, makes a matching run a Medicare number.
  const medicareContext = MEDICARE_WORDS.test(context) || typeId === "id.medicare";
  if (!numberField && medicareContext && digitRuns(value).some(looksLikeMedicare)) return "medicare";
  if (typeId && DOCUMENT_TYPES.has(typeId)) {
    for (const token of value.match(DOCUMENT_TOKEN) ?? []) {
      if ((token.match(/\d/g) ?? []).length >= 4 && !/^\d{4}$/.test(token) && !/^(19|20)\d{6}$/.test(token)) return "government_id";
    }
  }
  return null;
}

function normaliseField(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Every finding in one record's fields (names first, then values). */
export function findForbidden(fields: Readonly<Record<string, unknown>>, typeId: string | null): IdentifierFinding[] {
  const findings: IdentifierFinding[] = [];
  for (const [field, raw] of Object.entries(fields)) {
    const byName = forbiddenFieldName(field);
    if (byName) {
      findings.push({ field, rule: byName });
      continue;
    }
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    const byValue = forbiddenValue(field, String(raw), typeId);
    if (byValue) findings.push({ field, rule: byValue });
  }
  return findings;
}

/** The plain sentence a refusal gives for a finding: names the field and the rule, never the value. */
export function findingMessage(finding: IdentifierFinding): string {
  const field = `"${finding.field}"`;
  switch (finding.rule) {
    case "tax_file_number":
      return `${field} looks like a tax file number. Warthog never keeps tax file numbers.`;
    case "secret":
      return `${field} looks like a password, PIN, security answer or code. Warthog never keeps these in records.`;
    case "bank_account":
      return `${field} looks like a BSB and account number. Keep only the bank and the last 4 digits (last4).`;
    case "government_id":
      return `${field} looks like a passport, licence, visa or Centrelink number. Leave the number out: the person keeps it in their Warthog Vault.`;
    case "medicare":
      return `${field} looks like a Medicare number. Leave the number out: the person keeps it in their Warthog Vault.`;
    case "payment_details":
      return `${field} looks like payment details (how to pay, a payee, a biller code or reference). Warthog doesn't keep payment details taken from email; the person pays through the provider's own app or bill.`;
  }
}

// ---- value tidying for anything saved from email ------------------------------------------

const CARD_RUN = /[0-9](?:[ \-]?[0-9]){12,18}/g;
const LINK = /\bhttps?:\/\/[^\s<>"')]+/gi;

/** Card numbers masked to their last four, as everywhere else in Warthog. */
export function maskCards(value: string): { value: string; masked: boolean } {
  let masked = false;
  const out = value.replace(CARD_RUN, (run) => {
    const digits = run.replace(/[^0-9]/g, "");
    if (!passesLuhn(digits)) return run;
    masked = true;
    return `••••${digits.slice(-4)}`;
  });
  return { value: out, masked };
}

/** A link's site name ("https://my.service.nsw.gov.au/renew?x=1" → "my.service.nsw.gov.au"). */
export function siteName(link: string): string | null {
  try {
    const url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
    return url.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Every link in a value replaced by its site name, so no "pay here" link from an email survives. */
export function linksToSiteNames(value: string): { value: string; changed: boolean } {
  let changed = false;
  const out = value.replace(LINK, (link) => {
    changed = true;
    return siteName(link) ?? "";
  });
  return { value: out, changed };
}
