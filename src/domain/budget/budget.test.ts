// E03-S06 — Budgets and periods (`src/domain/budget/budget.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// below fails. That is intentional — the implementation is written afterwards to
// make these pass. Do NOT add the module to turn these green; the builder does
// that. The tests pin BEHAVIOUR (the window a period computes, the number a sum
// returns, the boolean an over-budget / card-access check returns), never the
// source text of the module, so a later rename that keeps behaviour leaves them
// untouched.
//
// This is a pure domain module (conventions: `src/domain/**` has no React, no DB,
// no fetch, no process.env, no Date.now — "take a clock"). Card requests are
// checked against agent and household budgets in deterministic code (design §8
// step 4: "agent budget for its period"), so the period arithmetic and the
// over-budget math belong here, pure, built before the policy engine consumes
// them. Time enters ONLY as an injected `now: Date` (the AC's "injected now"): a
// plain instant, so the module stays pure and does not reach across the domain
// boundary into the server's Clock seam — the caller passes `clock.now()` in.
//
// Vocabulary is EXACTLY the brief's: a "budget period" is `day | week | month`
// (CLAUDE.md), and the per-agent card budget "defaults to A$200 per month"
// (brief "Per-agent permissions page").
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
// The AC gives only two inputs for a window — a period kind and `now` — and says
// nothing about a time zone, so the only pure, dependency-free reading is UTC
// calendar arithmetic on the injected instant (if Sydney-local boundaries are
// ever needed, the caller shifts the instant it passes in; that is not this
// task's scope). Windows are half-open [start, end): `start` is the midnight-UTC
// boundary of the current period, `end` is the start of the NEXT period
// (exclusive). Weeks start on MONDAY (ISO-8601). Money is a plain number in the
// person's account-currency major unit (200 == A$200), the same loose numeric
// `amount` the rules module already uses — so the policy engine compares like
// with like. Over-budget is STRICTLY greater than the budget: spending exactly
// up to the cap is allowed, a cent over it is not.
//
//   type PeriodKind = "day" | "week" | "month";
//
//   interface PeriodWindow { start: Date; end: Date; }   // [start, end)
//
//   // periodWindow(kind, now): the current period window around the injected
//   // instant. Pure and deterministic; never mutates `now`.
//   function periodWindow(kind: PeriodKind, now: Date): PeriodWindow;
//
//   interface Budget { amount: number; period: PeriodKind; }
//
//   // The fallback card budget: A$200 per month (brief's default).
//   const DEFAULT_CARD_BUDGET: Budget;     // { amount: 200, period: "month" }
//
//   // Card access requires a NON-ZERO budget (brief: "card access cannot be
//   // switched on without a budget"). A positive amount allows it; zero or
//   // negative does not.
//   function budgetAllowsCard(budget: Budget): boolean;
//
//   interface Release { amount: number; at: Date; }       // an approved release
//
//   interface BudgetResult { spent: number; overBudget: boolean; window: PeriodWindow; }
//
//   // evaluateBudget(budget, releases, proposed, now): sum the approved releases
//   // that fall inside the current period window (that is `spent`), then flag
//   // over-budget when spent + proposed would exceed budget.amount. With
//   // proposed = 0 this is the plain "do the approved releases already exceed the
//   // budget?" check the AC names ("Summing approved releases against a budget
//   // flags over-budget"); with proposed > 0 it is the card-request check (does
//   // approving this amount push the period over budget?).
//   function evaluateBudget(
//     budget: Budget,
//     releases: readonly Release[],
//     proposed: number,
//     now: Date,
//   ): BudgetResult;
//
// These tests build budgets / releases / windows as plain literals (typed
// loosely, like the rules and hash-chain suites) and assert only on what the
// functions RETURN. Instant comparisons go through `ms()`/`iso()` helpers that
// accept a Date (per the contract) but tolerate an epoch-ms or ISO-string
// representation too, so a reasonable representation choice never reddens a test
// for the wrong reason.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  periodWindow,
  evaluateBudget,
  budgetAllowsCard,
  DEFAULT_CARD_BUDGET,
} from "./budget";

// ---------------------------------------------------------------------------
// Instant helpers — compare the moment, not the representation.
// ---------------------------------------------------------------------------

const ms = (value: Date | number | string): number => new Date(value as never).getTime();
const iso = (value: Date | number | string): string => new Date(value as never).toISOString();

type PeriodKind = "day" | "week" | "month";
type Release = { amount: number; at: Date };

// ===========================================================================
// AC1 — periodWindow: given a period kind and an injected now, compute the
// current period window.
// ===========================================================================

// --- day --------------------------------------------------------------------

test("periodWindow('day') spans the UTC day containing now", () => {
  const now = new Date("2026-03-15T13:45:30.000Z");
  const w = periodWindow("day", now);
  assert.equal(iso(w.start), "2026-03-15T00:00:00.000Z", "the day window starts at UTC midnight of that day");
  assert.equal(iso(w.end), "2026-03-16T00:00:00.000Z", "and ends at the start of the next day (exclusive)");
});

