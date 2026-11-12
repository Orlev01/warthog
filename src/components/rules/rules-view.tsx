"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { ArrowRight, Pause, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field, Label } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty";
import { FormSubmit } from "@/components/ui/form-submit";
import { ActiveFilters, FilterLinks } from "@/components/ui/filter-links";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { ViewPanels } from "@/components/ui/view-tabs";
import {
  ruleSentence,
  type RuleKind,
  type RuleScope,
  type RuleAction,
  type RuleCondition,
  type MessageChannel,
} from "@/domain/rules/rules";
import { RuleKindBadge, RuleStatusLabel } from "./rule-badges";
import {
  RULE_STATUS_FILTERS,
  RULE_STATUS_LABELS,
  groupRulesByScope,
  rulesStatusHref,
  type RuleStatusFilter,
} from "./rules-organise";

// E12-S16 / E12-S17 — Rules view component (design §8; brief "Rules and approvals").
//
// The Rules & budgets screen, in three in-page views (ViewPanels; the builder stays mounted
// so a draft survives switching):
//   • Your rules — every rule read back as the exact plain sentence Warthog enforces,
//     grouped by scope (all agents first, then each agent by name), filterable by status
//     (?status=active|paused), each with its kind and status in words, a live Pause
//     (active rules) and a Delete behind a confirmation;
//   • New rule — build an "Ask me first" or "Never allow" rule, previewed as a sentence
//     before saving and scoped to all agents or a chosen agent;
//   • Budgets — links to each agent's real card-budget control (its workspace Spending
//     section) and to the other places spending is limited or reviewed.
//
// The rules store holds only the two rule kinds. Per-purchase caps and merchant lists are
// expressed as card-request rules with an amount or merchant condition; there is no
// separate per-purchase, merchant-list or approval-expiry setting, so none is offered.
//
// This is the prop-driven VIEW (a Client Component): it renders the screen from its
// props so it can be pinned without a browser or a session. Persistence lives in the
// server composition root + the sibling `actions` module; the page binds the rule server
// actions through the action props. A rule reads back through the one-source-of-truth
// renderer `ruleSentence`. Colour comes from the design tokens — never a raw hex.

// One existing rule, as the Rules page read hands it back: its id, its exact plain
// sentence, its scope (all agents or a chosen agent), its kind and its lifecycle status.
export type RulesViewRule = {
  id: string;
  sentence: string;
  scope: RuleScope;
  status: "active" | "paused";
  kind: RuleKind;
};

// A connected agent: `id` is the connection id a chosen-agent scope matches on (what a
// scope choice posts); `workspaceId` is the agent's own id, for links to its workspace.
export type RulesViewAgent = { id: string; name: string; workspaceId?: string };

// A server action a rule form submits to (the page binds the real one; the view
// renders a live control either way). Optional — an unbound control still renders.
export type RuleFormAction = (formData: FormData) => void | Promise<void>;

// The initially-active create-form template, its action, optional condition and scope.
export type RuleDraft =
  | { template: "ask_first"; scope: RuleScope; action: RuleAction; condition?: RuleCondition }
  | { template: "never_allow"; scope: RuleScope; action: RuleAction; condition?: RuleCondition };

export type RulesViewProps = {
  // the person's EXISTING rules, each read back verbatim with a Pause + Delete.
  rules: ReadonlyArray<RulesViewRule>;
  // the person's connected agents, offered as the "chosen agents" scope choices.
  agents: ReadonlyArray<RulesViewAgent>;
  // the initially-active template, its values and its scope; drives the preview and
  // the initial controls. Omitted lets the view pick its own default.
  draft?: RuleDraft;
  // the person's currency label (e.g. "AUD").
  currency?: string;
  // the view to open (?view=); validated against the known keys, else the rules list.
  initialView?: string;
  // the status filter in force (?status=); omitted shows every rule.
  statusFilter?: RuleStatusFilter;
  // the four rule server actions the page binds (create the new rule; update, pause
  // or delete an existing one). Optional so the view renders without a session.
  createAction?: RuleFormAction;
  updateAction?: RuleFormAction;
  pauseAction?: RuleFormAction;
  deleteAction?: RuleFormAction;
};

type RuleTemplate = RuleDraft["template"];

// The default create-form template when the caller gives no draft.
const DEFAULT_DRAFT: RuleDraft = {
  template: "ask_first",
  scope: { type: "any_agent" },
  action: { type: "send_message", channel: "email" },
};

