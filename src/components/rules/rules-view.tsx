"use client";

import * as React from "react";
import { Pause, PauseCircle, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, Label } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty";
import {
  ruleSentence,
  type RuleScope,
  type RuleAction,
  type RuleCondition,
  type MessageChannel,
} from "@/domain/rules/rules";
import { type PeriodKind } from "@/domain/budget/budget";

// E12-S16 / E12-S17 — Rules view component (design §8; brief "Rules and approvals").
//
// The Rules screen lets a person READ BACK their existing rules as the exact plain
// sentences Warthog enforces — each with a live Pause (active rules) and a live
// Delete — and BUILD a new rule from a template, previewing it as a sentence before
// saving and scoping it to all agents or chosen agents.
//
// The rules the store holds are the brief's "Ask me first" and "Never allow" rules
// (over the brief's action + condition choices). The four spending rules (a
// per-purchase limit, a budget per agent, an allowed-merchants list and a
// blocked-merchants list) and the approval-expiry setting are configured ELSEWHERE
// (per agent / Spending / Settings), so on THIS screen they appear but DISABLED,
// each naming where it is set — never offered as a live choice that would post into
// a guaranteed error (E12-S17).
//
// This is the prop-driven VIEW (a Client Component): it renders the screen from its
// props so it can be pinned without a browser or a session. The real persistence
// lives in the server composition root + the sibling `actions` module; the page
// binds the four rule server actions (create / update / pause / delete) through the
// action props, and the `draft` prop drives which template is initially active +
// its values + scope. A rule reads back through the one-source-of-truth pure
// renderer `ruleSentence` — this view hard-codes no ask-first / never-allow
// wording. Colour comes from the design tokens (globals.css) — never a raw hex.

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

// A server action a rule form submits to (the page binds the real one; the view
// renders a live control either way). Optional — an unbound control still renders.
export type RuleFormAction = (formData: FormData) => void | Promise<void>;

// The initially-active create-form template, its values and its scope. The two rule
// templates carry the brief's action + optional condition; the spending templates
// and the expiry setting carry their own figures/merchants (set elsewhere).
export type RuleDraft =
  | { template: "ask_first"; scope: RuleScope; action: RuleAction; condition?: RuleCondition }
  | { template: "never_allow"; scope: RuleScope; action: RuleAction; condition?: RuleCondition }
  | { template: "per_purchase_limit"; scope: RuleScope; amount: number }
  | { template: "agent_budget"; scope: RuleScope; amount: number; period: PeriodKind }
  | { template: "allowed_merchants"; scope: RuleScope; merchants: readonly string[] }
  | { template: "blocked_merchants"; scope: RuleScope; merchants: readonly string[] }
  | { template: "approval_expiry"; scope: RuleScope; minutes: number };

export type RulesViewProps = {
  // the person's EXISTING rules, each read back verbatim with a Pause + Delete.
  rules: ReadonlyArray<RulesViewRule>;
  // the person's connected agents, offered as the "chosen agents" scope choices.
  agents: ReadonlyArray<RulesViewAgent>;
  // the initially-active template, its values and its scope; drives the preview and
  // the initial controls. Omitted lets the view pick its own default.
  draft?: RuleDraft;
  // the person's currency label (e.g. "A$").
  currency?: string;
  // the four rule server actions the page binds (create the new rule; update, pause
  // or delete an existing one). Optional so the view renders without a session.
  createAction?: RuleFormAction;
  updateAction?: RuleFormAction;
  pauseAction?: RuleFormAction;
  deleteAction?: RuleFormAction;
};

type TemplateKind = RuleDraft["template"];
type RuleTemplate = "ask_first" | "never_allow";
type NonRuleTemplate = Exclude<TemplateKind, RuleTemplate>;

// The default create-form template when the caller gives no draft.
const DEFAULT_DRAFT: RuleDraft = {
  template: "ask_first",
  scope: { type: "any_agent" },
  action: { type: "send_message", channel: "email" },
};

function isRuleTemplate(value: TemplateKind): value is RuleTemplate {
  return value === "ask_first" || value === "never_allow";
}

// Every template the create form offers, in the brief's own plain words. The two
// rule templates are live; the rest are shown disabled (set elsewhere).
const TEMPLATES: ReadonlyArray<{ value: TemplateKind; label: string; description: string }> = [
  { value: "ask_first", label: "Ask me first", description: "Warthog checks with you before the agent goes ahead." },
  { value: "never_allow", label: "Never allow", description: "Warthog stops it outright — no approval offered." },
  { value: "per_purchase_limit", label: "Per-purchase limit", description: "Cap how much the agent can spend on a single purchase." },
  { value: "agent_budget", label: "Budget per agent", description: "Cap what the agent can spend over a day, week or month." },
  { value: "allowed_merchants", label: "Allowed merchants only", description: "The agent can only pay the merchants you list." },
  { value: "blocked_merchants", label: "Blocked merchants", description: "The agent can never pay the merchants you list." },
  { value: "approval_expiry", label: "Approval expiry", description: "How long an approval stays open before it lapses." },
];

// Where each non-rule template is actually configured — shown as its one-line
// reason so a disabled choice is never a dead control (constitution: no dead
// controls; a control whose flow lives elsewhere says where).
const SET_ELSEWHERE: Record<NonRuleTemplate, string> = {
  per_purchase_limit: "Set a per-purchase spending limit for each agent in Spending.",
  agent_budget: "Set an agent's budget per day, week or month in Spending.",
  allowed_merchants: "Choose the merchants an agent may pay in Spending.",
  blocked_merchants: "Choose the merchants an agent may never pay in Spending.",
  approval_expiry: "Choose how long approvals stay open in Settings.",
};

