"use client";

import * as React from "react";
import { Check, ChevronDown, Info, SlidersHorizontal } from "lucide-react";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import {
  CONNECTION_CAPABILITIES, CONNECTION_PRESETS,
  type ChoiceKey, type ConnectionChoices, type ConnectionService,
} from "@/domain/permissions/connection-choices";
import type { PermissionTemplate } from "@/domain/permissions/templates";
import { formatMoney } from "@/domain/approvals/request-sentence";

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

export function ConnectionPermissions({ template, state, services = [], onTemplate, onChange, currency = "AUD" }: {
  template: PermissionTemplate; state: ConnectionChoices; services?: readonly ConnectionService[];
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
          <legend>Your connected services</legend>
          <p className="text-sm text-fg-muted">Selected services allow reads. Changes are set to <strong>Ask me first</strong>, and your rules still apply.</p>
          {services.length ? services.map(service => <div className="wh-permission-row" key={service.id}>
            <label className="wh-permission-label"><input type="checkbox" name="service" value={service.id} checked={state.services.includes(service.id)} onChange={e => onChange({ ...state, services: e.target.checked ? [...state.services.filter(id => id !== service.id), service.id] : state.services.filter(id => id !== service.id) })} /><span>Read from {service.name}</span></label>
            <p>Read information using this service’s available tools. Changes: Ask me first.</p>
          </div>) : <p className="wh-permission-empty">No services connected. You can connect a service and grant this agent access later.</p>}
          {services.length ? <PermissionHelp label="How service access works">For example, an email service may allow searching messages; sending or changing something asks you first. Available tools depend on the service. If you connected multiple accounts for a service, choose its account in the agent’s settings before it can be used.</PermissionHelp> : null}
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

export function ConnectionAccessSummary({ state, services = [], currency = "AUD" }: { state: ConnectionChoices; services?: readonly ConnectionService[]; currency?: string }) {
  const everyday: ChoiceKey[] = ["identity", "memoryRead", "memoryWrite", "tasks", "records"];
  const selected = services.filter(service => state.services.includes(service.id));
  return <div className="wh-permission-summary">
    <div><h3>Allowed through Warthog</h3>
      <ul>{everyday.filter(key => state[key]).map(key => <li key={key}>{CONNECTION_CAPABILITIES[key].label}</li>)}<li>Assigned skills and your preferences</li>{selected.map(service => <li key={service.id}>Read from {service.name}; changes ask you first</li>)}</ul>
    </div>
    <div><h3>Requests and sharing</h3><ul>
      <li>Protected details: {state.highTier ? "may ask; you approve each one" : "off"}</li>
      <li>Card requests: {state.card ? `${budgetText(state.cardBudget.amount, currency)} a ${state.cardBudget.period}; you approve each one` : "off"}</li>
      <li>Sharing new memories: {state.learningSharing ? (state.memoryWrite ? "on, with your other agents" : "on, but saving memories is off") : "off; new memories stay private to this agent"}</li>
      {!selected.length ? <li>Connected services: none selected</li> : null}
    </ul></div>
  </div>;
}
