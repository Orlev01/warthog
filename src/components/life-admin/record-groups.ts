// How Life admin organises a person's records (docs/adr/life-admin-profile.md): their things by
// category — the person's own catalogue, built-in and their own categories, in catalogue order
// — with the anchors other records belong to (a vehicle, a home, a trip, a pet, or a thing of a
// category of their own) heading those records, and finished ones set aside; what is coming up
// across every category; every booking, live and past; the categories still to fill in; and
// each row's reminder setting in one plain line.
//
// Pure functions over plain values, shared by the view and its tests. Nothing here reads the
// clock or decides on its own whether a record is live: the loader works out each record's
// phase with the one lifecycle module (`domain/life-admin/lifecycle.ts`) and passes it in, and
// the person's local date (`today`) too, so a render is the same for the same props.

import type { Catalogue } from "@/domain/life-admin/catalogue";
import { WINDOWS, type Phase } from "@/domain/life-admin/lifecycle";
import type { CategoryDef, RecordTypeDef, StoredKind } from "@/domain/life-admin/record-types";
import type { BookingFilters, CategoryStateView, RecordPhaseView } from "./record-view-types";

// A calendar date `days` after `isoDate` (both YYYY-MM-DD), computed on the calendar in
// UTC so no local offset or daylight-saving change can shift it.
export function addDays(isoDate: string, days: number): string {
  const [year, month, date] = isoDate.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! + days)).toISOString().slice(0, 10);
}

export function joinWords(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// A record's reminder setting in one line, so the row says what will happen without the
// Manage disclosure being opened. `on` is false when no reminder can be sent.
export function reminderSummary(dueDate: string | null, offsets: readonly number[]): { on: boolean; text: string } {
  if (offsets.length === 0) return { on: false, text: "Reminders off" };
  if (!dueDate) return { on: false, text: "Reminders start once it has a due date" };
  const days = [...new Set(offsets)].sort((a, b) => b - a);
  const parts = days.map((day) => (day === 0 ? "on the due date" : `${day} ${day === 1 ? "day" : "days"} before`));
  return { on: true, text: `Reminds you ${joinWords(parts)}` };
}

// "Coming up" runs from anything recently overdue through today + 60 days (the lifecycle's window).
export const COMING_UP_DAYS = WINDOWS.comingUpDays;

// A record with no phase from the loader (an older caller, a test) reads as current.
export const CURRENT_PHASE: RecordPhaseView = { phase: "current", bucket: "live", live: true, label: "Current", comingUp: false };

type Recordish = {
  readonly id: string;
  readonly kind: StoredKind;
  readonly type?: string | null;
  readonly parentId?: string | null;
  readonly dueDate: string | null;
  readonly fields: Readonly<Record<string, string>>;
  readonly phase?: RecordPhaseView;
};

export function phaseOfView(record: { readonly phase?: RecordPhaseView }): RecordPhaseView {
  return record.phase ?? CURRENT_PHASE;
}

const finished = (record: { readonly phase?: RecordPhaseView }) => phaseOfView(record).bucket === "finished";

// When a record happens or is due, for sorting: its start, else its due date (end of the list when neither).
function whenKey(record: Recordish): string {
  return phaseOfView(record).starts ?? (record.dueDate ? `${record.dueDate}T12:00:00.000Z` : "9999");
}

// ─── Your things: one section per shown category ─────────────────────────────────────

export type AnchorGroup<T> = { readonly anchor: T; readonly type: RecordTypeDef; readonly children: T[] };

export type CategorySection<T> = {
  readonly category: CategoryDef;
  // The live anchors in this category, each with the live records that belong to it
  // (whatever their category: an electricity account sits under the home it belongs to).
  readonly anchors: AnchorGroup<T>[];
  // This category's live records that belong to no anchor shown here.
  readonly loose: T[];
  // Everything finished that would otherwise show in this panel, newest first: finished
  // records, finished records of a live anchor, and a finished anchor followed by its records.
  readonly finished: T[];
};

/**
 * The person's records by category, in their catalogue's order, for the categories shown
 * (`shown`; every category with records when absent): each live anchor with its live records,
 * then the category's unlinked live records, then what is finished. A record linked to an anchor
 * in a category that isn't shown stays in its own category. Records keep the loader's order
 * (soonest due first); finished ones are newest first.
 */
export function organiseByCategory<T extends Recordish>(
  records: readonly T[],
  catalogue: Catalogue,
  shown?: ReadonlySet<string>,
): { sections: CategorySection<T>[] } {
  const types = new Map<string, RecordTypeDef>(records.map((record) => [record.id, catalogue.typeOfRecord(record.kind, record.type ?? null)]));
  const typeOf = (record: T) => types.get(record.id)!;
  const isShown = (categoryId: string) => (shown ? shown.has(categoryId) : true);
  const anchors = new Map(records.filter((record) => typeOf(record).anchor && isShown(typeOf(record).category)).map((record) => [record.id, record]));
  const parentOf = (record: T): string | null =>
    !typeOf(record).anchor && record.parentId && record.parentId !== record.id && anchors.has(record.parentId) ? record.parentId : null;
  const newestFirst = (list: T[]) => [...list].sort((a, b) => whenKey(b).localeCompare(whenKey(a)));

  const sections: CategorySection<T>[] = [];
  for (const category of catalogue.categories) {
    if (!isShown(category.id)) continue;
    const inCategory = records.filter((record) => typeOf(record).category === category.id);
    const groups: AnchorGroup<T>[] = [];
    const done: T[] = [];
    for (const anchor of inCategory.filter((record) => anchors.has(record.id))) {
      const children = records.filter((record) => parentOf(record) === anchor.id);
      if (finished(anchor)) {
        done.push(anchor, ...children);
        continue;
      }
      groups.push({ anchor, type: typeOf(anchor), children: children.filter((child) => !finished(child)) });
      done.push(...children.filter(finished));
    }
    const unlinked = inCategory.filter((record) => !anchors.has(record.id) && parentOf(record) === null);
    const loose = unlinked.filter((record) => !finished(record));
    done.push(...newestFirst(unlinked.filter(finished)));
    if (groups.length > 0 || loose.length > 0 || done.length > 0) {
      sections.push({ category, anchors: groups, loose, finished: done });
    }
  }
  return { sections };
}

// ─── Fill in the rest ────────────────────────────────────────────────────────────────

export const FILL_IN_MAX = 6;

/**
 * The built-in categories to offer next: at most FILL_IN_MAX of those still available (empty
 * and not hidden), lowest priority first ("Other" has nothing specific to look for); and the
 * ones the person said are not for them.
 */
export function fillInChoices(catalogue: Catalogue, states: readonly CategoryStateView[]): {
  available: CategoryDef[];
  notForMe: { category: CategoryDef; records: number }[];
} {
  const byId = new Map(states.map((state) => [state.id, state]));
  const builtIn = catalogue.categories.filter((category) => category.origin === "builtin");
  const available = builtIn
    .filter((category) => byId.get(category.id)?.visibility === "available" && category.id !== "other")
    .sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label))
    .slice(0, FILL_IN_MAX);
  const notForMe = builtIn
    .filter((category) => byId.get(category.id)?.visibility === "not_for_me")
    .map((category) => ({ category, records: byId.get(category.id)?.records ?? 0 }));
  return { available, notForMe };
}

