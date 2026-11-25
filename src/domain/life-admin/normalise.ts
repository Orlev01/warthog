// Turning what an agent (or a form) sends into a record kind's own fields
// (docs/adr/life-admin-profile.md, "Saving").
//
// Agents name things their own way ("insurer", "policy_number", "premium", "rego", "venue"), so a
// known alias is folded into the kind's field ("provider", "reference", "amount", "plate",
// "place"). Values are kept as plain strings, the way the Life admin page shows and edits them,
// in a canonical form per field kind: calendar dates, date-times with their own time zone
// ("2026-12-03T19:30+11:00[Australia/Sydney]"), month/year, plain numbers and amounts, yes/no,
// ISO durations. A due date given as a field ("expiry") becomes the record's due date when none
// was given. Anything the kind doesn't know is kept as an extra detail, within limits, so nothing
// an agent found is silently lost; agents can also send labelled `details`.
//
// From an agent, links are cut to their site name (a "pay here" link in an email never survives)
// and card numbers are masked to their last four. Identifiers that must never be kept are refused
// before this runs (`./identifiers.ts`).
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.

import { linksToSiteNames, maskCards, siteName } from "./identifiers";
import { isTimeZone, parseWhen, zoneOffsetMinutes } from "./lifecycle";
import { CYCLES, type Cycle, type FieldDef, type RecordTypeDef } from "./record-types";

export const MAX_FIELD_CHARS = 500;
export const MAX_NOTES_CHARS = 2000;
export const MAX_EXTRA_FIELDS = 20;
export const MAX_PLACE_CHARS = 300;
export const MAX_PERSON_CHARS = 60;

// Common ways agents name a field, folded into the first of the targets the kind has. An alias is
// used only when the kind has no field of the alias's own name.
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  service_name: ["provider"], merchant: ["provider"], store: ["provider"], retailer: ["provider"],
  insurer: ["provider"], insurance_company: ["provider"], fund: ["provider"], fund_name: ["provider"],
  lender: ["provider"], issuer: ["provider"], bank: ["provider"], company: ["provider"], airline: ["provider"],
  organisation: ["provider"], organization: ["provider"], employer_name: ["provider"], council: ["provider"],
  workshop: ["provider"], practice: ["provider"], clinic: ["provider"], institution: ["provider"],
  authority: ["provider"], restaurant: ["provider"], hotel: ["provider"], operator: ["provider"],
  service: ["provider"], vendor: ["provider"], platform: ["booked_via", "provider"],
  policy_number: ["reference"], policy_no: ["reference"], policy: ["reference"], member_number: ["reference"],
  member_no: ["reference"], membership_number: ["reference"], membership_no: ["reference"],
  account_number: ["reference"], account_no: ["reference"], customer_number: ["reference"],
  customer_no: ["reference"], reference_number: ["reference"], ref: ["reference"],
  confirmation: ["reference"], confirmation_number: ["reference"], confirmation_code: ["reference"],
  booking_reference: ["reference"], booking_ref: ["reference"], booking_number: ["reference"],
  reservation_number: ["reference"], pnr: ["reference"], claim_number: ["reference"], notice_number: ["reference"],
  student_number: ["reference"],
  cost: ["amount"], price: ["amount"], premium: ["amount"], fee: ["amount"], bill: ["amount"], rent: ["amount"],
  repayment: ["amount"], amount_due: ["amount"], total: ["amount"], total_price: ["amount"],
  billing_cycle: ["cycle"], frequency: ["cycle"], billing_frequency: ["cycle"], payment_frequency: ["cycle"],
  phone: ["contact"], contact_phone: ["contact"], telephone: ["contact"],
  email_address: ["email"],
  url: ["website"], link: ["website"], site: ["website"], web: ["website"],
  note: ["notes"], comments: ["notes"], comment: ["notes"], description: ["notes"],
  title: ["name"], nickname: ["name"],
  rego: ["plate"], rego_number: ["plate"], registration_number: ["plate"], plate_number: ["plate"],
  number_plate: ["plate"], licence_plate: ["plate"], license_plate: ["plate"], registration: ["plate"],
  last_four: ["last4"], last_4: ["last4"], last_digits: ["last4"], ending: ["last4"],
  nmi: ["meter_id"], mirn: ["meter_id"],
  warranty_end: ["warranty_ends"], warranty_until: ["warranty_ends"], warranty_expiry: ["warranty_ends"],
  order_no: ["order_number"], order_id: ["order_number"],
  date: ["purchased_on", "starts_at"], purchase_date: ["purchased_on"], bought_on: ["purchased_on"],
  start: ["starts_at"], starts: ["starts_at"], start_time: ["starts_at"], start_date: ["starts_at"], when: ["starts_at"],
  date_time: ["starts_at"], datetime: ["starts_at"], departure: ["starts_at"], departure_time: ["starts_at"],
  check_in: ["starts_at"], checkin: ["starts_at"], pickup_time: ["starts_at"], appointment_time: ["starts_at"],
  end: ["ends_at"], ends: ["ends_at"], end_time: ["ends_at"], end_date: ["ends_at"], arrival: ["ends_at"],
  arrival_time: ["ends_at"], check_out: ["ends_at"], checkout: ["ends_at"], return_time: ["ends_at"],
  venue: ["place"], location: ["place"], address: ["address", "place"], where: ["where", "place"],
  party: ["party_size"], guests: ["party_size"], people: ["people", "party_size"], party_size: ["party_size"],
  flight: ["flight_number"], flight_no: ["flight_number"],
  for: ["for_whom"], for_person: ["for_whom"], on_behalf_of: ["for_whom"], traveller: ["for_whom"], passenger: ["for_whom"], patient: ["for_whom"],
  cancellation_deadline: ["cancel_by"], free_cancellation_until: ["cancel_by"],
};

