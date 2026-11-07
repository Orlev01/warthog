"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";

// E15-S10 — Spending view component (brief "Spending view" + "Household sharing";
// design §8 step 4 / §9; constitution principle 14 "Warthog … labels
// agent-submitted summaries as reported by that agent, never treats an agent report
// as the source of truth").
//
// The Spending screen shows, DISTINCTLY:
//   - the person's OWN agents' spending in detail: per agent, its card budget and
//     the approved card releases this period (merchant + the APPROVED amount — the
//     only amount counted), and any amount the agent later REPORTED for a release,
//     surfaced ONLY with its "Reported by <agent>" label (never counted);
//   - the HOUSEHOLD totals section: per-member total against that member's limit plus
//     the household total against the shared budget — TOTALS ONLY, never another
//     member's merchants or individual release entries;
//   - an account-currency selector so the person can set their account currency.
// Every money figure is shown WITH its currency (a multi-currency app: a bare "$"
// does not say which dollar).
//
// This is the render-testable, prop-driven VIEW (a Client Component): it renders the
// screen entirely from its props so a render test pins each behaviour without a DOM.
// The real plumbing — persisting the chosen account currency, following a release's
// activity link — is wired by a later task / sibling modules. The prop shapes mirror
// the already-built reads (own-read `OwnSpending`, household-read
// `HouseholdSpendingReport`) but are declared LOCALLY so the view never couples to the
// server db modules. Colour comes from the design tokens (globals.css) — never raw hex.

export type SpendingPeriodKind = "day" | "week" | "month";

// An agent's card spending budget, in its own currency.
export type SpendingCardBudget = {
  amount: number;
  currency: string;
  period: SpendingPeriodKind;
};

// One approved card release this period: `amount` is the APPROVED amount (what counts
// toward budget); `reportedAmount` is any amount the agent later reported for THIS
// release (shown LABELLED, never counted), null when the agent reported nothing.
export type SpendingOwnRelease = {
  id: string;
  merchant: string;
  amount: number | string;
  currency: string;
  reportedAmount: number | string | null;
  activityLink: string;
};

// One of the person's own agents, with its budget and its releases this period.
export type SpendingOwnAgent = {
  agentId: string;
  displayName: string;
  budget: SpendingCardBudget | null;
  approvedTotal: number | string;
  releases: SpendingOwnRelease[];
};

export type SpendingOwn = {
  agents: SpendingOwnAgent[];
};

// One household member's totals — a limit and a total, NOTHING else (no merchant, no
// release entry): `monthlyLimit` is null until set, `spendToDate` is in the household
// currency.
export type SpendingHouseholdMember = {
  userId: string;
  monthlyLimit: number | null;
  spendToDate: number;
};

// The household spending report: the shared budget and the household total, plus one
// totals-only entry per member. Every amount is in the household currency.
export type SpendingHouseholdReport = {
  householdId: string;
  currency: string;
  monthlyBudget: number | null;
  budgetSpendToDate: number;
  members: SpendingHouseholdMember[];
};

export type SpendingViewProps = {
  own: SpendingOwn;
  // the household totals report, or null when the person is in no household.
  household: SpendingHouseholdReport | null;
  // the person's current account currency (an ISO 4217 code).
  accountCurrency: string;
  // the selectable account currencies offered by the account-currency selector.
  currencyOptions: readonly string[];
};

// A native <select> on the design tokens (one source of visual truth — never a
// parallel style).
const SELECT_CLASS =
  "min-h-11 rounded-card border border-line bg-surface px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

// A money amount in its major unit, two decimals — the fixtures carry a number or a
// numeric string depending on the driver, so both are accepted.
function amountText(value: number | string): string {
  const n = typeof value === "number" ? value : Number(value);
  return n.toFixed(2);
}

// Money ALWAYS shown with its currency: the ISO 4217 code sits on the figure, so a
// multi-currency view never leaves a bare "$" ambiguous.
function money(value: number | string, currency: string): string {
  return `${currency} ${amountText(value)}`;
}

