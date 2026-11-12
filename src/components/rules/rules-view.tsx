"use client";

import * as React from "react";
import { ArrowRight, Bot, ListChecks, Pause, Plus, Trash2 } from "lucide-react";

import { buttonClasses } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Field, SelectField } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty";
import { Notice } from "@/components/ui/notice";
import { ActionForm, FormSubmit, PendingFormFields } from "@/components/ui/form-submit";
import { ActiveFilters, FilterLinks } from "@/components/ui/filter-links";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { ViewPanels } from "@/components/ui/view-tabs";
import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { DEFAULT_EXPIRY_MINUTES } from "@/domain/approvals/state-machine";
import { APPROVAL_EXPIRY_PRESETS, expiryDurationLabel } from "@/domain/approvals/expiry-copy";
import {
  ruleSentence,
  type RuleDisplayLabels,
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
  ruleLabelsFromChoices,
  rulesStatusHref,
  type RuleStatusFilter,
  type RuleTargetGroup,
} from "./rules-organise";

// E12-S16 / E12-S17 — Rules view component (design §8; brief "Rules and approvals").
//
// The Rules & budgets screen, in three in-page views (ViewPanels; the builder stays mounted
// so a draft survives switching):
//   • Your rules — every rule read back as the exact plain sentence Warthog enforces,
//     grouped by scope (all agents first, then each agent by name), filterable by status
//     (?status=active|paused), each with its kind and status in words, a live Pause
//     (active rules) and a Delete behind a confirmation; then the Approval expiry panel —
//     how long a held request waits for the person (brief: default 15 minutes, 2 minutes
//     to 24 hours), a labelled select of presets saved from the panel footer;
//   • New rule — build an "Ask me first" or "Never allow" rule, previewed as a sentence
//     before saving and scoped to all agents or a chosen agent;
//   • Budgets — links to each agent's real card-budget control (its workspace Spending
//     section) and to the other places spending is limited or reviewed.
//
// Layout (the UI/UX pass): the page title, its purpose and the three tabs share one heading
// band; the outcome notice follows it. The builder is one panel whose steps are divided by
// rules, with the preview as an inset and "Add rule" in its footer. The status filter is a
// bounded toolbar above the rule groups, and Budgets is panels too — no text on the canvas.
// A specific tool or a service is CHOSEN from the real ones (the page passes them; the
// server refuses any other name), never typed from memory.
//
// The rules store holds only the two rule kinds. Per-purchase caps and merchant lists are
// expressed as card-request rules with an amount or merchant condition; there is no
// separate per-purchase or merchant-list setting, so none is offered. The approval expiry
// is a setting of its own (not a rule template), shown next to the rules it times.
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

// One tool or service a rule may name, grouped for the builder's <optgroup>s (defined with
// the other shared Rules keys in ./rules-organise, so server code can read them too).
export type { RuleTargetChoice, RuleTargetGroup } from "./rules-organise";

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
  // the real tools and services a new rule may name (the page loads them). Omitted in a
  // prop-only render, where the choice lists are empty.
  toolChoices?: ReadonlyArray<RuleTargetGroup>;
  serviceChoices?: ReadonlyArray<RuleTargetGroup>;
  // the view to open (?view=); validated against the known keys, else the rules list.
  initialView?: string;
  // the status filter in force (?status=); omitted shows every rule.
  statusFilter?: RuleStatusFilter;
  // the outcome of the last change (a PageNotice), shown under the heading band.
  notice?: React.ReactNode;
  // the four rule server actions the page binds (create the new rule; update, pause
  // or delete an existing one). Optional so the view renders without a session.
  createAction?: RuleFormAction;
  updateAction?: RuleFormAction;
  pauseAction?: RuleFormAction;
  deleteAction?: RuleFormAction;
  // the person's approval expiry in minutes (the page loads it; 15 when omitted) and the
  // server action that saves a new one. Optional so the view renders without a session.
  approvalExpiryMinutes?: number;
  approvalExpiryAction?: RuleFormAction;
  // the person's text/email reminder (Settings › Notifications): whether it is on and how
  // long it waits. When the expiry is at or below that delay, the panel warns that the
  // reminder can't go out in time. Omitted, no warning is shown.
  approvalReminder?: ApprovalReminder;
};

export type ApprovalReminder = { readonly on: boolean; readonly delayMinutes: number };

// Where the reminder delay is set.
const NOTIFICATION_SETTINGS_HREF = "/settings/notifications";

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
  { value: "never_allow", label: "Never allow", description: "Warthog stops it outright, with no approval offered." },
];

