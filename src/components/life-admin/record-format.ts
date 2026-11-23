// How a life-admin record's stored values read on screen (the UI/UX pass, content-22). Records
// are saved by the person and by agents, so their fields arrive as storage keys and raw
// values ("amount 25.99 / currency AUD / cycle monthly", "Due 2026-12-01 · active"). Here a
// known key gets a plain label and an unknown one is tidied ("how_to_cancel" → "How to
// cancel"), a calendar date reads as "1 Dec 2026", a status code reads as a word, and an
// amount with its currency and billing cycle reads as one "Cost" line ("AUD 25.99 a month").
//
// Display only: nothing here changes a stored value, and the edit form still posts every
// field under its own key. Pure functions over plain values (no clock, no locale of the
// machine), shared by the view and its tests.
//
// Typed records (docs/adr/life-admin-profile.md): a record's kind — from the person's own
// catalogue, built-in or a category of their own — supplies its field labels ("Insurer",
// "Policy number"), how each value reads by its field kind (a date-time in its own zone as
// "Thu 3 Dec, 7:30 pm AEDT", a month and year as "Mar 2027", yes/no, a duration in words), what
// its due date means ("Expires 14 Dec 2026"), and the provenance line says who added it and
// where an agent says it found it. Values an agent read from email are only ever shown as
// text, never as a link.

import { storedRecordName } from "@/domain/life-admin/normalise";
import { isTimeZone, parseWhen } from "@/domain/life-admin/lifecycle";
import type { Catalogue } from "@/domain/life-admin/catalogue";
import type { FieldDef, Lifecycle, RecordTypeDef, StoredKind } from "@/domain/life-admin/record-types";

const FIELD_LABELS: Readonly<Record<string, string>> = {
  name: "Name",
  title: "Title",
  amount: "Cost",
  cost: "Cost",
  price: "Price",
  currency: "Currency",
  cycle: "Billing cycle",
  billing_cycle: "Billing cycle",
  frequency: "Billing cycle",
  service: "Service",
  provider: "Provider",
  merchant: "Merchant",
  store: "Store",
  item: "Item",
  how_to_cancel: "How to cancel",
  return_by: "Return by",
  warranty_end: "Warranty ends",
  warranty_until: "Warranty ends",
  renews_on: "Renews",
  where: "Where",
  location: "Where",
  who: "Who",
  notes: "Notes",
  note: "Note",
  reference: "Reference",
  order_number: "Order number",
};

/** A field's label: the plain name for a known key, otherwise the key in sentence case. */
export function fieldLabel(key: string): string {
  const known = FIELD_LABELS[key.trim().toLowerCase()];
  if (known) return known;
  const words = key
    .replace(/([a-z0-9])([A-Z])(?=[a-z])/g, (_, before: string, capital: string) => `${before} ${capital.toLowerCase()}`)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!words) return key;
  // Keep a person's own capitals ("Monthly cost", "ABN"); only a lower-case first letter moves.
  return words[0]!.toUpperCase() + words.slice(1);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

// Formatted on the calendar in UTC, so the stored day is the day shown wherever the browser is.
const DATE_FORMAT = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** A calendar date ("2026-12-01") as "1 Dec 2026"; anything that isn't one is returned unchanged. */
export function formatCalendarDate(value: string): string {
  const match = ISO_DATE.exec(value.trim());
  if (!match) return value;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (!Number.isFinite(date.getTime()) || date.getUTCDate() !== Number(day)) return value;
  return DATE_FORMAT.format(date);
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  active: "Active",
  paused: "Paused",
  cancelled: "Cancelled",
  canceled: "Cancelled",
  done: "Done",
  expired: "Expired",
  returned: "Returned",
  confirmed: "Confirmed",
  pending: "Waiting to be confirmed",
  no_show: "Didn't go",
  open: "Open",
  waiting: "Waiting",
  resolved: "Resolved",
};

