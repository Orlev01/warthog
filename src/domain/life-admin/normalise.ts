// Turning what an agent (or a form) sends into a record type's own fields
// (docs/adr/life-admin-profile.md, "Saving").
//
// Agents name things their own way ("insurer", "policy_number", "premium", "rego"), so a known
// alias is folded into the type's field ("provider", "reference", "amount", "plate"). Values
// are kept as plain strings, the way the Life admin page shows and edits them. Dates must be
// calendar dates, an amount a plain number, a cycle one of the known cycles. A date given as
// a field the type uses as its due date ("expiry", "renews_on") becomes the record's due
// date when none was given. Anything the type doesn't know is kept as an extra detail, within
// limits, so nothing an agent found is silently lost.
//
// From an agent, links are cut to their site name (a "pay here" link in an email never
// survives) and card numbers are masked to their last four. Identifiers that must never be
// kept are refused before this runs (`./identifiers.ts`).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.

import { linksToSiteNames, maskCards, siteName } from "./identifiers";
import { CYCLES, typeOfRecord, type Cycle, type FieldDef, type RecordTypeDef, type StoredKind } from "./record-types";

export const MAX_FIELD_CHARS = 500;
export const MAX_NOTES_CHARS = 2000;
export const MAX_EXTRA_FIELDS = 20;

// Common ways agents name a field, folded into the field a type keeps. An alias is used only
// when the type has the target field and not a field of the alias's own name.
const ALIASES: Readonly<Record<string, string>> = {
  service_name: "provider", merchant: "provider", store: "provider", retailer: "provider",
  insurer: "provider", insurance_company: "provider", fund: "provider", fund_name: "provider",
  lender: "provider", issuer: "provider", bank: "provider", company: "provider",
  organisation: "provider", organization: "provider", employer_name: "provider", council: "provider",
  workshop: "provider", practice: "provider", institution: "provider", authority: "provider",
  service: "provider",
  policy_number: "reference", policy_no: "reference", policy: "reference", member_number: "reference",
  member_no: "reference", membership_number: "reference", membership_no: "reference",
  account_number: "reference", account_no: "reference", customer_number: "reference",
  customer_no: "reference", reference_number: "reference", ref: "reference",
  registration_number_professional: "reference", student_number: "reference",
  cost: "amount", price: "amount", premium: "amount", fee: "amount", bill: "amount", rent: "amount",
  repayment: "amount", amount_due: "amount",
  billing_cycle: "cycle", frequency: "cycle", billing_frequency: "cycle", payment_frequency: "cycle",
  phone: "contact", phone_number: "contact", contact_phone: "contact",
  url: "website", link: "website", site: "website", web: "website",
  note: "notes", comments: "notes", comment: "notes", details: "notes", description: "notes",
  title: "name", nickname: "name",
  rego: "plate", rego_number: "plate", registration_number: "plate", plate_number: "plate",
  number_plate: "plate", licence_plate: "plate", license_plate: "plate", registration: "plate",
  last_four: "last4", last_4: "last4", last_digits: "last4", ending: "last4",
  nmi: "meter_id", mirn: "meter_id",
  warranty_end: "warranty_ends", warranty_until: "warranty_ends", warranty_expiry: "warranty_ends",
  order_no: "order_number", order_id: "order_number",
  date: "purchased_on", purchase_date: "purchased_on", bought_on: "purchased_on",
};

// Field names that carry a due date. When no due date was given and the type has one, the
// first of these holding a calendar date becomes it.
const DUE_KEYS = [
  "due_date", "duedate", "due", "due_on", "expiry", "expiry_date", "expires", "expires_on", "expiration",
  "renewal_date", "renews_on", "renews", "next_renewal", "renewal", "valid_to", "valid_until",
  "ends_on", "end_date", "return_by", "next_due", "next_service", "census_date",
];