// The brief's six action choices under a rule template.
const ACTIONS: ReadonlyArray<{ value: RuleAction["type"]; label: string }> = [
  { value: "send_message", label: "Send a message" },
  { value: "specific_tool", label: "Use a specific tool" },
  { value: "service_tool", label: "Use any tool of a service" },
  { value: "any_change", label: "Make any change" },
  { value: "card_request", label: "Request a card" },
  { value: "high_tier_request", label: "Ask for a protected detail" },
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
// chosen-agent scope all flow through. A tool or service is named by the label of its
// choice, as the saved rule is on the Rules list.
function previewSentence(draft: RuleDraft, labels: RuleDisplayLabels): string {
  return ruleSentence(
    {
      kind: draft.template,
      scope: draft.scope,
      action: draft.action,
      condition: draft.condition,
    },
    labels,
  );
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

// The real names a rule may use, when the caller knows them: a tool or service outside
// these lists can never complete the draft (the server refuses it too).
export type RuleBuilderTargets = { tools?: ReadonlyArray<RuleTargetGroup>; services?: ReadonlyArray<RuleTargetGroup> };

function offers(groups: ReadonlyArray<RuleTargetGroup> | undefined, value: string): boolean {
  return groups === undefined || groups.some((group) => group.choices.some((choice) => choice.value === value));
}

export function isRuleBuilderComplete(state: RuleBuilderState, targets: RuleBuilderTargets = {}): boolean {
  const draft = state.draft;
  if (draft.action.type === "specific_tool" && (!draft.action.tool.trim() || !offers(targets.tools, draft.action.tool))) return false;
  if (draft.action.type === "service_tool" && (!draft.action.service.trim() || !offers(targets.services, draft.action.service))) return false;
  if (!draft.condition) return true;
  if (!state.detail.trim()) return false;
  if (draft.condition.type === "amount_over") return Number.isFinite(Number(state.detail)) && Number(state.detail) >= 0;
  if (draft.condition.type === "merchant_in" || draft.condition.type === "merchant_not_in") return draft.condition.merchants.length > 0;
  return true;
}

// One choice in a radio group: a native, user-adjustable radio whose checked state
// reflects the draft. Inside the builder panel it is the inset level: a bordered option
// whose chosen state shows with a strong border and a muted fill, not colour alone.
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
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-card border border-line bg-surface p-3 hover:bg-surface-muted has-[:checked]:border-line-strong has-[:checked]:bg-surface-muted">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange ?? (() => {})}
        className="mt-0.5 h-4 w-4 shrink-0"
      />
      <span className="flex min-w-0 flex-col gap-0.5 [overflow-wrap:anywhere]">
        <span className="text-sm font-medium text-fg">{label}</span>
        {description ? <span className="text-sm text-fg-muted">{description}</span> : null}
      </span>
    </label>
  );
}

// One numbered step of the builder: a fieldset whose legend is the step's title, ruled off
// from the step above.
function Step({ legend, hint, children }: { legend: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 border-t border-line pt-5 first:border-t-0 first:pt-0">
      <legend className="wh-group-title float-left w-full">{legend}</legend>
      {hint ? <p className="clear-left max-w-prose text-sm text-fg-muted">{hint}</p> : null}
      <div className="clear-left flex min-w-0 flex-col gap-3">{children}</div>
    </fieldset>
  );
}

// A text link with a full-height touch target.
const LINK_CLASS =
  "inline-flex min-h-11 w-fit items-center gap-1.5 text-sm font-medium text-fg underline underline-offset-4";

// A <summary> that reads as a button (the native disclosure stays keyboard operable; the
// marker is hidden because the label says what opens).
function summaryClass(variant: "secondary" | "danger"): string {
  return buttonClasses({ variant, size: "sm", className: "w-fit list-none [&::-webkit-details-marker]:hidden" });
}

