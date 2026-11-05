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
// aggregate the brief exposes — is gated by the caller's own participation in that
// household.

import { randomUUID } from "node:crypto";

import type { Db } from "./index";

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

// Read a single-row COALESCE(SUM(...), 0) result as an exact number (0 when no row
// matched or when the seam returned no rows).
function sumOf(rows: { total?: unknown }[]): number {
  return Number(rows[0]?.total ?? 0);
}

// Record one approved card release for `input.userId`: inserts ONE ledger row with
// the plaintext amount/currency/merchant and the three period keys, and returns the
// StoredRelease carrying the generated id. No DEK — these columns are plaintext
// metadata (design §4.1).
export async function recordRelease(db: Db, input: NewRelease): Promise<StoredRelease> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO card_spend_ledger
       (id, user_id, connection_id, household_id, amount, currency, merchant,
        period_day, period_week, period_month)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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

// The aggregate total across a household's members in the period (household_id
// bound) — the one cross-member number the brief exposes. Gated by the SESSION user
// id: the EXISTS clause returns the total only when `userId` participates in
// `householdId` (has at least one ledger row there); a non-participant gets 0 and
// never another member's merchants or rows — only ever a NUMBER.
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
          SELECT 1 FROM card_spend_ledger mem
           WHERE mem.user_id = $1 AND mem.household_id = $2
        )`,
    [userId, householdId, periodKey],
  );
  return sumOf(result.rows);
}
