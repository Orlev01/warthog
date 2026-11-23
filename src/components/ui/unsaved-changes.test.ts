// UI/UX audit 2026-11-23 W-03 — the pure decisions behind the unsaved-changes guard
// (src/components/ui/unsaved-changes.ts): which forms have changed, and which clicks leave the page.
import { test } from "node:test";
import assert from "node:assert/strict";

import { changedGroups, controlSignature, linkLeavesPage } from "./unsaved-changes";

test("a group's signature changes only when a control's value or tick changes", () => {
  const before = controlSignature([
    { name: "card", type: "checkbox", checked: true, value: "on" },
    { name: "cardBudget", type: "number", checked: false, value: "300" },
  ]);
  const same = controlSignature([
    { name: "card", type: "checkbox", checked: true, value: "on" },
    { name: "cardBudget", type: "number", checked: false, value: "300" },
  ]);
  const unticked = controlSignature([
    { name: "card", type: "checkbox", checked: false, value: "on" },
    { name: "cardBudget", type: "number", checked: false, value: "300" },
  ]);
  assert.equal(before, same);
  assert.notEqual(before, unticked, "unticking card access is a change");
});

test("buttons, hidden fields and controls marked to be ignored never count as edits", () => {
  const a = controlSignature([{ name: "q", type: "search", checked: false, value: "" }]);
  const b = controlSignature([
    { name: "q", type: "search", checked: false, value: "" },
    { name: "intent", type: "hidden", checked: false, value: "x" },
    { name: "go", type: "submit", checked: false, value: "Go" },
    { name: "ignored", type: "text", checked: false, value: "anything", ignore: true },
  ]);
  assert.equal(a, b);
});

test("changedGroups lists only the groups that differ from when the page was ready", () => {
  const baseline = new Map([["address", "a"], ["budget", "b"]]);
  assert.deepEqual(changedGroups(baseline, new Map([["address", "a"], ["budget", "b"]])), []);
  assert.deepEqual(changedGroups(baseline, new Map([["address", "A"], ["budget", "b"]])), ["address"]);
  assert.deepEqual(changedGroups(baseline, new Map([["address", "a"]])), [], "a group that went away is not an unsaved edit");
});

const here = "https://app.warthog.com.au/agents/1?section=spending";
const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

test("following a link to another page leaves it; the same page, a new tab or a hash link doesn't", () => {
  assert.equal(linkLeavesPage({ ...click, href: "https://app.warthog.com.au/agents/1?section=rules" }, here), true, "another agent section");
  assert.equal(linkLeavesPage({ ...click, href: "https://app.warthog.com.au/home" }, here), true);
  assert.equal(linkLeavesPage({ ...click, href: "https://app.warthog.com.au/agents/1?section=spending#budget" }, here), false, "a jump within the page");
  assert.equal(linkLeavesPage({ ...click, href: here, target: "_blank" }, here), false, "a new tab keeps this page");
  assert.equal(linkLeavesPage({ ...click, metaKey: true, href: "https://app.warthog.com.au/home" }, here), false, "cmd-click opens a new tab");
  assert.equal(linkLeavesPage({ ...click, button: 1, href: "https://app.warthog.com.au/home" }, here), false, "middle click opens a new tab");
  assert.equal(linkLeavesPage({ ...click, href: "https://app.warthog.com.au/home", download: true }, here), false);
});
