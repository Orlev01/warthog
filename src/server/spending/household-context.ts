// E15-S07 — Household + currency card-request context resolver (brief "Currency" +
// "Household sharing"; design §8 step 4). For a card-request call this resolves, for
// the connection's OWNING user, the member's account currency, the request amount
// converted into the household currency via the latest daily reference rate (deniable
// when no rate exists), their per-member monthly limit and the shared household monthly
// budget — each in the household currency and each with spend-to-date for the current
// month. The pure policy engine (E03-S13) already CONSUMES a household policy and a
// reference rate from its context (`CardPolicy.household`, `ctx.rate`); this resolver
// SUPPLIES them so the policy-context loader can hand the engine a ready context.
//
// This is a SERVER module composing its data access over the injected `Db` seam and the
// current instant over the injected `Clock` seam. Shared monthly budgets use UTC;
// personal agent periods still follow the person's own time zone. Every figure it reads — budgets,
// limits, an ISO 4217 code, a daily reference scalar — is PLAINTEXT METADATA (design
// §4.1), so it holds no key and reads no `process.env` (INV-103): configuration flows in
// as injected seams alone. Every member-scoped read is scoped by the `userId` the caller
// passes — the session/connection's id, never a client value (INV-102) — and each
// underlying store binds its ids and values as parameters, so a value shaped like SQL
// travels as data and cannot alter a query.

import { getAccountCurrency } from "../db/account-currency";
import { periodKeyFor } from "../db/card-spend-ledger";
import { readHouseholdSpending } from "./household-read";
import { getRate } from "../db/exchange-rates";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import { convert } from "../../domain/currency/convert";

// The card request being evaluated: a major-unit amount in the ISO 4217 code the agent
// asked in.
export interface CardRequest {
  readonly amount: number;
  readonly currency: string;
}

// The injected seams — no process.env. `timeZone` is kept for the surrounding
// personal-budget composition; the household and member limits use a shared UTC
// month, independently of that preference.
export interface CardRequestContextDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly timeZone?: string;
}

// Present only when a FOREIGN amount was converted via a reference rate: the converted
// amount in the target (household/account) currency, the rate used and the date it
// applies to (the approval shows both amounts and this date).
export interface ConvertedAmount {
  readonly amount: number;
  readonly currency: string;
  readonly rate: number;
  readonly rateDate: string;
}

// The household spending context — null when the member has no household.
export interface HouseholdSpendingContext {
  readonly periodUnavailable?: boolean;
  readonly householdId: string;
  readonly currency: string;
  readonly monthlyBudget: number | null;
  readonly budgetSpendToDate: number;
  readonly memberLimit: number | null;
  readonly memberSpendToDate: number;
  readonly totalsUnavailable?: boolean;
}

// The resolved card-request context the pipeline maps onto the pure engine's context.
export interface CardRequestContext {
  readonly accountCurrency: string;
  readonly targetCurrency: string;
  readonly converted: ConvertedAmount | null;
  readonly deniable: boolean;
  readonly reason: string | null;
  readonly household: HouseholdSpendingContext | null;
}

// Resolve the card-request context for `userId`: their account currency, their household
// (if any) with its currency / monthly budget / this member's monthly limit and the
// household + member spend so far this month, and the request amount converted into the
// target currency via the latest daily reference rate on or before today. A foreign
// request with no usable rate is marked `deniable` with a plain reason. Every read is
// member-scoped by `userId` (bound as a parameter).
export async function resolveCardRequestContext(
  userId: string,
  request: CardRequest,
  deps: CardRequestContextDeps,
): Promise<CardRequestContext> {
  const { db, clock } = deps;
  const now = clock.now();

  const accountCurrency = await getAccountCurrency(db, userId);
  const report = await readHouseholdSpending(userId, deps);

  // The limit and the budget are checked in the household currency when in a household,
  // otherwise in the member's own account currency.
  const targetCurrency = report ? report.currency : accountCurrency;

  let household: HouseholdSpendingContext | null = null;
  if (report) {
    const me = report.members.find((member) => member.userId === userId);
    const unavailable = (report.monthlyBudget !== null && report.unconverted.length > 0)
      || (me?.monthlyLimit != null && me.unconverted.length > 0);
    const periodUnavailable = (report.monthlyBudget !== null && report.periodIncomplete)
      || (me?.monthlyLimit != null && me.periodIncomplete);
    household = {
      householdId: report.householdId,
      currency: report.currency,
      monthlyBudget: report.monthlyBudget,
      budgetSpendToDate: report.budgetSpendToDate,
      memberLimit: me?.monthlyLimit ?? null,
      memberSpendToDate: me?.spendToDate ?? 0,
      ...(unavailable ? { totalsUnavailable: true } : {}),
      ...(periodUnavailable ? { periodUnavailable: true } : {}),
    };
  }

  // Convert the request into the target currency when they differ, via the latest daily
  // reference rate on or before today. A missing or unusable rate refuses with a plain
  // reason (reusing the domain's conversion result), so the engine denies rather than
  // guessing.
  let converted: ConvertedAmount | null = null;
  let deniable = household?.totalsUnavailable === true || household?.periodUnavailable === true;
  let reason: string | null = household?.periodUnavailable
    ? "Earlier household release dates need checking before this budget can be confirmed."
    : deniable ? "A reference rate is missing for earlier household spending. The budget cannot be checked yet." : null;

  if (request.currency !== targetCurrency) {
    const lookup = await getRate(db, {
      on: periodKeyFor("day", now),
      baseCurrency: request.currency,
      quoteCurrency: targetCurrency,
    });
    const rate = lookup.found
      ? { from: request.currency, to: targetCurrency, rate: lookup.rate, date: lookup.rateDate }
      : null;
    const result = convert(request.amount, rate);
    if (result.ok) {
      converted = {
        amount: result.converted.amount,
        currency: result.converted.currency,
        rate: result.rate,
        rateDate: result.rateDate,
      };
    } else {
      deniable = true;
      reason = result.reason;
    }
  }

  return { accountCurrency, targetCurrency, converted, deniable, reason, household };
}
