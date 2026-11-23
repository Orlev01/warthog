// The short life-admin summary an agent's context carries (docs/adr/life-admin-profile.md):
// how many records of each category there are, the few things due soon, how many wait for the
// person to check, and — only for an agent that could fill it in — a one-line suggestion to
// offer. Small on purpose (a few hundred tokens at most): enough for an agent to know Warthog
// already holds the answer and to say what needs attention, with list_records for the rest.
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.

import { storedRecordName } from "./normalise";
import { typeOfRecord, type StoredKind } from "./record-types";
import { LIFE_ADMIN_SKILL } from "./skill";

export interface SummaryRecord {
  readonly id: string;
  readonly kind: StoredKind;
  readonly type: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly dueDate: string | Date | null;
  readonly status: string;
  readonly reviewState: string;
  readonly pending: unknown;
}

export interface LifeAdminSummary {
  readonly total: number;
  readonly byCategory: Readonly<Record<string, number>>;
  readonly dueSoon: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly due: { readonly date: string; readonly label: string; readonly inDays: number };
    readonly checkedByPerson: boolean;
  }>;
  readonly dueSoonMore: number;
  readonly waitingForPerson: number;
  readonly next?: string;
}

export const DUE_SOON_DAYS = 60;
const OVERDUE_DAYS = 30;
const DUE_SOON_SHOWN = 5;
const NAME_CHARS = 60;
// Below this many records, an agent that can read mail and save records is told it may offer.
const SPARSE_RECORDS = 5;
const ENDED = new Set(["cancelled", "canceled", "done", "expired", "ended", "paused"]);

export const OFFER_TO_FILL =
  `The person's life admin is mostly empty. Once, at a natural pause (not in the middle of another task), you may offer: "Want me to look through your email for your rego, insurance, health cover, super, bills and ID expiry dates, and add them to Warthog for you to check?" If they agree, fetch the "${LIFE_ADMIN_SKILL.title}" skill with get_skill and follow it.`;

function dateOnly(value: string | Date | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The summary over the records this agent may see. `today` is the person's local date;
 * `mayOffer` is true when this agent can both read the person's mail and save records.
 */
export function summariseLifeAdmin(records: readonly SummaryRecord[], today: string, mayOffer: boolean): LifeAdminSummary {
  const byCategory: Record<string, number> = {};
  const upcoming: { record: SummaryRecord; date: string; inDays: number }[] = [];
  let waitingForPerson = 0;
  for (const record of records) {
    const type = typeOfRecord(record.kind, record.type);
    byCategory[type.category] = (byCategory[type.category] ?? 0) + 1;
    if (record.reviewState === "suggested" || record.pending) waitingForPerson += 1;
    const date = dateOnly(record.dueDate);
    if (!date || ENDED.has(record.status.toLowerCase())) continue;
    const inDays = daysBetween(today, date);
    if (inDays <= DUE_SOON_DAYS && inDays >= -OVERDUE_DAYS) upcoming.push({ record, date, inDays });
  }
  upcoming.sort((a, b) => a.inDays - b.inDays);
  return {
    total: records.length,
    byCategory,
    dueSoon: upcoming.slice(0, DUE_SOON_SHOWN).map(({ record, date, inDays }) => {
      const type = typeOfRecord(record.kind, record.type);
      return {
        id: record.id,
        // Names can come from email: kept short, and only as plain text.
        name: storedRecordName(record.kind, record.type, record.fields).replace(/\s+/g, " ").slice(0, NAME_CHARS),
        type: type.id,
        due: { date, label: type.due?.label ?? "Due", inDays },
        checkedByPerson: record.reviewState === "confirmed",
      };
    }),
    dueSoonMore: Math.max(0, upcoming.length - DUE_SOON_SHOWN),
    waitingForPerson,
    ...(mayOffer && records.length < SPARSE_RECORDS ? { next: OFFER_TO_FILL } : {}),
  };
}