test("periodWindow('day') rolls into the next month at a month boundary", () => {
  const now = new Date("2026-03-31T23:59:59.000Z");
  const w = periodWindow("day", now);
  assert.equal(iso(w.start), "2026-03-31T00:00:00.000Z", "the last day of March starts at its own midnight");
  assert.equal(iso(w.end), "2026-04-01T00:00:00.000Z", "and the next day is 1 April");
});

// --- week (Monday-start) ----------------------------------------------------

test("periodWindow('week') starts on the Monday of the week containing now", () => {
  // 2026-03-18 is a Wednesday; its week's Monday is 2026-03-16.
  const now = new Date("2026-03-18T09:00:00.000Z");
  const w = periodWindow("week", now);
  assert.equal(iso(w.start), "2026-03-16T00:00:00.000Z", "the week starts on Monday at UTC midnight");
  assert.equal(iso(w.end), "2026-03-23T00:00:00.000Z", "and ends on the following Monday (exclusive)");
});

test("periodWindow('week') puts a Sunday in the week that began the previous Monday", () => {
  // 2026-03-22 is a Sunday — the Monday-start convention keeps it in the week
  // that began on 2026-03-16, NOT the one starting the next day.
  const now = new Date("2026-03-22T23:59:59.000Z");
  const w = periodWindow("week", now);
  assert.equal(iso(w.start), "2026-03-16T00:00:00.000Z", "Sunday belongs to the Monday-started week before it");
  assert.equal(iso(w.end), "2026-03-23T00:00:00.000Z", "which ends the next Monday");
});

test("periodWindow('week') on a Monday starts that same Monday at midnight", () => {
  const now = new Date("2026-03-16T15:00:00.000Z");
  const w = periodWindow("week", now);
  assert.equal(iso(w.start), "2026-03-16T00:00:00.000Z", "a Monday is the first day of its own week");
  assert.equal(iso(w.end), "2026-03-23T00:00:00.000Z", "spanning seven days to the next Monday");
});

// --- month ------------------------------------------------------------------

test("periodWindow('month') spans the calendar month containing now", () => {
  const now = new Date("2026-03-15T13:45:30.000Z");
  const w = periodWindow("month", now);
  assert.equal(iso(w.start), "2026-03-01T00:00:00.000Z", "the month starts on the 1st at UTC midnight");
  assert.equal(iso(w.end), "2026-04-01T00:00:00.000Z", "and ends on the 1st of the next month (exclusive)");
});

test("periodWindow('month') rolls across the year boundary from December", () => {
  const now = new Date("2026-12-20T10:00:00.000Z");
  const w = periodWindow("month", now);
  assert.equal(iso(w.start), "2026-12-01T00:00:00.000Z", "December starts on 1 December");
  assert.equal(iso(w.end), "2027-01-01T00:00:00.000Z", "and ends on 1 January of the next year");
});

// --- cross-kind invariants --------------------------------------------------

test("periodWindow places now inside the half-open window for every kind", () => {
  const now = new Date("2026-03-18T09:00:00.000Z");
  for (const kind of ["day", "week", "month"] as PeriodKind[]) {
    const w = periodWindow(kind, now);
    assert.ok(ms(w.start) <= ms(now), `${kind}: the window starts at or before now`);
    assert.ok(ms(now) < ms(w.end), `${kind}: now is strictly before the exclusive end`);
    assert.ok(ms(w.start) < ms(w.end), `${kind}: the window is non-empty`);
  }
});

test("periodWindow is deterministic and does not mutate the injected now", () => {
  const now = new Date("2026-03-18T09:00:00.000Z");
  const before = now.getTime();
  const a = periodWindow("month", now);
  const b = periodWindow("month", now);
  assert.equal(now.getTime(), before, "the injected instant is left untouched");
  assert.equal(iso(a.start), iso(b.start), "same inputs give the same start");
  assert.equal(iso(a.end), iso(b.end), "same inputs give the same end");
});

// ===========================================================================
// AC2a — evaluateBudget: summing approved releases against a budget flags
// over-budget.
// ===========================================================================

const MARCH = new Date("2026-03-15T12:00:00.000Z"); // inside the March 2026 month window
const MONTH_200 = { amount: 200, period: "month" as const };

const IN_WINDOW: Release[] = [
  { amount: 100, at: new Date("2026-03-05T10:00:00.000Z") },
  { amount: 50, at: new Date("2026-03-14T10:00:00.000Z") },
];

test("evaluateBudget sums the approved releases inside the current period as spent", () => {
  const r = evaluateBudget(MONTH_200, IN_WINDOW, 0, MARCH);
  assert.equal(r.spent, 150, "the two March releases sum to 150");
  assert.equal(r.overBudget, false, "150 spent with nothing proposed is within a 200 budget");
});

