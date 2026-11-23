// How Life admin organises a person's records (the "tidy and organise" pass, reshaped for
// typed records): what is coming up, the records by category with the things other records
// belong to as headers, and each row's reminder setting in one plain line.
//
// Pure functions over plain values, shared by the view and its tests. Nothing here reads
// the clock: the page loader works out the person's local date (`today`, YYYY-MM-DD, in
// their account time zone) and passes it in, so a render is the same for the same props.

import { CATEGORIES, typeOfRecord, type CategoryDef, type RecordTypeDef, type StoredKind } from "@/domain/life-admin/record-types";

// A calendar date `days` after `isoDate` (both YYYY-MM-DD), computed on the calendar in
// UTC so no local offset or daylight-saving change can shift it.
export function addDays(isoDate: string, days: number): string {
  const [year, month, date] = isoDate.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! + days)).toISOString().slice(0, 10);
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

// ─── "Your things": coming up, and one section per category ─────────────────────────────
//
// Typed records (docs/adr/life-admin-profile.md) are shown by category, in the catalogue's
// order, with the things other records belong to (a vehicle, a home, a pet) as headers over
// their records. "Coming up" lists what is overdue or due in the next COMING_UP_DAYS days.

// "Coming up" runs from anything overdue through today + COMING_UP_DAYS, inclusive.
export const COMING_UP_DAYS = 60;

// Statuses that mean the record needs nothing more (reminders stop for these too).
const SETTLED_STATUSES = new Set(["cancelled", "canceled", "done", "expired", "paused", "ended"]);

/** Whether a record still needs attention: not cancelled, done, expired or paused. */
export function isLive(status: string): boolean {
  return !SETTLED_STATUSES.has(status.trim().toLowerCase());
}

type TypedLike = { readonly kind: StoredKind; readonly type?: string | null };

function typeOf(record: TypedLike): RecordTypeDef {
  return typeOfRecord(record.kind, record.type ?? null);
}

export type ComingUpItem<T> = { readonly record: T; readonly type: RecordTypeDef; readonly overdue: boolean };

/**
 * The live records that are overdue or due within COMING_UP_DAYS of `today`, soonest first.
 * A return-by date that has passed is left out: the window is over, there is nothing to do.
 */
export function comingUp<T extends TypedLike & { readonly dueDate: string | null; readonly status: string }>(
  records: readonly T[],
  today: string,
  days: number = COMING_UP_DAYS,
): ComingUpItem<T>[] {
  const last = addDays(today, days);
  const items: ComingUpItem<T>[] = [];
  for (const record of records) {
    if (!record.dueDate || !isLive(record.status)) continue;
    const due = record.dueDate.slice(0, 10);
    const type = typeOf(record);
    const overdue = due < today;
    if (due > last || (overdue && type.due?.means === "return_by")) continue;
    items.push({ record, type, overdue });
  }
  return items.sort((a, b) => a.record.dueDate!.slice(0, 10).localeCompare(b.record.dueDate!.slice(0, 10)));
}

export type AssetGroup<T> = { readonly asset: T; readonly type: RecordTypeDef; readonly children: T[] };

export type CategorySection<T> = {
  readonly category: CategoryDef;
  // The vehicles, homes or pets in this category, each with the records that belong to it.
  readonly assets: AssetGroup<T>[];
  // This category's records that belong to no asset shown here.
  readonly loose: T[];
};

/**
 * The person's records by category, in the catalogue's order: each asset with its records
 * (whatever their category: an electricity account sits under the home it belongs to), then
 * the category's unlinked records. `empty` lists the categories with no records at all.
 * Records keep the loader's order (soonest due first).
 */
export function organiseByCategory<T extends TypedLike & { readonly id: string; readonly parentId?: string | null }>(
  records: readonly T[],
): { sections: CategorySection<T>[]; empty: CategoryDef[] } {
  const types = new Map<string, RecordTypeDef>(records.map((record) => [record.id, typeOf(record)]));
  const assetIds = new Set(records.filter((record) => types.get(record.id)!.asset).map((record) => record.id));
  const parentOf = (record: T): string | null =>
    record.parentId && record.parentId !== record.id && assetIds.has(record.parentId) ? record.parentId : null;

  const sections: CategorySection<T>[] = [];
  const empty: CategoryDef[] = [];
  for (const category of CATEGORIES) {
    const inCategory = records.filter((record) => types.get(record.id)!.category === category.id);
    if (inCategory.length === 0) {
      empty.push(category);
      continue;
    }
    const assets = inCategory
      .filter((record) => assetIds.has(record.id))
      .map((asset) => ({ asset, type: types.get(asset.id)!, children: records.filter((record) => parentOf(record) === asset.id) }));
    const loose = inCategory.filter((record) => !assetIds.has(record.id) && parentOf(record) === null);
    if (assets.length > 0 || loose.length > 0) sections.push({ category, assets, loose });
  }
  return { sections, empty };
}
