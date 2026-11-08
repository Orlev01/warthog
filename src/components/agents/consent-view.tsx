"use client";

import * as React from "react";
import { ShieldCheck, AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import {
  permissionTemplate,
  type PermissionTemplate,
} from "@/domain/permissions/templates";

// E10-S02 — Agent consent view (design §6.1; brief "Agent consent screen").
//
// When an agent starts connecting, the signed-in person names it, sees what it is
// asking for in plain words, picks a starting permission set (Minimal / Standard /
// Custom), adjusts the individual toggles, sees whether the platform calling back
// is a known/verified one, and Approves or Refuses — all on ONE screen.
//
// This is the PURE, prop-driven view: it renders the screen from its props so it
// can be pinned without a browser, a session or any protocol machinery. The real
// OAuth/consent plumbing (deciding the redirect host, issuing the credential on
// approve, persisting the adjusted set) lives in the server composition root and
// is wired by a later task; the controls here are native, user-adjustable form
// controls whose initial state is driven by the chosen `template`.
//
// The grants a starting set produces are the one-source-of-truth domain contract
// @/domain/permissions/templates — this view hard-codes none of the rules; it
// computes the set and reflects it. Colour comes from the design tokens
// (globals.css) — never a raw hex.
//
// Review fix A2 — what is ticked is what is granted. Every toggle the person can change
// is a named, CONTROLLED input seeded from the chosen starting set and re-seeded when the
// starting set changes (`consentToggleState`); the decision reads each one. Card requests
// carry a budget (default A$200 a month, the person's currency); a ticked service submits
// its id. The rows that are always included — or that follow another setting — are shown
// as fixed (disabled) rows, never as live controls that change nothing.

export type ConsentViewService = {
  id: string;
  name: string;
  ticked?: boolean;
};

export type ConsentViewProps = {
  // the connecting agent's platform (e.g. "Claude"), named on the screen.
  platform: string;
  // the proposed name for the agent, pre-filled into the editable name field.
  defaultName?: string;
  // what the agent asked for, each a plain-words line shown verbatim.
  requestedScopes: ReadonlyArray<string>;
  // the person's connectable services; the ticked ones' read tools are granted
  // under Standard/Custom with their change-making tools set to "Ask me first".
  services?: ReadonlyArray<ConsentViewService>;
  // the selected starting set; it drives which toggles render ON.
  template: PermissionTemplate;
  // a KNOWN platform callback (verified) shows the "Verified platform" badge; any
  // other host is shown prominently.
  redirect: { host: string; verified: boolean };
  // E10-S12 — the server decision actions the live consent screen submits to. When
  // given, the view becomes a real form: Approve submits the chosen name, starting set
  // and opt-ins to `approveAction`; Refuse submits to `refuseAction`. When omitted the
  // view renders as the pure, presentational screen (E10-S02) — no form, inert buttons.
  approveAction?: (formData: FormData) => void | Promise<void>;
  refuseAction?: (formData: FormData) => void | Promise<void>;
  // the person's currency for the card budget (default AUD).
  currency?: string;
  // the toggles to open on, when not the starting set's own (a re-render after a refused
  // submission, or a test pinning a state); defaults to consentToggleState(template, …).
  initialState?: ConsentToggleState;
};

// The adjustable choices on the screen, as the form submits them. Each boolean is one
// named checkbox; `services` are the ticked service ids; the budget is the card budget's
// amount (as typed) and period.
export type ConsentToggleState = {
  identity: boolean;
  memoryRead: boolean;
  tasks: boolean;
  records: boolean;
  highTier: boolean;
  card: boolean;
  learningSharing: boolean;
  services: string[];
  cardBudget: { amount: string; period: "day" | "week" | "month" };
};

// The brief's default card budget: A$200 per month, in the person's currency.
const DEFAULT_CARD_BUDGET = { amount: "200", period: "month" } as const;

// The toggles a starting set opens on — the domain contract, mapped to the form's
// choices. Choosing another starting set re-seeds the screen from this, so the toggles
// always show what the chosen set grants until the person adjusts them.
export function consentToggleState(
  template: PermissionTemplate,
  tickedIds: readonly string[],
): ConsentToggleState {
  const set = permissionTemplate(template, tickedIds);
  return {
    identity: set.lowTierProfile,
    memoryRead: set.sharedMemoryRead,
    tasks: set.tasks,
    records: set.lifeAdmin,
    highTier: set.highTier,
    card: set.card,
    learningSharing: set.learningSharing,
    services: set.services.map((s) => s.service),
    cardBudget: { ...DEFAULT_CARD_BUDGET },
  };
}

// The three starting sets the consent screen offers, in plain words.
const STARTING_SETS: ReadonlyArray<{
  value: PermissionTemplate;
  label: string;
  description: string;
}> = [
  { value: "minimal", label: "Minimal", description: "Just the low-tier basics." },
  { value: "standard", label: "Standard", description: "The recommended balance." },
  { value: "custom", label: "Custom", description: "Start from Standard, then change anything." },
];

// The opt-in and adjustable choices (booleans of ConsentToggleState).
type ToggleKey = Exclude<keyof ConsentToggleState, "services" | "cardBudget">;

// Every row of "What it can do", in the brief's own plain words. An ADJUSTABLE row is a
// named checkbox the decision reads (`key` is both the state field and the form name). A
// FIXED row has no grant of its own: skills, preferences and activity logging are always
// included, and saving its own memories goes with reading shared memory (the memory
// tools share that grant) — shown checked or not, but disabled, with the reason.
type CapabilityRow =
  | { kind: "adjustable"; key: ToggleKey; label: string }
  | { kind: "fixed"; label: string; note: string; on: (state: ConsentToggleState) => boolean };

const CAPABILITIES: ReadonlyArray<CapabilityRow> = [
  { kind: "adjustable", key: "identity", label: "Your basic profile" },
  { kind: "fixed", label: "Your skills", note: "Always included", on: () => true },
  { kind: "fixed", label: "Your preferences", note: "Always included", on: () => true },
  { kind: "fixed", label: "Logging its activity", note: "Always included", on: () => true },
  { kind: "adjustable", key: "memoryRead", label: "Read your shared memory" },
  {
    kind: "fixed",
    label: "Save its own memories",
    note: "Goes with reading shared memory",
    on: (state) => state.memoryRead,
  },
  { kind: "adjustable", key: "tasks", label: "Your tasks" },
  { kind: "adjustable", key: "records", label: "Your life-admin records" },
  { kind: "adjustable", key: "highTier", label: "High-tier identity requests" },
  { kind: "adjustable", key: "card", label: "Card requests" },
  { kind: "adjustable", key: "learningSharing", label: "Share what it learns" },
];

// One capability row: a native checkbox. An adjustable row is controlled by the screen's
// state and named for the form; a fixed row is disabled (and unnamed, so it submits
// nothing) with a plain-words note saying why.
function Toggle({
  on,
  name,
  disabled,
  note,
  onChange,
  children,
}: {
  on: boolean;
  name?: string;
  disabled?: boolean;
  note?: string;
  onChange?: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-3 rounded-card border border-line bg-surface p-3">
      <input
        type="checkbox"
        name={name}
        checked={on}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.checked)}
        className="h-4 w-4 accent-accent"
      />
      <span className="flex flex-col">
        <span className="text-fg">{children}</span>
        {note ? <span className="text-sm text-fg-muted">{note}</span> : null}
      </span>
    </label>
  );
}