test("evaluateBudget ignores releases that fall outside the current period window", () => {
  // A February release must not count toward the March budget.
  const withStray: Release[] = [...IN_WINDOW, { amount: 999, at: new Date("2026-02-28T10:00:00.000Z") }];
  const r = evaluateBudget(MONTH_200, withStray, 0, MARCH);
  assert.equal(r.spent, 150, "the out-of-period release is excluded from the sum");
});

test("evaluateBudget flags over-budget when approved releases already exceed the budget", () => {
  // The AC's literal case: summing approved releases alone (proposed = 0) flags
  // over-budget when their total passes the cap.
  const over: Release[] = [
    { amount: 150, at: new Date("2026-03-05T10:00:00.000Z") },
    { amount: 100, at: new Date("2026-03-10T10:00:00.000Z") },
  ];
  const r = evaluateBudget(MONTH_200, over, 0, MARCH);
  assert.equal(r.spent, 250, "the releases sum to 250");
  assert.equal(r.overBudget, true, "250 spent exceeds a 200 budget");
});

test("evaluateBudget allows a proposed amount that lands exactly on the budget", () => {
  // 150 spent + 50 proposed = 200 = the cap. Spending exactly up to the budget is
  // allowed; over-budget is STRICTLY greater.
  const r = evaluateBudget(MONTH_200, IN_WINDOW, 50, MARCH);
  assert.equal(r.spent, 150, "spent reflects only the approved releases, not the proposal");
  assert.equal(r.overBudget, false, "reaching the cap exactly is not over budget");
});

test("evaluateBudget allows a proposed amount that stays under the budget", () => {
  const r = evaluateBudget(MONTH_200, IN_WINDOW, 42, MARCH);
  assert.equal(r.overBudget, false, "150 + 42 = 192 is under a 200 budget");
});

test("evaluateBudget flags over-budget when a proposed amount would push past the budget", () => {
  const r = evaluateBudget(MONTH_200, IN_WINDOW, 60, MARCH);
  assert.equal(r.overBudget, true, "150 + 60 = 210 exceeds a 200 budget");
});

test("evaluateBudget reports the period window it summed over", () => {
  const r = evaluateBudget(MONTH_200, IN_WINDOW, 0, MARCH);
  const w = periodWindow("month", MARCH);
  assert.equal(iso(r.window.start), iso(w.start), "the result's window start agrees with periodWindow");
  assert.equal(iso(r.window.end), iso(w.end), "the result's window end agrees with periodWindow");
});

test("evaluateBudget counts a release exactly at the window start but not one at the window end", () => {
  // Half-open [start, end): a day budget around 2026-03-15 spans
  // [2026-03-15T00:00:00Z, 2026-03-16T00:00:00Z).
  const dayBudget = { amount: 1000, period: "day" as const };
  const now = new Date("2026-03-15T12:00:00.000Z");
  const releases: Release[] = [
    { amount: 10, at: new Date("2026-03-15T00:00:00.000Z") }, // == start → counted
    { amount: 20, at: new Date("2026-03-14T23:59:59.999Z") }, // just before start → excluded
    { amount: 40, at: new Date("2026-03-16T00:00:00.000Z") }, // == end (exclusive) → excluded
    { amount: 5, at: new Date("2026-03-15T23:59:59.999Z") }, // inside → counted
  ];
  const r = evaluateBudget(dayBudget, releases, 0, now);
  assert.equal(r.spent, 15, "only the two releases within [start, end) are summed");
});

// ===========================================================================
// AC2b — card access requires a non-zero budget defaulting to A$200 per month.
// ===========================================================================

test("DEFAULT_CARD_BUDGET is A$200 per month", () => {
  assert.equal(DEFAULT_CARD_BUDGET.amount, 200, "the default card budget amount is 200 (A$200)");
  assert.equal(DEFAULT_CARD_BUDGET.period, "month", "the default card budget period is a month");
});

test("budgetAllowsCard allows a positive budget", () => {
  assert.equal(budgetAllowsCard({ amount: 200, period: "month" }), true, "a 200/month budget allows card access");
  assert.equal(budgetAllowsCard(DEFAULT_CARD_BUDGET), true, "the default budget allows card access");
});

test("budgetAllowsCard refuses a zero budget", () => {
  // Brief: "card access cannot be switched on without a budget" — a zero budget
  // is no budget.
  assert.equal(budgetAllowsCard({ amount: 0, period: "month" }), false, "a zero budget does not allow card access");
});

test("budgetAllowsCard refuses a negative budget", () => {
  assert.equal(budgetAllowsCard({ amount: -1, period: "month" }), false, "a negative budget does not allow card access");
});

test("a first card request fits within the default A$200 monthly budget", () => {
  // The walkthrough's $42 at BoxCo against Claude's $200 monthly budget, no prior
  // spend this period.
  const r = evaluateBudget(DEFAULT_CARD_BUDGET, [], 42, MARCH);
  assert.equal(r.spent, 0, "no releases yet this period");
  assert.equal(r.overBudget, false, "42 proposed against a 200 budget is within budget");
});
