// Gather the permissions screen's edits from its rendered controls (operator fix for the E10-S08
// review veto). Every control the screen renders is carried with its explicit on/off state, and a
// control the form cannot find REFUSES the save — naming what is missing — instead of silently
// omitting that field and reporting "Saved" over a dropped edit. Pure, so it is unit-tested
// without a DOM; the form maps its <input>s to ControlSnapshots.
import type { PeriodKind } from "@/domain/budget/budget";
import type { PermissionsSaveInput } from "./actions";

export type ControlSnapshot = {
  readonly type: string; // the input's type: "checkbox" | "number" | …
  readonly label: string; // its accessible name (label text or aria-label)
  readonly checked: boolean;
  readonly value: string;
};

export type CollectResult =
  | { readonly ok: true; readonly input: PermissionsSaveInput }
  | { readonly ok: false; readonly reason: "form_incomplete"; readonly missing: readonly string[] };

// The controls the screen always renders, keyed by the save field each one feeds.
const REQUIRED: ReadonlyArray<readonly [field: string, type: string, label: RegExp]> = [
  ["identity", "checkbox", /low-tier/i],
  ["highTier", "checkbox", /high-tier/i],
  ["card", "checkbox", /card/i],
  ["memoryRead", "checkbox", /shared memory/i],
  ["learningSharing", "checkbox", /learn/i],
  ["requestLimit", "number", /request|limit|minute/i],
];

export function collectEdits(
  controls: readonly ControlSnapshot[],
  opts: { readonly currency: string; readonly period: PeriodKind },
): CollectResult {
  const find = (type: string, re: RegExp) => controls.find((c) => c.type === type && re.test(c.label));
  const missing = REQUIRED.filter(([, type, re]) => !find(type, re)).map(([field]) => field);
  if (missing.length > 0) return { ok: false, reason: "form_incomplete", missing };

  const at = (field: string) => {
    const [, type, re] = REQUIRED.find(([f]) => f === field)!;
    return find(type, re)!;
  };
  const input: PermissionsSaveInput = {
    identity: at("identity").checked,
    highTier: at("highTier").checked,
    card: at("card").checked,
    memoryRead: at("memoryRead").checked,
    learningSharing: at("learningSharing").checked,
  };
  const limit = at("requestLimit").value.trim();
  if (limit !== "") input.requestLimit = Number(limit);
  // The budget field only renders while card access is on; with card off the stored budget is
  // kept (OBS-022), so nothing is sent.
  const budget = find("number", /budget/i);
  if (input.card && budget && budget.value.trim() !== "") {
    input.cardBudget = { amount: Number(budget.value), currency: opts.currency, period: opts.period };
  }
  return { ok: true, input };
}
