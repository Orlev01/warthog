// E03-S06 — Budgets and periods (design §8 step 4: "agent budget for its period").
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.
// Card requests are checked against agent and household budgets in deterministic
// code, so the period arithmetic and the over-budget math live here, pure, built
// before the policy engine consumes them. Time enters ONLY as an injected
// `now: Date` — a plain instant — so the module never reaches across the domain
// boundary into the server's Clock seam; the caller passes `clock.now()` in.
//
// The vocabulary is exactly the brief's: a "budget period" is `day | week | month`
// and the per-agent card budget "defaults to A$200 per month". Windows are
// half-open [start, end) in UTC calendar arithmetic; weeks start on Monday
// (ISO-8601). Money is a plain number in the account-currency major unit
// (200 == A$200). Over-budget is STRICTLY greater than the budget: spending
// exactly up to the cap is allowed, a cent over it is not.

/** The length of a budget period. */
export type PeriodKind = "day" | "week" | "month";

/** A half-open period window [start, end): `end` is the start of the next period. */
export interface PeriodWindow {
  start: Date;
  end: Date;
}

/**
 * The current period window around the injected instant, in UTC calendar
 * arithmetic. Pure and deterministic; never mutates `now`.
 */
export function periodWindow(kind: PeriodKind, now: Date): PeriodWindow {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const date = now.getUTCDate();

  switch (kind) {
    case "day":
      return {
        start: new Date(Date.UTC(year, month, date)),
        end: new Date(Date.UTC(year, month, date + 1)),
      };
    case "week": {
      // getUTCDay(): Sunday = 0 … Saturday = 6. Monday-start means Monday = 0.
      const daysFromMonday = (now.getUTCDay() + 6) % 7;
      return {
        start: new Date(Date.UTC(year, month, date - daysFromMonday)),
        end: new Date(Date.UTC(year, month, date - daysFromMonday + 7)),
      };
    }
    case "month":
      return {
        start: new Date(Date.UTC(year, month, 1)),
        end: new Date(Date.UTC(year, month + 1, 1)),
      };
  }
}

/** A budget: a cap amount over a period. */
export interface Budget {
  amount: number;
  period: PeriodKind;
}

/** The fallback card budget: A$200 per month (the brief's default). */
export const DEFAULT_CARD_BUDGET: Budget = { amount: 200, period: "month" };

/**
 * Card access requires a non-zero budget (brief: "card access cannot be switched
 * on without a budget"). A positive amount allows it; zero or negative does not.
 */
export function budgetAllowsCard(budget: Budget): boolean {
  return budget.amount > 0;
}

/** One approved release of a card or high-tier value. */
export interface Release {
  amount: number;
  at: Date;
}

/** The outcome of evaluating a budget: what was spent, and whether it is over. */
export interface BudgetResult {
  spent: number;
  overBudget: boolean;
  window: PeriodWindow;
}

/**
 * Sum the approved releases that fall inside the current period window (that is
 * `spent`), then flag over-budget when `spent + proposed` would exceed
 * `budget.amount`. With `proposed = 0` this is the plain "do the approved
 * releases already exceed the budget?" check; with `proposed > 0` it is the
 * card-request check (does approving this amount push the period over budget?).
 */
export function evaluateBudget(
  budget: Budget,
  releases: readonly Release[],
  proposed: number,
  now: Date,
): BudgetResult {
  const window = periodWindow(budget.period, now);
  const start = window.start.getTime();
  const end = window.end.getTime();

  let spent = 0;
  for (const release of releases) {
    const at = release.at.getTime();
    if (at >= start && at < end) {
      spent += release.amount;
    }
  }

  return {
    spent,
    overBudget: spent + proposed > budget.amount,
    window,
  };
}
