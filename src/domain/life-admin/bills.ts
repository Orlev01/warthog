// What the person pays on repeat (docs/adr/life-admin-profile.md, "The Bills tab"): a view
// worked out across categories, never a place records are filed. One rule decides what is a bill,
// what it costs a month, when the next payment is, and which of the person's cards or accounts it
// comes out of. The Bills tab, the Records tab's cost line and list_records all use it, so the
// three figures agree.
//
// - A bill is a live record of a kind marked `bill` (subscriptions, utilities, rent, insurance,
//   rego, a card's annual fee …), or of the person's own kinds (or Other) with a cost and a
//   repeating cycle. Income (a pension, a government payment), balances and one-offs aren't.
// - The next payment comes from `next_payment`, else the kind's own date when that is the payment
//   (a renewal, an annual fee). On a cycle, a past or far date is moved to the first payment on or
//   after today and marked estimated; a bill the person pays by hand stays overdue for 30 days.
//   Estimates are for showing only: stored dates and reminders don't move.
// - "Paid with" is matched to the person's own bank account or card by its last 4 digits, else by
//   name, only when exactly one fits.
//
// Pure domain module: no React, no DB, no clock (today is passed in, in the person's zone).

import { monthlyTotals, type MonthlyCost } from "./costs";
import { WINDOWS, type Bucket } from "./lifecycle";
import { calendarDate, cycleOf, plainAmount, storedRecordName } from "./normalise";
import type { RecordTypeDef } from "./record-types";

export interface Interval {
  readonly unit: "week" | "month";
  readonly count: number;
}

const CYCLE_INTERVALS: Readonly<Record<string, Interval>> = {
  weekly: { unit: "week", count: 1 },
  fortnightly: { unit: "week", count: 2 },
  monthly: { unit: "month", count: 1 },
  quarterly: { unit: "month", count: 3 },
  yearly: { unit: "month", count: 12 },
};

// The person's own kinds, and Other, count when they carry a cost on a cycle.
const FALLBACK_TYPES: ReadonlySet<string> = new Set(["other.item", "other.reminder"]);

/** How often, from a cycle word ("monthly", "Annual") or, for rego, its term ("6 months"). */
export function intervalOf(cycle: unknown, term?: unknown): Interval | null {
  if (typeof cycle === "string" && cycle.trim()) {
    const known = cycleOf(cycle);
    if (known && CYCLE_INTERVALS[known]) return CYCLE_INTERVALS[known]!;
  }
  if (typeof term === "string") {
    const match = /^\s*(\d{1,2})\s*(month|year)s?\b/i.exec(term);
    if (match && Number(match[1]) > 0) return { unit: "month", count: Number(match[1]) * (match[2]!.toLowerCase() === "year" ? 12 : 1) };
  }
  return null;
}

/** "a month", "a fortnight", "every 6 months". */
export function intervalWords(interval: Interval): string {
  if (interval.unit === "week") return interval.count === 1 ? "a week" : interval.count === 2 ? "a fortnight" : `every ${interval.count} weeks`;
  if (interval.count === 1) return "a month";
  if (interval.count === 3) return "a quarter";
  if (interval.count === 12) return "a year";
  return interval.count % 12 === 0 ? `every ${interval.count / 12} years` : `every ${interval.count} months`;
}

/** What one payment comes to a month. */
export function monthlyOf(amount: number, interval: Interval): number {
  return interval.unit === "month" ? amount / interval.count : (amount * 52) / (12 * interval.count);
}

function amountOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const plain = plainAmount(value);
  return plain === null ? null : Number(plain);
}