const CYCLE_WORDS: Readonly<Record<string, Cycle>> = {
  weekly: "weekly", week: "weekly", a_week: "weekly",
  fortnightly: "fortnightly", fortnight: "fortnightly", biweekly: "fortnightly",
  monthly: "monthly", month: "monthly", a_month: "monthly",
  quarterly: "quarterly", quarter: "quarterly",
  yearly: "yearly", year: "yearly", annual: "yearly", annually: "yearly", a_year: "yearly", per_year: "yearly",
  one_off: "one_off", once: "one_off", one_time: "one_off",
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** A field name as the catalogue writes it: lower case, words joined by underscores. */
export function fieldKey(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/** A calendar date "YYYY-MM-DD" from an ISO date or date-time, or null. */
export function calendarDate(value: string): string | null {
  const match = ISO_DATE.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  if (year === "0000") return null;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCDate() === Number(day) && date.getUTCMonth() === Number(month) - 1 ? `${year}-${month}-${day}` : null;
}

/** A plain amount ("$1,250.50" → "1250.50"), or null when it isn't one. */
export function plainAmount(value: string): string | null {
  const cleaned = value.trim().replace(/^(?:[A-Za-z]{3}\s+|[A-Za-z]{0,2}\$\s*)/, "").replace(/[,\s]/g, "");
  return /^\d+(?:\.\d+)?$/.test(cleaned) ? cleaned : null;
}

/** One of the known cycles, or null. */
export function cycleOf(value: string): Cycle | null {
  const word = fieldKey(value);
  return (CYCLES as readonly string[]).includes(word) ? (word as Cycle) : CYCLE_WORDS[word] ?? null;
}

export interface NormaliseOptions {
  // From an agent: links become site names and card numbers are masked.
  readonly fromAgent: boolean;
}

export interface NormalisedFields {
  readonly fields: Record<string, string>;
  // A due date found among the fields (only when none was given separately).
  readonly dueDate: string | null;
  // Plain notes on what was changed or dropped, for the agent or person who saved it.
  readonly problems: string[];
}

function scalar(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return null;
}

/**
 * The fields to keep for a record of `type`, from `raw` (an agent's or form's field map).
 * `hasDueDate` says whether a due date was given separately, so one is not lifted from the
 * fields. A null or empty value leaves the field out.
 */
export function normaliseFields(
  type: RecordTypeDef,
  raw: Readonly<Record<string, unknown>>,
  hasDueDate: boolean,
  options: NormaliseOptions,
): NormalisedFields {
  const known = new Map<string, FieldDef>(type.fields.map((field) => [field.key, field]));
  const fields: Record<string, string> = {};
  const problems: string[] = [];
  let dueDate: string | null = null;
  let extras = 0;
  let linksCut = false;
  let cardsMasked = false;

  for (const [rawKey, rawValue] of Object.entries(raw)) {
    let value = scalar(rawValue);
    if (value === null) {
      if (rawValue !== null && rawValue !== undefined) problems.push(`Left out "${rawKey}": give a plain text, number or date value.`);
      continue;
    }
    if (value === "") continue;

    const plain = fieldKey(rawKey);
    if (!plain) continue;
    const aliased = ALIASES[plain];
    const key = known.has(plain) || !aliased || !known.has(aliased) ? plain : aliased;
    const def = known.get(key);

    // A due date given as a field becomes the record's due date.
    if (!def && type.due && !hasDueDate && dueDate === null && DUE_KEYS.includes(plain)) {
      const date = calendarDate(value);
      if (date) {
        dueDate = date;
        continue;
      }
    }

    if (options.fromAgent && def?.kind !== "website") {
      const links = linksToSiteNames(value);
      const cards = maskCards(links.value);
      linksCut ||= links.changed;
      cardsMasked ||= cards.masked;
      value = cards.value.trim();
      if (value === "") continue;
    }

    if (!def) {
      if (extras >= MAX_EXTRA_FIELDS) {
        problems.push(`Left out "${rawKey}": a record keeps at most ${MAX_EXTRA_FIELDS} extra details.`);
        continue;
      }
      extras += 1;
      fields[key] = value.slice(0, MAX_FIELD_CHARS);
      continue;
    }

    switch (def.kind) {
      case "date": {
        const date = calendarDate(value);
        if (!date) {
          problems.push(`Left out "${rawKey}": dates are YYYY-MM-DD.`);
          continue;
        }
        fields[key] = date;
        break;
      }
      case "amount": {
        const amount = plainAmount(value);
        if (amount === null) {
          problems.push(`Left out "${rawKey}": give the amount as a plain number, with the currency in "currency".`);
          continue;
        }
        fields[key] = amount;
        break;
      }
      case "currency": {
        const code = value.toUpperCase();
        if (!/^[A-Z]{3}$/.test(code)) {
          problems.push(`Left out "${rawKey}": give the currency as a three-letter code, for example AUD.`);
          continue;
        }
        fields[key] = code;
        break;
      }
      case "cycle": {
        const cycle = cycleOf(value);
        if (!cycle) {
          problems.push(`Left out "${rawKey}": use weekly, fortnightly, monthly, quarterly, yearly or one_off.`);
          continue;
        }
        fields[key] = cycle;
        break;
      }
      case "last4": {
        const chars = value.replace(/[^A-Za-z0-9]/g, "");
        if (chars.length === 0) continue;
        fields[key] = chars.slice(-4);
        if (chars.length > 4) problems.push(`Kept only the last 4 characters of "${rawKey}".`);
        break;
      }
      case "website": {
        const site = siteName(value);
        if (!site) {
          problems.push(`Left out "${rawKey}": give a website such as example.com.au.`);
          continue;
        }
        fields[key] = site;
        break;
      }
      case "long_text":
        fields[key] = value.slice(0, MAX_NOTES_CHARS);
        break;
      default:
        fields[key] = value.slice(0, MAX_FIELD_CHARS);
    }
  }

  if (linksCut) problems.push("Links are kept as the website's name only.");
  if (cardsMasked) problems.push("Card numbers are kept as their last 4 digits only.");
  return { fields, dueDate, problems };
}

/** A record's display name: its name, else its provider, else its item, else the type's label. */
export function recordDisplayName(type: RecordTypeDef, fields: Readonly<Record<string, unknown>>): string {
  for (const key of ["name", "provider", "item", "service", "merchant", "title"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return type.label;
}

/**
 * The name a stored record goes by anywhere it is listed: its own name or title (older and
 * agent-written records use `title` or `what`), else its provider or item, else the first
 * filled-in value, else its type in words — never a stored enum.
 */
export function storedRecordName(kind: StoredKind, storedType: string | null | undefined, fields: Readonly<Record<string, unknown>>): string {
  const text = (key: string) => (typeof fields[key] === "string" ? (fields[key] as string).trim() : "");
  for (const key of ["name", "title", "item", "what"]) if (text(key)) return text(key);
  const type = typeOfRecord(kind, storedType);
  const typed = Boolean(storedType) && type.id === storedType;
  // A typed record identified by something other than its provider (a plate, a country, a
  // state) goes by its type and that ("Registration · BX12AB", "Passport · Australia"), so a
  // rego isn't named after the registration authority.
  if (typed && !type.identity.includes("provider")) {
    const lead = type.identity.find((part) => !["provider", "parent", "title", "name"].includes(part) && text(part));
    if (lead) return `${type.label} · ${text(lead)}`;
  }
  for (const key of ["provider", "service", "merchant"]) if (text(key)) return text(key);
  if (typed) return type.label;
  const first = Object.values(fields).find((value): value is string => typeof value === "string" && value.trim() !== "");
  return first?.trim() ?? type.label;
}

/** The values that identify one record of `type` (normalised), or null when any is missing. */
export function identityParts(
  type: RecordTypeDef,
  fields: Readonly<Record<string, unknown>>,
  parentId: string | null,
): string[] | null {
  if (type.singleton) return [];
  if (type.identity.length === 0) return null;
  const parts: string[] = [];
  for (const key of type.identity) {
    const value = key === "parent" ? parentId : key === "title" ? recordDisplayName(type, fields) : fields[key];
    const text = typeof value === "string" ? value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") : "";
    if (text === "" || (key === "title" && value === type.label)) return null;
    parts.push(text);
  }
  return parts;
}
