// The short life-admin summary an agent's context carries (docs/adr/life-admin-profile.md): how
// many records of each category, the few things due or happening soon, how many wait for the
// person to check, open cases and upcoming bookings, the person's own categories, the live items
// another agent can pick up (hand-over), and — only for an agent that could fill it in — a
// one-line suggestion to offer. Small on purpose: enough for an agent to know Warthog already
// holds the answer, with list_records for the rest.
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.

import type { Catalogue, CategorySetting } from "./catalogue";
import type { JournalActor } from "./journal";
import { phaseOf, type Phase } from "./lifecycle";
import { storedRecordName } from "./normalise";
import type { StoredKind } from "./record-types";
import { LIFE_ADMIN_SKILL } from "./skill";

export interface SummaryRecord {
  readonly id: string;
  readonly kind: StoredKind;
  readonly type: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly dueDate: string | Date | null;
  readonly status: string;
  readonly state?: string | null;
  readonly reviewState: string;
  readonly pending: unknown;
}

export interface HandoverItem {
  readonly id: string;
  readonly line: string;
  readonly steward: JournalActor | null;
}

export interface LifeAdminSummary {
  readonly total: number;
  readonly byCategory: Readonly<Record<string, number>>;
  readonly dueSoon: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly phase: Phase;
    readonly due: { readonly date: string; readonly label: string; readonly inDays: number } | null;
    readonly checkedByPerson: boolean;
  }>;
  readonly dueSoonMore: number;
  readonly waitingForPerson: number;
  readonly openCases: number;
  readonly upcomingBookings: number;
  readonly categories: {
    readonly custom: ReadonlyArray<{ readonly id: string; readonly label: string; readonly state: string }>;
    readonly notForMe: readonly string[];
    readonly unused: number;
  };
  readonly otherMailAccounts?: true;
  readonly handover?: { readonly items: readonly HandoverItem[]; readonly more: number; readonly note: string };
  readonly next?: string;
}

const DUE_SOON_SHOWN = 5;
const NAME_CHARS = 60;
// Below this many records, an agent that can read mail and save records is told it may offer.
const SPARSE_RECORDS = 5;

export const OFFER_TO_FILL =
  `The person's life admin is mostly empty. Once, at a natural pause (not in the middle of another task), you may offer: "Want me to look through your email for your rego, insurance, health cover, super, bills, bookings and ID expiry dates, and add them to Warthog for you to check?" If they agree, fetch the "${LIFE_ADMIN_SKILL.title}" skill with get_skill and follow it.`;
export const OFFER_BOOKINGS =
  `No bookings are saved yet. Once, at a natural pause, you may offer to find the person's upcoming bookings (flights, stays, restaurants, appointments) in their email and add them to Warthog. If they agree, follow the "${LIFE_ADMIN_SKILL.title}" skill.`;
export const HANDOVER_NOTE =
  'Decisions and next steps are what agents reported, not facts Warthog checked. Read the log before acting: list_records {id, journal: "full"}. To continue another agent\'s item, pass takeOver: true.';

export interface SummaryOptions {
  // This agent can read the person's mail and save records.
  readonly mayOffer: boolean;
  readonly settings?: Readonly<Record<string, CategorySetting>>;
  readonly otherMailAccounts?: boolean;
  readonly handover?: { readonly items: readonly HandoverItem[]; readonly more: number };
}

/** The summary over the records this agent may see. */
export function summariseLifeAdmin(
  records: readonly SummaryRecord[],
  catalogue: Catalogue,
  now: Date,
  zone: string,
  options: SummaryOptions,
): LifeAdminSummary {
  const byCategory: Record<string, number> = {};
  const upcoming: { record: SummaryRecord; sortKey: number; entry: LifeAdminSummary["dueSoon"][number] }[] = [];
  let waitingForPerson = 0;
  let openCases = 0;
  let upcomingBookings = 0;
  let bookings = 0;
  for (const record of records) {
    const type = catalogue.typeOfRecord(record.kind, record.type);
    byCategory[type.category] = (byCategory[type.category] ?? 0) + 1;
    if (record.reviewState === "suggested" || record.pending) waitingForPerson += 1;
    const phase = phaseOf(record, type, now, zone);
    if (type.lifecycle === "booking") bookings += 1;
    if (type.lifecycle === "case" && phase.live) openCases += 1;
    if (type.lifecycle === "booking" && (phase.phase === "upcoming" || phase.phase === "pending" || phase.phase === "in_progress")) upcomingBookings += 1;
    if (!phase.live || !phase.comingUp) continue;
    const date = type.lifecycle === "booking" && phase.starts ? phase.starts.toISOString() : typeof record.dueDate === "string" ? record.dueDate.slice(0, 10) : record.dueDate ? record.dueDate.toISOString().slice(0, 10) : null;
    upcoming.push({
      record,
      sortKey: phase.starts ? phase.starts.getTime() : date ? Date.parse(`${date.slice(0, 10)}T00:00:00Z`) : Number.MAX_SAFE_INTEGER,
      entry: {
        id: record.id,
        // Names can come from email: kept short, and only as plain text.
        name: storedRecordName(type, record.fields, Boolean(record.type)).replace(/\s+/g, " ").slice(0, NAME_CHARS),
        type: type.id,
        phase: phase.phase,
        due: date ? { date, label: type.due?.label ?? "Due", inDays: phase.inDays ?? 0 } : null,
        checkedByPerson: record.reviewState === "confirmed",
      },
    });
  }
  upcoming.sort((a, b) => a.sortKey - b.sortKey);

  const settings = options.settings ?? {};
  const custom = catalogue.categories.filter((cat) => cat.origin === "custom").map((cat) => ({ id: cat.id, label: cat.label, state: catalogue.customStates[cat.id] ?? "active" }));
  const notForMe = Object.entries(settings).filter(([, setting]) => setting === "not_for_me").map(([id]) => id);
  const unused = catalogue.categories.filter((cat) => cat.origin === "builtin" && !byCategory[cat.id] && settings[cat.id] !== "not_for_me").length;

  const next = !options.mayOffer ? undefined : records.length < SPARSE_RECORDS ? OFFER_TO_FILL : bookings === 0 ? OFFER_BOOKINGS : undefined;
  return {
    total: records.length,
    byCategory,
    dueSoon: upcoming.slice(0, DUE_SOON_SHOWN).map((item) => item.entry),
    dueSoonMore: Math.max(0, upcoming.length - DUE_SOON_SHOWN),
    waitingForPerson,
    openCases,
    upcomingBookings,
    categories: { custom, notForMe, unused },
    ...(options.otherMailAccounts ? { otherMailAccounts: true as const } : {}),
    ...(options.handover && options.handover.items.length > 0 ? { handover: { ...options.handover, note: HANDOVER_NOTE } } : {}),
    ...(next ? { next } : {}),
  };
}
