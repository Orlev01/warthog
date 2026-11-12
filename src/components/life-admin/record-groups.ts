// How the Life admin record tabs organise a list (the "tidy and organise" pass): records
// are grouped by how soon they fall due — Overdue, Next 30 days, Later, No due date — and
// each row summarises its reminder setting in one plain line.
//
// Pure functions over plain values, shared by the view and its tests. Nothing here reads
// the clock: the page loader works out the person's local date (`today`, YYYY-MM-DD, in
// their account time zone) and passes it in, so a render is the same for the same props.

export type DueGroupKey = "overdue" | "soon" | "later" | "undated";

// "Next 30 days" runs from today through today + DUE_SOON_DAYS, inclusive.
export const DUE_SOON_DAYS = 30;

const GROUP_ORDER: readonly DueGroupKey[] = ["overdue", "soon", "later", "undated"];

export const DUE_GROUP_TITLES: Readonly<Record<DueGroupKey, string>> = {
  overdue: "Overdue",
  soon: `Next ${DUE_SOON_DAYS} days`,
  later: "Later",
  undated: "No due date",
};

// A calendar date `days` after `isoDate` (both YYYY-MM-DD), computed on the calendar in
// UTC so no local offset or daylight-saving change can shift it.
export function addDays(isoDate: string, days: number): string {
  const [year, month, date] = isoDate.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! + days)).toISOString().slice(0, 10);
}

// Which group a due date falls in relative to `today`. ISO dates compare as strings.
export function dueGroupOf(dueDate: string | null, today: string): DueGroupKey {
  if (!dueDate) return "undated";
  const due = dueDate.slice(0, 10);
  if (due < today) return "overdue";
  return due <= addDays(today, DUE_SOON_DAYS) ? "soon" : "later";
}

export type DueGroup<T> = { readonly key: DueGroupKey; readonly title: string; readonly records: T[] };

// The non-empty groups, in the fixed order, each soonest due first. The sort is stable,
// so records sharing a due date keep the loader's (deterministic) order.
export function groupRecordsByDue<T extends { readonly dueDate: string | null }>(
  records: readonly T[],
  today: string,
): DueGroup<T>[] {
  const buckets = new Map<DueGroupKey, T[]>(GROUP_ORDER.map((key) => [key, []]));
  for (const record of records) buckets.get(dueGroupOf(record.dueDate, today))!.push(record);
  return GROUP_ORDER.filter((key) => buckets.get(key)!.length > 0).map((key) => ({
    key,
    title: DUE_GROUP_TITLES[key],
    records: [...buckets.get(key)!].sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "")),
  }));
}

function joinWords(parts: readonly string[]): string {
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

// The name a row leads with: a "name" or "title" field (any case) when there is one, else
// the first filled-in field. `key` says which field it came from (null when none), so the
// row can list the remaining fields without repeating it.
export function recordTitle(fields: Readonly<Record<string, string>>): { title: string; key: string | null } {
  const entries = Object.entries(fields);
  const named = entries.find(([key, value]) => /^(name|title)$/i.test(key) && value.trim() !== "");
  const chosen = named ?? entries.find(([, value]) => value.trim() !== "");
  return chosen ? { title: chosen[1], key: chosen[0] } : { title: "", key: null };
}
