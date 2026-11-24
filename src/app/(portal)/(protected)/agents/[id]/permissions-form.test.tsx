// The agent page's unsaved-changes guard with one row per connected account
// (docs/adr/several-accounts-per-agent.md; UI/UX audit W-03). The form asks before an edit is
// lost, says "Nothing to save" when nothing changed, and counts the page as saved only after a
// save that worked. Each of those must still hold now that every account has its own controls.
//
// No DOM here (React component testing is a per-job ADR): the controls are read off the
// server-rendered screen the way the browser exposes them to the guard (name, type, ticked,
// value, in page order), and the guard's own pure decisions (controlSignature) and the form's
// (planSave, saveOutcome) are run over them.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { PermissionsView, type AccountAccess, type PermissionsViewProps } from "@/components/agents/permissions-view";
import { controlSignature, type ControlState } from "@/components/ui/unsaved-changes";
import { collectEdits } from "./permission-edits";
import { planSave, saveOutcome } from "./permissions-form";

const LEVY = "a0000000-0000-4000-8000-000000000001";
const BILLING = "a0000000-0000-4000-8000-000000000002";
const BOOKING = "a0000000-0000-4000-8000-000000000003";

const gmail = (id: string, label: string, grant: AccountAccess["grant"]): AccountAccess => ({
  id, connectorId: "google-gmail", serviceName: "Gmail", label, connected: true, grant,
  readTools: ["google-gmail__search", "google-gmail__read"], changeTools: ["google-gmail__send"],
});

const PROPS: PermissionsViewProps = {
  agentName: "ChatGPT",
  section: "connectors",
  embedded: true,
  readTools: true,
  changeTools: "ask_first",
  accounts: [
    gmail(LEVY, "levyoren1@gmail.com", {}),
    gmail(BILLING, "levyorenbilling@gmail.com", { changeTools: "allow" }),
    gmail(BOOKING, "levyorenbooking@gmail.com", null),
  ],
  lowTierRead: false,
  highTierRequest: false,
  cardAccess: false,
  budget: null,
  skills: [],
  tasksAccess: false,
  recordsAccess: false,
  sharedMemoryRead: false,
  learningSharing: false,
  rules: [],
};

const OPTS = { currency: "A$", period: "month" as const, accounts: [LEVY, BILLING, BOOKING], skills: [], section: "connectors" as const };

const attr = (attrs: string, name: string) => attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const flag = (attrs: string, name: string) => new RegExp(`(?:^|\\s)${name}(?:="")?(?=\\s|/|$)`).test(attrs);

// The screen's inputs and selects in page order, as the browser hands them to the guard and the
// save: a checkbox's value is "on" unless it has its own, a select's is its chosen option.
function controlsOf(markup: string): ControlState[] {
  const out: ControlState[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>|<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    if (m[1] !== undefined) {
      const type = attr(m[1], "type") ?? "text";
      out.push({ name: attr(m[1], "name") ?? "", type, checked: flag(m[1], "checked"), value: attr(m[1], "value") ?? (type === "checkbox" ? "on" : "") });
    } else {
      const options = [...m[3]!.matchAll(/<option\b([^>]*)>/g)].map((o) => o[1]!);
      const chosen = options.find((o) => flag(o, "selected")) ?? options[0]!;
      out.push({ name: attr(m[2]!, "name") ?? "", type: "select-one", checked: false, value: attr(chosen, "value") ?? "" });
    }
  }
  return out;
}

const edit = (controls: ControlState[], name: string, change: Partial<ControlState>): ControlState[] => {
  assert.ok(controls.some((c) => c.name === name), `the screen has ${name}`);
  return controls.map((c) => (c.name === name ? { ...c, ...change } : c));
};

const MARKUP = renderToStaticMarkup(<PermissionsView {...PROPS} />);
const LOADED = controlsOf(MARKUP);
// What the guard remembers once the page is ready.
const BASELINE = controlSignature(LOADED);