// The two templates the create form offers, in the brief's own plain words.
const TEMPLATES: ReadonlyArray<{ value: RuleTemplate; label: string; description: string }> = [
  { value: "ask_first", label: "Ask me first", description: "Warthog checks with you before the agent goes ahead." },
  { value: "never_allow", label: "Never allow", description: "Warthog stops it outright — no approval offered." },
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
function previewSentence(draft: RuleDraft): string {
  return ruleSentence({
    kind: draft.template,
    scope: draft.scope,
    action: draft.action,
    condition: draft.condition,
  });
}

// The builder's state: the draft and the raw text of its condition detail field.
export interface RuleBuilderState { draft: RuleDraft; detail: string }
export type RuleBuilderEvent =
  | { type: "template"; template: RuleTemplate }
  | { type: "action"; action: RuleAction["type"] }
  | { type: "channel"; channel: MessageChannel }
  | { type: "target"; value: string }
  | { type: "condition"; condition: RuleCondition["type"] | "none" }
  | { type: "detail"; value: string }
  | { type: "scope"; scope: RuleScope };
export function createRuleBuilderState(draft: RuleDraft = DEFAULT_DRAFT): RuleBuilderState {
  return { draft, detail: conditionValueText(draft.condition) };
}
function conditionFromDetail(type: RuleCondition["type"], value: string): RuleCondition {
  switch (type) {
    case "recipient_is": return { type, address: value };
    case "recipient_in_domain": return { type, domain: value };
    case "amount_over": return { type, amount: Number.isFinite(Number(value)) ? Number(value) : 0 };
    case "merchant_in": case "merchant_not_in": return { type, merchants: value.split(",").map((part) => part.trim()).filter(Boolean) };
  }
}
export function updateRuleBuilder(state: RuleBuilderState, event: RuleBuilderEvent): RuleBuilderState {
  const draft = state.draft;
  switch (event.type) {
    case "template": return { ...state, draft: { ...draft, template: event.template } };
    case "scope": return { ...state, draft: { ...draft, scope: event.scope } };
    case "action": {
      const type = event.action;
      const action: RuleAction = type === "send_message" ? { type, channel: "email" } : type === "specific_tool" ? { type, tool: "" } : type === "service_tool" ? { type, service: "" } : { type };
      return { ...state, draft: { ...draft, action } };
    }
    case "channel": return draft.action.type === "send_message" ? { ...state, draft: { ...draft, action: { type: "send_message", channel: event.channel } } } : state;
    case "target": {
      const action = draft.action.type === "specific_tool" ? { type: "specific_tool" as const, tool: event.value } : draft.action.type === "service_tool" ? { type: "service_tool" as const, service: event.value } : draft.action;
      return { ...state, draft: { ...draft, action } };
    }
    case "condition": {
      const { condition: _previous, ...base } = draft;
      return { detail: "", draft: event.condition === "none" ? base : { ...base, condition: conditionFromDetail(event.condition, "") } };
    }
    case "detail": return draft.condition ? { detail: event.value, draft: { ...draft, condition: conditionFromDetail(draft.condition.type, event.value) } } : state;
  }
}
export function isRuleBuilderComplete(state: RuleBuilderState): boolean {
  const draft = state.draft;
  if (draft.action.type === "specific_tool" && !draft.action.tool.trim()) return false;
  if (draft.action.type === "service_tool" && !draft.action.service.trim()) return false;
  if (!draft.condition) return true;
  if (!state.detail.trim()) return false;
  if (draft.condition.type === "amount_over") return Number.isFinite(Number(state.detail)) && Number(state.detail) >= 0;
  if (draft.condition.type === "merchant_in" || draft.condition.type === "merchant_not_in") return draft.condition.merchants.length > 0;
  return true;
}
function PendingRuleFields({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return <fieldset disabled={pending} className="contents">{children}</fieldset>;
}
function AddRuleButton({ complete }: { complete: boolean }) {
  const { pending } = useFormStatus();
  return <Button type="submit" variant="primary" disabled={!complete || pending}><Plus aria-hidden={true} className="h-4 w-4 shrink-0" />{pending ? "Adding rule…" : "Add rule"}</Button>;
}

// One choice in a radio group: a native, user-adjustable radio whose checked state
// reflects the draft.
function Choice({
  name,
  value,
  checked,
  label,
  description,
  onChange,
}: {
  name: string;
  value: string;
  checked: boolean;
  label: React.ReactNode;
  description?: React.ReactNode;
  onChange?: () => void;
}) {
  return (
    <label className="flex items-start gap-3 rounded-card border border-line bg-surface p-3">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange ?? (() => {})}
        className="mt-1 h-4 w-4 shrink-0 accent-accent"
      />
      <span className="flex min-w-0 flex-col gap-0.5 [overflow-wrap:anywhere]">
        <span className="font-medium text-fg">{label}</span>
        {description ? <span className="text-sm text-fg-muted">{description}</span> : null}
      </span>
    </label>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold text-fg">{children}</h2>;
}

// A text link with a full-height touch target.
const LINK_CLASS =
  "inline-flex min-h-11 w-fit items-center gap-1.5 text-sm font-medium text-fg underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

// A <summary> that reads as a secondary button (the native disclosure stays keyboard
// operable; the marker is hidden because the label says what opens).
const SUMMARY_BUTTON_CLASS =
  "inline-flex min-h-11 w-fit cursor-pointer list-none items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-medium text-fg hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg [&::-webkit-details-marker]:hidden";

// The status filter a row's Pause/Delete form returns to, so acting on a filtered list
// lands back on it (the page validates the value again before redirecting).
function ReturnStatus({ status }: { status: RuleStatusFilter | undefined }) {
  return status ? <input type="hidden" name="return-status" value={status} /> : null;
}

function RuleRow({
  rule,
  statusFilter,
  pauseAction,
  deleteAction,
}: {
  rule: RulesViewRule;
  statusFilter: RuleStatusFilter | undefined;
  pauseAction?: RuleFormAction;
  deleteAction?: RuleFormAction;
}) {
  return (
    <li className={LIST_ROW}>
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-fg">{rule.sentence}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <RuleKindBadge kind={rule.kind} />
          <RuleStatusLabel status={rule.status} />
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {rule.status === "active" ? (
            <form action={pauseAction}>
              <input type="hidden" name="rule-id" value={rule.id} />
              <ReturnStatus status={statusFilter} />
              <Button variant="secondary" type="submit">
                <Pause aria-hidden={true} className="h-4 w-4 shrink-0" />
                Pause
              </Button>
            </form>
          ) : null}
          {/* Delete cannot be undone, so it asks first (the same native disclosure the
          life-admin records use) and then posts to the same delete handler. */}
          <details className="min-w-0 open:basis-full">
            <summary className={SUMMARY_BUTTON_CLASS}>
              <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
              Delete
            </summary>
            <div className="mt-2 flex flex-col gap-3 rounded-card border border-line bg-surface-muted p-3">
              <p className="text-sm text-fg">Delete this rule? Warthog stops applying it, and this cannot be undone.</p>
              <form action={deleteAction}>
                <input type="hidden" name="rule-id" value={rule.id} />
                <ReturnStatus status={statusFilter} />
                <FormSubmit variant="secondary" preserveFocus pendingLabel="Deleting rule…">
                  Delete rule
                </FormSubmit>
              </form>
            </div>
          </details>
        </div>
      </div>
    </li>
  );
}

// "Your rules": the status filter, then the rules grouped by scope.
function RulesList({
  rules,
  agents,
  statusFilter,
  pauseAction,
  deleteAction,
}: {
  rules: ReadonlyArray<RulesViewRule>;
  agents: ReadonlyArray<RulesViewAgent>;
  statusFilter: RuleStatusFilter | undefined;
  pauseAction?: RuleFormAction;
  deleteAction?: RuleFormAction;
}) {
  if (rules.length === 0) {
    return (
      <EmptyState
        heading="No rules yet"
        description="Rules tell Warthog when to ask you first and what to stop outright. Build your first one in the New rule tab."
      />
    );
  }
  const shown = statusFilter ? rules.filter((rule) => rule.status === statusFilter) : rules;
  const groups = groupRulesByScope(shown);
  const workspaceOf = new Map(agents.map((agent) => [agent.id, agent.workspaceId]));
  const allHref = rulesStatusHref(undefined);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <FilterLinks
          label="Filter rules by status"
          items={[
            { label: "All", href: allHref, active: statusFilter === undefined, count: rules.length },
            ...RULE_STATUS_FILTERS.map((status) => ({
              label: RULE_STATUS_LABELS[status],
              href: rulesStatusHref(status),
              active: statusFilter === status,
              count: rules.filter((rule) => rule.status === status).length,
            })),
          ]}
        />
        <ActiveFilters
          clearHref={allHref}
          filters={statusFilter ? [{ label: `Status: ${RULE_STATUS_LABELS[statusFilter]}`, removeHref: allHref }] : []}
        />
      </div>
      {groups.length === 0 && statusFilter ? (
        <EmptyState
          heading={`No ${RULE_STATUS_LABELS[statusFilter].toLowerCase()} rules`}
          description="None of your rules match this filter."
          action={
            <a href={allHref} className={LINK_CLASS}>
              Show all rules
            </a>
          }
        />
      ) : (
        groups.map((group, index) => {
          const workspaceId = group.agentId ? workspaceOf.get(group.agentId) : undefined;
          return (
            <ListGroup
              key={group.key}
              // Index-based, so an agent's connection id never reaches the markup.
              id={`rules-group-${index}`}
              title={group.title}
              count={group.rules.length}
              summary={
                group.agentId === null ? (
                  "Apply to every agent, including any you connect later."
                ) : workspaceId ? (
                  <a href={`/agents/${encodeURIComponent(workspaceId)}?section=rules`} className={LINK_CLASS}>
                    {`Open in ${group.title}'s workspace`}
                  </a>
                ) : undefined
              }
            >
              {group.rules.map((rule) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  statusFilter={statusFilter}
                  pauseAction={pauseAction}
                  deleteAction={deleteAction}
                />
              ))}
            </ListGroup>
          );
        })
      )}
    </div>
  );
}