/** The statuses the forms offer, in order, as stored value → label (the record service's
 * RECORD_STATUSES; record-format.test.ts keeps the two lists the same). */
export const RECORD_STATUS_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "cancelled", label: "Cancelled" },
  { value: "expired", label: "Expired" },
  { value: "done", label: "Done" },
];

// A booking's and a case's status choices (the record service's words for them).
export const BOOKING_STATUS_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "confirmed", label: "Confirmed" },
  { value: "pending", label: "Waiting to be confirmed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "no_show", label: "Didn't go" },
];
export const CASE_STATUS_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "open", label: "Open" },
  { value: "waiting", label: "Waiting" },
  { value: "resolved", label: "Resolved" },
];

/** The status choices a kind's forms offer, by its lifecycle. */
export function statusChoices(lifecycle: Lifecycle): ReadonlyArray<{ value: string; label: string }> {
  return lifecycle === "booking" ? BOOKING_STATUS_CHOICES : lifecycle === "case" ? CASE_STATUS_CHOICES : RECORD_STATUS_CHOICES;
}

/** A record's status as a word: "active" → "Active", an agent's own code tidied. */
export function statusLabel(status: string): string {
  const trimmed = status.trim();
  return STATUS_LABELS[trimmed.toLowerCase()] ?? (trimmed ? fieldLabel(trimmed) : "");
}

const AMOUNT_KEYS = ["amount", "cost", "price"];
const CURRENCY_KEYS = ["currency"];
const CYCLE_KEYS = ["cycle", "billing_cycle", "frequency"];

const CYCLE_WORDS: Readonly<Record<string, string>> = {
  daily: "a day",
  day: "a day",
  weekly: "a week",
  week: "a week",
  fortnightly: "a fortnight",
  fortnight: "a fortnight",
  monthly: "a month",
  month: "a month",
  quarterly: "a quarter",
  quarter: "a quarter",
  yearly: "a year",
  year: "a year",
  annual: "a year",
  annually: "a year",
  one_off: "once",
};

export type RecordFact = { readonly key: string; readonly label: string; readonly value: string };

function findKey(fields: Readonly<Record<string, string>>, keys: readonly string[], skip: string | null): string | undefined {
  return Object.keys(fields).find((key) => key !== skip && keys.includes(key.trim().toLowerCase()) && fields[key]!.trim() !== "");
}

// A plain number ("25.99", "1,250") — never a value that already carries its own currency
// ("A$18.50"), which reads as the person wrote it.
function plainAmount(value: string): number | null {
  const cleaned = value.trim().replace(/,/g, "");
  return /^\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
}

/**
 * The facts a record row lists under its name, in order: a combined "Cost" line first when
 * the record has a plain amount (its currency and a known billing cycle folded in), then every
 * other filled-in field with its label, dates formatted. `titleKey` (the field the row leads
 * with) is left out; so are empty values.
 */
export function recordFacts(
  fields: Readonly<Record<string, string>>,
  titleKey: string | null,
  labelOf: (key: string) => string = fieldLabel,
  formatOf: (key: string, value: string) => string = formatValue,
): RecordFact[] {
  const facts: RecordFact[] = [];
  const used = new Set<string>(titleKey ? [titleKey] : []);
  const amountKey = findKey(fields, AMOUNT_KEYS, titleKey);
  const amount = amountKey ? plainAmount(fields[amountKey]!) : null;
  if (amountKey && amount !== null) {
    const currencyKey = findKey(fields, CURRENCY_KEYS, titleKey);
    const cycleKey = findKey(fields, CYCLE_KEYS, titleKey);
    const currency = currencyKey ? fields[currencyKey]!.trim().toUpperCase() : "";
    const cycle = cycleKey ? CYCLE_WORDS[fields[cycleKey]!.trim().toLowerCase()] : undefined;
    const money = `${currency ? `${currency} ` : ""}${amount.toFixed(2)}`;
    facts.push({ key: amountKey, label: labelOf(amountKey), value: cycle ? `${money} ${cycle}` : money });
    used.add(amountKey);
    if (currencyKey) used.add(currencyKey);
    if (cycleKey && cycle) used.add(cycleKey);
  }
  for (const [key, value] of Object.entries(fields)) {
    if (used.has(key) || value.trim() === "") continue;
    facts.push({ key, label: labelOf(key), value: formatOf(key, value) });
  }
  return facts;
}

