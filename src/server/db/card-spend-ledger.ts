// The card spend ledger's data access (design §8 policy step 4 "card requests",
// §4.1, brief "Card requests" + "Spending view"). On an approved card release
// Warthog records the approved amount, currency and merchant against the
// connection's budget; the Spending page and the policy engine's budget checks
// (§8 step 4) read approved-release TOTALS for the current period — per connection
// (an agent's budget), per member (the member's own limit) and per household (the
// shared household budget).
//
// The amount, currency and merchant are PLAINTEXT METADATA (design §4.1: explicitly
// allowed plaintext for budgets) — needed to sum spend — so, unlike vault values,
// held-request args or rule conditions, they are NOT DEK-encrypted and this store
// holds no key and reads no `process.env` (INV-103): config flows from
// `src/server/config.ts` alone.
//
// Every statement is parameterized through the `Db` seam (INV-102): the ids, the
// amount and the period keys travel as BOUND values, never concatenated into the
// SQL text, so a value shaped like SQL is stored as data and cannot alter the
// query. The one piece of the statement chosen in code — WHICH period column to
// filter — comes from a fixed whitelist keyed by the `PeriodKind` enum, never from
// caller text. Every read is member-scoped by the `userId` the caller passes (the
// session's id, never a client value); the household total — the one cross-member
// aggregate the brief exposes — is gated by the caller's MEMBERSHIP of that household
// (the household_members store, E15-S04).

import { randomUUID } from "node:crypto";

import type { Db, Row } from "./index";

// The brief's budget periods: a release falls in one bucket per granularity.
export type PeriodKind = "day" | "week" | "month";

// The period bucket a release falls in, one opaque key per granularity (chosen by
// the caller, e.g. "2026-11-05" / "2026-W45" / "2026-11"). The store matches them
// verbatim — it does no date math.
export interface PeriodKeys {
  readonly day: string;
  readonly week: string;
  readonly month: string;
}

// What recordRelease writes: the member (the session's id, never a client value)
// and the release's plaintext metadata plus the three period buckets it falls in.
export interface NewRelease {
  readonly userId: string;
  readonly connectionId: string;
  readonly householdId: string | null;
  readonly amount: number;
  readonly currency: string;
  readonly merchant: string;
  readonly periodKeys: PeriodKeys;
  // The approval this release came from. An approval counts at most once: a second
  // row for the same approval is refused by the store (a unique index).
  readonly approvalId?: string;
}

// A release as handed back to callers: its generated id on top of its content. The
// id is generated UP FRONT (not via RETURNING), so the returned id never depends on
// a db round-trip.
export interface StoredRelease extends NewRelease {
  readonly id: string;
}

// Which period column a sum filters on, selected from the PeriodKind enum — never
// from caller text — so an injected value can never become part of the statement.
const PERIOD_COLUMN: Record<PeriodKind, "period_day" | "period_week" | "period_month"> = {
  day: "period_day",
  week: "period_week",
  month: "period_month",
};

function periodColumn(period: PeriodKind): string {
  const column = PERIOD_COLUMN[period];
  if (!column) throw new Error(`card-spend-ledger: unknown period "${period}"`);
  return column;
}

// Pad a number to two digits for a calendar key ("1" -> "01").
function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// The opaque period-bucket key this ledger stores (design §8 / E07-S07), derived
// from the instant in UTC calendar arithmetic: the day bucket "YYYY-MM-DD", the
// month bucket "YYYY-MM", and the week bucket "YYYY-Www" (ISO-8601, weeks start
// Monday — the same convention the budget domain's period windows use). The
// `period` selects which granularity. The ONE source of truth for the ledger's
// bucket keys: the policy-context loader and the spending read both derive their
// current-period key through here, so a writer and a reader can never drift.
export function periodKeyFor(period: PeriodKind, now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const date = now.getUTCDate();

  if (period === "month") {
    return `${year}-${pad2(month + 1)}`;
  }
  if (period === "day") {
    return `${year}-${pad2(month + 1)}-${pad2(date)}`;
  }
  // week: the ISO week number, decided by the Thursday of the current week.
  const thursday = new Date(Date.UTC(year, month, date));
  const dayFromMonday = (thursday.getUTCDay() + 6) % 7; // Monday = 0 … Sunday = 6
  thursday.setUTCDate(thursday.getUTCDate() - dayFromMonday + 3);
  const isoYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstFromMonday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstFromMonday + 3);
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / weekMs);
  return `${isoYear}-W${pad2(week)}`;
}

// Map a raw ledger row back to a StoredRelease. `amount` is a `numeric` column, so
// the driver hands it back as a number or a string; normalise to a number (the same
// coercion the SUM reads use), currency/merchant/period keys are plain text.
function toStoredRelease(row: Row): StoredRelease {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    connectionId: String(row.connection_id),
    householdId: row.household_id == null ? null : String(row.household_id),
    amount: Number(row.amount),
    currency: String(row.currency),
    merchant: String(row.merchant),
    periodKeys: {
      day: String(row.period_day),
      week: String(row.period_week),
      month: String(row.period_month),
    },
  };
}

// Read a single-row COALESCE(SUM(...), 0) result as an exact number (0 when no row
// matched or when the seam returned no rows).
function sumOf(rows: { total?: unknown }[]): number {
  return Number(rows[0]?.total ?? 0);
}