// Plain words for the period the approved total is counted over.
function periodWords(period: SpendingPeriodKind): string {
  switch (period) {
    case "day":
      return "today";
    case "week":
      return "this week";
    case "month":
      return "this month";
  }
}

// An agent's approved total this period against its budget. Without a card budget
// there is nothing to count against — say so in plain words rather than invent a
// figure (and never print a null placeholder).
function budgetLine(agent: SpendingOwnAgent, accountCurrency: string): string {
  const spent = money(agent.approvedTotal, agent.budget?.currency ?? accountCurrency);
  if (agent.budget) {
    return `${spent} of ${money(agent.budget.amount, agent.budget.currency)} ${periodWords(agent.budget.period)}`;
  }
  return `${spent} approved · No card budget set`;
}

// A member's total against their monthly limit (an unset limit reads as plain copy).
function memberLine(member: SpendingHouseholdMember, currency: string): string {
  const spent = money(member.spendToDate, currency);
  if (member.monthlyLimit !== null) {
    return `${spent} of ${money(member.monthlyLimit, currency)} this month`;
  }
  return `${spent} · No limit set`;
}

// The household total against the shared household budget (an unset budget reads as
// plain copy).
function householdLine(household: SpendingHouseholdReport): string {
  const spent = money(household.budgetSpendToDate, household.currency);
  if (household.monthlyBudget !== null) {
    return `${spent} of ${money(household.monthlyBudget, household.currency)} this month`;
  }
  return `${spent} · No budget set`;
}

export function SpendingView({ own, household, accountCurrency, currencyOptions }: SpendingViewProps) {
  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
      {/* ----- Title + the account-currency selector ----- */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Spending</h1>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="account-currency" className="text-sm font-medium text-fg">
            Account currency
          </label>
          <select
            id="account-currency"
            name="account-currency"
            aria-label="Account currency"
            defaultValue={accountCurrency}
            className={SELECT_CLASS}
          >
            {currencyOptions.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* ----- Own agents: card budget + approved releases this period, in detail ----- */}
      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-fg">Your agents</h2>
        {own.agents.length === 0 ? (
          <p className="text-sm text-fg-muted">No agents connected yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {own.agents.map((agent) => (
              <li key={agent.agentId}>
                <Card className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1">
                    <h3 className="font-medium text-fg">{agent.displayName}</h3>
                    <span className="text-sm text-fg-muted">{budgetLine(agent, accountCurrency)}</span>
                  </div>
                  {agent.releases.length === 0 ? (
                    <p className="text-sm text-fg-muted">No approved releases this period.</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {agent.releases.map((release) => (
                        <li
                          key={release.id}
                          className="flex flex-col gap-0.5 rounded-card border border-line bg-surface-muted p-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-fg">{release.merchant}</span>
                            <span className="font-medium text-fg">{money(release.amount, release.currency)}</span>
                          </div>
                          {release.reportedAmount !== null ? (
                            <span className="text-sm text-fg-muted">
                              Reported by {agent.displayName}: {money(release.reportedAmount, release.currency)}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ----- Household totals: per-member against limit + the household total.
              TOTALS ONLY — never another member's merchants or release entries. ----- */}
      {household ? (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-fg">Household</h2>
          <p className="text-sm text-fg-muted">
            Shared totals only — no one sees another member&apos;s merchants or entries.
          </p>
          <Card className="flex flex-col gap-3">
            <ul className="flex flex-col gap-2">
              {household.members.map((member, index) => (
                <li key={member.userId} className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-fg">Member {index + 1}</span>
                  <span className="text-sm text-fg-muted">{memberLine(member, household.currency)}</span>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
              <span className="font-medium text-fg">Household total</span>
              <span className="font-medium text-fg">{householdLine(household)}</span>
            </div>
          </Card>
        </div>
      ) : null}
    </section>
  );
}

export default SpendingView;
