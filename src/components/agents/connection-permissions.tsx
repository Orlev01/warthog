"use client";

import * as React from "react";
import { Check, ChevronDown, Info, SlidersHorizontal } from "lucide-react";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import {
  CONNECTION_CAPABILITIES, CONNECTION_PRESETS, accountName, byServiceThenAccount,
  type ChoiceKey, type ConnectionAccount, type ConnectionChoices,
} from "@/domain/permissions/connection-choices";
import type { PermissionTemplate } from "@/domain/permissions/templates";
import { formatMoney } from "@/domain/approvals/request-sentence";
import { MAIL_CONNECTOR_IDS } from "@/domain/content/mail-connectors";

export function PermissionHelp({ label, children }: { label: string; children: React.ReactNode }) {
  return <details className="wh-permission-help">
    <summary><Info size={16} aria-hidden="true" /><span>{label}</span><ChevronDown size={14} aria-hidden="true" /></summary>
    <div>{children}</div>
  </details>;
}

function PermissionChoice({ choice, state, onChange }: { choice: ChoiceKey; state: ConnectionChoices; onChange: (state: ConnectionChoices) => void }) {
  const id = React.useId();
  const copy = CONNECTION_CAPABILITIES[choice];
  return <div className="wh-permission-row">
    <label htmlFor={id} className="wh-permission-label">
      <input id={id} type="checkbox" name={choice} checked={state[choice]} onChange={e => onChange({ ...state, [choice]: e.target.checked })} aria-describedby={`${id}-help`} />
      <span>{copy.label}</span>
    </label>
    <p id={`${id}-help`}>{copy.description}</p>
    <PermissionHelp label={`Example: ${copy.label.toLowerCase()}`}>{copy.example}</PermissionHelp>
  </div>;
}

// The person's connected accounts, one checkbox each (docs/adr/several-accounts-per-agent.md):
// each account is its own grant, so two Gmail accounts are two rows, listed by service and
// then account.
function AccountChoices({ accounts, state, onChange }: { accounts: readonly ConnectionAccount[]; state: ConnectionChoices; onChange: (state: ConnectionChoices) => void }) {
  const toggle = (id: string, on: boolean) => onChange({ ...state, accounts: on ? [...state.accounts.filter(ticked => ticked !== id), id] : state.accounts.filter(ticked => ticked !== id) });
  return <>
    {[...accounts].sort(byServiceThenAccount).map(account => <div className="wh-permission-row" key={account.id}>
      <label className="wh-permission-label"><input type="checkbox" name="account" value={account.id} checked={state.accounts.includes(account.id)} onChange={e => toggle(account.id, e.target.checked)} /><span>{accountName(account)}</span></label>
      <p>{MAIL_CONNECTOR_IDS.has(account.connectorId) ? "Reads a checked copy of your email, without sign-in codes or password links." : "Read information using this service’s available tools."} Changes: Ask me first.</p>
    </div>)}
  </>;
}

