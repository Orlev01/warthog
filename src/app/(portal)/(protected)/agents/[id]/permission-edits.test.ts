// Operator fix (E10-S08 review veto 2): the permissions form gathered only four of the screen's
// seven controls and silently omitted any control its label match didn't find, so edits were
// dropped behind a "Saved" banner. collectEdits gathers every control and refuses (naming what is
// missing) rather than omitting.
//
// Review fix W2.3: the screen also carries the tasks and life-admin records grants and one toggle
// per connected service. Controls are now found by their stable `name` (never by visible label
// text), so a service or skill whose name happens to contain "card" or "learn" can never stand in
// for the card-access or sharing toggle.
//
// Several accounts of one service (docs/adr/several-accounts-per-agent.md): the Connectors
// section has one row per connected ACCOUNT, each with its own on/off, reading, changes and tool
// choices, keyed by the account's id. The save carries every row it shows, and a row it can't
// find refuses the save as a missing service toggle did.
import { test } from "node:test";
import assert from "node:assert/strict";

import { collectEdits, type ControlSnapshot } from "./permission-edits";

const box = (name: string, checked: boolean): ControlSnapshot => ({ type: "checkbox", name, checked, value: "" });
const num = (name: string, value: string): ControlSnapshot => ({ type: "number", name, checked: false, value });
const pick = (name: string, value: string): ControlSnapshot => ({ type: "select-one", name, checked: false, value });
const tool = (name: string, value: string, checked: boolean): ControlSnapshot => ({ type: "checkbox", name, checked, value });

// Two Gmail accounts and a calendar account, as the Connectors section renders their rows.
const BILLING = "0b0e5a8e-1c2d-4e3f-8a9b-0c1d2e3f4a5b";
const BOOKING = "1c1f6b9f-2d3e-4f40-9bac-1d2e3f4a5b6c";
const CALENDAR = "2d207cae-3e4f-4051-acbd-2e3f4a5b6c7d";

function row(id: string, over: { granted?: boolean; read?: string; change?: string; scope?: string; tools?: Record<string, boolean> } = {}): ControlSnapshot[] {
  return [
    box(`account:${id}`, over.granted ?? false),
    pick(`accountRead:${id}`, over.read ?? "default"),
    pick(`accountChange:${id}`, over.change ?? "default"),
    pick(`accountToolScope:${id}`, over.scope ?? "all"),
    ...Object.entries(over.tools ?? {}).map(([name, checked]) => tool(`accountTool:${id}`, name, checked)),
  ];
}

const FULL = (over: Partial<Record<string, boolean | string>> = {}): ControlSnapshot[] => [
  ...row(CALENDAR, { granted: (over.calendar as boolean) ?? false }),
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
const OPTS = { currency: "A$", period: "month" as const, accounts: [CALENDAR] };

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

test("each account's toggle is carried: the ticked accounts are the ones granted", () => {
  const ticked = collectEdits(FULL({ calendar: true }), OPTS);
  assert.ok(ticked.ok);
  if (!ticked.ok) return;
  assert.deepEqual(ticked.input.accounts, [{ id: CALENDAR, granted: true }]);
  const unticked = collectEdits(FULL({ calendar: false }), OPTS);
  assert.ok(unticked.ok);
  if (!unticked.ok) return;
  assert.deepEqual(unticked.input.accounts, [{ id: CALENDAR, granted: false }], "an unticked account is sent as not granted, never dropped");
});

test("two accounts of one service each carry their own settings; \"same as this agent\" leaves a setting out", () => {
  const controls = [
    ...FULL(),
    ...row(BILLING, { granted: true, read: "off", change: "allow", scope: "chosen", tools: { "google-gmail__search": true, "google-gmail__send": false } }),
    ...row(BOOKING, { granted: true }),
  ];
  const r = collectEdits(controls, { ...OPTS, accounts: [CALENDAR, BILLING, BOOKING] });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.input.accounts, [
    { id: CALENDAR, granted: false },
    { id: BILLING, granted: true, readTools: false, changeTools: "allow", allowedTools: ["google-gmail__search"] },
    { id: BOOKING, granted: true },
  ]);
  // One account's tool ticks never leak into another's.
  const swapped = collectEdits(
    [...FULL(), ...row(BILLING, { scope: "all", tools: { "google-gmail__search": true } }), ...row(BOOKING, { scope: "chosen", tools: { "google-gmail__send": true } })],
    { ...OPTS, accounts: [BILLING, BOOKING] },
  );
  assert.ok(swapped.ok);
  if (!swapped.ok) return;
  assert.deepEqual(swapped.input.accounts, [
    { id: BILLING, granted: false },
    { id: BOOKING, granted: false, allowedTools: ["google-gmail__send"] },
  ]);
  assert.equal("connectors" in swapped.input || "connectorAccounts" in swapped.input || "connectorPolicies" in swapped.input, false, "the old service-keyed fields are gone");
});

test("\"only the tools I tick\" with nothing ticked is sent as no tools, not as all tools", () => {
  const r = collectEdits([...FULL(), ...row(BILLING, { granted: true, scope: "chosen", tools: { "google-gmail__search": false } })], { ...OPTS, accounts: [BILLING] });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.input.accounts, [{ id: BILLING, granted: true, allowedTools: [] }]);
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

test("an account the screen shows but the form cannot find refuses the save, naming it", () => {
  const withoutCalendar = FULL().filter((c) => c.name !== `account:${CALENDAR}`);
  const r = collectEdits(withoutCalendar, OPTS);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "form_incomplete");
  assert.deepEqual(r.missing, [`account:${CALENDAR}`]);
});

test("an account row missing one of its settings refuses the save rather than resetting it", () => {
  const r = collectEdits(FULL().filter((c) => c.name !== `accountChange:${CALENDAR}`), OPTS);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(r.missing, [`accountChange:${CALENDAR}`]);
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

// docs/adr/agent-saved-skills.md: the Skills section's "Let it save skills" switch is carried
// with the section, beside the tasks and records controls the settings section carries.
test("the Let it save skills switch is carried with the Skills section, merged with the other controls", () => {
  const skills = collectEdits([box("skillsWrite", false)], { ...OPTS, skills: [], section: "skills" });
  assert.equal(skills.ok, true);
  if (skills.ok) assert.deepEqual(skills.input.resourceControls, { skillsWrite: false });
  const all = collectEdits([...FULL(), box("tasksWrite", true), box("skillsWrite", true)], { ...OPTS, skills: [] });
  assert.equal(all.ok, true);
  if (all.ok) assert.deepEqual(all.input.resourceControls, { tasksWrite: true, skillsWrite: true });
  const settings = collectEdits([...FULL(), box("skillsWrite", false)], { ...OPTS, section: "settings" });
  assert.equal(settings.ok, true);
  if (settings.ok) assert.equal(settings.input.resourceControls?.skillsWrite, undefined, "another section doesn't carry it");
});
