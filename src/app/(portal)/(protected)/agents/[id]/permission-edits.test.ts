// Operator fix (E10-S08 review veto 2): the permissions form gathered only four of the screen's
// seven controls and silently omitted any control its label match didn't find, so edits were
// dropped behind a "Saved" banner. collectEdits gathers every control and refuses (naming what is
// missing) rather than omitting.
//
// Review fix W2.3: the screen also carries the tasks and life-admin records grants and one toggle
// per connected service. Controls are now found by their stable `name` (never by visible label
// text), so a service or skill whose name happens to contain "card" or "learn" can never stand in
// for the card-access or sharing toggle.
import { test } from "node:test";
import assert from "node:assert/strict";

import { collectEdits, type ControlSnapshot } from "./permission-edits";

const box = (name: string, checked: boolean): ControlSnapshot => ({ type: "checkbox", name, checked, value: "" });
const num = (name: string, value: string): ControlSnapshot => ({ type: "number", name, checked: false, value });

const FULL = (over: Partial<Record<string, boolean | string>> = {}): ControlSnapshot[] => [
  box("connector:google-calendar", (over.calendar as boolean) ?? false),
  box("identity", (over.identity as boolean) ?? true),
  box("highTier", (over.highTier as boolean) ?? false),
  box("card", (over.card as boolean) ?? false),
  num("cardBudget", (over.budget as string) ?? ""),
  box("tasks", (over.tasks as boolean) ?? false),
  box("records", (over.records as boolean) ?? false),
  box("memoryRead", (over.memoryRead as boolean) ?? false),
  box("learningSharing", (over.learn as boolean) ?? false),
  num("requestLimit", (over.limit as string) ?? "120"),
];
const OPTS = { currency: "A$", period: "month" as const, connectors: ["google-calendar"] };

test("every toggle on the screen is carried, with its explicit on/off state", () => {
  const r = collectEdits(FULL({ identity: false, highTier: true, memoryRead: true, learn: true }), OPTS);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(
    { identity: r.input.identity, highTier: r.input.highTier, memoryRead: r.input.memoryRead, learningSharing: r.input.learningSharing, card: r.input.card, requestLimit: r.input.requestLimit },
    { identity: false, highTier: true, memoryRead: true, learningSharing: true, card: false, requestLimit: 120 },
  );
});

test("the tasks and life-admin records grants are carried with their on/off state", () => {
  const on = collectEdits(FULL({ tasks: true, records: false }), OPTS);
  assert.ok(on.ok);
  if (!on.ok) return;
  assert.equal(on.input.tasks, true);
  assert.equal(on.input.records, false);
});

test("each connected service's toggle is carried: the ticked services are the ones granted", () => {
  const ticked = collectEdits(FULL({ calendar: true }), OPTS);
  assert.ok(ticked.ok && ticked.input.connectors !== undefined);
  if (!ticked.ok) return;
  assert.deepEqual(ticked.input.connectors, ["google-calendar"]);
  const unticked = collectEdits(FULL({ calendar: false }), OPTS);
  assert.ok(unticked.ok);
  if (!unticked.ok) return;
  assert.deepEqual(unticked.input.connectors, [], "an unticked service is sent as not granted, never dropped");
});

test("card on with a budget carries the budget; card off sends no budget (the stored one is kept)", () => {
  const on = collectEdits(FULL({ card: true, budget: "250" }), OPTS);
  assert.ok(on.ok && on.input.cardBudget?.amount === 250 && on.input.cardBudget.period === "month");
  const off = collectEdits(FULL({ card: false, budget: "250" }), OPTS);
  assert.ok(off.ok && off.input.cardBudget === undefined);
});

test("a control the form cannot find refuses the save, naming it, instead of dropping the edit", () => {
  const withoutHighTier = FULL().filter((c) => c.name !== "highTier");
  const r = collectEdits(withoutHighTier, OPTS);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "form_incomplete");
  assert.deepEqual(r.missing, ["highTier"]);
});

test("a connected service the screen shows but the form cannot find refuses the save, naming it", () => {
  const withoutCalendar = FULL().filter((c) => c.name !== "connector:google-calendar");
  const r = collectEdits(withoutCalendar, OPTS);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(r.missing, ["connector:google-calendar"]);
});

test("a missing tasks or records toggle refuses the save rather than dropping the grant", () => {
  const r = collectEdits(FULL().filter((c) => c.name !== "tasks" && c.name !== "records"), OPTS);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(r.missing, ["tasks", "records"]);
});

test("controls are matched by name, so a service or skill whose label says 'card' or 'learn' binds nothing else", () => {
  // A skill toggle labelled like the sharing / card toggles, rendered before them: it carries
  // its own name, so the card-access and sharing grants come from their own controls only.
  const decoys: ControlSnapshot[] = [
    { type: "checkbox", name: "skill:sk1", label: "Learning plan for your card", checked: true, value: "" },
  ];
  const r = collectEdits([...decoys, ...FULL({ card: false, learn: false })], OPTS);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.input.card, false);
  assert.equal(r.input.learningSharing, false);
});
