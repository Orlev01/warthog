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

/** The statuses the edit form offers, in order, as stored value → label. */
export const RECORD_STATUS_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "cancelled", label: "Cancelled" },
  { value: "done", label: "Done" },
];

/** A record's status as a word: "active" → "Active", an agent's own code tidied. */
export function statusLabel(status: string): string {
  const trimmed = status.trim();
  return STATUS_LABELS[trimmed.toLowerCase()] ?? (trimmed ? fieldLabel(trimmed) : "");
}

/** The line under a record's name: "Due 1 Dec 2026 · Active", or just the status. */
export function dueLine(dueDate: string | null, status: string): string {
  const word = statusLabel(status);
  if (!dueDate) return word;
  const due = `Due ${formatCalendarDate(dueDate)}`;
  return word ? `${due} · ${word}` : due;
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
export function recordFacts(fields: Readonly<Record<string, string>>, titleKey: string | null): RecordFact[] {
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
    facts.push({ key: amountKey, label: fieldLabel(amountKey), value: cycle ? `${money} ${cycle}` : money });
    used.add(amountKey);
    if (currencyKey) used.add(currencyKey);
    if (cycleKey && cycle) used.add(cycleKey);
  }
  for (const [key, value] of Object.entries(fields)) {
    if (used.has(key) || value.trim() === "") continue;
    const shown = CYCLE_KEYS.includes(key.trim().toLowerCase()) ? fieldLabel(value) : formatCalendarDate(value);
    facts.push({ key, label: fieldLabel(key), value: shown });
  }
  return facts;
}
