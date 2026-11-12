"use client";

import * as React from "react";
import { AlertTriangle, Bot, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { EmptyState } from "@/components/ui/empty";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { SelectField } from "@/components/ui/field";
import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";

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
//   - an account-currency selector so the person can set their account currency —
//     one compact form in the page header, its Save bound to the page's action.
// Every money figure is shown WITH its currency (a multi-currency app: a bare "$"
// does not say which dollar).
//
// Organisation: each agent is a divider row (never a card nested in a card). Its
// releases are grouped by merchant — one disclosure per merchant whose summary carries
// the subtotal (per currency, never summed across currencies), largest first — with
// the individual releases inside. An agent with releases links to its approvals and
// releases in Activity.
//
// Layout (the UI/UX pass): the page heading band carries the title, its purpose and the
// currency form; the outcome notice follows it; "Your agents" is always one bounded group
// (with an empty state and a next step before any agent is connected) that links to where
// card budgets are set; the household totals are one panel of divider rows.
//
// This is the render-testable, prop-driven VIEW (a Client Component): it renders the
// screen entirely from its props so a render test pins each behaviour without a DOM.
// The page binds the save-currency action; a prop-only render without it shows the
// Save disabled with a reason (no dead control). The prop shapes mirror
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
};

// One of the person's own agents, with its budget and its releases this period.
// `activityLink` opens Activity filtered to this agent's approvals and releases.
export type SpendingOwnAgent = {
  agentId: string;
  displayName: string;
  budget: SpendingCardBudget | null;
  approvedTotal: number | string;
  unconverted?: readonly SpendingUnconverted[];
  activityLink?: string;
  releases: SpendingOwnRelease[];
};

export type SpendingOwn = {
  agents: SpendingOwnAgent[];
};

// Spend in a currency with no reference rate into the household currency: the amount
// in its own currency. It is never part of a total (review fix W4.5) — the view flags
// it in words instead.
export type SpendingUnconverted = {
  currency: string;
  amount: number;
};

// One household member's totals — a limit and a total, NOTHING else (no merchant, no
// release entry): `monthlyLimit` is null until set, `spendToDate` is in the household
// currency, and `unconverted` is their spend that could not be converted into it.
export type SpendingHouseholdMember = {
  periodIncomplete?: boolean;
  userId: string;
  monthlyLimit: number | null;
  spendToDate: number;
  unconverted?: SpendingUnconverted[];
};

// The household spending report: the shared budget and the household total, plus one
// totals-only entry per member. Every amount is in the household currency, except the
// `unconverted` amounts, which are left out of the totals and flagged.
export type SpendingHouseholdReport = {
  periodIncomplete?: boolean;
  householdId: string;
  currency: string;
  monthlyBudget: number | null;
  budgetSpendToDate: number;
  unconverted?: SpendingUnconverted[];
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
  // The page's bound save-currency server action. Absent in a prop-only render, where
  // the Save control is shown disabled with its reason.
  currencyAction?: (formData: FormData) => void | Promise<void>;
  // The outcome of the last currency save, shown under the header.
  notice?: React.ReactNode;
};

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
  if (agent.unconverted?.length) {
    return `Total unavailable: a reference rate is missing for ${agent.unconverted.map((entry) => money(entry.amount, entry.currency)).join(", ")}.`;
  }
  const spent = money(agent.approvedTotal, agent.budget?.currency ?? accountCurrency);
  if (agent.budget) {
    return `${spent} of ${money(agent.budget.amount, agent.budget.currency)} ${periodWords(agent.budget.period)}`;
  }
  return `${spent} approved · no card budget`;
}

// A member's total against their monthly limit (an unset limit reads as plain copy),
// plus any of their spend that couldn't be converted, named in its own currency.
function memberLine(member: SpendingHouseholdMember, currency: string): string {
  if (member.periodIncomplete) return "Total unavailable: earlier release dates need checking.";
  const spent = money(member.spendToDate, currency);
  const line =
    member.monthlyLimit !== null
      ? `${spent} of ${money(member.monthlyLimit, currency)} this month`
      : `${spent} · No limit set`;
  const unconverted = member.unconverted ?? [];
  if (unconverted.length === 0) return line;
  return `${line} · plus ${unconverted.map((entry) => money(entry.amount, entry.currency)).join(", ")} not converted`;
}

// One plain sentence per currency that couldn't be converted: what, why, and that it
// is left out of the totals (never silently counted as nothing).
function unconvertedLine(entry: SpendingUnconverted): string {
  return `Couldn't convert ${money(entry.amount, entry.currency)} — no rate for ${entry.currency} yet, so it's not included in these totals.`;
}

// The household total against the shared household budget (an unset budget reads as
// plain copy).
function householdLine(household: SpendingHouseholdReport): string {
  if (household.periodIncomplete) return "Total unavailable: earlier release dates need checking. Contact support before making another release.";
  const spent = money(household.budgetSpendToDate, household.currency);
  if (household.monthlyBudget !== null) {
    return `${spent} of ${money(household.monthlyBudget, household.currency)} this month`;
  }
  return `${spent} · No budget set`;
}

