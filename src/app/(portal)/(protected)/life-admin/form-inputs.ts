import { isTimeZone } from "@/domain/life-admin/lifecycle";
import { canonicalDateTime, calendarDate } from "@/domain/life-admin/normalise";
import { DEFAULT_LIST_STATUSES, LIST_STATUSES, recordsHref } from "@/components/life-admin/record-groups";
import type { RecordFilter, RecordListStatus } from "@/components/life-admin/record-view-types";
import { allParams } from "@/lib/href";

// The Life admin forms' inputs, read from a submitted FormData (pure: no session, no DB).

// A date-time field posts its wall time from a <input type=datetime-local> ("2026-12-03T19:30")
// as `field:<key>`, the zone it happens in as `zone:<key>` (an IANA name, or "offset:+05:30"
// for a value saved with an offset only), and — when the stored value was a date alone —
// `dateonly:<key>`. They combine here, on the server, into the canonical stored form
// ("2026-12-03T19:30+11:00[Australia/Sydney]"), so an untouched value posts back exactly as it
// was saved and an edit never rewrites what the person didn't change.
export function combineDateTime(local: string, zone: string | null, dateOnly: string | null = null): string {
  const value = local.trim();
  if (value === "") return "";
  if (dateOnly && (value === dateOnly || value === `${dateOnly}T00:00`)) return dateOnly;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return calendarDate(value) ?? value;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return value;
  const wall = value.slice(0, 16);
  if (zone?.startsWith("offset:")) {
    const offset = zone.slice(7);
    if (!/^[+-]\d{2}:\d{2}$/.test(offset)) return wall;
    return canonicalDateTime(`${wall}${offset}`, "UTC")?.value ?? wall;
  }
  if (zone && isTimeZone(zone)) return canonicalDateTime(`${wall}[${zone}]`, zone)?.value ?? wall;
  // No usable zone: the record service reads it in the person's own zone.
  return wall;
}

// Keep editable personal fields separate from scheduling metadata and React's
// server-action control fields, including when a personal field has the same name.
export function recordFields(form: FormData): Record<string, string> {
  const namespaced = form.get("recordFormVersion") === "2";
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : null;
  };
  return Object.fromEntries([...form.entries()]
    .filter(([name, value]) => typeof value === "string" && (namespaced
      ? name.startsWith("field:")
      : name !== "recordId" && name !== "setting" && !name.startsWith("$ACTION_")))
    .map(([name, value]) => {
      if (!namespaced) return [name, value as string];
      const key = name.slice(6);
      const zone = text(`zone:${key}`);
      return [key, zone !== null ? combineDateTime(value as string, zone, text(`dateonly:${key}`)) : (value as string)];
    }));
}

export function recordDate(form: FormData): string | null | undefined {
  // A form left open before the upgrade has only personal fields. In particular,
  // a legacy personal field named dueDate must not become scheduling metadata.
  if (form.get("recordFormVersion") !== "2") return undefined;
  const value = form.get("dueDate");
  return typeof value === "string" ? value || null : undefined;
}

export function recordStatus(form: FormData): string | undefined {
  if (form.get("recordFormVersion") !== "2") return undefined;
  const value = form.get("status");
  return typeof value === "string" ? value || undefined : undefined;
}

// The records view's tab (`?tab=`): Records, Upcoming, Bookings or the moving checklist. The
// tab's old name ("things") and the tabs Life admin had before typed records (subscriptions,
// receipts, renewals) — still named in reminder links people already have — and anything else
// open Records.
export type RecordTab = "records" | "upcoming" | "bookings" | "checklist";
const RECORD_TABS: readonly RecordTab[] = ["records", "upcoming", "bookings", "checklist"];
export function recordTab(value: unknown): RecordTab {
  return typeof value === "string" && (RECORD_TABS as readonly string[]).includes(value) ? (value as RecordTab) : "records";
}

// A category id or a slug of the person's own ("vehicles", "x_7kq2mz"): the shape only; the page
// checks it against the person's catalogue.
const CATEGORY_ID = /^[a-z0-9_]{1,40}$/;
const isListStatus = (value: string): value is RecordListStatus => (LIST_STATUSES as readonly string[]).includes(value);

// Where a record action lands afterwards: the tab it was submitted from and, on Records, the
// filters it was shown under (`returnCategory` / `returnStatus`, well-formed values only; the
// page validates them again).
export function recordReturnPath(form: FormData): string {
  const tab = recordTab(form.get("returnTab"));
  if (tab !== "records") return `/life-admin?view=life&tab=${tab}`;
  const strings = (name: string) => form.getAll(name).filter((value): value is string => typeof value === "string");
  const statuses = allParams(strings("returnStatus")).filter(isListStatus);
  return recordsHref({
    categories: allParams(strings("returnCategory")).filter((value) => CATEGORY_ID.test(value)),
    statuses: LIST_STATUSES.filter((status) => statuses.includes(status)),
  });
}

