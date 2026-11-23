// How Life admin organises a person's records (docs/adr/life-admin-profile.md): where each record
// stands on the Records tab (Active, On hold, Finished, Cancelled) and the tab's category and
// status filters; what's active by category — the person's own catalogue, built-in and their own
// categories, in catalogue order — with the anchors other records belong to (a vehicle, a home,
// a trip, a pet, or a thing of a category of their own) heading those records, most urgent
// first; each other status as its own list, newest first; what is coming up across every
// category; every booking, live and past; the categories still to fill in; and each row's
// reminder setting in one plain line.
//
// Pure functions over plain values, shared by the view and its tests. Nothing here reads the
// clock or decides on its own whether a record is live: the loader works out each record's
// phase with the one lifecycle module (`domain/life-admin/lifecycle.ts`) and passes it in, and
// the person's local date (`today`) too, so a render is the same for the same props.

import type { Catalogue } from "@/domain/life-admin/catalogue";
import { PHASE_LABELS, statusFor, WINDOWS, type Phase } from "@/domain/life-admin/lifecycle";
import type { CategoryDef, RecordTypeDef, StoredKind } from "@/domain/life-admin/record-types";
import { recordName } from "./record-format";
import type { BookingFilters, CategoryStateView, RecordFilter, RecordListStatus, RecordPhaseView } from "./record-view-types";
import { monthlyCost, type MonthlyCost } from "@/domain/life-admin/costs";

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

// ─── By category ─────────────────────────────────────────────────────────────────────

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

// ─── Records: statuses, filters, Active by category and the other statuses ──────────────

// The Records tab's statuses, in the order the tab lists them: what's active always first.
export const LIST_STATUSES: readonly RecordListStatus[] = ["active", "on_hold", "finished", "cancelled"];
export const DEFAULT_LIST_STATUSES: readonly RecordListStatus[] = ["active"];
export const LIST_STATUS_LABELS: Readonly<Record<RecordListStatus, string>> = {
  active: "Active",
  on_hold: "On hold",
  finished: "Finished",
  cancelled: "Cancelled",
};

// Each phase's status. "ended" (a standing item) is Finished unless its status says cancelled.
const STATUS_OF_PHASE: Readonly<Record<Phase, RecordListStatus>> = {
  current: "active", due_soon: "active", overdue: "active", date_passed: "active",
  pending: "active", upcoming: "active", in_progress: "active", open: "active", waiting: "active",
  paused: "on_hold",
  ended: "finished", completed: "finished", resolved: "finished",
  cancelled: "cancelled", missed: "cancelled", lapsed: "cancelled",
};

/**
 * Where a record stands on the Records tab, from the phase the loader worked out: Active (live),
 * On hold (paused), Finished (ended, completed, resolved) or Cancelled (cancelled, missed,
 * lapsed, and a standing item whose status is cancelled).
 */
export function listStatusOf(record: { readonly phase?: RecordPhaseView; readonly status: string }): RecordListStatus {
  const { phase } = phaseOfView(record);
  if (phase === "ended" && statusFor({ lifecycle: "standing" }, record.status)?.status === "cancelled") return "cancelled";
  return STATUS_OF_PHASE[phase] ?? "active";
}

// Most urgent first: overdue and date passed, happening now, due soon, then everything else with
// a date, then the undated.
const URGENCY: Partial<Record<Phase, number>> = { overdue: 0, date_passed: 0, in_progress: 1, due_soon: 2 };
const UNDATED = "9999";

/**
 * A list most urgent first: overdue and date passed, happening now, due soon (each soonest
 * first), then by due or start date, then the undated by name.
 */
export function mostUrgentFirst<T extends Recordish>(list: readonly T[], catalogue: Catalogue): T[] {
  const nameOf = (record: T) => recordName(catalogue.typeOfRecord(record.kind, record.type ?? null), record.fields, Boolean(record.type)).name;
  const rank = (record: T) => URGENCY[phaseOfView(record).phase] ?? (whenKey(record) === UNDATED ? 4 : 3);
  return [...list].sort((a, b) => rank(a) - rank(b) || whenKey(a).localeCompare(whenKey(b)) || nameOf(a).localeCompare(nameOf(b)));
}

/** The records the Records tab lists: all but those in a category the person said is not for them. */
export function listedRecords<T extends Recordish>(records: readonly T[], catalogue: Catalogue, states: readonly CategoryStateView[]): T[] {
  const hidden = new Set(states.filter((state) => state.visibility === "not_for_me").map((state) => state.id));
  return hidden.size === 0 ? [...records] : records.filter((record) => !hidden.has(catalogue.typeOfRecord(record.kind, record.type ?? null).category));
}

export type StatusRow<T> = { readonly record: T; readonly type: RecordTypeDef; readonly category?: CategoryDef; readonly anchor: T | null };

