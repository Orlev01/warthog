// Operator fix (E10-S08 review veto 2): the permissions form gathered only four of the screen's
// seven controls and silently omitted any control its label match didn't find, so edits were
// dropped behind a "Saved" banner. collectEdits gathers every control and refuses (naming what is
// missing) rather than omitting.
import { test } from "node:test";
import assert from "node:assert/strict";

import { collectEdits, type ControlSnapshot } from "./permission-edits";

const box = (label: string, checked: boolean): ControlSnapshot => ({ type: "checkbox", label, checked, value: "" });
const num = (label: string, value: string): ControlSnapshot => ({ type: "number", label, checked: false, value });

const FULL = (over: Partial<Record<string, boolean | string>> = {}): ControlSnapshot[] => [
  box("Read your low-tier identity details", (over.identity as boolean) ?? true),
  box("Let it ask for high-tier identity details", (over.highTier as boolean) ?? false),
  box("Let it ask to use a card", (over.card as boolean) ?? false),
  num("Budget per month (A$)", (over.budget as string) ?? ""),
  box("Read your shared memory", (over.memoryRead as boolean) ?? false),
  box("Share what it learns with your other agents", (over.learn as boolean) ?? false),
  num("Request limit (per minute)", (over.limit as string) ?? "120"),
];
const OPTS = { currency: "A$", period: "month" as const };

test("every toggle on the screen is carried, with its explicit on/off state", () => {
  const r = collectEdits(FULL({ identity: false, highTier: true, memoryRead: true, learn: true }), OPTS);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(
    { identity: r.input.identity, highTier: r.input.highTier, memoryRead: r.input.memoryRead, learningSharing: r.input.learningSharing, card: r.input.card, requestLimit: r.input.requestLimit },
    { identity: false, highTier: true, memoryRead: true, learningSharing: true, card: false, requestLimit: 120 },
  );
});

test("card on with a budget carries the budget; card off sends no budget (the stored one is kept)", () => {
  const on = collectEdits(FULL({ card: true, budget: "250" }), OPTS);
  assert.ok(on.ok && on.input.cardBudget?.amount === 250 && on.input.cardBudget.period === "month");
  const off = collectEdits(FULL({ card: false, budget: "250" }), OPTS);
  assert.ok(off.ok && off.input.cardBudget === undefined);
});

test("a control the form cannot find refuses the save, naming it, instead of dropping the edit", () => {
  const withoutHighTier = FULL().filter((c) => !/high-tier/i.test(c.label));
  const r = collectEdits(withoutHighTier, OPTS);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "form_incomplete");
  assert.deepEqual(r.missing, ["highTier"]);
});
