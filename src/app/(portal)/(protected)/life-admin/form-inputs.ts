import { isTimeZone } from "@/domain/life-admin/lifecycle";
import { canonicalDateTime, calendarDate } from "@/domain/life-admin/normalise";

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

// The records view's tab (`?tab=`): Your things, Upcoming, Bookings or the moving checklist.
// The tabs Life admin had before typed records (subscriptions, receipts, renewals) — still
// named in reminder links people already have — and anything else open "Your things".
export type RecordTab = "things" | "upcoming" | "bookings" | "checklist";
const RECORD_TABS: readonly RecordTab[] = ["things", "upcoming", "bookings", "checklist"];
export function recordTab(value: unknown): RecordTab {
  return typeof value === "string" && (RECORD_TABS as readonly string[]).includes(value) ? (value as RecordTab) : "things";
}

export function recordReturnPath(form: FormData): string {
  return `/life-admin?view=life&tab=${recordTab(form.get("returnTab"))}`;
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
  return typeof id === "string" && UUID_RE.test(id) ? `/life-admin/items/${id.toLowerCase()}` : "/life-admin?view=life&tab=things";
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

// The Bookings tab's GET filters, each kept only when well formed (a category id or slug, a
// short "for whom" label, a booking phase, a page number); the view matches them against
// what the person actually has.
export function bookingFilters(params: Readonly<Record<string, string | undefined>>): {
  category?: string;
  forWhom?: string;
  state?: string;
  page?: number;
} {
  const category = params.category && /^[a-z0-9_]{1,40}$/.test(params.category) ? params.category : undefined;
  const forWhom = params.for_whom && params.for_whom.trim().length > 0 && params.for_whom.length <= 60 ? params.for_whom.trim() : undefined;
  const state = params.state && (BOOKING_STATES as readonly string[]).includes(params.state) ? params.state : undefined;
  const page = params.page && /^\d{1,4}$/.test(params.page) && Number(params.page) >= 1 ? Number(params.page) : undefined;
  return { ...(category ? { category } : {}), ...(forWhom ? { forWhom } : {}), ...(state ? { state } : {}), ...(page ? { page } : {}) };
}