// Record one approved card release for `input.userId`: inserts ONE ledger row with
// the plaintext amount/currency/merchant, the three period keys and the approval it
// came from, and returns the StoredRelease carrying the generated id. No DEK — these
// columns are plaintext metadata (design §4.1). Throws when the approval has already
// been recorded (an approval counts against a budget at most once).
export async function recordRelease(db: Db, input: NewRelease): Promise<StoredRelease> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO card_spend_ledger
       (id, user_id, connection_id, household_id, amount, currency, merchant,
        period_day, period_week, period_month, approval_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      input.userId,
      input.connectionId,
      input.householdId,
      input.amount,
      input.currency,
      input.merchant,
      input.periodKeys.day,
      input.periodKeys.week,
      input.periodKeys.month,
      input.approvalId ?? null,
    ],
  );
  return { id, ...input };
}

// The total approved amount for THAT connection owned by `userId`, in the bucket
// `period`/`periodKey`. Member-scoped (user_id AND connection_id both bound) — so a
// connection belonging to another user sums to 0. Returns 0 when no row matches.
export async function sumForConnectionPeriod(
  db: Db,
  userId: string,
  connectionId: string,
  period: PeriodKind,
  periodKey: string,
): Promise<number> {
  const result = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
       FROM card_spend_ledger
      WHERE user_id = $1 AND connection_id = $2 AND ${periodColumn(period)} = $3`,
    [userId, connectionId, periodKey],
  );
  return sumOf(result.rows);
}

// Every approved release for THAT connection owned by `userId` in the bucket
// `period`/`periodKey` — the per-release detail the spending view lists (parallel
// to `sumForConnectionPeriod`, which totals the same rows). Member-scoped (user_id
// AND connection_id both bound), so another user's connection returns no rows; the
// period key is bound and WHICH column is matched comes from the `PeriodKind`
// whitelist, never caller text, so a value shaped like SQL is stored as data and
// cannot alter the query. Returns an empty array when none match.
export async function listReleasesForConnectionPeriod(
  db: Db,
  userId: string,
  connectionId: string,
  period: PeriodKind,
  periodKey: string,
): Promise<StoredRelease[]> {
  const result = await db.query(
    `SELECT id, user_id, connection_id, household_id, amount, currency, merchant,
            period_day, period_week, period_month
       FROM card_spend_ledger
      WHERE user_id = $1 AND connection_id = $2 AND ${periodColumn(period)} = $3`,
    [userId, connectionId, periodKey],
  );
  return result.rows.map(toStoredRelease);
}

// The member's OWN total across ALL their connections in the period (user_id
// bound). Returns 0 when no row matches.
export async function sumForMemberPeriod(
  db: Db,
  userId: string,
  period: PeriodKind,
  periodKey: string,
): Promise<number> {
  const result = await db.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
       FROM card_spend_ledger
      WHERE user_id = $1 AND ${periodColumn(period)} = $2`,
    [userId, periodKey],
  );
  return sumOf(result.rows);
}

// One (member, currency) sub-total within a household's period: the member the
// releases belong to, the ISO 4217 code they were released in, and the approved
// total in that currency. A NUMBER per currency per member — never a merchant, a
// release id or any other row content.
export interface MemberCurrencyTotal {
  readonly userId: string;
  readonly currency: string;
  readonly total: number;
}

// Every member's approved spend this period against the household budget, broken
// down by the currency each release was made in (household_id bound), so the caller
// can convert each currency into the household currency and sum. Gated by the SESSION
// user id exactly as `sumForHouseholdPeriod`: the EXISTS clause yields rows only when
// `userId` is a MEMBER of `householdId` (household_members store, E15-S04), so a
// non-member reads nothing and never another member's rows. Grouped per (user, currency)
// and returning ONLY the summed amount, it exposes totals alone — no merchant, no
// release id, no other personal content. The period key is bound and WHICH column is
// matched comes from the `PeriodKind` whitelist, never caller text.
export async function sumByMemberCurrencyForHouseholdPeriod(
  db: Db,
  userId: string,
  householdId: string,
  period: PeriodKind,
  periodKey: string,
): Promise<MemberCurrencyTotal[]> {
  const result = await db.query(
    `SELECT led.user_id, led.currency, COALESCE(SUM(led.amount), 0) AS total
       FROM card_spend_ledger led
      WHERE led.household_id = $2 AND led.${periodColumn(period)} = $3
        AND EXISTS (
          SELECT 1 FROM household_members mem
           WHERE mem.user_id = $1 AND mem.household_id = $2
        )
      GROUP BY led.user_id, led.currency`,
    [userId, householdId, periodKey],
  );
  return result.rows.map((row) => ({
    userId: String(row.user_id),
    currency: String(row.currency),
    total: Number(row.total),
  }));
}

// The aggregate total across a household's members in the period (household_id
// bound) — the one cross-member number the brief exposes. Gated by the SESSION user
// id: the EXISTS clause returns the total only when `userId` is a MEMBER of
// `householdId` in the household_members store (E15-S04) — NOT merely when they have a
// ledger row there, so a member with no spend of their own still reads the household
// total; a non-member gets 0 and never another member's merchants or rows — only ever
// a NUMBER.
export async function sumForHouseholdPeriod(
  db: Db,
  userId: string,
  householdId: string,
  period: PeriodKind,
  periodKey: string,
): Promise<number> {
  const result = await db.query(
    `SELECT COALESCE(SUM(led.amount), 0) AS total
       FROM card_spend_ledger led
      WHERE led.household_id = $2 AND led.${periodColumn(period)} = $3
        AND EXISTS (
          SELECT 1 FROM household_members mem
           WHERE mem.user_id = $1 AND mem.household_id = $2
        )`,
    [userId, householdId, periodKey],
  );
  return sumOf(result.rows);
}
