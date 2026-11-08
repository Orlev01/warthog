// E15-S09 — Household spending totals read (brief "Spending view" + "Household
// sharing"; design §8 step 4). Within a household both the owner and members see
// ONLY each member's total approved spend this period against that member's monthly
// limit and the household total against the shared household budget — never each
// other's merchants or individual release entries. Every figure is expressed in the
// household currency: a release made in another currency is converted via the latest
// daily reference rate on or before today, a same-currency release counts at face
// value.
//
// It COMPOSES the already-built, tested stores rather than re-running their SQL: the
// caller's household (`getHouseholdForMember`), its member list with each member's
// limit (`listMembers`), each member's per-currency household spend this month
// (`sumByMemberCurrencyForHouseholdPeriod`, gated by the caller's membership) and the
// daily reference rates (`getRate`) fed through the pure `convert` domain.
//
// Member-scoped by the GIVEN `userId` alone (the session's id, never a client value,
// INV-102): the household is resolved FROM that id — no household id is ever accepted
// from the client — and each underlying store binds it as a parameter, so a value
// shaped like SQL travels as data and cannot alter a query. Every figure it reads —
// budgets, limits, an ISO 4217 code, amounts, a daily reference scalar — is PLAINTEXT
// METADATA (design §4.1), so the read holds no key and reads no `process.env`
// (INV-103): the db and the clock are INJECTED seams.

import { getHouseholdForMember, listMembers } from "../db/households";
import { periodKeyFor, sumByMemberCurrencyForHouseholdPeriod } from "../db/card-spend-ledger";
import { getRate } from "../db/exchange-rates";
import { convert, type ReferenceRate } from "../../domain/currency/convert";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";

// An approved amount this month that could NOT be expressed in the household currency,
// because no daily reference rate is on file for its currency: the currency and the
// amount in it. It is shown beside the totals and never counted in them as 0 (review
// fix W4.5: the totals used to understate other-currency spend silently).
export interface UnconvertedSpend {
  readonly currency: string;
  readonly amount: number;
}

// One household member's totals — a limit, a converted total and what could not be
// converted, NOTHING else: no merchant, no release entry/id, no email, no other
// personal content.
export interface HouseholdMemberSpending {
  readonly userId: string;
  readonly monthlyLimit: number | null; // this member's per-member monthly limit (null until set)
  readonly spendToDate: number; // this member's approved spend this month, in the household currency
  readonly unconverted: UnconvertedSpend[]; // this member's spend with no rate into the household currency
}

// The household spending report for a member: the shared budget and the household
// total, plus one totals-only entry per member (incl. the owner). Every amount is in
// the household currency, except the `unconverted` amounts, which are left out of the
// totals and listed in their own currency.
export interface HouseholdSpendingReport {
  readonly householdId: string;
  readonly currency: string; // the household currency every figure is expressed in
  readonly monthlyBudget: number | null; // the shared monthly household budget (null until set)
  readonly budgetSpendToDate: number; // the household total this month, in the household currency
  readonly unconverted: UnconvertedSpend[]; // the household's spend with no rate, per currency
  readonly members: HouseholdMemberSpending[];
}

// Add `amount` in `currency` to a per-currency list (one entry per currency).
function addUnconverted(list: UnconvertedSpend[], currency: string, amount: number): UnconvertedSpend[] {
  const existing = list.find((entry) => entry.currency === currency);
  if (!existing) return [...list, { currency, amount }];
  return list.map((entry) => (entry.currency === currency ? { currency, amount: entry.amount + amount } : entry));
}

// The injected seams — no process.env. `timeZone` is the reader's own IANA zone
// (`./time-zone`, resolved by the caller, which holds their DEK): "this month" is their
// local month, the same bucket the release handler writes in (review fix W4.3). Sydney
// when absent.
export interface HouseholdSpendingDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly timeZone?: string;
}

// The budget period the member limit and the household budget are checked over (the
// brief's shared monthly household budget and per-member monthly limit).
const PERIOD = "month" as const;

// Read the household spending totals for `userId`: resolve their household from that
// id alone (null when they are in none), then each member's converted spend-to-date
// against their monthly limit and the household total against the shared budget — all
// in the household currency, converting an other-currency release via the latest daily
// reference rate on or before today, and flagging (never zeroing) one with no rate.
// TOTALS only — never a merchant or a release entry.
export async function readHouseholdSpending(
  userId: string,
  deps: HouseholdSpendingDeps,
): Promise<HouseholdSpendingReport | null> {
  const { db, clock } = deps;

  const household = await getHouseholdForMember(db, userId);
  if (!household) return null;

  const now = clock.now();
  const monthKey = periodKeyFor(PERIOD, now, deps.timeZone);
  const dayKey = periodKeyFor("day", now);
  const householdCurrency = household.currency;

  const members = await listMembers(db, household.id, userId);
  const subTotals = await sumByMemberCurrencyForHouseholdPeriod(
    db,
    userId,
    household.id,
    PERIOD,
    monthKey,
  );

  // The latest daily rate into the household currency, looked up once per source
  // currency (the quote and the date are fixed for this read) and reused.
  const rates = new Map<string, ReferenceRate | null>();
  async function rateInto(from: string): Promise<ReferenceRate | null> {
    const cached = rates.get(from);
    if (cached !== undefined) return cached;
    const lookup = await getRate(db, {
      on: dayKey,
      baseCurrency: from,
      quoteCurrency: householdCurrency,
    });
    const rate = lookup.found
      ? { from, to: householdCurrency, rate: lookup.rate, date: lookup.rateDate }
      : null;
    rates.set(from, rate);
    return rate;
  }

  // Convert each (member, currency) sub-total into the household currency and
  // accumulate it per member and into the household total. A same-currency amount
  // counts at face value (no rate needed, never dropped for lack of one); an
  // other-currency amount with no usable rate is never a fabricated figure and never
  // a silent 0: it stays out of the totals and is listed, in its own currency, as
  // unconverted — for the member and for the household.
  const perMember = new Map<string, number>();
  const unconvertedPerMember = new Map<string, UnconvertedSpend[]>();
  let budgetSpendToDate = 0;
  let unconverted: UnconvertedSpend[] = [];
  for (const sub of subTotals) {
    let amount: number;
    if (sub.currency === householdCurrency) {
      amount = sub.total;
    } else {
      const result = convert(sub.total, await rateInto(sub.currency));
      if (!result.ok) {
        unconvertedPerMember.set(
          sub.userId,
          addUnconverted(unconvertedPerMember.get(sub.userId) ?? [], sub.currency, sub.total),
        );
        unconverted = addUnconverted(unconverted, sub.currency, sub.total);
        continue;
      }
      amount = result.converted.amount;
    }
    perMember.set(sub.userId, (perMember.get(sub.userId) ?? 0) + amount);
    budgetSpendToDate += amount;
  }

  const memberRows: HouseholdMemberSpending[] = members.map((member) => ({
    userId: member.userId,
    monthlyLimit: member.monthlyLimit,
    spendToDate: perMember.get(member.userId) ?? 0,
    unconverted: unconvertedPerMember.get(member.userId) ?? [],
  }));

  return {
    householdId: household.id,
    currency: household.currency,
    monthlyBudget: household.monthlyBudget,
    budgetSpendToDate,
    unconverted,
    members: memberRows,
  };
}
