"use client";

// A card's billing address (docs/adr/card-billing-addresses.md): one of the person's About you
// postal addresses, one of the addresses they keep with their cards, or a different address typed
// here. Used by "Add a card" and by a saved card's "Change".
//
// Nothing is chosen for them when they have saved addresses: picking an About you address is a
// tap they make, and an address they're moving to is never the default. With nothing saved, the
// address field shows straight away (there is no empty dropdown). A typed address is kept with
// their cards only, never in About you, so agents never read it as an everyday detail.

import * as React from "react";

import { Field } from "@/components/ui/field";

// One address the person can choose (the server's billing choices; `source` "postal" is an
// About you address, "billing" one kept with their cards).
export type BillingChoiceView = {
  id: string;
  value: string;
  source?: "postal" | "billing";
  upcoming?: boolean;
  movingOn?: string | null;
  usedBy?: readonly string[];
};

// What the person chose, as the server's card actions take it.
export type BillingSelection =
  | { source: "postal"; id: string }
  | { source: "billing"; id: string }
  | { source: "new"; value: string };

// The same bound as an About you postal address.
export const BILLING_ADDRESS_MAX = 4096;
// The radio value for "A different billing address".
export const NEW_BILLING_KEY = "new";

export const BILLING_CHOOSE_COPY = "Choose a billing address for this card.";
export const BILLING_TYPE_COPY = "Type the billing address for this card.";
export const BILLING_TOO_LONG_COPY = "That billing address is too long. Please shorten it.";
export const BILLING_GONE_COPY = "That billing address is no longer saved. Choose another, or type it.";
const NEW_HINT = "Kept with your cards, not in About you. An agent only gets it with a card purchase you approve.";

export function choiceKey(choice: BillingChoiceView): string {
  return `${choice.source ?? "postal"}:${choice.id}`;
}

// The key a choice for this card starts with: none when the person has saved addresses (they
// choose), the typed-address field when they have none, or the card's current address when
// changing it.
export function initialBillingKey(choices: readonly BillingChoiceView[], current?: { source: "postal" | "billing"; id: string } | null): string {
  if (current) {
    const match = choices.find((c) => (c.source ?? "postal") === current.source && c.id === current.id);
    if (match) return choiceKey(match);
  }
  return choices.length === 0 ? NEW_BILLING_KEY : "";
}

// The person's choice as a selection, or the plain-words problem with it.
export function billingSelection(
  key: string,
  newValue: string,
  choices: readonly BillingChoiceView[],
): { ok: true; selection: BillingSelection } | { ok: false; error: string } {
  if (key === NEW_BILLING_KEY || choices.length === 0) {
    const value = newValue.trim();
    if (value.length === 0) return { ok: false, error: BILLING_TYPE_COPY };
    if (value.length > BILLING_ADDRESS_MAX) return { ok: false, error: BILLING_TOO_LONG_COPY };
    return { ok: true, selection: { source: "new", value } };
  }
  const choice = choices.find((c) => choiceKey(c) === key);
  if (!choice) return { ok: false, error: BILLING_CHOOSE_COPY };
  return { ok: true, selection: { source: choice.source ?? "postal", id: choice.id } };
}

// "1 Mar 2027" for a moving-on date (a calendar date, shown as written).
function movingDate(day: string): string {
  const date = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// Where an address comes from, in plain words.
export function choiceSource(choice: BillingChoiceView): string {
  if ((choice.source ?? "postal") === "billing") {
    const cards = choice.usedBy ?? [];
    return cards.length > 0 ? `Kept with your cards · used for ${cards.join(", ")}` : "Kept with your cards";
  }
  if (choice.upcoming && choice.movingOn) return `From About you · you're moving here on ${movingDate(choice.movingOn)}`;
  return "From About you";
}

export interface BillingAddressChoiceProps {
  choices: readonly BillingChoiceView[];
  selectedKey: string;
  newValue: string;
  onSelect: (key: string) => void;
  onNewValue: (value: string) => void;
  // A problem with the choice, shown on it.
  error?: string;
}

export function BillingAddressChoice({ choices, selectedKey, newValue, onSelect, onNewValue, error }: BillingAddressChoiceProps): React.ReactElement {
  const name = React.useId();
  const newFieldId = React.useId();
  const errorId = React.useId();
  const rootRef = React.useRef<HTMLElement | null>(null);
  const typing = selectedKey === NEW_BILLING_KEY || choices.length === 0;

  // A problem with the choice takes the person to it: the address field when typing one, else the
  // first address.
  React.useEffect(() => {
    if (!error) return;
    const target = typing ? document.getElementById(newFieldId) : rootRef.current?.querySelector<HTMLElement>('input[type="radio"]');
    target?.focus();
  }, [error]); // only a new problem moves focus, not every keystroke or choice

  const typedField = (
    <Field
      label={choices.length === 0 ? "Billing address" : "Different billing address"}
      id={newFieldId}
      width="text"
      autoComplete="billing street-address"
      maxLength={BILLING_ADDRESS_MAX}
      hint={NEW_HINT}
      error={error}
      value={newValue}
      onChange={(event) => onNewValue(event.target.value)}
    />
  );

  // Nothing saved: no radios and no empty dropdown, just the field.
  if (choices.length === 0) {
    return (
      <div ref={(node) => { rootRef.current = node; }} className="min-w-0">
        {typedField}
      </div>
    );
  }

  return (
    <fieldset
      ref={(node) => { rootRef.current = node; }}
      className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
      aria-describedby={error && !typing ? errorId : undefined}
      aria-invalid={error && !typing ? true : undefined}
    >
      <legend className="mb-1 text-sm font-medium text-fg">Billing address</legend>
      {choices.map((choice) => {
        const key = choiceKey(choice);
        return (
          <label key={key} className="flex min-h-11 min-w-0 cursor-pointer items-start gap-3 text-sm text-fg">
            <input
              type="radio"
              name={name}
              value={key}
              className="mt-1 shrink-0"
              checked={selectedKey === key}
              onChange={() => onSelect(key)}
            />
            <span className="flex min-w-0 flex-col [overflow-wrap:anywhere]">
              <span>{choice.value}</span>
              <span className="text-fg-muted">{choiceSource(choice)}</span>
            </span>
          </label>
        );
      })}
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-fg">
        <input
          type="radio"
          name={name}
          value={NEW_BILLING_KEY}
          className="shrink-0"
          checked={typing}
          onChange={() => onSelect(NEW_BILLING_KEY)}
        />
        A different billing address
      </label>
      {typing ? <div className="pl-7">{typedField}</div> : null}
      {error && !typing ? (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export default BillingAddressChoice;