/**
 * The Records tab's filters from the address (`?category=…&status=…`, each repeatable): the
 * categories the person's catalogue has (`categoryIds`, in its order), once each, and the known
 * statuses in their usual order; Active when no status is left.
 */
export function recordFilters(
  params: { readonly category?: string | readonly string[]; readonly status?: string | readonly string[] },
  categoryIds: readonly string[],
): RecordFilter {
  const categories = new Set(allParams(params.category).filter((value) => CATEGORY_ID.test(value)));
  const statuses = new Set(allParams(params.status).filter(isListStatus));
  const chosen = LIST_STATUSES.filter((status) => statuses.has(status));
  return {
    categories: categoryIds.filter((id) => categories.has(id)),
    statuses: chosen.length ? chosen : [...DEFAULT_LIST_STATUSES],
  };
}

// The record type the Add form posts ("vehicles.registration"); the action validates it.
export function recordTypeId(form: FormData): string {
  const value = form.get("type");
  return typeof value === "string" ? value : "";
}

// The anchor a record belongs to: undefined when the form has no "Belongs to" choice (the
// link is kept), null for "Not linked", else the chosen record's id (the action validates it
// as one of the person's own).
export function recordParent(form: FormData): string | null | undefined {
  const value = form.get("parentId");
  if (typeof value !== "string") return undefined;
  return value === "" ? null : value;
}

// Every record id a form posts (Confirm all posts one per suggestion).
export function recordIds(form: FormData): string[] {
  return form.getAll("recordId").filter((value): value is string => typeof value === "string");
}

// The field a refusal names, as carried back in the address (`&field=`): a short plain
// label only (letters, digits, spaces and simple punctuation), else nothing.
export function noticeField(value: unknown): string | null {
  return typeof value === "string" && /^[\p{L}\p{N} ,.'()&/+-]{1,60}$/u.test(value) ? value : null;
}

// Where a task action lands afterwards: the Tasks view, keeping the `?assignee=` filter
// the form was submitted under when it is well formed ("any" or a uuid). The page then
// validates it against the person's own agents, exactly as for a typed-in link.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function taskReturnPath(form: FormData): string {
  const value = form.get("returnAssignee");
  const assignee = typeof value === "string" && (value === "any" || UUID_RE.test(value)) ? value : null;
  return assignee ? `/life-admin?view=tasks&assignee=${assignee}` : "/life-admin?view=tasks";
}

// Empty input disables reminders. Invalid nonempty entries survive as NaN so
// boundary validation refuses the whole change instead of silently losing it.
export function recordOffsets(raw: string): number[] {
  return raw.split(",").map(part => part.trim()).filter(Boolean).map(Number);
}

// ─── the item page ───────────────────────────────────────────────────────────────────

// Where an item-page action lands afterwards: that item's page (a well-formed id only), else
// Life admin.
export function itemPath(id: unknown): string {
  return typeof id === "string" && UUID_RE.test(id) ? `/life-admin/items/${id.toLowerCase()}` : "/life-admin?view=life&tab=records";
}

// What the "Add a note or decision" form posts: the kind, the text and (for a next step) an
// optional due date. Shape only; the action validates and checks the text.
export function journalInput(form: FormData): { id: string; kind: string; text: string; due: string | null } {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const kind = text("entryKind");
  const due = text("due").trim();
  return { id: text("recordId"), kind, text: text("text"), due: kind === "next" && due ? due : null };
}

// ─── the Bookings tab's filters ──────────────────────────────────────────────────────

export const BOOKING_STATES = ["pending", "upcoming", "in_progress", "completed", "cancelled", "missed", "lapsed"] as const;

// The Bookings tab's GET filters, each repeatable and kept only when well formed (category ids
// or slugs, short "for whom" labels, booking phases in their usual order, a page number); the
// view matches them against what the person actually has.
export function bookingFilters(params: Readonly<Record<string, string | readonly string[] | undefined>>): {
  categories?: string[];
  forWhom?: string[];
  states?: string[];
  page?: number;
} {
  const categories = allParams(params.category).filter((value) => CATEGORY_ID.test(value));
  const people = new Map<string, string>();
  for (const value of allParams(params.for_whom)) {
    const who = value.trim();
    if (who.length > 0 && value.length <= 60 && !people.has(who.toLowerCase())) people.set(who.toLowerCase(), who);
  }
  const forWhom = [...people.values()];
  const given = allParams(params.state);
  const states = BOOKING_STATES.filter((state) => given.includes(state));
  const first = typeof params.page === "string" ? params.page : params.page?.[0];
  const page = first && /^\d{1,4}$/.test(first) && Number(first) >= 1 ? Number(first) : undefined;
  return {
    ...(categories.length ? { categories } : {}),
    ...(forWhom.length ? { forWhom } : {}),
    ...(states.length ? { states } : {}),
    ...(page ? { page } : {}),
  };
}
