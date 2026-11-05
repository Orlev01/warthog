import * as React from "react";
import { CreditCard, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { DEFAULT_CARD_BUDGET, budgetAllowsCard, type Budget } from "@/domain/budget/budget";
import { ruleSentence, type Rule } from "@/domain/rules/rules";

// E10-S07 — Per-agent permissions view (design §7; brief "Per-agent permissions
// page"). Each agent's reach is shaped on ONE screen. For a given agent the person
// sees which connected services and which of their tools it may use (read tools and
// change-making tools listed SEPARATELY, change-making tools defaulting to "Ask me
// first"), which identity fields it may read without asking (low tier only) and
// whether it may request high-tier fields, whether it may request a card and its
// spending budget (card access cannot be switched on without a budget; the budget
// defaults to A$200 per month), which skills it receives, whether it may read shared
// memory, whether what it learns is shared with other agents, its own rules, and
// (under Advanced) its request limit (default 120 per minute).
//
// This is the PURE, prop-driven VIEW: it renders the screen from its props so it can
// be pinned without a browser, a session or any server plumbing. The persistence /
// apply plumbing ("changes take effect on the agent's next request") lives in the
// server composition root and is wired by a later task; the controls here are
// native, user-adjustable form controls whose initial state is driven by the props.
//
// The budget default (A$200 / month) is the one-source-of-truth domain contract
// DEFAULT_CARD_BUDGET, and whether a budget allows card access is budgetAllowsCard —
// this view re-encodes neither. Rules read back as ruleSentence() verbatim. Colour
// comes from the design tokens (globals.css) — never a raw hex.

// The view's own default request limit (brief NFR: "default 120 requests per
// minute, set per agent by the person on that agent's permissions page").
const DEFAULT_REQUEST_LIMIT = 120;

export type ConnectorAccess = {
  id: string;
  name: string;
  // the tool names the agent may use, split into the two groups the brief names:
  // read tools and change-making tools (the latter default to "Ask me first").
  readTools: ReadonlyArray<string>;
  changeTools: ReadonlyArray<string>;
};

export type SkillGrant = { id: string; name: string; granted: boolean };

export type PermissionsViewProps = {
  // the agent being shaped, named on the screen.
  agentName: string;
  // granted connectors and the tools it may use, reads and changes listed apart.
  connectors: ReadonlyArray<ConnectorAccess>;
  // low-tier identity read (always low tier only) vs. the high-tier REQUEST toggle.
  lowTierRead: boolean;
  highTierRequest: boolean;
  // card access and its spending budget; a null budget means none is set yet.
  cardAccess: boolean;
  budget: Budget | null;
  // which skills it receives, each grantable.
  skills: ReadonlyArray<SkillGrant>;
  // read the person's shared memory; share what it learns with other agents.
  sharedMemoryRead: boolean;
  learningSharing: boolean;
  // its own rules, each rendered as its plain-English sentence (ruleSentence).
  rules: ReadonlyArray<Rule>;
  // Advanced: the sliding-window request limit; defaults to 120 requests/min.
  requestLimit?: number;
  // the person's currency label (e.g. "A$").
  currency?: string;
};

// One capability toggle: a native, user-adjustable checkbox whose initial checked
// state reflects the prop. The visible label text IS the control's accessible name.
function Toggle({
  on,
  label,
  description,
}: {
  on: boolean;
  label: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-3 rounded-card border border-line bg-surface p-3">
      <input type="checkbox" defaultChecked={on} className="mt-1 h-4 w-4 shrink-0 accent-accent" />
      <span className="flex flex-col gap-0.5">
        <span className="text-fg">{label}</span>
        {description ? <span className="text-sm text-fg-muted">{description}</span> : null}
      </span>
    </label>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold text-fg">{children}</h2>;
}

export function PermissionsView({
  agentName,
  connectors,
  lowTierRead,
  highTierRequest,
  cardAccess,
  budget,
  skills,
  sharedMemoryRead,
  learningSharing,
  rules,
  requestLimit,
  currency = "A$",
}: PermissionsViewProps) {
  // Card access cannot be switched on without a budget (and that budget must allow
  // it): the save control is disabled with a stated reason until one is set.
  const cardNeedsBudget = cardAccess && (budget === null || !budgetAllowsCard(budget));
  const budgetPeriod = budget?.period ?? DEFAULT_CARD_BUDGET.period;
  const limit = requestLimit ?? DEFAULT_REQUEST_LIMIT;

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-fg">What {agentName} can do</h1>
        <p className="text-sm text-fg-muted">
          Shape {agentName}&rsquo;s reach. Changes take effect on its next request.
        </p>
      </header>

      {/* Connected services and their tools — reads and changes listed separately. */}
      <div className="flex flex-col gap-3">
        <SectionHeading>Connected services</SectionHeading>
        {connectors.map((connector) => (
          <Card key={connector.id} className="flex flex-col gap-3">
            <h3 className="font-medium text-fg">{connector.name}</h3>

            <div className="flex flex-col gap-1.5">
              <h4 className="text-sm font-medium text-fg-muted">Reads</h4>
              <ul className="flex flex-col gap-1">
                {connector.readTools.map((tool) => (
                  <li
                    key={tool}
                    className="rounded-card border border-line bg-surface-muted p-2 text-sm text-fg"
                  >
                    {tool}
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex flex-col gap-1.5">
              <h4 className="text-sm font-medium text-fg-muted">Makes changes</h4>
              <ul className="flex flex-col gap-1">
                {connector.changeTools.map((tool) => (
                  <li
                    key={tool}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-line bg-surface-muted p-2 text-sm text-fg"
                  >
                    <span>{tool}</span>
                    <span className="font-medium text-fg-muted">Ask me first</span>
                  </li>
                ))}
              </ul>
            </div>
          </Card>
        ))}
      </div>

      {/* Identity: low-tier read vs. the high-tier REQUEST toggle. */}
      <div className="flex flex-col gap-3">
        <SectionHeading>Your identity</SectionHeading>
        <Toggle
          on={lowTierRead}
          label="Read your low-tier identity details"
          description="Low tier only — the everyday basics, never the sensitive ones."
        />
        <Toggle
          on={highTierRequest}
          label="Let it ask for high-tier identity details"
          description="You approve each request before anything is released."
        />
      </div>

      {/* Card access and its spending budget. The budget field shows only alongside
          card access; enabling card access without a budget blocks save. */}
      <div className="flex flex-col gap-3">
        <SectionHeading>Card access</SectionHeading>
        <Toggle
          on={cardAccess}
          label={
            <span className="inline-flex items-center gap-2">
              <CreditCard aria-hidden={true} className="h-4 w-4 shrink-0" />
              Let it ask to use a card
            </span>
          }
          description="You approve each payment before anything is charged."
        />
        {cardAccess ? (
          <Card className="flex flex-col gap-2">
            <Field
              label={`Budget per ${budgetPeriod} (${currency})`}
              type="number"
              min={0}
              inputMode="numeric"
              defaultValue={budget ? budget.amount : undefined}
              placeholder={String(DEFAULT_CARD_BUDGET.amount)}
            />
            <p className="text-sm text-fg-muted">
              Defaults to {currency}
              {DEFAULT_CARD_BUDGET.amount} per {DEFAULT_CARD_BUDGET.period}.
            </p>
          </Card>
        ) : null}
      </div>

      {/* Skills it receives. */}
      <div className="flex flex-col gap-3">
        <SectionHeading>Skills</SectionHeading>
        {skills.map((skill) => (
          <Toggle key={skill.id} on={skill.granted} label={skill.name} />
        ))}
      </div>

      {/* Shared memory and sharing what it learns. */}
      <div className="flex flex-col gap-3">
        <SectionHeading>Memory and sharing</SectionHeading>
        <Toggle on={sharedMemoryRead} label="Read your shared memory" />
        <Toggle
          on={learningSharing}
          label="Share what it learns with your other agents"
        />
      </div>

      {/* The agent's own rules, each read back as its exact plain-English sentence. */}
      <div className="flex flex-col gap-3">
        <SectionHeading>Rules for {agentName}</SectionHeading>
        <ul className="flex flex-col gap-2">
          {rules.map((rule, i) => (
            <li
              key={i}
              className="rounded-card border border-line bg-surface p-3 text-sm text-fg"
            >
              {ruleSentence(rule)}
            </li>
          ))}
        </ul>
      </div>

      {/* Advanced: the per-minute request limit (default 120/min). */}
      <details className="rounded-card border border-line bg-surface p-3">
        <summary className="cursor-pointer text-sm font-semibold text-fg">Advanced</summary>
        <div className="mt-3">
          <Field
            label="Request limit (per minute)"
            type="number"
            min={1}
            inputMode="numeric"
            defaultValue={limit}
          />
        </div>
      </details>

      {/* Save — disabled with a stated reason when card access has no budget. */}
      <div className="flex flex-col gap-2">
        {cardNeedsBudget ? (
          <p className="inline-flex items-center gap-2 text-sm font-medium text-warning">
            <TriangleAlert aria-hidden={true} className="h-4 w-4 shrink-0" />
            Add a budget before you can save card access.
          </p>
        ) : null}
        <Button type="button" variant="primary" disabled={cardNeedsBudget}>
          Save changes
        </Button>
      </div>
    </section>
  );
}

export default PermissionsView;