/** The prompt the person can paste into their agent, naming what to look for. */
export function fillInPrompt(categories: readonly CategoryDef[]): string {
  const words = categories.map((category) => category.promptWords).filter(Boolean);
  return `Use Warthog to look through my email for my ${joinWords(words)}, and save what you find to my Life admin for me to check.`;
}

// ─── Upcoming ────────────────────────────────────────────────────────────────────────

export type UpcomingSections<T> = {
  readonly now: T[];
  readonly overdue: T[];
  readonly week: T[];
  readonly later: T[];
};

/**
 * What is coming up, across every category: happening now, overdue (recently, within the
 * lifecycle's window), this week (today to 7 days) and later (to 60 days), each soonest first
 * (overdue: longest overdue first). Only what the lifecycle says is coming up is listed.
 */
export function upcomingSections<T extends Recordish>(records: readonly T[]): UpcomingSections<T> {
  const now: T[] = [];
  const overdue: T[] = [];
  const week: T[] = [];
  const later: T[] = [];
  for (const record of records) {
    const phase = phaseOfView(record);
    if (!phase.live && phase.phase !== "pending") continue;
    if (phase.phase === "in_progress") {
      now.push(record);
      continue;
    }
    if (!phase.comingUp || phase.inDays === undefined) continue;
    if (phase.inDays < 0) overdue.push(record);
    else if (phase.inDays <= 7) week.push(record);
    else later.push(record);
  }
  const soonest = (list: T[]) => list.sort((a, b) => whenKey(a).localeCompare(whenKey(b)));
  return { now: soonest(now), overdue: soonest(overdue), week: soonest(week), later: soonest(later) };
}