// A row form bound to its action when the page passes one (one guarded submission at a
// time); a plain form in a prop-only render.
function RowForm({ action, children }: { action?: RuleFormAction; children: React.ReactNode }) {
  return action ? <ActionForm action={action}>{children}</ActionForm> : <form>{children}</form>;
}

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
  const sentenceId = React.useId();
  return (
    <li className={LIST_ROW}>
      <div className="flex min-w-0 flex-col gap-2">
        <p id={sentenceId} className="text-fg">{rule.sentence}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <RuleKindBadge kind={rule.kind} />
          <RuleStatusLabel status={rule.status} />
        </div>
        <div className="flex flex-wrap items-start gap-2">
          {rule.status === "active" ? (
            <RowForm action={pauseAction}>
              <input type="hidden" name="rule-id" value={rule.id} />
              <ReturnStatus status={statusFilter} />
              <FormSubmit variant="secondary" size="sm" pendingLabel="Pausing…" aria-describedby={sentenceId}>
                <Pause aria-hidden={true} className="h-4 w-4 shrink-0" />
                Pause
              </FormSubmit>
            </RowForm>
          ) : null}
          {/* Delete cannot be undone, so it asks first (the same native disclosure the
          life-admin records use) and then posts to the same delete handler. */}
          <details className="min-w-0 open:basis-full">
            <summary className={summaryClass("danger")} aria-describedby={sentenceId}>
              <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
              Delete
            </summary>
            <div className="mt-2 flex flex-col gap-3 rounded-card bg-surface-muted p-4">
              <p className="text-sm text-fg">Delete this rule? Warthog stops applying it, and this cannot be undone.</p>
              <RowForm action={deleteAction}>
                <input type="hidden" name="rule-id" value={rule.id} />
                <ReturnStatus status={statusFilter} />
                <FormSubmit variant="danger-solid" size="sm" pendingLabel="Deleting rule…">
                  Delete rule
                </FormSubmit>
              </RowForm>
            </div>
          </details>
        </div>
      </div>
    </li>
  );
}

// "Your rules": the status filter in one toolbar, then the rules grouped by scope.
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
        icon={ListChecks}
        heading="No rules yet"
        description="Rules tell Warthog when to ask you first and what to stop outright. Build your first one in New rule."
        action={<ButtonLink href="/rules?view=new" variant="primary">Create your first rule</ButtonLink>}
      />
    );
  }
  const shown = statusFilter ? rules.filter((rule) => rule.status === statusFilter) : rules;
  const groups = groupRulesByScope(shown);
  const workspaceOf = new Map(agents.map((agent) => [agent.id, agent.workspaceId]));
  const allHref = rulesStatusHref(undefined);
  return (
    <>
      <ListToolbar
        label="Find rules"
        filters={
          <FilterLinks
            label="Filter rules by status"
            variant="chips"
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
        }
        applied={
          <ActiveFilters
            clearHref={allHref}
            filters={statusFilter ? [{ label: `Status: ${RULE_STATUS_LABELS[statusFilter]}`, removeHref: allHref }] : []}
          />
        }
      />
      {groups.length === 0 && statusFilter ? (
        <EmptyState
          heading={`No ${RULE_STATUS_LABELS[statusFilter].toLowerCase()} rules`}
          description="None of your rules match this filter."
          action={<ButtonLink href={allHref}>Show all rules</ButtonLink>}
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
    </>
  );
}

// The approval expiry choices: every preset plus the person's current value when it is not
// one (so a saved value is shown as the current choice and never silently replaced by the
// first option), in time order. The default is marked.
function expiryChoices(current: number): { value: number; label: string }[] {
  const values = APPROVAL_EXPIRY_PRESETS.includes(current) ? [...APPROVAL_EXPIRY_PRESETS] : [...APPROVAL_EXPIRY_PRESETS, current].sort((a, b) => a - b);
  return values.map((value) => ({
    value,
    label: value === DEFAULT_EXPIRY_MINUTES ? `${expiryDurationLabel(value)} (default)` : expiryDurationLabel(value),
  }));
}

// Whether the text/email reminder can never go out: it fires after its delay only while the
// request is still waiting, so an expiry at or below the delay leaves it no time.
function reminderTooLate(minutes: number, reminder: ApprovalReminder | undefined): reminder is ApprovalReminder {
  return reminder !== undefined && reminder.on && minutes <= reminder.delayMinutes;
}

// "Approval expiry": how long Warthog holds a request that needs the person before it is
// denied. One panel, its save in the footer, in the Your rules tab beside the rules that ask.
// When the saved expiry leaves the reminder no time, a warning inside the panel says so and
// links to where the delay is set.
function ApprovalExpiryPanel({
  minutes,
  action,
  reminder,
}: {
  minutes: number;
  action?: RuleFormAction;
  reminder?: ApprovalReminder;
}) {
  const warningId = React.useId();
  const tooLate = reminderTooLate(minutes, reminder);
  const panel = (
    <WorkspacePanel
      title="Approval expiry"
      description="How long Warthog holds any request that needs your approval, such as one caught by an Ask me first rule or a card request."
      footer={<FormSubmit pendingLabel="Saving…">Save approval expiry</FormSubmit>}
    >
      <PendingFormFields>
        <SelectField
          label="Requests wait for"
          name="approval-expiry-minutes"
          defaultValue={String(minutes)}
          width="text"
          aria-describedby={tooLate ? warningId : undefined}
          hint="If you don't decide in time, the request is denied and the agent is told. A change applies to new requests; ones already waiting keep their time. Text and email reminders go out after the delay set in Settings."
        >
          {expiryChoices(minutes).map((choice) => (
            <option key={choice.value} value={String(choice.value)}>
              {choice.label}
            </option>
          ))}
        </SelectField>
        {tooLate ? (
          <Notice tone="warning" announce={false} className="mt-4">
            <p id={warningId}>
              {`Your text or email reminder waits ${expiryDurationLabel(reminder.delayMinutes)}, so it won't be sent before requests expire. Choose a longer time, or shorten the reminder delay in Settings.`}
            </p>
            <a href={NOTIFICATION_SETTINGS_HREF} className={LINK_CLASS}>
              Change the reminder delay
              <ArrowRight aria-hidden={true} className="h-4 w-4 shrink-0" />
            </a>
          </Notice>
        ) : null}
      </PendingFormFields>
    </WorkspacePanel>
  );
  return action ? (
    <ActionForm action={action} className="contents">
      {panel}
    </ActionForm>
  ) : (
    <form className="contents" onSubmit={(event) => event.preventDefault()}>
      {panel}
    </form>
  );
}

// "Budgets": where each spending limit really lives. Only per-agent card budgets are
// settings; caps and merchant lists are card-request rules built in New rule.
function BudgetsPanel({ agents }: { agents: ReadonlyArray<RulesViewAgent> }) {
  return (
    <>
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
        <WorkspacePanel title="Card budgets" description="Each agent gets its own card budget per day, week or month.">
          <EmptyState
            variant="inline"
            icon={Bot}
            heading="No agents connected yet."
            description="Connect an agent, then set its card budget in its Spending section."
            action={<ButtonLink href="/agents/connect" variant="primary" size="sm">Connect your first agent</ButtonLink>}
          />
        </WorkspacePanel>
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
    </>
  );
}

// The tool or service a rule names, chosen from the real ones (grouped), never typed.
function TargetField({
  kind,
  value,
  groups,
  onChange,
}: {
  kind: "specific_tool" | "service_tool";
  value: string;
  groups: ReadonlyArray<RuleTargetGroup>;
  onChange: (value: string) => void;
}) {
  const known = groups.some((group) => group.choices.some((choice) => choice.value === value));
  return (
    <SelectField
      label={kind === "specific_tool" ? "Tool" : "Service"}
      name="rule-target"
      value={known ? value : ""}
      required
      width="text"
      hint={
        kind === "specific_tool"
          ? "Warthog's own tools, and the tools of services you've connected."
          : "Covers every tool the service has, including any it adds later."
      }
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{kind === "specific_tool" ? "Choose a tool" : "Choose a service"}</option>
      {groups.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </optgroup>
      ))}
    </SelectField>
  );
}

