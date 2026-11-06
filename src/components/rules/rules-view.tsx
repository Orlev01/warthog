"use client";

import * as React from "react";
import { Pause, Play, Plus, PauseCircle, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty";
import {
  ruleSentence,
  type RuleScope,
  type RuleAction,
  type RuleCondition,
} from "@/domain/rules/rules";
import { type PeriodKind } from "@/domain/budget/budget";

// E12-S16 — Rules view component (design §8; brief "Rules and approvals").
//
// The Rules screen lets a person READ BACK their existing rules as the exact plain
// sentences Warthog enforces — each with a Pause (or Resume) and a Delete — and BUILD
// a new rule from a template, previewing it as a sentence before saving and scoping
// it to all agents or chosen agents. The templates are the brief's own: the
// "Ask me first" and "Never allow" rules (over the brief's action + condition
// choices), the four spending rules (a per-purchase limit, a budget per agent per
// day/week/month, an allowed-merchants-only list and a blocked-merchants list) and an
// approval-expiry setting.
//
// This is the PURE, prop-driven VIEW (a Client Component in the app): it renders the
// screen from its props so it can be pinned without a browser, a session or any
// server plumbing. The real persistence/apply plumbing (pausing, deleting, saving a
// new rule, and the live state as the person switches templates) lives in the server
// composition root and a sibling actions module wired by a LATER task; the controls
// here are native, user-adjustable form controls whose initial state is driven by the
// `draft` prop — exactly the precedent the sibling consent view set (a chosen template
// drives the initial render of a conceptually-interactive screen).
//
// A rule reads back through the one-source-of-truth pure renderer `ruleSentence`
// (@/domain/rules/rules) — this view hard-codes no ask-first / never-allow wording;
// it computes the sentence from the draft and reflects it. Colour comes from the
// design tokens (globals.css) — never a raw hex.

// One existing rule, as the Rules page read hands it back: its id, its exact plain
// sentence, its scope (all agents or a chosen agent) and its lifecycle status.
export type RulesViewRule = {
  id: string;
  sentence: string;
  scope: RuleScope;
  status: "active" | "paused";
};

// A connected agent, offered as a "chosen agents" scope choice.
export type RulesViewAgent = { id: string; name: string };

// The initially-active create-form template, its values and its scope. The two rule
// templates carry the brief's action + optional condition; the spending templates and
// the expiry setting carry their own figures/merchants.
export type RuleDraft =
  | { template: "ask_first"; scope: RuleScope; action: RuleAction; condition?: RuleCondition }
  | { template: "never_allow"; scope: RuleScope; action: RuleAction; condition?: RuleCondition }
  | { template: "per_purchase_limit"; scope: RuleScope; amount: number }
  | { template: "agent_budget"; scope: RuleScope; amount: number; period: PeriodKind }
  | { template: "allowed_merchants"; scope: RuleScope; merchants: readonly string[] }
  | { template: "blocked_merchants"; scope: RuleScope; merchants: readonly string[] }
  | { template: "approval_expiry"; scope: RuleScope; minutes: number };

export type RulesViewProps = {
  // the person's EXISTING rules, each read back verbatim with a Pause/Resume + Delete.
  rules: ReadonlyArray<RulesViewRule>;
  // the person's connected agents, offered as the "chosen agents" scope choices.
  agents: ReadonlyArray<RulesViewAgent>;
  // the initially-active template, its values and its scope; drives the preview and
  // the initial controls. Omitted lets the view pick its own default.
  draft?: RuleDraft;
  // the person's currency label (e.g. "A$").
  currency?: string;
};

type TemplateKind = RuleDraft["template"];

// The default create-form template when the caller gives no draft.
const DEFAULT_DRAFT: RuleDraft = {
  template: "ask_first",
  scope: { type: "any_agent" },
  action: { type: "send_message", channel: "email" },
};

// Every template the create form offers, in the brief's own plain words.
const TEMPLATES: ReadonlyArray<{ value: TemplateKind; label: string; description: string }> = [
  { value: "ask_first", label: "Ask me first", description: "Warthog checks with you before the agent goes ahead." },
  { value: "never_allow", label: "Never allow", description: "Warthog stops it outright — no approval offered." },
  { value: "per_purchase_limit", label: "Per-purchase limit", description: "Cap how much the agent can spend on a single purchase." },
  { value: "agent_budget", label: "Budget per agent", description: "Cap what the agent can spend over a day, week or month." },
  { value: "allowed_merchants", label: "Allowed merchants only", description: "The agent can only pay the merchants you list." },
  { value: "blocked_merchants", label: "Blocked merchants", description: "The agent can never pay the merchants you list." },
  { value: "approval_expiry", label: "Approval expiry", description: "How long an approval stays open before it lapses." },
];

// The brief's six action choices under a rule template.
const ACTIONS: ReadonlyArray<{ value: RuleAction["type"]; label: string }> = [
  { value: "send_message", label: "Send a message" },
  { value: "specific_tool", label: "Use a specific tool" },
  { value: "service_tool", label: "Use any tool of a service" },
  { value: "any_change", label: "Make any change" },
  { value: "card_request", label: "Request a card" },
  { value: "high_tier_request", label: "Request a high-tier identity detail" },
];

// The three budget periods the brief names.
const PERIODS: ReadonlyArray<{ value: PeriodKind; label: string }> = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

// The condition choices a rule template can carry, in plain words.
const CONDITIONS: ReadonlyArray<{ value: RuleCondition["type"] | "none"; label: string }> = [
  { value: "none", label: "Any time" },
  { value: "recipient_is", label: "When the recipient is a certain address" },
  { value: "recipient_in_domain", label: "When the recipient is at a domain" },
  { value: "amount_over", label: "When the amount is over a figure" },
  { value: "merchant_in", label: "When the merchant is in a list" },
  { value: "merchant_not_in", label: "When the merchant is not in a list" },
];

function subjectOf(scope: RuleScope): string {
  return scope.type === "any_agent" ? "any agent" : scope.name;
}

// The current draft's starting value, for the condition's value field.
function conditionValueText(condition: RuleCondition | undefined): string {
  if (!condition) return "";
  switch (condition.type) {
    case "recipient_is":
      return condition.address;
    case "recipient_in_domain":
      return condition.domain;
    case "amount_over":
      return String(condition.amount);
    case "merchant_in":
    case "merchant_not_in":
      return condition.merchants.join(", ");
  }
}

// The exact sentence the chosen draft reads back as, previewed before saving. Rule
// templates flow through the one-source-of-truth renderer; the spending and expiry
// templates are worded here around their figures/merchants/minutes.
function previewSentence(draft: RuleDraft, currency: string): string {
  const subject = subjectOf(draft.scope);
  switch (draft.template) {
    case "ask_first":
    case "never_allow":
      return ruleSentence({
        kind: draft.template,
        scope: draft.scope,
        action: draft.action,
        condition: draft.condition,
      });
    case "per_purchase_limit":
      return `Ask me before ${subject} spends more than ${currency}${draft.amount} on a single purchase`;
    case "agent_budget":
      return `Limit ${subject} to ${currency}${draft.amount} per ${draft.period}`;
    case "allowed_merchants":
      return `Only allow ${subject} to use a card at ${draft.merchants.join(", ")}`;
    case "blocked_merchants":
      return `Never allow ${subject} to use a card at ${draft.merchants.join(", ")}`;
    case "approval_expiry":
      return `Approvals expire after ${draft.minutes} minutes`;
  }
}

// One choice in a radio group: a native, user-adjustable radio whose initial checked
// state reflects the draft. The visible label text IS the control's accessible name.
function Choice({
  name,
  value,
  checked,
  label,
  description,
}: {
  name: string;
  value: string;
  checked: boolean;
  label: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-3 rounded-card border border-line bg-surface p-3">
      <input
        type="radio"
        name={name}
        value={value}
        defaultChecked={checked}
        className="mt-1 h-4 w-4 shrink-0 accent-accent"
      />
      <span className="flex flex-col gap-0.5">
        <span className="font-medium text-fg">{label}</span>
        {description ? <span className="text-sm text-fg-muted">{description}</span> : null}
      </span>
    </label>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold text-fg">{children}</h2>;
}

export function RulesView({ rules, agents, draft = DEFAULT_DRAFT, currency = "A$" }: RulesViewProps) {
  const active = draft.template;
  const isRuleTemplate = draft.template === "ask_first" || draft.template === "never_allow";
  const preview = previewSentence(draft, currency);

  return (
    <section className="flex flex-col gap-8">
      {/* ----- Existing rules, each read back as its exact plain sentence ----- */}
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold text-fg">Your rules</h1>
        {rules.length === 0 ? (
          <EmptyState
            heading="No rules yet"
            description="Build your first rule from a template below."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {rules.map((rule) => (
              <li key={rule.id}>
                <Card className="flex flex-col gap-3">
                  <p className="text-fg">{rule.sentence}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {rule.status === "paused" ? (
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-fg-muted">
                        <PauseCircle aria-hidden={true} className="h-4 w-4 shrink-0" />
                        Paused
                      </span>
                    ) : null}
                    {rule.status === "active" ? (
                      <Button variant="secondary" type="button">
                        <Pause aria-hidden={true} className="h-4 w-4 shrink-0" />
                        Pause
                      </Button>
                    ) : (
                      <Button variant="secondary" type="button">
                        <Play aria-hidden={true} className="h-4 w-4 shrink-0" />
                        Resume
                      </Button>
                    )}
                    <Button variant="secondary" type="button">
                      <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
                      Delete
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ----- Create form: build a rule from a template, previewed as a sentence ----- */}
      <div className="flex flex-col gap-6">
        <h2 className="text-lg font-semibold text-fg">New rule</h2>

        {/* The template picker — always offers every template. */}
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-2 text-sm font-medium text-fg">Choose a template</legend>
          <div className="flex flex-col gap-2">
            {TEMPLATES.map((t) => (
              <Choice
                key={t.value}
                name="rule-template"
                value={t.value}
                checked={active === t.value}
                label={t.label}
                description={t.description}
              />
            ))}
          </div>
        </fieldset>

        {/* A rule template offers the brief's action and condition choices. */}
        {draft.template === "ask_first" || draft.template === "never_allow" ? (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="pb-2 text-sm font-medium text-fg">What the agent is doing</legend>
              <div className="flex flex-col gap-2">
                {ACTIONS.map((a) => (
                  <Choice
                    key={a.value}
                    name="rule-action"
                    value={a.value}
                    checked={draft.action.type === a.value}
                    label={a.label}
                  />
                ))}
              </div>
            </fieldset>

            <fieldset className="flex flex-col gap-2">
              <legend className="pb-2 text-sm font-medium text-fg">When it applies</legend>
              <select
                name="rule-condition"
                defaultValue={draft.condition?.type ?? "none"}
                className="min-h-11 w-full rounded-card border border-line bg-surface px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                {CONDITIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              {draft.condition ? (
                <Field label="Condition detail" defaultValue={conditionValueText(draft.condition)} />
              ) : null}
            </fieldset>
          </>
        ) : null}

        {/* The per-purchase spending limit. */}
        {draft.template === "per_purchase_limit" ? (
          <Field
            label={`Spending limit per purchase (${currency})`}
            type="number"
            min={0}
            inputMode="numeric"
            defaultValue={draft.amount}
          />
        ) : null}

        {/* A budget per agent, over a day, week or month. */}
        {draft.template === "agent_budget" ? (
          <>
            <Field
              label={`Budget per agent (${currency})`}
              type="number"
              min={0}
              inputMode="numeric"
              defaultValue={draft.amount}
            />
            <fieldset className="flex flex-col gap-2">
              <legend className="pb-2 text-sm font-medium text-fg">Budget period</legend>
              <div className="flex flex-wrap gap-2">
                {PERIODS.map((p) => (
                  <label
                    key={p.value}
                    className="inline-flex items-center gap-2 rounded-card border border-line bg-surface px-3 py-2"
                  >
                    <input
                      type="radio"
                      name="budget-period"
                      value={p.value}
                      defaultChecked={draft.period === p.value}
                      className="h-4 w-4 accent-accent"
                    />
                    <span className="text-fg">{p.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        ) : null}

        {/* An allowed-only or blocked merchant list. */}
        {draft.template === "allowed_merchants" || draft.template === "blocked_merchants" ? (
          <Field
            label={draft.template === "allowed_merchants" ? "Allowed merchants" : "Blocked merchants"}
            placeholder="e.g. BoxCo, MoveIt"
            defaultValue={draft.merchants.join(", ")}
          />
        ) : null}

        {/* How long an approval stays open before it expires. */}
        {draft.template === "approval_expiry" ? (
          <Field
            label="Expire approvals after (minutes)"
            type="number"
            min={1}
            inputMode="numeric"
            defaultValue={draft.minutes}
          />
        ) : null}

        {/* Scope — all agents or a chosen agent. */}
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-2 text-sm font-medium text-fg">Which agents</legend>
          <div className="flex flex-col gap-2">
            <Choice
              name="rule-scope"
              value="any_agent"
              checked={draft.scope.type === "any_agent"}
              label="All agents"
            />
            {agents.map((agent) => (
              <Choice
                key={agent.id}
                name="rule-scope"
                value={agent.id}
                checked={draft.scope.type === "agent" && draft.scope.agentId === agent.id}
                label={agent.name}
              />
            ))}
          </div>
        </fieldset>

        {/* The preview — the exact sentence this rule reads back as, before saving. */}
        <div className="flex flex-col gap-1.5 rounded-card border border-line bg-surface-muted p-3">
          <SectionHeading>Preview</SectionHeading>
          <p className="text-fg">{preview}</p>
        </div>

        {/* The one accent action: add the new rule. */}
        <Button type="button" variant="primary">
          <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
          Add rule
        </Button>
      </div>
    </section>
  );
}

export default RulesView;