// One status other than Active, as its own list across categories, newest first.
export type StatusSection<T> = { readonly status: RecordListStatus; readonly label: string; readonly rows: StatusRow<T>[] };

export type RecordsView<T> = {
  // Every category with at least one record (any status), plus any chosen one, in catalogue
  // order, each counted among the chosen statuses.
  readonly categoryOptions: { readonly category: CategoryDef; readonly count: number }[];
  // The four statuses, each counted among the chosen categories.
  readonly statusOptions: { readonly status: RecordListStatus; readonly label: string; readonly count: number }[];
  // What's active, by category (empty when Active isn't chosen): a category's live anchors with
  // their records, then its other records, most urgent first. No category is ever empty.
  readonly active: CategorySection<T>[];
  // Each other chosen status that has records, in the order On hold, Finished, Cancelled.
  readonly others: StatusSection<T>[];
  // How many records the chosen filters show.
  readonly shown: number;
  // What the active, recurring records in the chosen categories cost a month, per currency.
  readonly monthly: MonthlyCost[];
};

/**
 * The Records tab for `filter`: what's active by category first, then each other chosen
 * status, with the category and status choices and their counts. A record is shown when its
 * own category is chosen (or none is) and its status is.
 */
export function recordsView<T extends Recordish & { readonly status: string }>(
  records: readonly T[],
  catalogue: Catalogue,
  filter: RecordFilter,
): RecordsView<T> {
  const typeOf = new Map(records.map((record) => [record.id, catalogue.typeOfRecord(record.kind, record.type ?? null)] as const));
  const categoryOf = (record: T) => typeOf.get(record.id)!.category;
  const statusOf = new Map(records.map((record) => [record.id, listStatusOf(record)] as const));
  const chosenCategories = new Set(filter.categories);
  const chosenStatuses = new Set(filter.statuses);
  const inCategory = (record: T) => chosenCategories.size === 0 || chosenCategories.has(categoryOf(record));
  const inStatus = (record: T) => chosenStatuses.has(statusOf.get(record.id)!);

  const categoryOptions = catalogue.categories
    .filter((category) => chosenCategories.has(category.id) || records.some((record) => categoryOf(record) === category.id))
    .map((category) => ({ category, count: records.filter((record) => categoryOf(record) === category.id && inStatus(record)).length }));
  const statusOptions = LIST_STATUSES.map((status) => ({
    status,
    label: LIST_STATUS_LABELS[status],
    count: records.filter((record) => inCategory(record) && statusOf.get(record.id) === status).length,
  }));

  const shownRecords = records.filter((record) => inCategory(record) && inStatus(record));
  const active = chosenStatuses.has("active")
    ? organiseByCategory(shownRecords.filter((record) => statusOf.get(record.id) === "active"), catalogue).sections.map((section) => ({
        ...section,
        anchors: mostUrgentFirst(section.anchors.map((group) => group.anchor), catalogue).map((anchor) => {
          const group = section.anchors.find((candidate) => candidate.anchor.id === anchor.id)!;
          return { ...group, children: mostUrgentFirst(group.children, catalogue) };
        }),
        loose: mostUrgentFirst(section.loose, catalogue),
      }))
    : [];

  const byId = new Map(records.map((record) => [record.id, record] as const));
  const nameOf = (record: T) => recordName(typeOf.get(record.id)!, record.fields, Boolean(record.type)).name;
  // Newest first by start or due date; the undated after, by name.
  const newestFirst = (a: T, b: T) => {
    const [x, y] = [whenKey(a), whenKey(b)];
    if (x === UNDATED || y === UNDATED) return x === y ? nameOf(a).localeCompare(nameOf(b)) : x === UNDATED ? 1 : -1;
    return y.localeCompare(x) || nameOf(a).localeCompare(nameOf(b));
  };
  const others: StatusSection<T>[] = LIST_STATUSES.filter((status) => status !== "active" && chosenStatuses.has(status))
    .map((status) => ({
      status,
      label: LIST_STATUS_LABELS[status],
      rows: shownRecords
        .filter((record) => statusOf.get(record.id) === status)
        .sort(newestFirst)
        .map((record) => {
          const type = typeOf.get(record.id)!;
          const parent = record.parentId && record.parentId !== record.id ? byId.get(record.parentId) ?? null : null;
          return { record, type, category: catalogue.category(type.category), anchor: parent };
        }),
    }))
    .filter((section) => section.rows.length > 0);

  // What the person pays is what's active, whichever statuses they chose to show.
  const monthly = monthlyCost(records.filter((record) => inCategory(record) && statusOf.get(record.id) === "active"));
  return { categoryOptions, statusOptions, active, others, shown: shownRecords.length, monthly };
}

