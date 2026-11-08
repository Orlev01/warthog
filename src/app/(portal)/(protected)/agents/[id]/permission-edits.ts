// Gather the permissions screen's edits from its rendered controls (operator fix for the E10-S08
// review veto). Every control the screen renders is carried with its explicit on/off state, and a
// control the form cannot find REFUSES the save — naming what is missing — instead of silently
// omitting that field and reporting "Saved" over a dropped edit. Pure, so it is unit-tested
// without a DOM; the form maps its <input>s to ControlSnapshots.
//
// Review fix W2.3: controls are found by their stable `name` attribute (the view names every
// input), never by matching visible label text — so a connected service or skill whose name
// contains "card" or "learn" can never stand in for the card-access or sharing toggle, and a copy
// change cannot break saving. The screen's tasks and records grants and one toggle per connected
// service (`connector:<id>`) are carried the same way.
import type { PeriodKind } from "@/domain/budget/budget";
import type { PermissionsSaveInput } from "./actions";

export type ControlSnapshot = {
  readonly type: string; // the input's type: "checkbox" | "number" | …
  readonly name: string; // its stable `name` attribute (e.g. "card", "connector:notion")
  readonly label?: string; // its accessible name, for diagnostics only — never matched on
  readonly checked: boolean;
  readonly value: string;
};

export type CollectResult =
  | { readonly ok: true; readonly input: PermissionsSaveInput }
  | { readonly ok: false; readonly reason: "form_incomplete"; readonly missing: readonly string[] };

// The `name` a connected service's toggle carries on the screen.
export function connectorControlName(connectorId: string): string {
  return `connector:${connectorId}`;
}

// The toggles the screen always renders, by the save field each one feeds (field = input name).
const REQUIRED_TOGGLES = [
  "identity",
  "highTier",
  "card",
  "tasks",
  "records",
  "memoryRead",
  "learningSharing",
] as const;
const REQUEST_LIMIT = "requestLimit";
const CARD_BUDGET = "cardBudget";

export function collectEdits(
  controls: readonly ControlSnapshot[],
  opts: { readonly currency: string; readonly period: PeriodKind; readonly connectors: readonly string[] },
): CollectResult {
  const find = (type: string, name: string) => controls.find((c) => c.type === type && c.name === name);

  const missing: string[] = [];
  for (const name of REQUIRED_TOGGLES) if (!find("checkbox", name)) missing.push(name);
  if (!find("number", REQUEST_LIMIT)) missing.push(REQUEST_LIMIT);
  for (const id of opts.connectors) {
    const name = connectorControlName(id);
    if (!find("checkbox", name)) missing.push(name);
  }
  if (missing.length > 0) return { ok: false, reason: "form_incomplete", missing };

  const on = (name: string): boolean => find("checkbox", name)!.checked;
  const input: PermissionsSaveInput = {
    identity: on("identity"),
    highTier: on("highTier"),
    card: on("card"),
    tasks: on("tasks"),
    records: on("records"),
    memoryRead: on("memoryRead"),
    learningSharing: on("learningSharing"),
    // Every service the screen shows is sent, ticked or not, so an untick revokes it.
    connectors: opts.connectors.filter((id) => on(connectorControlName(id))),
  };
  const limit = find("number", REQUEST_LIMIT)!.value.trim();
  if (limit !== "") input.requestLimit = Number(limit);
  // The budget field only renders while card access is on; with card off the stored budget is
  // kept (OBS-022), so nothing is sent.
  const budget = find("number", CARD_BUDGET);
  if (input.card && budget && budget.value.trim() !== "") {
    input.cardBudget = { amount: Number(budget.value), currency: opts.currency, period: opts.period };
  }
  return { ok: true, input };
}