// Field names that carry a due date. When no due date was given and the kind has one, the first of
// these holding a calendar date becomes it.
const DUE_KEYS = [
  "due_date", "duedate", "due", "due_on", "expiry", "expiry_date", "expires", "expires_on", "expiration",
  "renewal_date", "renews_on", "renews", "next_renewal", "renewal", "valid_to", "valid_until",
  "ends_on", "return_by", "next_due", "next_service", "census_date", "pay_by",
];

const CYCLE_WORDS: Readonly<Record<string, Cycle>> = {
  weekly: "weekly", week: "weekly", a_week: "weekly",
  fortnightly: "fortnightly", fortnight: "fortnightly", biweekly: "fortnightly",
  monthly: "monthly", month: "monthly", a_month: "monthly",
  quarterly: "quarterly", quarter: "quarterly",
  yearly: "yearly", year: "yearly", annual: "yearly", annually: "yearly", a_year: "yearly", per_year: "yearly",
  one_off: "one_off", once: "one_off", one_time: "one_off",
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?(?:\[[^\]]+\])?$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

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

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * A date or date-time in canonical form: "2026-12-03" for a date alone, else
 * "2026-12-03T19:30+11:00[Australia/Sydney]" — the wall time, its offset, and the zone it happens
 * in (its own when given, else `fallbackZone`, which is then reported as assumed).
 */
export function canonicalDateTime(value: string, fallbackZone: string): { value: string; assumedZone: boolean } | null {
  const raw = value.trim();
  const bracket = /\[([^\]]+)\]$/.exec(raw)?.[1];
  const explicitZone = bracket && isTimeZone(bracket) ? bracket : null;
  if (bracket && !explicitZone) return null;
  const when = parseWhen(raw, explicitZone ?? fallbackZone);
  if (!when) return null;
  if (when.dateOnly) return calendarDate(when.date) ? { value: when.date, assumedZone: false } : null;
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})(?:\[[^\]]+\])?$/.test(raw);
  const zone = explicitZone ?? fallbackZone;
  const offset = zoneOffsetMinutes(zone, when.instant);
  // An offset given without a zone that doesn't fit the fallback zone: keep the offset, no zone.
  if (hasOffset && !explicitZone) {
    const given = /(Z|[+-]\d{2}:?\d{2})$/.exec(raw)![1]!;
    const givenMinutes = given === "Z" ? 0 : (given.startsWith("-") ? -1 : 1) * (Number(given.replace(/[+:-]/g, "").slice(0, 2)) * 60 + Number(given.replace(/[+:-]/g, "").slice(2, 4)));
    const local = new Date(when.instant.getTime() + givenMinutes * 60_000).toISOString().slice(0, 16);
    return { value: givenMinutes === offset ? `${local}${offsetText(offset)}[${zone}]` : `${local}${offsetText(givenMinutes)}`, assumedZone: false };
  }
  const local = new Date(when.instant.getTime() + offset * 60_000).toISOString().slice(0, 16);
  return { value: `${local}${offsetText(offset)}[${zone}]`, assumedZone: !explicitZone && !hasOffset };
}