test("every account control is one the guard watches: named, not ignored, outside any form", () => {
  for (const id of [LEVY, BILLING, BOOKING]) {
    for (const name of [`account:${id}`, `accountRead:${id}`, `accountChange:${id}`, `accountToolScope:${id}`, `accountTool:${id}`]) {
      assert.ok(LOADED.some((c) => c.name === name), `${name} is on the screen`);
    }
  }
  assert.ok(LOADED.every((c) => c.name !== ""), "no unnamed control");
  assert.doesNotMatch(MARKUP, /data-unsaved-ignore|<form\b/);
});

test("with nothing changed, Save says there's nothing to save and sends nothing", () => {
  const dirty = controlSignature(controlsOf(MARKUP)) !== BASELINE;
  assert.equal(dirty, false);
  const plan = planSave(dirty, () => assert.fail("nothing is gathered or sent"));
  assert.ok("notice" in plan);
  assert.match(plan.notice.text, /^Nothing to save/);
});

test("an edit to one account's row is noticed, and that edit is what Save sends", () => {
  const offForBilling = edit(LOADED, `accountChange:${BILLING}`, { value: "off" });
  assert.notEqual(controlSignature(offForBilling), BASELINE, "changing one account's changes setting is an unsaved edit");
  const bookingOn = edit(LOADED, `account:${BOOKING}`, { checked: true });
  assert.notEqual(controlSignature(bookingOn), BASELINE, "ticking another account is an unsaved edit");
  const toolOff = LOADED.map((c) => (c.name === `accountTool:${LEVY}` && c.value === "google-gmail__send" ? { ...c, checked: false } : c));
  assert.notEqual(controlSignature(toolOff), BASELINE, "unticking one account's tool is an unsaved edit");

  const plan = planSave(true, () => collectEdits(offForBilling, OPTS));
  assert.ok("input" in plan);
  assert.deepEqual(plan.input.accounts, [
    { id: LEVY, granted: true },
    { id: BILLING, granted: true, changeTools: "off" },
    { id: BOOKING, granted: false },
  ]);
});

test("Save refuses a screen it can't fully read rather than dropping an account", () => {
  const plan = planSave(true, () => collectEdits(LOADED.filter((c) => c.name !== `account:${BILLING}`), OPTS));
  assert.ok("notice" in plan);
  assert.match(plan.notice.text, /couldn't read all of your settings/);
});

test("after a save that worked the page counts as saved; a refused save leaves the edit unsaved", () => {
  // The guard as the hook keeps it: a baseline, reset by markSaved() only when a save worked.
  const guard = { baseline: BASELINE };
  const dirty = (controls: ControlState[]) => controlSignature(controls) !== guard.baseline;
  const afterAnswer = (controls: ControlState[], answer: Parameters<typeof saveOutcome>[0]) => {
    const outcome = saveOutcome(answer);
    if (outcome.saved) guard.baseline = controlSignature(controls);
    return outcome;
  };
  const edited = edit(LOADED, `accountRead:${LEVY}`, { value: "off" });
  assert.equal(dirty(edited), true);

  const refused = afterAnswer(edited, { ok: false, reason: "invalid_request" });
  assert.match(refused.notice.text, /^Nothing was changed/);
  assert.equal(dirty(edited), true, "a refused save leaves the edit unsaved");

  const saved = afterAnswer(edited, { ok: true });
  assert.match(saved.notice.text, /^Saved\./);
  assert.equal(dirty(edited), false, "after a save that worked, the guard is clear");
  const again = planSave(dirty(edited), () => assert.fail("nothing to send"));
  assert.ok("notice" in again && /^Nothing to save/.test(again.notice.text), "pressing Save again says there's nothing to save");
  assert.equal(dirty(edit(edited, `account:${BOOKING}`, { checked: true })), true, "a later edit is noticed again");
});