/**
 * A record's cost in one phrase: "AUD 25.99 a month" for a plain amount (its currency and a
 * known billing cycle folded in), an amount written with its own currency as written ("A$18.50
 * a week"); null when it has none. `skip` is a field the row already leads with.
 */
export function costText(fields: Readonly<Record<string, string>>, skip: string | null = null): string | null {
  const amountKey = findKey(fields, AMOUNT_KEYS, skip);
  if (!amountKey) return null;
  const cycleKey = findKey(fields, CYCLE_KEYS, skip);
  const cycle = cycleKey ? CYCLE_WORDS[fields[cycleKey]!.trim().toLowerCase()] : undefined;
  const amount = plainAmount(fields[amountKey]!);
  const currencyKey = findKey(fields, CURRENCY_KEYS, skip);
  const currency = currencyKey ? fields[currencyKey]!.trim().toUpperCase() : "";
  const money = amount !== null ? `${currency ? `${currency} ` : ""}${amount.toFixed(2)}` : fields[amountKey]!.trim();
  return cycle ? `${money} ${cycle}` : money;
}

/** One stored value as it reads on screen: a date formatted, a billing cycle in words. */
export function formatValue(key: string, value: string): string {
  return CYCLE_KEYS.includes(key.trim().toLowerCase()) ? fieldLabel(value) : formatCalendarDate(value);
}

// ─── typed records ──────────────────────────────────────────────────────────────────────

const PARTS_FORMAT = (zone: string, withYear: boolean) =>
  new Intl.DateTimeFormat("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" as const } : {}),
    hour: "numeric",
    minute: "2-digit",
    timeZone: zone,
    timeZoneName: "short",
  });

/**
 * A date-time as it reads on screen, in the zone it happens in (its own, else `fallbackZone`):
 * "Thu 3 Dec, 7:30 pm AEDT". The year is added when it isn't `currentYear`. A date alone reads
 * as "3 Dec 2026"; anything that isn't a date or date-time is returned unchanged.
 */
export function formatDateTime(value: string, fallbackZone = "UTC", currentYear?: string): string {
  const when = parseWhen(value, isTimeZone(fallbackZone) ? fallbackZone : "UTC");
  if (!when) return value;
  if (when.dateOnly) return formatCalendarDate(when.date);
  return formatInstant(when.instant, when.zone, currentYear);
}

/** An instant in a zone: "Thu 3 Dec, 7:30 pm AEDT" (the year added when it isn't `currentYear`). */
export function formatInstant(at: Date, zone: string, currentYear?: string): string {
  const tz = isTimeZone(zone) ? zone : "UTC";
  const withYear = currentYear === undefined ? false : new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric" }).format(at) !== currentYear;
  const parts = Object.fromEntries(PARTS_FORMAT(tz, withYear).formatToParts(at).map((part) => [part.type, part.value]));
  const date = `${parts.weekday} ${parts.day} ${parts.month}${withYear ? ` ${parts.year}` : ""}`;
  return `${date}, ${parts.hour}:${parts.minute} ${(parts.dayPeriod ?? "").toLowerCase()} ${parts.timeZoneName}`.replace(/\s+/g, " ").trim();
}

const MONTH_FORMAT = new Intl.DateTimeFormat("en-AU", { month: "short", year: "numeric", timeZone: "UTC" });

/** "2027-03" as "Mar 2027"; anything else unchanged. */
export function formatMonthYear(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) return value;
  return MONTH_FORMAT.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 15)));
}