// --- merchant grouping ---------------------------------------------------------------

// One currency's subtotal for a merchant, in its major unit.
export type MerchantSubtotal = { currency: string; amount: number };

// An agent's releases at one merchant: a subtotal PER CURRENCY (amounts in different
// currencies are never added together — there is no rate here to convert them), and
// the individual releases, largest first.
export type MerchantGroup = {
  merchant: string;
  subtotals: MerchantSubtotal[];
  releases: SpendingOwnRelease[];
};

// Whole cents, so a subtotal never shows a floating-point artefact.
function cents(value: number | string): number {
  return Math.round(Number(value) * 100);
}

// Group an agent's releases by merchant (trimmed, case-insensitive; the first spelling
// seen names the group) and order the groups largest first: by the subtotal in
// `primaryCurrency` (the currency the agent's budget counts in), then by the largest
// subtotal in any other currency, then by how many releases, then by name — so the
// same releases always yield the same order.
export function groupReleasesByMerchant(
  releases: readonly SpendingOwnRelease[],
  primaryCurrency: string,
): MerchantGroup[] {
  const groups = new Map<string, { merchant: string; byCurrency: Map<string, number>; releases: SpendingOwnRelease[] }>();
  for (const release of releases) {
    const name = release.merchant.trim() || "Merchant not named";
    const key = name.toLocaleLowerCase("en-AU");
    const group = groups.get(key) ?? { merchant: name, byCurrency: new Map<string, number>(), releases: [] };
    group.byCurrency.set(release.currency, (group.byCurrency.get(release.currency) ?? 0) + cents(release.amount));
    group.releases.push(release);
    groups.set(key, group);
  }

  const weighed = [...groups.values()].map((group) => {
    const subtotals = [...group.byCurrency.entries()]
      .sort(([a], [b]) => (a === primaryCurrency ? -1 : b === primaryCurrency ? 1 : a.localeCompare(b)))
      .map(([currency, total]) => ({ currency, total }));
    const primary = group.byCurrency.get(primaryCurrency) ?? 0;
    const other = Math.max(0, ...subtotals.filter((s) => s.currency !== primaryCurrency).map((s) => s.total));
    return { group, subtotals, primary, other };
  });
  weighed.sort(
    (a, b) =>
      b.primary - a.primary ||
      b.other - a.other ||
      b.group.releases.length - a.group.releases.length ||
      a.group.merchant.localeCompare(b.group.merchant),
  );

  return weighed.map(({ group, subtotals }) => ({
    merchant: group.merchant,
    subtotals: subtotals.map(({ currency, total }) => ({ currency, amount: total / 100 })),
    releases: [...group.releases].sort((a, b) => cents(b.amount) - cents(a.amount) || a.id.localeCompare(b.id)),
  }));
}

// --- pieces ---------------------------------------------------------------------------

// The account-currency setting: ONE compact form in the page header — the selector and
// its Save side by side. Without a bound action (a prop-only render) the Save is
// disabled and the reason is given in words, never a live button over nothing.
function CurrencyForm({
  accountCurrency,
  currencyOptions,
  action,
}: {
  accountCurrency: string;
  currencyOptions: readonly string[];
  action?: (formData: FormData) => void | Promise<void>;
}) {
  const select = (
    <SelectField label="Account currency" id="account-currency" name="account-currency" defaultValue={accountCurrency} className="w-36">
      {currencyOptions.map((code) => (
        <option key={code} value={code}>
          {code}
        </option>
      ))}
    </SelectField>
  );
  if (!action) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-end gap-2">
          {select}
          <Button variant="secondary" disabled aria-describedby="account-currency-unavailable">
            Save currency
          </Button>
        </div>
        <p id="account-currency-unavailable" className="text-sm text-fg-muted">
          Saving the account currency isn&apos;t available just now.
        </p>
      </div>
    );
  }
  return (
    <ActionForm action={action} className="flex flex-wrap items-end gap-2">
      {select}
      <FormSubmit variant="secondary" pendingLabel="Saving…">
        Save currency
      </FormSubmit>
    </ActionForm>
  );
}

