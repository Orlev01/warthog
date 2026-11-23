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
// Typed records (docs/adr/life-admin-profile.md): a record's type supplies its field labels
// ("Insurer", "Policy number"), what its due date means ("Expires 14 Dec 2026"), and the
// provenance line says who added it and where an agent says it found it. Values an agent read
// from email are only ever shown as text, never as a link.

import { storedRecordName } from "@/domain/life-admin/normalise";
import { typeFieldLabel, typeOfRecord, type RecordTypeDef, type StoredKind } from "@/domain/life-admin/record-types";

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
    facts.push({ key, label: labelOf(key), value: formatValue(key, value) });
  }
  return facts;
}

/** One stored value as it reads on screen: a date formatted, a billing cycle in words. */
export function formatValue(key: string, value: string): string {
  return CYCLE_KEYS.includes(key.trim().toLowerCase()) ? fieldLabel(value) : formatCalendarDate(value);
}

// ─── typed records ──────────────────────────────────────────────────────────────────────

/** The record type a stored record reads as: its own, else its original kind's. */
export function recordTypeOf(record: { readonly kind: StoredKind; readonly type?: string | null }): RecordTypeDef {
  return typeOfRecord(record.kind, record.type ?? null);
}

/** A field's label for a type: the type's own wording, else the key tidied. */
export function typedFieldLabel(type: RecordTypeDef, key: string): string {
  return typeFieldLabel(type, key) ?? fieldLabel(key);
}

const NAME_KEYS = ["name", "title", "item", "what", "provider", "service", "merchant"];

/**
 * The name a record goes by (the same one Home and reminders use) and the field it came
 * from, so the row can list the other fields without repeating it. `key` is null when the
 * name is the type's own label.
 */
export function recordName(
  kind: StoredKind,
  type: string | null | undefined,
  fields: Readonly<Record<string, string>>,
): { name: string; key: string | null } {
  const name = storedRecordName(kind, type, fields);
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
  const days = daysBetween(today, date);
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
): ChangeLine[] {
  const before = (key: string): string | null => {
    const value = current.fields[key] ?? current.heldFields?.[key];
    return value === undefined || value.trim() === "" ? null : formatValue(key, value);
  };
  const lines: ChangeLine[] = [];
  for (const [key, value] of Object.entries(pending.set)) {
    lines.push({ key, label: typedFieldLabel(type, key), from: before(key), to: value.trim() === "" ? null : formatValue(key, value) });
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
