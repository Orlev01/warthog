import { isTimeZone } from "@/domain/life-admin/lifecycle";
import { canonicalDateTime, calendarDate } from "@/domain/life-admin/normalise";
import { DEFAULT_LIST_STATUSES, HISTORY_STATUSES, RECORDS_TAB_STATUSES, historyHref, recordsHref } from "@/components/life-admin/record-groups";
import type { HistoryFilter, LifeAdminTab, RecordFilter, RecordListStatus } from "@/components/life-admin/record-view-types";
import { allParams } from "@/lib/href";
import { ADD_TAB_HREF, tabNamed } from "@/components/life-admin/tab-address";

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

// Life admin's tabs and older addresses (`?tab=`, `?view=…`): shared with the view, which puts
// today's address in the browser (`./tab-address.ts`).
export { currentLifeAdminHref, lifeAdminTab, requestedLifeAdminTab } from "@/components/life-admin/tab-address";
type Params = Readonly<Record<string, string | readonly string[] | undefined>>;
const first = (value: string | readonly string[] | undefined): string | undefined => (typeof value === "string" ? value : value?.[0]);

// The tab a record form was submitted from (`returnTab`): Records, Upcoming or History; older
// forms' tab names map as their addresses do.
export type RecordTab = Exclude<LifeAdminTab, "tasks">;
export function recordTab(value: unknown): RecordTab {
  const tab = typeof value === "string" ? tabNamed(value) : undefined;
  return tab && tab !== "tasks" ? tab : "records";
}

// A category id or a slug of the person's own ("vehicles", "x_7kq2mz"): the shape only; the page
// checks it against the person's catalogue.
const CATEGORY_ID = /^[a-z0-9_]{1,40}$/;
const isListStatus = (value: string): value is RecordListStatus => (["active", "on_hold", "finished", "cancelled"] as readonly string[]).includes(value);
const pageNumber = (value: string | undefined): number | undefined =>
  value && /^\d{1,4}$/.test(value) && Number(value) >= 1 ? Number(value) : undefined;

// The Add tab: what's still to fill in, and adding a record (founder, 24 Nov 2026).
export { ADD_TAB_HREF } from "@/components/life-admin/tab-address";

// Where a record action lands afterwards: the tab it was submitted from and, on Records or in
// History, the filters it was shown under (`returnCategory` / `returnStatus` / `returnPage`,
// well-formed values only; the page validates them again).
export function recordReturnPath(form: FormData): string {
  const tab = recordTab(form.get("returnTab"));
  if (tab === "upcoming") return "/life-admin?tab=upcoming";
  if (tab === "add") return ADD_TAB_HREF;
  const strings = (name: string) => form.getAll(name).filter((value): value is string => typeof value === "string");
  const categories = allParams(strings("returnCategory")).filter((value) => CATEGORY_ID.test(value));
  const statuses = allParams(strings("returnStatus")).filter(isListStatus);
  if (tab === "history") {
    const page = pageNumber(strings("returnPage")[0]);
    return historyHref({ categories, statuses: HISTORY_STATUSES.filter((status) => statuses.includes(status)), ...(page ? { page } : {}) });
  }
  return recordsHref({ categories, statuses: RECORDS_TAB_STATUSES.filter((status) => statuses.includes(status)) });
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
  const chosen = RECORDS_TAB_STATUSES.filter((status) => statuses.has(status));
  return {
    categories: categoryIds.filter((id) => categories.has(id)),
    statuses: chosen.length ? chosen : [...DEFAULT_LIST_STATUSES],
  };
}

/**
 * History's filters from the address (`?history_category=…&history_status=…`, each repeatable,
 * and `history_page`): the categories the person's catalogue has, in its order, once each;
 * Finished and Cancelled in that order (none ⇒ both); a page number.
 */
export function historyFilters(
  params: { readonly history_category?: string | readonly string[]; readonly history_status?: string | readonly string[]; readonly history_page?: string | readonly string[] },
  categoryIds: readonly string[],
): HistoryFilter {
  const categories = new Set(allParams(params.history_category).filter((value) => CATEGORY_ID.test(value)));
  const statuses = new Set(allParams(params.history_status).filter(isListStatus));
  const page = pageNumber(first(params.history_page));
  return {
    categories: categoryIds.filter((id) => categories.has(id)),
    statuses: HISTORY_STATUSES.filter((status) => statuses.has(status)),
    ...(page ? { page } : {}),
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
  return assignee ? `/life-admin?tab=tasks&assignee=${assignee}` : "/life-admin?tab=tasks";
}

// Empty input disables reminders. Invalid nonempty entries survive as NaN so
// boundary validation refuses the whole change instead of silently losing it.
export function recordOffsets(raw: string): number[] {
  return raw.split(",").map(part => part.trim()).filter(Boolean).map(Number);
}

// The reminder days a form posts: one `reminderOffsets` per ticked box (none ticked ⇒ reminders
// off), or one comma-separated value from a form left open before the boxes.
export function reminderOffsetsFrom(form: FormData): number[] {
  return recordOffsets(form.getAll("reminderOffsets").filter((value): value is string => typeof value === "string").join(","));
}

// ─── the item page ───────────────────────────────────────────────────────────────────

// Where an item-page action lands afterwards: that item's page (a well-formed id only), else
// Life admin.
export function itemPath(id: unknown): string {
  return typeof id === "string" && UUID_RE.test(id) ? `/life-admin/items/${id.toLowerCase()}` : "/life-admin";
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