// The brief's six action choices under a rule template.
const ACTIONS: ReadonlyArray<{ value: RuleAction["type"]; label: string }> = [
  { value: "send_message", label: "Send a message" },
  { value: "specific_tool", label: "Use a specific tool" },
  { value: "service_tool", label: "Use any tool of a service" },
  { value: "any_change", label: "Make any change" },
  { value: "card_request", label: "Request a card" },
  { value: "high_tier_request", label: "Request a high-tier identity detail" },
];

// The message channels a send-message action can cover.
const CHANNELS: ReadonlyArray<{ value: MessageChannel; label: string }> = [
  { value: "email", label: "Email" },
  { value: "chat", label: "Chat message" },
  { value: "post", label: "Post" },
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

// A native <select> on the design tokens, shared by the channel and condition
// pickers (one source of visual truth — never a parallel style).
const SELECT_CLASS =
  "min-h-11 w-full rounded-card border border-line bg-surface px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

// The current draft's starting value for the condition's detail field.
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

// The exact sentence a rule draft reads back as, previewed before saving — straight
// through the one-source-of-truth renderer, so the condition and the all-agents /
// chosen-agent scope all flow through.
function previewSentence(draft: Extract<RuleDraft, { template: RuleTemplate }>): string {
  return ruleSentence({
    kind: draft.template,
    scope: draft.scope,
    action: draft.action,
    condition: draft.condition,
  });
}

// One choice in a radio group: a native, user-adjustable radio whose initial checked
// state reflects the draft. A disabled choice (a template set elsewhere) uses the
// native `disabled` attribute so it reads as present-but-not-actionable.
function Choice({
  name,
  value,
  checked,
  label,
  description,
  disabled,
}: {
  name: string;
  value: string;
  checked: boolean;
  label: React.ReactNode;
  description?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-3 rounded-card border border-line bg-surface p-3">
      <input
        type="radio"
        name={name}
        value={value}
        defaultChecked={checked}
        disabled={disabled}
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

export function RulesView({
  rules,
  agents,
  draft = DEFAULT_DRAFT,
  createAction,
  pauseAction,
  deleteAction,
}: RulesViewProps) {
  const active = draft.template;

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
                    ) : (
                      <form action={pauseAction}>
                        <input type="hidden" name="rule-id" value={rule.id} />
                        <Button variant="secondary" type="submit">
                          <Pause aria-hidden={true} className="h-4 w-4 shrink-0" />
                          Pause
                        </Button>
                      </form>
                    )}
                    <form action={deleteAction}>
                      <input type="hidden" name="rule-id" value={rule.id} />
                      <Button variant="secondary" type="submit">
                        <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
                        Delete
                      </Button>
                    </form>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ----- Create form: build a rule from a template, previewed as a sentence ----- */}
      <form action={createAction} className="flex flex-col gap-6">
        <h2 className="text-lg font-semibold text-fg">New rule</h2>

        {/* The template picker — the two rule templates live, the rest disabled. */}
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-2 text-sm font-medium text-fg">Choose a template</legend>
          <div className="flex flex-col gap-2">
            {TEMPLATES.map((t) => (
              <Choice
                key={t.value}
                name="rule-template"
                value={t.value}
                checked={active === t.value}
                disabled={!isRuleTemplate(t.value)}
                label={t.label}
                // A disabled template says where it is actually set, in the state a person
                // sees (the default render), so it is never a dead control.
                description={
                  isRuleTemplate(t.value) ? t.description : SET_ELSEWHERE[t.value as NonRuleTemplate]
                }
              />
            ))}
          </div>
        </fieldset>

        {draft.template === "ask_first" || draft.template === "never_allow" ? (
          <>
            {/* The brief's six action choices. */}
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

            {/* A message channel, or the tool/service name the action names. */}
            {draft.action.type === "send_message" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rule-channel-field">Message channel</Label>
                <select
                  id="rule-channel-field"
                  name="rule-channel"
                  defaultValue={draft.action.channel}
                  className={SELECT_CLASS}
                >
                  {CHANNELS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {draft.action.type === "specific_tool" || draft.action.type === "service_tool" ? (
              <Field
                label={draft.action.type === "specific_tool" ? "Tool name" : "Service name"}
                name="rule-target"
                defaultValue={
                  draft.action.type === "specific_tool" ? draft.action.tool : draft.action.service
                }
              />
            ) : null}

            {/* When the rule applies. */}
            <fieldset className="flex flex-col gap-2">
              <legend className="pb-2 text-sm font-medium text-fg">When it applies</legend>
              <select
                name="rule-condition"
                defaultValue={draft.condition?.type ?? "none"}
                className={SELECT_CLASS}
              >
                {CONDITIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              {draft.condition ? (
                <Field
                  label="Condition detail"
                  name="rule-condition-detail"
                  defaultValue={conditionValueText(draft.condition)}
                />
              ) : null}
            </fieldset>

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
              <p className="text-fg">{previewSentence(draft)}</p>
            </div>

            {/* The one accent action: add the new rule. */}
            <Button type="submit" variant="primary">
              <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
              Add rule
            </Button>
          </>
        ) : (
          // A template that is set elsewhere: no submit (never posted into a
          // guaranteed error), with a one-line reason pointing to where it lives.
          <p className="rounded-card border border-line bg-surface-muted p-3 text-sm text-fg-muted">
            {SET_ELSEWHERE[draft.template]}
          </p>
        )}
      </form>
    </section>
  );
}

export default RulesView;