function text(fields: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = fields[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export interface BillCost {
  // null: not known yet (still a bill, left out of the totals).
  readonly amount: number | null;
  readonly currency: string;
  readonly interval: Interval | null;
  readonly monthly: number | null;
}

/**
 * What a record costs as a bill, or null when it isn't one. A card's bill is its annual fee (a fee
 * of 0, or none known, means it isn't a bill); only a card with no fee falls back to its cost and
 * cycle.
 */
export function billCost(type: RecordTypeDef, fields: Readonly<Record<string, unknown>>): BillCost | null {
  const currency = (text(fields, "currency") ?? "AUD").toUpperCase();
  const fee = type.id === "banking.card" ? amountOf(fields.annual_fee) : null;
  if (fee === 0) return null;
  const amount = fee ?? amountOf(fields.amount);
  // A card is a bill once its fee (or a cost) is known: a card with neither is just a card.
  if (type.id === "banking.card" && amount === null) return null;
  const interval = fee !== null ? CYCLE_INTERVALS.yearly! : intervalOf(fields.cycle, type.id === "vehicles.registration" ? fields.term : undefined);
  if (!type.bill) {
    const fallback = type.lifecycle === "standing" && !type.anchor && (type.origin === "custom" || FALLBACK_TYPES.has(type.id));
    if (!fallback || amount === null || amount === 0 || interval === null) return null;
  }
  return { amount, currency, interval, monthly: amount !== null && interval !== null ? monthlyOf(amount, interval) : null };
}

// ---- calendar dates (YYYY-MM-DD, as in the person's zone) ------------------------------------

const DAY_MS = 86_400_000;

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return [y, m, d];
}

function iso(year: number, monthIndex: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysIn(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Whole days from one date to another (negative when `to` is earlier). */
export function daysFrom(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** `date` plus `months`, on the same day of the month or the month's last day (31 Jan + 1 → 28 Feb). */
export function addMonthsClamped(date: string, months: number): string {
  const [y, m, d] = parts(date);
  const index = m - 1 + months;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  return iso(year, month, Math.min(d, daysIn(year, month)));
}

/**
 * The first payment on or after `today` of a cycle through `anchor` (anchor + k × interval, for
 * any whole k), counted from the anchor each time so a 31st doesn't drift. Estimated unless it is
 * the anchor itself.
 */
export function nextOnCycle(anchor: string, interval: Interval, today: string): { date: string; estimated: boolean } {
  if (interval.unit === "week") {
    const step = 7 * interval.count;
    const k = Math.ceil(daysFrom(anchor, today) / step);
    return { date: addDays(anchor, k * step), estimated: k !== 0 };
  }
  const [ay, am] = parts(anchor);
  const [ty, tm] = parts(today);
  let k = Math.floor(((ty - ay) * 12 + (tm - am)) / interval.count) - 1;
  let date = addMonthsClamped(anchor, k * interval.count);
  while (date < today) {
    k += 1;
    date = addMonthsClamped(anchor, k * interval.count);
  }
  return { date, estimated: k !== 0 };
}

// ---- bills ----------------------------------------------------------------------------------

/** A record as the bill rule reads it: the page's view and the stored record both fit. */
export interface BillRecord {
  readonly id: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly dueDate: string | Date | null;
  readonly status: string;
  readonly reviewState?: string;
  // Where it stands (`phaseOf`); absent ⇒ read from its status.
  readonly phase?: { readonly live: boolean; readonly bucket?: Bucket };
}

export interface Bill extends BillCost {
  readonly id: string;
  readonly typeId: string;
  readonly category: string;
  readonly name: string;
  // The next payment, or null when it isn't known yet.
  readonly next: { readonly date: string; readonly estimated: boolean } | null;
  // The next payment's date is past: a bill the person pays by hand, not paid yet.
  readonly overdue: boolean;
  // A date it had that has passed, kept when the next one isn't known.
  readonly lastKnown: string | null;
  readonly paidWith: string | null;
  readonly accountEmail: string | null;
  readonly notChecked: boolean;
}

function dateOf(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : calendarDate(value.slice(0, 10));
}

function live(record: BillRecord): boolean {
  return record.phase ? record.phase.live : record.status === "active";
}

/** The cost and live-ness only (no dates): for the monthly figure. */
export function billCostOf(type: RecordTypeDef, record: BillRecord): BillCost | null {
  if (type.lifecycle !== "standing" || record.status !== "active" || !live(record)) return null;
  return billCost(type, record.fields);
}

/** The record as a bill, with its next payment worked out against `today`, or null. */
export function billOf(type: RecordTypeDef, record: BillRecord, today: string): Bill | null {
  const cost = billCostOf(type, record);
  if (!cost) return null;
  const nextPayment = text(record.fields, "next_payment");
  const own = !type.bill || type.bill.date === "due_date" ? dateOf(record.dueDate) : null;
  const anchor = (nextPayment ? calendarDate(nextPayment) : null) ?? own;
  const byHand = type.bill?.paid === "manual";
  let next: Bill["next"] = null;
  let overdue = false;
  let lastKnown: string | null = null;
  if (anchor) {
    const passed = anchor < today;
    const recently = passed && daysFrom(anchor, today) <= WINDOWS.overdueShownDays;
    if (passed && recently && (byHand || !cost.interval)) {
      next = { date: anchor, estimated: false };
      overdue = true;
    } else if (cost.interval) {
      next = nextOnCycle(anchor, cost.interval, today);
    } else if (!passed) {
      next = { date: anchor, estimated: false };
    } else {
      lastKnown = anchor;
    }
  }
  return {
    id: record.id,
    typeId: type.id,
    category: type.category,
    name: storedRecordName(type, record.fields),
    ...cost,
    next,
    overdue,
    lastKnown,
    paidWith: text(record.fields, "paid_with"),
    accountEmail: text(record.fields, "account_email"),
    notChecked: record.reviewState === "suggested",
  };
}

/** What the person pays a month, per currency: live bills only. */
export function billsMonthlyCost(records: readonly BillRecord[], typeOf: (record: BillRecord) => RecordTypeDef | null): MonthlyCost[] {
  const items: { currency: string; monthly: number }[] = [];
  for (const record of records) {
    const type = typeOf(record);
    const cost = type ? billCostOf(type, record) : null;
    if (cost && cost.monthly !== null) items.push({ currency: cost.currency, monthly: cost.monthly });
  }
  return monthlyTotals(items);
}

// ---- which card or account it comes out of ---------------------------------------------------

export interface PaymentSource {
  readonly id: string;
  readonly typeId: "banking.account" | "banking.card";
  // "NAB Qantas Rewards Signature card ending 2686": what the form suggests and the row shows.
  readonly label: string;
  readonly provider: string | null;
  readonly last4: string | null;
  readonly closed: boolean;
  // The words of its name and card product that tell it apart (not its bank's, not "card" or
  // "account"), for matching.
  readonly words: readonly string[];
}

const words = (value: string): string[] => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
const GENERIC: ReadonlySet<string> = new Set(["card", "account", "the", "and", "of", "my", "ending"]);

function distinctive(values: readonly (string | null)[], provider: string | null): string[] {
  const bank = new Set(provider ? words(provider) : []);
  return [...new Set(values.flatMap((value) => (value ? words(value) : [])))].filter((word) => !bank.has(word) && !GENERIC.has(word) && !/^\d+$/.test(word));
}

/** The person's bank accounts and cards, open or closed, as places a bill can come out of. */
export function paymentSources(records: readonly BillRecord[], typeOf: (record: BillRecord) => RecordTypeDef | null): PaymentSource[] {
  const sources: PaymentSource[] = [];
  for (const record of records) {
    const type = typeOf(record);
    if (!type || (type.id !== "banking.account" && type.id !== "banking.card")) continue;
    const name = storedRecordName(type, record.fields);
    const last4 = text(record.fields, "last4");
    const digits = last4 && /^\d{3,4}$/.test(last4) ? last4 : null;
    const finished = record.phase?.bucket === "finished" || ["cancelled", "expired", "done"].includes(record.status);
    sources.push({
      id: record.id,
      typeId: type.id,
      label: digits && !name.includes(digits) ? `${name} ending ${digits}` : name,
      provider: text(record.fields, "provider"),
      last4: digits,
      closed: finished,
      words: distinctive([name, text(record.fields, "card_product")], text(record.fields, "provider")),
    });
  }
  return sources;
}

const DIGITS = /(?:ending(?:\s+in)?|ends\s+in|last\s*4(?:\s+digits)?|[·•*x.]{2,})\s*(\d{3,4})\b/i;

/**
 * The account or card `paidWith` names, or null unless exactly one fits. Four digits must match a
 * last 4 (the provider in the text settles a tie; no match means no link, never a guess by
 * name). Three digits match a last 4 ending in them, else words among accounts with no last 4.
 * Words: "card" narrows to cards, "account", "savings" or "everyday" to accounts; the source with
 * the most of its own distinctive words in the text fits ("Altitude", "Choice", "Savings"), if no
 * other has as many; else its bank appearing fits when it is the only one of that kind. A card's
 * own fee, with nothing in Paid with, comes out of the card itself.
 */
export function resolvePaidFrom(paidWith: string | null, sources: readonly PaymentSource[], self: PaymentSource | null = null): PaymentSource | null {
  if (!paidWith) return self;
  const said = paidWith.toLowerCase();
  const tokens = new Set(words(paidWith));
  const hasProvider = (source: PaymentSource) => source.provider !== null && words(source.provider).every((word) => tokens.has(word));
  const only = (list: readonly PaymentSource[]) => (list.length === 1 ? list[0]! : null);
  const match = DIGITS.exec(said) ?? /(\d{4})\s*$/.exec(said.replace(/[^\w\s]/g, " "));
  let pool: readonly PaymentSource[] = sources;
  if (match) {
    const digits = match[1]!;
    if (digits.length === 4) {
      const exact = sources.filter((source) => source.last4 === digits);
      return only(exact) ?? only(exact.filter(hasProvider));
    }
    const ending = sources.filter((source) => source.last4?.endsWith(digits));
    if (ending.length === 1) return ending[0]!;
    pool = sources.filter((source) => source.last4 === null);
  }
  if (tokens.has("card")) pool = pool.filter((source) => source.typeId === "banking.card");
  else if (["account", "savings", "everyday"].some((word) => tokens.has(word))) pool = pool.filter((source) => source.typeId === "banking.account");
  const scored = pool.map((source) => ({ source, score: source.words.filter((word) => tokens.has(word)).length }));
  const best = Math.max(0, ...scored.map((entry) => entry.score));
  if (best > 0) return only(scored.filter((entry) => entry.score === best).map((entry) => entry.source));
  return only(pool.filter(hasProvider));
}

// ---- the view -------------------------------------------------------------------------------

export interface PaidBill extends Bill {
  readonly paidFrom: PaymentSource | null;
}

export interface AccountGroup {
  readonly key: string;
  // The card or account, when Paid with matched one.
  readonly source: PaymentSource | null;
  // What Paid with says, when it matched none (shown as written).
  readonly said: string | null;
  readonly bills: readonly PaidBill[];
  readonly monthly: readonly MonthlyCost[];
}

export interface BillsView {
  readonly overdue: readonly PaidBill[];
  // Due in the next 30 days.
  readonly soon: readonly PaidBill[];
  readonly later: readonly PaidBill[];
  readonly unknown: readonly PaidBill[];
  readonly accounts: readonly AccountGroup[];
  readonly monthly: readonly MonthlyCost[];
  readonly total: number;
  // Bills with no cost or how often yet, so not in the monthly figure.
  readonly uncounted: number;
  readonly notChecked: number;
}

export const BILLS_SOON_DAYS = 30;

const byDate = (a: PaidBill, b: PaidBill) => (a.next!.date < b.next!.date ? -1 : a.next!.date > b.next!.date ? 1 : a.name.localeCompare(b.name));
const byCost = (a: PaidBill, b: PaidBill) => (b.monthly ?? -1) - (a.monthly ?? -1) || a.name.localeCompare(b.name);

function totals(bills: readonly PaidBill[]): MonthlyCost[] {
  return monthlyTotals(bills.filter((bill) => bill.monthly !== null).map((bill) => ({ currency: bill.currency, monthly: bill.monthly! })));
}

/**
 * Every bill in `records`, grouped by when the next payment is (overdue, the next 30 days,
 * later, not known yet) and by the card or account it comes out of. `sources` are the person's
 * cards and accounts (from all their records, so a closed card a bill still names is found).
 */
export function billsView(
  records: readonly BillRecord[],
  typeOf: (record: BillRecord) => RecordTypeDef | null,
  today: string,
  sources: readonly PaymentSource[],
): BillsView {
  const bills: PaidBill[] = [];
  for (const record of records) {
    const type = typeOf(record);
    const bill = type ? billOf(type, record, today) : null;
    if (!bill) continue;
    const self = bill.typeId === "banking.card" ? sources.find((source) => source.id === bill.id) ?? null : null;
    bills.push({ ...bill, paidFrom: resolvePaidFrom(bill.paidWith, sources, self) });
  }
  const dated = bills.filter((bill) => bill.next !== null);
  const soonUntil = addDays(today, BILLS_SOON_DAYS);
  const groups = new Map<string, { source: PaymentSource | null; said: string | null; bills: PaidBill[] }>();
  for (const bill of [...dated].sort(byDate).concat(bills.filter((bill) => bill.next === null).sort(byCost))) {
    const key = bill.paidFrom ? `source:${bill.paidFrom.id}` : bill.paidWith ? `said:${words(bill.paidWith).join(" ")}` : "unknown";
    const group = groups.get(key) ?? { source: bill.paidFrom, said: bill.paidFrom ? null : bill.paidWith, bills: [] };
    group.bills.push(bill);
    groups.set(key, group);
  }
  const rank = (key: string, group: { source: PaymentSource | null }) => (key === "unknown" ? 3 : group.source === null ? 2 : group.source.closed ? 1 : 0);
  const accounts = [...groups]
    .sort(([a, ga], [b, gb]) => rank(a, ga) - rank(b, gb) || (ga.source?.label ?? ga.said ?? "").localeCompare(gb.source?.label ?? gb.said ?? ""))
    .map(([key, group]) => ({ key, source: group.source, said: group.said, bills: group.bills, monthly: totals(group.bills) }));
  return {
    overdue: dated.filter((bill) => bill.overdue).sort(byDate),
    soon: dated.filter((bill) => !bill.overdue && bill.next!.date <= soonUntil).sort(byDate),
    later: dated.filter((bill) => !bill.overdue && bill.next!.date > soonUntil).sort(byDate),
    unknown: bills.filter((bill) => bill.next === null).sort(byCost),
    accounts,
    monthly: totals(bills),
    total: bills.length,
    uncounted: bills.filter((bill) => bill.monthly === null).length,
    notChecked: bills.filter((bill) => bill.notChecked).length,
  };
}