/** "2027-03" from "2027-03", "03/27", "03/2027", "March 2027" or "Mar 2027". */
export function monthYear(value: string): string | null {
  const v = value.trim().toLowerCase();
  let match = /^(\d{4})-(\d{1,2})$/.exec(v);
  if (match) return Number(match[2]) >= 1 && Number(match[2]) <= 12 ? `${match[1]}-${match[2]!.padStart(2, "0")}` : null;
  match = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(v);
  if (match) {
    const month = Number(match[1]);
    const year = match[2]!.length === 2 ? 2000 + Number(match[2]) : Number(match[2]);
    return month >= 1 && month <= 12 ? `${year}-${String(month).padStart(2, "0")}` : null;
  }
  match = /^([a-z]{3})[a-z]*\.?\s+(\d{4})$/.exec(v);
  if (match) {
    const month = MONTHS.indexOf(match[1]!);
    return month >= 0 ? `${match[2]}-${String(month + 1).padStart(2, "0")}` : null;
  }
  return null;
}

/** "6" from "6 people", "45000" from "45,000 km"; null when it isn't a number. */
export function plainNumber(value: string): string | null {
  const match = /^-?[\d,]+(?:\.\d+)?/.exec(value.trim());
  if (!match) return null;
  const cleaned = match[0].replace(/,/g, "");
  return /^-?\d+(?:\.\d+)?$/.test(cleaned) ? cleaned : null;
}

/** "yes" or "no", or null. */
export function yesNo(value: string): "yes" | "no" | null {
  const v = value.trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(v)) return "yes";
  if (["no", "n", "false", "0"].includes(v)) return "no";
  return null;
}

/** An ISO 8601 duration ("PT45M", "P12M") from itself or from "45 minutes", "1h30m", "12 months". */
export function isoDuration(value: string): string | null {
  const v = value.trim();
  if (/^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?)?$/.test(v)) return v;
  const units: Record<string, number> = { Y: 0, Mo: 0, W: 0, D: 0, H: 0, Mi: 0 };
  let found = false;
  for (const [, n, unit] of v.toLowerCase().matchAll(/(\d+)\s*(years?|yrs?|y|months?|mos?|weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m)(?![a-z])/g)) {
    found = true;
    const u = unit!;
    const key = /^y/.test(u) ? "Y" : /^mo/.test(u) ? "Mo" : /^w/.test(u) ? "W" : /^d/.test(u) ? "D" : /^h/.test(u) ? "H" : "Mi";
    units[key]! += Number(n);
  }
  if (!found) return null;
  const date = `${units.Y ? `${units.Y}Y` : ""}${units.Mo ? `${units.Mo}M` : ""}${units.W ? `${units.W}W` : ""}${units.D ? `${units.D}D` : ""}`;
  const time = `${units.H ? `${units.H}H` : ""}${units.Mi ? `${units.Mi}M` : ""}`;
  return `P${date}${time ? `T${time}` : ""}` === "P" ? null : `P${date}${time ? `T${time}` : ""}`;
}