// One merchant: a disclosure whose summary names the merchant, how many releases and
// the subtotal per currency; the individual releases (each approved amount, and any
// amount the agent reported, labelled) sit inside, collapsed until opened.
function MerchantRow({ group, agentName }: { group: MerchantGroup; agentName: string }) {
  const count = group.releases.length;
  return (
    <li className="border-b border-line last:border-0">
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-field py-2 [&::-webkit-details-marker]:hidden">
          <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180" />
          <span className="min-w-0 flex-1 text-fg">{group.merchant}</span>
          <span className="text-sm text-fg-muted">
            {count} release{count === 1 ? "" : "s"}
          </span>
          <span className="font-medium tabular-nums text-fg">
            {group.subtotals.map((subtotal) => money(subtotal.amount, subtotal.currency)).join(" · ")}
          </span>
        </summary>
        <ul role="list" className="flex flex-col pb-2 ps-7">
          {group.releases.map((release) => (
            <li key={release.id} className="flex flex-col gap-0.5 border-t border-line py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-fg-muted">Approved</span>
                <span className="tabular-nums text-fg">{money(release.amount, release.currency)}</span>
              </div>
              {release.reportedAmount !== null ? (
                <span className="text-fg-muted">
                  Reported by {agentName}: {money(release.reportedAmount, release.currency)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </details>
    </li>
  );
}

// One of the person's agents: a divider row with its name, its total against budget,
// a link to its approvals and releases in Activity, and its releases by merchant.
function AgentRow({ agent, accountCurrency }: { agent: SpendingOwnAgent; accountCurrency: string }) {
  const groups = groupReleasesByMerchant(agent.releases, agent.budget?.currency ?? accountCurrency);
  return (
    <li className="flex min-w-0 flex-col gap-2 border-b border-line py-4 last:border-0 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="font-medium text-fg">{agent.displayName}</h3>
          <p className="text-sm text-fg-muted">{budgetLine(agent, accountCurrency)}</p>
        </div>
        {agent.activityLink && agent.releases.length > 0 ? (
          <a
            href={agent.activityLink}
            className="inline-flex min-h-11 items-center text-sm font-medium text-fg underline underline-offset-4"
          >
            View approvals in Activity<span className="sr-only"> for {agent.displayName}</span>
          </a>
        ) : null}
      </div>
      {groups.length === 0 ? (
        <p className="text-sm text-fg-muted">No approved releases this period.</p>
      ) : (
        <ul role="list" aria-label={`${agent.displayName} releases by merchant`} className="flex flex-col border-t border-line">
          {groups.map((group) => (
            <MerchantRow key={group.merchant} group={group} agentName={agent.displayName} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function SpendingView({
  own,
  household,
  accountCurrency,
  currencyOptions,
  currencyAction,
  notice,
}: SpendingViewProps) {
  // Where each agent's card budget is set (Rules & budgets › Budgets links to every agent's
  // Spending section), so "what was spent" and "what may be spent" are one click apart.
  const budgetsLink = (
    <a href="/rules?view=budgets" className="inline-flex min-h-11 items-center text-sm font-medium text-fg underline underline-offset-4">
      Card budgets
    </a>
  );
  return (
    <div className="wh-page [overflow-wrap:anywhere]">
      {/* ----- The heading band: title, purpose and the account-currency form ----- */}
      <WorkspaceHeading
        title="Spending"
        description={`Approved card releases for your agents this period${household ? ", and your household's shared totals" : ""}.`}
      >
        <CurrencyForm accountCurrency={accountCurrency} currencyOptions={currencyOptions} action={currencyAction} />
      </WorkspaceHeading>
      {notice}

      {/* ----- Own agents: card budget + approved releases by merchant, in detail ----- */}
      {own.agents.length === 0 ? (
        <WorkspacePanel title="Your agents" action={budgetsLink}>
          <EmptyState
            variant="inline"
            icon={Bot}
            heading="No agents connected yet."
            description="Each agent's approved card releases show here once you connect one and give it card access."
            action={<ButtonLink href="/agents/connect" variant="primary" size="sm">Connect your first agent</ButtonLink>}
          />
        </WorkspacePanel>
      ) : (
        <ListGroup
          id="spending-agents"
          title="Your agents"
          count={own.agents.length}
          action={budgetsLink}
          summary="Each agent's releases are grouped by merchant, largest first. Open a merchant to see each release."
        >
          {own.agents.map((agent) => (
            <AgentRow key={agent.agentId} agent={agent} accountCurrency={accountCurrency} />
          ))}
        </ListGroup>
      )}

      {/* ----- Household totals: per-member against limit + the household total.
              TOTALS ONLY — never another member's merchants or release entries. ----- */}
      {household ? (
        <WorkspacePanel
          title="Household"
          description="Shared totals only: no one sees another member's merchants or entries. Budgets and limits reset at the start of each month, at the same moment for everyone in the household."
          action={
            <a href="/household" className="inline-flex min-h-11 items-center text-sm font-medium text-fg underline underline-offset-4">
              Manage household
            </a>
          }
        >
          <ul role="list" className="flex flex-col">
            {household.members.map((member, index) => (
              <li key={member.userId} className={`${LIST_ROW} sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-4`}>
                <span className="text-fg">Member {index + 1}</span>
                <span className="text-sm text-fg-muted">{memberLine(member, household.currency)}</span>
              </li>
            ))}
            <li className={`${LIST_ROW} sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-4`}>
              <span className="font-medium text-fg">Household total</span>
              <span className="font-medium text-fg">{householdLine(household)}</span>
            </li>
          </ul>
          {(household.unconverted ?? []).map((entry) => (
            <p key={entry.currency} className="mt-3 flex items-start gap-2 text-sm text-fg">
              <AlertTriangle aria-hidden={true} className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              {unconvertedLine(entry)}
            </p>
          ))}
        </WorkspacePanel>
      ) : null}
    </div>
  );
}

export default SpendingView;