export function RulesView({
  rules,
  agents,
  draft: initialDraft = DEFAULT_DRAFT,
  currency = "AUD",
  toolChoices,
  serviceChoices,
  initialView,
  statusFilter,
  notice,
  createAction,
  pauseAction,
  deleteAction,
  approvalExpiryMinutes = DEFAULT_EXPIRY_MINUTES,
  approvalExpiryAction,
  approvalReminder,
}: RulesViewProps) {
  const [builder, dispatch] = React.useReducer(updateRuleBuilder, initialDraft, createRuleBuilderState);
  const draft = builder.draft;
  const complete = isRuleBuilderComplete(builder, { tools: toolChoices ?? [], services: serviceChoices ?? [] });
  const labels = React.useMemo(() => ruleLabelsFromChoices(toolChoices, serviceChoices), [toolChoices, serviceChoices]);
  const incompleteId = React.useId();

  // Create form: build a rule from a template, previewed as a sentence before saving. One
  // panel; each step is ruled off from the last, and "Add rule" closes it in the footer.
  const panel = (
    <WorkspacePanel
      title="New rule"
      description={`Build a rule from a template and check the sentence before you add it. Amount conditions use your account currency (${currency}).`}
      footer={
        <>
          <FormSubmit pendingLabel="Adding rule…" disabled={!complete} aria-describedby={complete ? undefined : incompleteId}>
            <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
            Add rule
          </FormSubmit>
          {complete ? null : <span id={incompleteId}>Finish the steps above to add this rule.</span>}
        </>
      }
    >
      <PendingFormFields>
        <div className="flex min-w-0 flex-col gap-5">
          <Step legend="Choose a template">
            <div className="grid min-w-0 gap-2 sm:grid-cols-2">
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
          </Step>

          {/* The brief's six action choices, then the channel or the tool/service it names. */}
          <Step
            legend="What the agent is doing"
            hint="Some tools don't say who they message or how much they spend. When Warthog can't tell, your rule applies anyway, so a few more requests may be held or blocked."
          >
            <div className="grid min-w-0 gap-2 sm:grid-cols-2">
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
            {draft.action.type === "send_message" ? (
              <SelectField
                label="Message channel"
                id="rule-channel-field"
                name="rule-channel"
                value={draft.action.channel}
                width="short"
                onChange={(event) => dispatch({ type: "channel", channel: event.target.value as MessageChannel })}
              >
                {CHANNELS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </SelectField>
            ) : null}
            {draft.action.type === "specific_tool" || draft.action.type === "service_tool" ? (
              <TargetField
                kind={draft.action.type}
                value={draft.action.type === "specific_tool" ? draft.action.tool : draft.action.service}
                groups={(draft.action.type === "specific_tool" ? toolChoices : serviceChoices) ?? []}
                onChange={(value) => dispatch({ type: "target", value })}
              />
            ) : null}
          </Step>

          {/* When the rule applies. */}
          <Step legend="When it applies">
            <SelectField
              label="Condition"
              name="rule-condition"
              value={draft.condition?.type ?? "none"}
              width="text"
              onChange={(event) => dispatch({ type: "condition", condition: event.target.value as RuleCondition["type"] | "none" })}
            >
              {CONDITIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </SelectField>
            {draft.condition ? (
              <Field
                label={draft.condition.type === "amount_over" ? `Amount (${currency})` : "Condition detail"}
                name="rule-condition-detail"
                value={builder.detail}
                type={draft.condition.type === "amount_over" ? "number" : "text"}
                inputMode={draft.condition.type === "amount_over" ? "decimal" : undefined}
                min={draft.condition.type === "amount_over" ? 0 : undefined}
                step={draft.condition.type === "amount_over" ? "any" : undefined}
                hint={
                  draft.condition.type === "merchant_in" || draft.condition.type === "merchant_not_in"
                    ? "Separate merchants with commas."
                    : undefined
                }
                required
                width={draft.condition.type === "amount_over" ? "short" : "text"}
                onChange={(event) => dispatch({ type: "detail", value: event.target.value })}
              />
            ) : null}
          </Step>

          {/* Scope — all agents or a chosen agent. */}
          <Step legend="Which agents">
            <div className="grid min-w-0 gap-2 sm:grid-cols-2">
              <Choice
                name="rule-scope"
                value="any_agent"
                checked={draft.scope.type === "any_agent"}
                onChange={() => dispatch({ type: "scope", scope: { type: "any_agent" } })}
                label="All agents"
                description="Including any you connect later."
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
          </Step>

          {/* The preview — the exact sentence this rule reads back as, before saving. */}
          <div className="flex flex-col gap-1.5 rounded-card bg-surface-muted p-4">
            <p className="text-sm font-semibold text-fg">Preview</p>
            <p className="text-fg" aria-live="polite">
              {complete ? previewSentence(draft, labels) : "Complete the action and condition details to preview your rule."}
            </p>
          </div>
        </div>
      </PendingFormFields>
    </WorkspacePanel>
  );
  const newRule = createAction ? (
    <ActionForm action={createAction}>{panel}</ActionForm>
  ) : (
    <form onSubmit={(event) => event.preventDefault()}>{panel}</form>
  );

  // The outcome of the last change sits first in the view the change returned to.
  const opening = initialView === "new" || initialView === "budgets" ? initialView : "rules";
  const withNotice = (key: string, content: React.ReactNode) =>
    notice && key === opening ? (
      <>
        {notice}
        {content}
      </>
    ) : (
      content
    );

  return (
    <ViewPanels
      label="Rules and budgets"
      initialTab={initialView}
      defaultTab="rules"
      heading={{
        title: "Rules & budgets",
        description: "Rules decide when Warthog asks you first and what it never allows. Rules for all agents apply to every agent; an agent's own rules add to them.",
      }}
      tabs={[
        {
          key: "rules",
          label: `Your rules (${rules.length})`,
          content: withNotice(
            "rules",
            <>
              <RulesList
                rules={rules}
                agents={agents}
                statusFilter={statusFilter}
                pauseAction={pauseAction}
                deleteAction={deleteAction}
              />
              <ApprovalExpiryPanel minutes={approvalExpiryMinutes} action={approvalExpiryAction} reminder={approvalReminder} />
            </>,
          ),
        },
        { key: "new", label: "New rule", content: withNotice("new", newRule) },
        { key: "budgets", label: "Budgets", content: withNotice("budgets", <BudgetsPanel agents={agents} />) },
      ]}
    />
  );
}

export default RulesView;