// The date part's units (its "M" is months; the time part's "M" is minutes).
const DATE_UNITS: ReadonlyArray<[RegExp, string]> = [[/(\d+)Y/, "year"], [/(\d+)M/, "month"], [/(\d+)W/, "week"], [/(\d+)D/, "day"]];
const TIME_UNITS: ReadonlyArray<[RegExp, string]> = [[/(\d+)H/, "hour"], [/(\d+)M/, "minute"], [/(\d+)S/, "second"]];

/** An ISO duration in words: "PT45M" → "45 minutes", "P12M" → "12 months", "PT1H30M" → "1 hour 30 minutes". */
export function formatDuration(value: string): string {
  const match = /^P(?!$)((?:\d+[YMWD])*)(?:T((?:\d+[HMS])+))?$/.exec(value.trim());
  if (!match) return value;
  const words: string[] = [];
  const unit = (n: number, word: string) => words.push(`${n} ${word}${n === 1 ? "" : "s"}`);
  const datePart = match[1] ?? "";
  const timePart = match[2] ?? "";
  for (const [pattern, word] of DATE_UNITS) {
    const found = pattern.exec(datePart);
    if (found) unit(Number(found[1]), word);
  }
  for (const [pattern, word] of TIME_UNITS) {
    const found = pattern.exec(timePart);
    if (found) unit(Number(found[1]), word);
  }
  return words.length ? words.join(" ") : value;
}

/** "yes"/"no" as "Yes"/"No"; anything else unchanged. */
export function formatBoolean(value: string): string {
  const v = value.trim().toLowerCase();
  return v === "yes" ? "Yes" : v === "no" ? "No" : value;
}

/** One stored value as it reads on screen, by its field's kind; an unknown field as formatValue does. */
export function formatFieldValue(field: FieldDef | undefined, key: string, value: string, zone = "UTC", currentYear?: string): string {
  switch (field?.kind) {
    case "datetime":
      return formatDateTime(value, zone, currentYear);
    case "date":
      return formatCalendarDate(value);
    case "month_year":
      return formatMonthYear(value);
    case "boolean":
      return formatBoolean(value);
    case "duration":
      return formatDuration(value);
    case "number":
      return field.unit && /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? `${value.trim()} ${field.unit}` : value;
    case "cycle":
      return fieldLabel(value);
    case undefined:
      return formatValue(key, value);
    default:
      return value;
  }
}

/** A field's label for a type: the type's own wording, else the key tidied. */
export function typedFieldLabel(type: RecordTypeDef, key: string): string {
  return type.fields.find((field) => field.key === key)?.label ?? fieldLabel(key);
}

/** A record's facts, labelled and formatted through its kind (date-times in their own zone). */
export function typedFacts(
  type: RecordTypeDef,
  fields: Readonly<Record<string, string>>,
  titleKey: string | null,
  zone = "UTC",
  currentYear?: string,
): RecordFact[] {
  const defs = new Map(type.fields.map((field) => [field.key, field]));
  return recordFacts(
    fields,
    titleKey,
    (key) => typedFieldLabel(type, key),
    (key, value) => formatFieldValue(defs.get(key), key, value, zone, currentYear),
  );
}

const NAME_KEYS = ["name", "title", "item", "what", "provider", "service", "merchant"];

/**
 * The name a record goes by (the same one Home, reminders and agents use) and the field it
 * came from, so the row can list the other fields without repeating it. `key` is null when
 * the name is the kind's own label or is built from it ("Registration · BX12AB").
 */
export function recordName(
  type: RecordTypeDef,
  fields: Readonly<Record<string, string>>,
  ownType = true,
): { name: string; key: string | null } {
  const name = storedRecordName(type, fields, ownType);
  const key =
    NAME_KEYS.find((candidate) => fields[candidate]?.trim() === name) ??
    Object.keys(fields).find((candidate) => fields[candidate]!.trim() === name) ??
    null;
  return { name, key };
}