// "Budgets": where each spending limit really lives. Only per-agent card budgets are
// settings; caps and merchant lists are card-request rules built in New rule.
function BudgetsPanel({ agents }: { agents: ReadonlyArray<RulesViewAgent> }) {
  return (
    <div className="flex flex-col gap-6">
      {agents.length > 0 ? (
        <ListGroup
          id="rules-budgets"
          title="Card budgets"
          count={agents.length}
          summary="Each agent has its own card budget per day, week or month, set in its Spending section. You still approve every card release."
        >
          {agents.map((agent) => (
            <li key={agent.id} className={`${LIST_ROW} sm:flex-row sm:items-center sm:justify-between sm:gap-4`}>
              <span className="font-medium text-fg">{agent.name}</span>
              <a
                href={agent.workspaceId ? `/agents/${encodeURIComponent(agent.workspaceId)}?section=spending` : "/agents"}
                className={LINK_CLASS}
              >
                {`Set ${agent.name}'s budget`}
                <ArrowRight aria-hidden={true} className="h-4 w-4 shrink-0" />
              </a>
            </li>
          ))}
        </ListGroup>
      ) : (
        <section aria-labelledby="rules-budgets-heading" className="flex flex-col gap-1">
          <h2 id="rules-budgets-heading" className="text-lg font-semibold text-fg">Card budgets</h2>
          <p className="text-sm text-fg-muted">
            Each agent gets its own card budget. No agents are connected yet.{" "}
            <a href="/agents/connect" className="font-medium text-fg underline underline-offset-4">
              Connect an agent
            </a>
            .
          </p>
        </section>
      )}
      <ListGroup id="rules-other-limits" title="Other limits">
        <li className={LIST_ROW}>
          <span className="font-medium text-fg">Per-purchase caps and merchant lists</span>
          <span className="text-sm text-fg-muted">
            Add a Never allow rule in New rule: choose &ldquo;Request a card&rdquo;, then a condition on the amount or the merchant.
          </span>
        </li>
        <li className={LIST_ROW}>
          <span className="font-medium text-fg">Household budget and member limits</span>
          <a href="/household" className={LINK_CLASS}>
            Manage in Household
            <ArrowRight aria-hidden={true} className="h-4 w-4 shrink-0" />
          </a>
        </li>
        <li className={LIST_ROW}>
          <span className="font-medium text-fg">What each agent has spent</span>
          <a href="/spending" className={LINK_CLASS}>
            Review in Spending
            <ArrowRight aria-hidden={true} className="h-4 w-4 shrink-0" />
          </a>
        </li>
      </ListGroup>
    </div>
  );
}