export interface NormaliseOptions {
  // From an agent: links become site names and card numbers are masked.
  readonly fromAgent: boolean;
  // The time zone a date-time with no zone of its own is read in (the person's account zone).
  readonly zone?: string;
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

/** The field a raw key lands in for `type`: its own name, else the first alias target the kind has. */
export function fieldFor(type: Pick<RecordTypeDef, "fields">, rawKey: string): string {
  const plain = fieldKey(rawKey);
  const known = new Set(type.fields.map((field) => field.key));
  if (known.has(plain)) return plain;
  return ALIASES[plain]?.find((target) => known.has(target)) ?? plain;
}

/**
 * The fields to keep for a record of `type`, from `raw` (an agent's or form's field map) and any
 * labelled `details`. `hasDueDate` says whether a due date was given separately, so one is not
 * lifted from the fields. A null or empty value leaves the field out.
 */
export function normaliseFields(
  type: RecordTypeDef,
  raw: Readonly<Record<string, unknown>>,
  hasDueDate: boolean,
  options: NormaliseOptions,
  details: readonly { readonly label: string; readonly value: string }[] = [],
): NormalisedFields {
  const known = new Map<string, FieldDef>(type.fields.map((field) => [field.key, field]));
  const zone = options.zone && isTimeZone(options.zone) ? options.zone : "UTC";
  const fields: Record<string, string> = {};
  const problems: string[] = [];
  let dueDate: string | null = null;
  let extras = 0;
  let linksCut = false;
  let cardsMasked = false;
  let assumedZone = false;

  const entries: [string, unknown][] = [...Object.entries(raw), ...details.map((detail) => [detail.label, detail.value] as [string, unknown])];
  for (const [rawKey, rawValue] of entries) {
    let value = scalar(rawValue);
    if (value === null) {
      if (rawValue !== null && rawValue !== undefined) problems.push(`Left out "${rawKey}": give a plain text, number or date value.`);
      continue;
    }
    if (value === "") continue;

    const plain = fieldKey(rawKey);
    if (!plain) continue;
    const key = fieldFor(type, rawKey);
    const def = known.get(key);

    // A due date given as a field becomes the record's due date.
    if (!def && type.due && type.lifecycle !== "booking" && !hasDueDate && dueDate === null && DUE_KEYS.includes(plain)) {
      const date = calendarDate(value);
      if (date) {
        dueDate = date;
        continue;
      }
    }

    if (options.fromAgent && def?.kind !== "website") {
      const links = linksToSiteNames(value);
      // A policy, account or member number is kept as written even when it looks like a card;
      // only a banking record's reference could be one.
      const keepNumber = def?.kind === "reference" && !type.id.startsWith("banking.");
      const cards = keepNumber ? { value: links.value, masked: false } : maskCards(links.value);
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

    const leftOut = (why: string) => problems.push(`Left out "${rawKey}": ${why}`);
    switch (def.kind) {
      case "date": {
        const date = calendarDate(value);
        if (!date) { leftOut("dates are YYYY-MM-DD."); continue; }
        fields[key] = date;
        break;
      }
      case "datetime": {
        const when = canonicalDateTime(value, zone);
        if (!when) { leftOut("give a date (YYYY-MM-DD) or a date and time, ideally with its time zone, e.g. 2026-12-03T19:30[Australia/Sydney]."); continue; }
        assumedZone ||= when.assumedZone;
        fields[key] = when.value;
        break;
      }
      case "month_year": {
        const month = monthYear(value);
        if (!month) { leftOut("give the month and year as YYYY-MM."); continue; }
        fields[key] = month;
        break;
      }
      case "amount": {
        const amount = plainAmount(value);
        if (amount === null) { leftOut('give the amount as a plain number, with the currency in "currency".'); continue; }
        fields[key] = amount;
        break;
      }
      case "number": {
        const number = plainNumber(value);
        if (number === null) { leftOut("give a plain number."); continue; }
        fields[key] = number;
        break;
      }
      case "boolean": {
        const answer = yesNo(value);
        if (answer === null) { leftOut("give yes or no."); continue; }
        fields[key] = answer;
        break;
      }
      case "duration": {
        const duration = isoDuration(value);
        if (duration === null) { leftOut('give a length of time, such as "45 minutes" or "12 months".'); continue; }
        fields[key] = duration;
        break;
      }
      case "currency": {
        const code = value.toUpperCase();
        if (!/^[A-Z]{3}$/.test(code)) { leftOut("give the currency as a three-letter code, for example AUD."); continue; }
        fields[key] = code;
        break;
      }
      case "cycle": {
        const cycle = cycleOf(value);
        if (!cycle) { leftOut("use weekly, fortnightly, monthly, quarterly, yearly or one_off."); continue; }
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
        if (!site) { leftOut("give a website such as example.com.au."); continue; }
        fields[key] = site;
        break;
      }
      case "email": {
        const email = value.toLowerCase();
        if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { leftOut("give an email address."); continue; }
        fields[key] = email;
        break;
      }
      case "person": {
        if (value.includes("@") || /\d{4,}/.test(value)) { leftOut("give a first name or relationship only, such as Mum or Sam."); continue; }
        fields[key] = value.slice(0, MAX_PERSON_CHARS);
        break;
      }
      case "place":
        fields[key] = value.slice(0, MAX_PLACE_CHARS);
        break;
      case "long_text":
        fields[key] = value.slice(0, MAX_NOTES_CHARS);
        break;
      default:
        fields[key] = value.slice(0, MAX_FIELD_CHARS);
    }
  }

  if (linksCut) problems.push("Links are kept as the website's name only.");
  if (cardsMasked) problems.push("Card numbers are kept as their last 4 digits only.");
  if (assumedZone) problems.push(`Times without a time zone were read in ${zone}. Add the zone, e.g. [Australia/Sydney], if that's wrong.`);
  return { fields, dueDate, problems };
}

/** A record's display name: its name, else its provider, else its item, else the kind's label. */
export function recordDisplayName(type: RecordTypeDef, fields: Readonly<Record<string, unknown>>): string {
  for (const key of ["name", "provider", "item", "service", "merchant", "title"]) {
    const value = fields[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return type.label;
}

/**
 * The name a stored record goes by anywhere it is listed: its own name or title (older and
 * agent-written records use `title` or `what`), else — for a kind identified by something other
 * than its provider (a plate, a country, a flight) — its kind and that ("Registration · BX12AB"),
 * else its provider or item, else (an older record) its first filled-in value, else its kind.
 * `ownType` is false for a record saved before kinds existed.
 */
export function storedRecordName(type: RecordTypeDef, fields: Readonly<Record<string, unknown>>, ownType = true): string {
  const text = (key: string) => (typeof fields[key] === "string" ? (fields[key] as string).trim() : "");
  for (const key of ["name", "title", "item", "what"]) if (text(key)) return text(key);
  const first = type.identity[0] ?? [];
  if (ownType && !first.includes("provider")) {
    const lead = first.find((part) => !["provider", "parent", "title", "name", "starts_at"].includes(part) && text(part));
    if (lead) return `${type.label} · ${text(lead)}`;
  }
  for (const key of ["provider", "service", "merchant"]) if (text(key)) return text(key);
  if (ownType) return type.label;
  const any = Object.values(fields).find((value): value is string => typeof value === "string" && value.trim() !== "");
  return any?.trim() ?? type.label;
}

/**
 * Each identity alternative of `type` this record can fill: the field keys and their normalised
 * values (a date-time matches on its date). A singleton kind has one empty alternative. The kind's
 * fallback identity counts only when the record fills none of the others.
 */
export function identityAlternatives(
  type: RecordTypeDef,
  fields: Readonly<Record<string, unknown>>,
  parentId: string | null,
): { readonly keys: readonly string[]; readonly values: readonly string[] }[] {
  if (type.singleton) return [{ keys: [], values: [] }];
  const filled = fillIdentities(type, type.identity, fields, parentId);
  return filled.length === 0 && type.fallbackIdentity ? fillIdentities(type, [type.fallbackIdentity], fields, parentId) : filled;
}

function fillIdentities(
  type: RecordTypeDef,
  identities: readonly (readonly string[])[],
  fields: Readonly<Record<string, unknown>>,
  parentId: string | null,
): { readonly keys: readonly string[]; readonly values: readonly string[] }[] {
  const alternatives: { keys: readonly string[]; values: string[] }[] = [];
  for (const keys of identities) {
    if (keys.length === 0) continue;
    const values: string[] = [];
    for (const key of keys) {
      const def = type.fields.find((field) => field.key === key);
      const raw = key === "parent" ? parentId : key === "title" ? recordDisplayName(type, fields) : fields[key];
      if (key === "title" && raw === type.label) break;
      let text = typeof raw === "string" ? raw : "";
      if (def?.kind === "datetime" || def?.kind === "date") text = text.slice(0, 10);
      text = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
      if (text === "") break;
      values.push(text);
    }
    if (values.length === keys.length) alternatives.push({ keys, values });
  }
  return alternatives;
}