export function ConnectionPermissions({ template, state, accounts = [], onTemplate, onChange, currency = "AUD" }: {
  template: PermissionTemplate; state: ConnectionChoices; accounts?: readonly ConnectionAccount[];
  onTemplate: (template: PermissionTemplate) => void; onChange: (state: ConnectionChoices) => void; currency?: string;
}) {
  const [editing, setEditing] = React.useState(template === "custom");
  const id = React.useId();
  React.useEffect(() => { if (template === "custom") setEditing(true); }, [template]);
  const groups: { title: string; choices: ChoiceKey[] }[] = [
    { title: "Everyday details", choices: ["identity"] },
    { title: "Memory", choices: ["memoryRead", "memoryWrite", "learningSharing"] },
    { title: "Tasks and records", choices: ["tasks", "records"] },
    { title: "Protected details and cards · off by default", choices: ["highTier", "card"] },
  ];
  return <section className="wh-connection-section" aria-labelledby={`${id}-heading`}>
    <div className="wh-connection-section-heading"><span>02</span><div><h2 id={`${id}-heading`}>Choose its access</h2><p>Pick a starting set, then review or adjust the individual permissions.</p></div></div>
    <fieldset className="wh-permission-presets">
      <legend className="sr-only">Starting permission set</legend>
      {CONNECTION_PRESETS.map(preset => <label key={preset.value} data-selected={template === preset.value}>
        <span><input type="radio" name="starting-set" value={preset.value} checked={template === preset.value} onChange={() => { onTemplate(preset.value); setEditing(preset.value === "custom"); }} /><strong>{preset.label}</strong></span>
        <span>{preset.description}</span>
      </label>)}
    </fieldset>
    <p className="wh-permission-preset-note">Minimal and Standard replace your choices below. Neither turns on services, protected details, cards or sharing.</p>
    <details className="wh-permission-editor" open={editing} onToggle={event => setEditing(event.currentTarget.open)}>
      <summary><SlidersHorizontal size={18} aria-hidden="true" /><span>{template === "custom" ? "Custom permissions — edit your choices" : "Review and customise permissions"}</span><ChevronDown size={18} aria-hidden="true" /></summary>
      <div className="wh-permission-editor-body">
        {groups.map(group => <fieldset className="wh-permission-group" key={group.title}>
          <legend>{group.title}</legend>
          {group.choices.map(choice => <PermissionChoice key={choice} choice={choice} state={state} onChange={onChange} />)}
          {group.choices.includes("card") && state.card ? <div className="wh-permission-budget">
            <Field label={`Card budget (${currency})`} name="cardBudgetAmount" type="number" inputMode="decimal" min="0.01" step="0.01" required value={state.cardBudget.amount} onChange={e => onChange({ ...state, cardBudget: { ...state.cardBudget, amount: e.target.value } })} />
            <label htmlFor={`${id}-period`}>Budget period<Select id={`${id}-period`} name="cardBudgetPeriod" value={state.cardBudget.period} onChange={e => onChange({ ...state, cardBudget: { ...state.cardBudget, period: e.target.value as ConnectionChoices["cardBudget"]["period"] } })}><option value="day">Per day</option><option value="week">Per week</option><option value="month">Per month</option></Select></label>
            <input type="hidden" name="cardBudgetCurrency" value={currency} />
            <p>Limits the total amount approved for card releases in each period. Every release still asks you first; this is not a limit enforced by your bank.</p>
          </div> : null}
        </fieldset>)}
        <fieldset className="wh-permission-group">
          <legend>Your connected accounts</legend>
          <p className="text-sm text-fg-muted">Selected accounts allow reads. Changes are set to <strong>Ask me first</strong>, and your rules still apply.</p>
          {accounts.length ? <AccountChoices accounts={accounts} state={state} onChange={onChange} /> : <p className="wh-permission-empty">No services connected. You can connect a service and grant this agent access later.</p>}
          {accounts.length ? <PermissionHelp label="How service access works">For example, an email service may allow searching messages; sending or changing something asks you first. Available tools depend on the service. Each account is separate. You can change these later in the agent’s settings.</PermissionHelp> : null}
        </fieldset>
      </div>
    </details>
    <div className="wh-permission-included">
      <h3><Check size={16} aria-hidden="true" /> Included with every connection</h3>
      <p>Every agent gets your preferences and the skills you’ve given it, and Warthog records what it does.</p>
      <PermissionHelp label="What stays under your control">Only skills you’ve switched on for this agent are available. You can choose individual details, memories, skills and service accounts on the agent’s page later. Your rules for all agents still apply. Warthog can’t control the platform’s own tools, billing or the model’s private memory.</PermissionHelp>
    </div>
  </section>;
}

// "$200.00" for a typed budget, or a dash while the field is empty (content-20).
function budgetText(amount: string, currency: string): string {
  const value = Number(amount.trim());
  return amount.trim() === "" || !Number.isFinite(value) ? "—" : formatMoney(value, currency);
}

export function ConnectionAccessSummary({ state, accounts = [], currency = "AUD" }: { state: ConnectionChoices; accounts?: readonly ConnectionAccount[]; currency?: string }) {
  const everyday: ChoiceKey[] = ["identity", "memoryRead", "memoryWrite", "tasks", "records"];
  const selected = accounts.filter(account => state.accounts.includes(account.id)).sort(byServiceThenAccount);
  return <div className="wh-permission-summary">
    <div><h3>Allowed through Warthog</h3>
      <ul>{everyday.filter(key => state[key]).map(key => <li key={key}>{CONNECTION_CAPABILITIES[key].label}</li>)}<li>Assigned skills and your preferences</li>{selected.map(account => <li key={account.id}>Read from {accountName(account)}; changes ask you first</li>)}</ul>
    </div>
    <div><h3>Requests and sharing</h3><ul>
      <li>Protected details: {state.highTier ? "may ask; you approve each one" : "off"}</li>
      <li>Card requests: {state.card ? `${budgetText(state.cardBudget.amount, currency)} a ${state.cardBudget.period}; you approve each one` : "off"}</li>
      <li>Sharing new memories: {state.learningSharing ? (state.memoryWrite ? "on, with your other agents" : "on, but saving memories is off") : "off; new memories stay private to this agent"}</li>
      {!selected.length ? <li>Connected accounts: none selected</li> : null}
    </ul></div>
  </div>;
}