/** What a type's due date means, as the person reads it ("Expires", "Renews"). */
export function dueLabelOf(type: RecordTypeDef | null | undefined): string {
  return type?.due?.label ?? "Due";
}

/** "Expires 14 Dec 2026": the date with the type's own wording. */
export function dueText(type: RecordTypeDef | null | undefined, dueDate: string): string {
  return `${dueLabelOf(type)} ${formatCalendarDate(dueDate)}`;
}

const SPAN_DAY = (zone: string) => new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: zone });

/** An anchor's span from its bookings, as days: "3 – 10 Dec 2026", "28 Nov – 3 Dec 2026". */
export function formatSpan(starts: string, ends: string, zone: string): string {
  const tz = isTimeZone(zone) ? zone : "UTC";
  const parts = (iso: string) => Object.fromEntries(SPAN_DAY(tz).formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  const a = parts(starts);
  const b = parts(ends);
  if (a.year === b.year && a.month === b.month) return a.day === b.day ? `${a.day} ${a.month} ${a.year}` : `${a.day} – ${b.day} ${b.month} ${b.year}`;
  if (a.year === b.year) return `${a.day} ${a.month} – ${b.day} ${b.month} ${b.year}`;
  return `${a.day} ${a.month} ${a.year} – ${b.day} ${b.month} ${b.year}`;
}

/**
 * When a record happens or is due, in its kind's words: a booking's start in its own zone
 * ("Starts Thu 3 Dec, 7:30 pm AEDT"), an anchor's span ("3 – 10 Dec 2026"), else its due date
 * ("Expires 14 Dec 2026"). Null when it has none.
 */
export function whenLine(
  type: RecordTypeDef,
  record: { readonly fields: Readonly<Record<string, string>>; readonly dueDate: string | null; readonly phase?: { readonly starts?: string; readonly ends?: string } },
  zone: string,
  currentYear?: string,
): string | null {
  if (type.anchor && record.phase?.starts && record.phase.ends) return formatSpan(record.phase.starts, record.phase.ends, zone);
  if (type.lifecycle === "booking") {
    const starts = record.fields.starts_at;
    if (starts) return `${dueLabelOf(type)} ${formatDateTime(starts, zone, currentYear)}`;
  }
  return record.dueDate ? dueText(type, record.dueDate) : null;
}

/**
 * A compact row's one muted line under the record's name: its kind (unless the name already
 * starts with it, or the row leads with something else), when it's due, renews or starts, its
 * cost and cycle, and its provider (unless it's named for it) — "Expires 14 Dec 2026 · AUD
 * 412.50 a year · Transport for NSW". A list across categories leads with the `category`.
 */
export function rowSummary(
  type: RecordTypeDef,
  record: { readonly fields: Readonly<Record<string, string>>; readonly dueDate: string | null; readonly phase?: { readonly starts?: string; readonly ends?: string } },
  options: { readonly name: string; readonly titleKey: string | null; readonly lead?: boolean; readonly category?: string; readonly zone?: string; readonly currentYear?: string },
): string {
  const { name, titleKey } = options;
  const provider = record.fields.provider?.trim();
  return [
    options.category ?? null,
    options.lead || name.startsWith(type.label) ? null : type.label,
    whenLine(type, record, options.zone ?? "UTC", options.currentYear),
    costText(record.fields, titleKey),
    provider && titleKey !== "provider" && !name.includes(provider) ? provider : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The line under a typed record's name: "Registration · Expires 14 Dec 2026 · Active". */
export function typedDueLine(type: RecordTypeDef, dueDate: string | null, status: string): string {
  return [type.label, dueDate ? dueText(type, dueDate) : null, statusLabel(status) || null].filter(Boolean).join(" · ");
}

const DAY_MS = 86_400_000;

function utcDay(isoDate: string): number {
  const [year, month, day] = isoDate.slice(0, 10).split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!);
}

/** Whole calendar days from `today` to `date` (negative when it has passed). */
export function daysBetween(today: string, date: string): number {
  return Math.round((utcDay(date) - utcDay(today)) / DAY_MS);
}

/** How far away a date is, in words: "today", "tomorrow", "in 21 days", "3 days ago". */
export function whenText(today: string, date: string): string {
  return daysText(daysBetween(today, date));
}

/** A number of days from today, in words: "today", "tomorrow", "in 21 days", "3 days ago". */
export function daysText(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 1) return `in ${days} days`;
  if (days === -1) return "yesterday";
  return `${-days} days ago`;
}

// ─── provenance: who added a record and where an agent says it found it ───────────────────

export type ProvenanceActor =
  | { readonly kind: "person" }
  | { readonly kind: "agent"; readonly agentId?: string; readonly name: string };

export type ProvenanceFoundIn = {
  readonly service: string;
  readonly sender?: string;
  readonly date?: string;
  readonly seenByWarthog: boolean;
};

function capitalise(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

// What kind of item the service holds, so the line says "an email" or "a file".
function sourceNoun(service: string): { noun: string; hasSender: boolean } {
  if (/calendar/i.test(service)) return { noun: "a calendar event", hasSender: false };
  if (/drive|files?\b|dropbox|onedrive|sharepoint/i.test(service)) return { noun: "a file", hasSender: false };
  return { noun: "an email", hasSender: true };
}

/** Where an agent says it found something, as a sentence ("Found by ChatGPT in an email from …"). */
export function foundInSentence(agentName: string, foundIn: ProvenanceFoundIn): string {
  const { noun, hasSender } = sourceNoun(foundIn.service);
  const sender = hasSender && foundIn.sender?.trim() ? ` from ${foundIn.sender.trim()}` : "";
  const date = foundIn.date?.trim() ? ` (${formatCalendarDate(foundIn.date.trim())})` : "";
  return foundIn.seenByWarthog
    ? `Found by ${agentName} in ${noun}${sender}${date}. ${capitalise(agentName)} read it through Warthog.`
    : `${capitalise(agentName)} says it found this in ${noun}${sender}${date}.`;
}

function sameActor(a: ProvenanceActor, b: ProvenanceActor): boolean {
  if (a.kind === "person" || b.kind === "person") return a.kind === b.kind;
  return a.agentId !== undefined && b.agentId !== undefined ? a.agentId === b.agentId : a.name === b.name;
}

/**
 * Who a record came from, in plain words: "Added by you.", "Found by ChatGPT in an email
 * from service.nsw.gov.au (2 Oct 2026). ChatGPT read it through Warthog.", "ChatGPT says it
 * found this in an email from …", "Added by ChatGPT." — then "Checked by you." once the
 * person confirmed an agent's record, and "Last changed by Claude." when another agent
 * rewrote it since.
 */
export function provenanceLine(input: {
  readonly addedBy: ProvenanceActor;
  readonly changedBy?: ProvenanceActor | null;
  readonly reviewState: "suggested" | "confirmed";
  readonly foundIn?: ProvenanceFoundIn | null;
}): string {
  const { addedBy, changedBy, reviewState, foundIn } = input;
  const parts: string[] = [];
  if (addedBy.kind === "person") {
    parts.push("Added by you.");
  } else {
    parts.push(foundIn ? foundInSentence(addedBy.name, foundIn) : `Added by ${addedBy.name}.`);
    if (reviewState === "confirmed") parts.push("Checked by you.");
  }
  if (changedBy && changedBy.kind === "agent" && !sameActor(addedBy, changedBy)) {
    parts.push(`Last changed by ${changedBy.name}.`);
  }
  return parts.join(" ");
}

// ─── an agent's proposed change, line by line ─────────────────────────────────────────────

export type ChangeLine = {
  readonly key: string;
  readonly label: string;
  // null ⇒ not set (before) or removed (after).
  readonly from: string | null;
  readonly to: string | null;
};

/**
 * An agent's pending change as "label: old → new" lines, labelled through the record's
 * type, with the due date and status last. Values read as everywhere else (dates formatted).
 */
export function pendingChangeLines(
  type: RecordTypeDef,
  current: {
    readonly fields: Readonly<Record<string, string>>;
    readonly heldFields?: Readonly<Record<string, string>>;
    readonly dueDate: string | null;
    readonly status: string;
  },
  pending: {
    readonly set: Readonly<Record<string, string>>;
    readonly remove: readonly string[];
    readonly dueDate?: string | null;
    readonly status?: string;
  },
  zone = "UTC",
): ChangeLine[] {
  const defs = new Map(type.fields.map((field) => [field.key, field]));
  const show = (key: string, value: string) => formatFieldValue(defs.get(key), key, value, zone);
  const before = (key: string): string | null => {
    const value = current.fields[key] ?? current.heldFields?.[key];
    return value === undefined || value.trim() === "" ? null : show(key, value);
  };
  const lines: ChangeLine[] = [];
  for (const [key, value] of Object.entries(pending.set)) {
    lines.push({ key, label: typedFieldLabel(type, key), from: before(key), to: value.trim() === "" ? null : show(key, value) });
  }
  for (const key of pending.remove) {
    lines.push({ key, label: typedFieldLabel(type, key), from: before(key), to: null });
  }
  if (pending.dueDate !== undefined) {
    lines.push({
      key: "dueDate",
      label: dueLabelOf(type),
      from: current.dueDate ? formatCalendarDate(current.dueDate) : null,
      to: pending.dueDate ? formatCalendarDate(pending.dueDate) : null,
    });
  }
  if (pending.status !== undefined) {
    lines.push({ key: "status", label: "Status", from: statusLabel(current.status) || null, to: statusLabel(pending.status) || null });
  }
  return lines;
}

/**
 * An agent's pending change as the person reads it: when it gives the record another kind, a
 * "Kind: Renewal or appointment → Vehicle (Vehicles)" line first, what it sets labelled through
 * the new kind and what it removes through the old one, without the old schema's `type` and
 * `source` fields (moving an older record into its proper kind drops them, which isn't news);
 * otherwise the change line by line, as `pendingChangeLines`. A kind the catalogue doesn't have
 * is ignored.
 */
export function pendingChangeView(
  catalogue: Catalogue,
  current: {
    readonly kind: StoredKind;
    readonly type?: string | null;
    readonly fields: Readonly<Record<string, string>>;
    readonly heldFields?: Readonly<Record<string, string>>;
    readonly dueDate: string | null;
    readonly status: string;
  },
  pending: {
    readonly type?: string;
    readonly set: Readonly<Record<string, string>>;
    readonly remove: readonly string[];
    readonly dueDate?: string | null;
    readonly status?: string;
  },
  zone = "UTC",
): ChangeLine[] {
  const from = catalogue.typeOfRecord(current.kind, current.type ?? null);
  const to = pending.type ? catalogue.type(pending.type) : undefined;
  if (!to || to.id === from.id) return pendingChangeLines(from, current, pending, zone);
  const gained = pendingChangeLines(to, current, { set: pending.set, remove: [], dueDate: pending.dueDate, status: pending.status }, zone);
  const setCount = Object.keys(pending.set).length;
  const removed = pendingChangeLines(from, current, { set: {}, remove: pending.remove.filter((key) => key !== "type" && key !== "source") }, zone);
  const category = catalogue.category(to.category)?.label;
  return [
    { key: "kind", label: "Kind", from: from.label, to: category ? `${to.label} (${category})` : to.label },
    ...gained.slice(0, setCount),
    ...removed,
    ...gained.slice(setCount),
  ];
}