export function RulesView({
  rules,
  agents,
  draft: initialDraft = DEFAULT_DRAFT,
  currency = "AUD",
  initialView,
  statusFilter,
  createAction,
  pauseAction,
  deleteAction,
}: RulesViewProps) {
  const [builder, dispatch] = React.useReducer(updateRuleBuilder, initialDraft, createRuleBuilderState);
  const draft = builder.draft;
  const complete = isRuleBuilderComplete(builder);

  // Create form: build a rule from a template, previewed as a sentence before saving.
  const newRule = (
    <form action={createAction} className="flex flex-col gap-6">
      <PendingRuleFields>
        <p className="text-sm text-fg-muted">Amount conditions use your account currency ({currency}).</p>

        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="pb-2 text-sm font-medium text-fg">Choose a template</legend>
          <div className="flex flex-col gap-2">
            {TEMPLATES.map((t) => (
              <Choice
                key={t.value}
                name="rule-template"
                value={t.value}
                checked={draft.template === t.value}
                onChange={() => dispatch({ type: "template", template: t.value })}
                label={t.label}
                description={t.description}
              />
            ))}
          </div>
        </fieldset>

        {/* The brief's six action choices. */}
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="pb-2 text-sm font-medium text-fg">What the agent is doing</legend>
          <p className="text-sm text-fg-muted">Rules govern requests through Warthog. If a tool cannot identify its message type, recipient or amount, an applicable restriction also applies to that uncertain change. This can block or hold more actions than a tool with verified details.</p>
          <div className="flex flex-col gap-2">
            {ACTIONS.map((a) => (
              <Choice
                key={a.value}
                name="rule-action"
                value={a.value}
                checked={draft.action.type === a.value}
                onChange={() => dispatch({ type: "action", action: a.value })}
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
              value={draft.action.channel}
              onChange={(event) => dispatch({ type: "channel", channel: event.target.value as MessageChannel })}
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
            value={draft.action.type === "specific_tool" ? draft.action.tool : draft.action.service}
            required
            onChange={(event) => dispatch({ type: "target", value: event.target.value })}
          />
        ) : null}

        {/* When the rule applies. */}
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="pb-2 text-sm font-medium text-fg">When it applies</legend>
          <select
            name="rule-condition"
            aria-label="When it applies"
            value={draft.condition?.type ?? "none"}
            onChange={(event) => dispatch({ type: "condition", condition: event.target.value as RuleCondition["type"] | "none" })}
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
              label={draft.condition.type === "amount_over" ? `Amount (${currency})` : "Condition detail"}
              name="rule-condition-detail"
              value={builder.detail}
              type={draft.condition.type === "amount_over" ? "number" : "text"}
              min={draft.condition.type === "amount_over" ? 0 : undefined}
              step={draft.condition.type === "amount_over" ? "any" : undefined}
              required
              onChange={(event) => dispatch({ type: "detail", value: event.target.value })}
            />
          ) : null}
        </fieldset>

        {/* Scope — all agents or a chosen agent. */}
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="pb-2 text-sm font-medium text-fg">Which agents</legend>
          <div className="flex flex-col gap-2">
            <Choice
              name="rule-scope"
              value="any_agent"
              checked={draft.scope.type === "any_agent"}
              onChange={() => dispatch({ type: "scope", scope: { type: "any_agent" } })}
              label="All agents"
            />
            {agents.map((agent) => (
              <Choice
                key={agent.id}
                name="rule-scope"
                value={agent.id}
                checked={draft.scope.type === "agent" && draft.scope.agentId === agent.id}
                onChange={() => dispatch({ type: "scope", scope: { type: "agent", agentId: agent.id, name: agent.name } })}
                label={agent.name}
              />
            ))}
          </div>
        </fieldset>

        {/* The preview — the exact sentence this rule reads back as, before saving. */}
        <div className="flex flex-col gap-1.5 rounded-card border border-line bg-surface-muted p-3">
          <SectionHeading>Preview</SectionHeading>
          <p className="text-fg" aria-live="polite">{complete ? previewSentence(draft) : "Complete the action and condition details to preview your rule."}</p>
        </div>

        {/* The one accent action: add the new rule. */}
        <AddRuleButton complete={complete} />
      </PendingRuleFields>
    </form>
  );

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Rules &amp; budgets</h1>
        <p className="text-sm text-fg-muted">
          Rules decide when Warthog asks you first and what it never allows. Rules for all agents apply to every agent; an agent&rsquo;s own rules add to them.
        </p>
      </header>
      <ViewPanels
        label="Rules and budgets"
        initialTab={initialView}
        defaultTab="rules"
        tabs={[
          {
            key: "rules",
            label: `Your rules (${rules.length})`,
            content: (
              <RulesList
                rules={rules}
                agents={agents}
                statusFilter={statusFilter}
                pauseAction={pauseAction}
                deleteAction={deleteAction}
              />
            ),
          },
          { key: "new", label: "New rule", content: newRule },
          { key: "budgets", label: "Budgets", content: <BudgetsPanel agents={agents} /> },
        ]}
      />
    </section>
  );
}

export default RulesView;