/** The Records tab with these filters: each chosen value repeated, the default status left out. */
export function recordsHref(filter: RecordFilter): string {
  const query = new URLSearchParams([["view", "life"], ["tab", "records"]]);
  for (const category of filter.categories) query.append("category", category);
  const statuses = LIST_STATUSES.filter((status) => filter.statuses.includes(status));
  const isDefault = statuses.length === DEFAULT_LIST_STATUSES.length && statuses.every((status) => DEFAULT_LIST_STATUSES.includes(status));
  if (!isDefault) for (const status of statuses) query.append("status", status);
  return `/life-admin?${query.toString()}`;
}

// ─── Fill in the rest ────────────────────────────────────────────────────────────────

export const FILL_IN_MAX = 6;

/**
 * The built-in categories to offer next: at most FILL_IN_MAX of those with no records that the
 * person hasn't said are not for them (whether or not they once chose to show it), lowest
 * priority first ("Other" has nothing specific to look for); and the ones the person said are
 * not for them.
 */
export function fillInChoices(catalogue: Catalogue, states: readonly CategoryStateView[]): {
  available: CategoryDef[];
  notForMe: { category: CategoryDef; records: number }[];
} {
  const byId = new Map(states.map((state) => [state.id, state]));
  const builtIn = catalogue.categories.filter((category) => category.origin === "builtin");
  const available = builtIn
    .filter((category) => {
      const state = byId.get(category.id);
      return state !== undefined && state.records === 0 && state.visibility !== "not_for_me" && category.id !== "other";
    })
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
  // What the filters can offer: the categories, people and states present among the bookings,
  // and any chosen one besides, so it can be unticked.
  readonly options: {
    readonly categories: CategoryDef[];
    readonly forWhom: string[];
    readonly states: { readonly phase: Phase; readonly label: string }[];
  };
  // How many bookings each choice would show with the other filters as they are.
  readonly counts: {
    readonly categories: Readonly<Record<string, number>>;
    readonly forWhom: Readonly<Record<string, number>>;
    readonly states: Readonly<Record<string, number>>;
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
 * any of the chosen categories, people ("for whom") and states; values that match nothing simply
 * show nothing.
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
  const chosen = {
    categories: new Set(filters.categories ?? []),
    forWhom: new Set((filters.forWhom ?? []).map((who) => who.toLowerCase())),
    states: new Set<string>(filters.states ?? []),
  };
  const matches = {
    categories: (row: BookingRow<T>) => chosen.categories.size === 0 || chosen.categories.has(row.type.category),
    forWhom: (row: BookingRow<T>) => chosen.forWhom.size === 0 || chosen.forWhom.has(forWhomOf(row).toLowerCase()),
    states: (row: BookingRow<T>) => chosen.states.size === 0 || chosen.states.has(phaseOfView(row.record).phase),
  };
  // What each choice would show with the other two filters as they are.
  const without = (skip: keyof typeof matches) => all.filter((row) => (Object.keys(matches) as (keyof typeof matches)[]).every((key) => key === skip || matches[key](row)));
  const countBy = (list: BookingRow<T>[], keyOf: (row: BookingRow<T>) => string) => {
    const out: Record<string, number> = {};
    for (const row of list) out[keyOf(row)] = (out[keyOf(row)] ?? 0) + 1;
    return out;
  };
  const people = [...new Set(all.map(forWhomOf).filter(Boolean))];
  for (const who of filters.forWhom ?? []) if (!people.some((person) => person.toLowerCase() === who.toLowerCase())) people.push(who);
  const states = new Map(all.map((row) => { const phase = phaseOfView(row.record); return [phase.phase, phase.label] as const; }));
  for (const state of filters.states ?? []) if (!states.has(state as Phase) && state in PHASE_LABELS) states.set(state as Phase, PHASE_LABELS[state as Phase]);
  const options = {
    categories: catalogue.categories.filter((category) => chosen.categories.has(category.id) || all.some((row) => row.type.category === category.id)),
    forWhom: people.sort((a, b) => a.localeCompare(b)),
    states: [...states.entries()].map(([phase, label]) => ({ phase, label })),
  };
  const byCategory = countBy(without("categories"), (row) => row.type.category);
  const byPerson = countBy(without("forWhom"), (row) => forWhomOf(row).toLowerCase());
  const byState = countBy(without("states"), (row) => phaseOfView(row.record).phase);
  const counts = {
    categories: Object.fromEntries(options.categories.map((category) => [category.id, byCategory[category.id] ?? 0])),
    forWhom: Object.fromEntries(options.forWhom.map((who) => [who, byPerson[who.toLowerCase()] ?? 0])),
    states: Object.fromEntries(options.states.map((state) => [state.phase, byState[state.phase] ?? 0])),
  };
  const rows = all.filter((row) => matches.categories(row) && matches.forWhom(row) && matches.states(row));

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
  return { live, past, pastTotal: pastAll.length, page, pages, options, counts, total: all.length };
}