// Where the platform calls back to: a verified platform wears a badge; any other
// host is shown prominently with a caution, in words plus an icon (never colour
// alone).
function RedirectNotice({ redirect }: { redirect: ConsentViewProps["redirect"] }) {
  return (
    <div className="flex flex-col gap-2 rounded-card border border-line bg-surface-muted p-3 text-sm">
      <span className="text-fg-muted">Connecting back to</span>
      <span className="font-medium text-fg">{redirect.host}</span>
      {redirect.verified ? (
        <span className="inline-flex items-center gap-1.5 font-medium text-success">
          <ShieldCheck aria-hidden={true} className="h-4 w-4 shrink-0" />
          Verified platform
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 font-medium text-warning">
          <AlertTriangle aria-hidden={true} className="h-4 w-4 shrink-0" />
          We do not recognise this platform. Check the address before you approve.
        </span>
      )}
    </div>
  );
}

export function ConsentView({
  platform,
  defaultName,
  requestedScopes,
  services = [],
  template,
  redirect,
  approveAction,
  refuseAction,
  currency = "AUD",
  initialState,
}: ConsentViewProps) {
  const tickedIds = services.filter((s) => s.ticked).map((s) => s.id);
  const [startingSet, setStartingSet] = React.useState<PermissionTemplate>(template);
  const [state, setState] = React.useState<ConsentToggleState>(
    () => initialState ?? consentToggleState(template, tickedIds),
  );
  // A live form only when the decision actions are wired in; otherwise the pure view.
  const live = approveAction != null;

  // Choosing a starting set re-seeds every toggle from it (the person adjusts from there).
  const chooseStartingSet = (next: PermissionTemplate) => {
    setStartingSet(next);
    setState(consentToggleState(next, tickedIds));
  };
  const setToggle = (key: ToggleKey, checked: boolean) =>
    setState((current) => ({ ...current, [key]: checked }));
  const setService = (id: string, checked: boolean) =>
    setState((current) => ({
      ...current,
      services: checked
        ? [...current.services.filter((s) => s !== id), id]
        : current.services.filter((s) => s !== id),
    }));
  const setBudget = (budget: Partial<ConsentToggleState["cardBudget"]>) =>
    setState((current) => ({ ...current, cardBudget: { ...current.cardBudget, ...budget } }));

  const content = (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold text-fg">Connect {platform}</h1>
        <p className="text-sm text-fg-muted">
          Name it, choose what it can do, then approve.
        </p>
        <RedirectNotice redirect={redirect} />
      </header>

      <Field label="Name" name="name" defaultValue={defaultName} placeholder={defaultName} />

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-fg">{platform} is asking to</h2>
        <ul className="flex flex-col gap-1.5">
          {requestedScopes.map((scope, i) => (
            <li
              key={i}
              className="rounded-card border border-line bg-surface p-3 text-sm text-fg"
            >
              {scope}
            </li>
          ))}
        </ul>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-sm font-medium text-fg">Starting set</legend>
        <div className="flex flex-col gap-2">
          {STARTING_SETS.map((set) => (
            <div key={set.value} className="rounded-card border border-line bg-surface p-3">
              <label className="flex items-center gap-3">
                <input
                  type="radio"
                  name="starting-set"
                  value={set.value}
                  checked={startingSet === set.value}
                  onChange={() => chooseStartingSet(set.value)}
                  className="h-4 w-4 accent-accent"
                />
                <span className="font-medium text-fg">{set.label}</span>
              </label>
              <p className="mt-1 text-sm text-fg-muted">{set.description}</p>
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-sm font-medium text-fg">What it can do</legend>
        <div className="flex flex-col gap-2">
          {CAPABILITIES.map((cap) =>
            cap.kind === "adjustable" ? (
              <Toggle
                key={cap.key}
                name={cap.key}
                on={state[cap.key]}
                onChange={(checked) => setToggle(cap.key, checked)}
              >
                {cap.label}
              </Toggle>
            ) : (
              <Toggle key={cap.label} on={cap.on(state)} disabled note={cap.note}>
                {cap.label}
              </Toggle>
            ),
          )}
        </div>
        {state.card ? (
          <div className="flex flex-col gap-2 rounded-card border border-line bg-surface-muted p-3">
            <Field
              label={`Card budget (${currency})`}
              name="cardBudgetAmount"
              type="number"
              inputMode="decimal"
              min="1"
              step="any"
              required
              value={state.cardBudget.amount}
              onChange={(event) => setBudget({ amount: event.target.value })}
            />
            <label className="flex flex-col gap-1.5 text-sm font-medium text-fg">
              Budget period
              <select
                name="cardBudgetPeriod"
                value={state.cardBudget.period}
                onChange={(event) =>
                  setBudget({ period: event.target.value as ConsentToggleState["cardBudget"]["period"] })
                }
                className="rounded-card border border-line bg-surface p-2 text-fg"
              >
                <option value="day">Per day</option>
                <option value="week">Per week</option>
                <option value="month">Per month</option>
              </select>
            </label>
            <input type="hidden" name="cardBudgetCurrency" value={currency} />
            <p className="text-sm text-fg-muted">
              It can never spend more than this in each period, and every payment still asks you first.
            </p>
          </div>
        ) : null}
      </fieldset>

      {services.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-2 text-sm font-medium text-fg">Your services</legend>
          <div className="flex flex-col gap-2">
            {services.map((service) => {
              const granted = state.services.includes(service.id);
              return (
                <div
                  key={service.id}
                  className="flex flex-col gap-1 rounded-card border border-line bg-surface p-3"
                >
                  <label className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      name="service"
                      value={service.id}
                      checked={granted}
                      onChange={(event) => setService(service.id, event.target.checked)}
                      className="h-4 w-4 accent-accent"
                    />
                    <span className="text-fg">Read from {service.name}</span>
                  </label>
                  {granted ? (
                    <p className="text-sm text-fg-muted">Changes: Ask me first</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type={live ? "submit" : "button"} variant="primary" className="sm:flex-1">
          Approve
        </Button>
        <Button
          type={refuseAction != null ? "submit" : "button"}
          formAction={refuseAction}
          formNoValidate={refuseAction != null ? true : undefined}
          variant="secondary"
          className="sm:flex-1"
        >
          Refuse
        </Button>
      </div>
    </section>
  );

  // When the decision actions are wired in, the whole screen is a form that posts the
  // person's choices to Approve (the form action) or Refuse (the button's formAction);
  // otherwise it is the pure, presentational view.
  return live ? <form action={approveAction}>{content}</form> : content;
}

export default ConsentView;