// ─── Bookings ────────────────────────────────────────────────────────────────────────

export const BOOKINGS_PAGE_SIZE = 30;
const LIVE_BOOKING: ReadonlySet<Phase> = new Set(["pending", "upcoming", "in_progress"]);

export type BookingRow<T> = { readonly record: T; readonly type: RecordTypeDef; readonly category?: CategoryDef; readonly anchor: T | null };

export type BookingsView<T> = {
  readonly live: BookingRow<T>[];
  // Past bookings on this page, newest first, by the month they started in.
  readonly past: { readonly key: string; readonly label: string; readonly rows: BookingRow<T>[] }[];
  readonly pastTotal: number;
  readonly page: number;
  readonly pages: number;
  // What the filters can offer: the categories, people and states present among the bookings.
  readonly options: {
    readonly categories: CategoryDef[];
    readonly forWhom: string[];
    readonly states: { readonly phase: Phase; readonly label: string }[];
  };
  readonly total: number;
};

const MONTH_KEY = (zone: string) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone: zone });
const MONTH_LABEL = (zone: string) => new Intl.DateTimeFormat("en-AU", { month: "long", year: "numeric", timeZone: zone });

function zoneOr(zone: string): string {
  try {
    new Intl.DateTimeFormat("en-AU", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

/**
 * Every booking-lifecycle record from every category, built-in or the person's own: live ones
 * (waiting to be confirmed, upcoming, happening now) soonest first, and past ones (completed,
 * cancelled, missed, lapsed) newest first, grouped by month and paged. `filters` narrow both to
 * a category, a "for whom" and a state; values that match nothing simply show nothing.
 */
export function bookingsView<T extends Recordish>(
  records: readonly T[],
  catalogue: Catalogue,
  filters: BookingFilters,
  zone: string,
  pageSize = BOOKINGS_PAGE_SIZE,
): BookingsView<T> {
  const byId = new Map(records.map((record) => [record.id, record]));
  const all: BookingRow<T>[] = [];
  for (const record of records) {
    const type = catalogue.typeOfRecord(record.kind, record.type ?? null);
    if (type.lifecycle !== "booking") continue;
    const parent = record.parentId && record.parentId !== record.id ? byId.get(record.parentId) ?? null : null;
    all.push({ record, type, category: catalogue.category(type.category), anchor: parent });
  }
  const forWhomOf = (row: BookingRow<T>) => row.record.fields.for_whom?.trim() ?? "";
  const options = {
    categories: catalogue.categories.filter((category) => all.some((row) => row.type.category === category.id)),
    forWhom: [...new Set(all.map(forWhomOf).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    states: [...new Map(all.map((row) => { const phase = phaseOfView(row.record); return [phase.phase, phase.label] as const; })).entries()]
      .map(([phase, label]) => ({ phase, label })),
  };
  const rows = all.filter((row) =>
    (!filters.category || row.type.category === filters.category) &&
    (!filters.forWhom || forWhomOf(row).toLowerCase() === filters.forWhom.toLowerCase()) &&
    (!filters.state || phaseOfView(row.record).phase === filters.state));

  const live = rows
    .filter((row) => LIVE_BOOKING.has(phaseOfView(row.record).phase))
    .sort((a, b) => whenKey(a.record).localeCompare(whenKey(b.record)));
  const pastAll = rows
    .filter((row) => !LIVE_BOOKING.has(phaseOfView(row.record).phase))
    .sort((a, b) => whenKey(b.record).localeCompare(whenKey(a.record)));
  const pages = Math.max(1, Math.ceil(pastAll.length / pageSize));
  const page = Math.min(Math.max(1, filters.page ?? 1), pages);
  const tz = zoneOr(zone);
  const past: { key: string; label: string; rows: BookingRow<T>[] }[] = [];
  for (const row of pastAll.slice((page - 1) * pageSize, page * pageSize)) {
    const when = whenKey(row.record);
    const at = when === "9999" ? null : new Date(when);
    const key = at ? MONTH_KEY(tz).format(at).slice(0, 7) : "undated";
    const label = at ? MONTH_LABEL(tz).format(at) : "No date";
    const group = past[past.length - 1];
    if (group && group.key === key) group.rows.push(row);
    else past.push({ key, label, rows: [row] });
  }
  return { live, past, pastTotal: pastAll.length, page, pages, options, total: all.length };
}
