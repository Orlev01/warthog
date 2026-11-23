// UI/UX audit 2026-11-23 W-03 — the pure decisions behind the unsaved-changes guard
// (src/components/ui/unsaved-changes.ts): which forms have changed, and which clicks leave the page.
import { test } from "node:test";
import assert from "node:assert/strict";

import { controlSignature, formChanged, linkLeavesPage } from "./unsaved-changes";

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

// Code review: a server-rendered form is compared with the values the page rendered it with
// (its defaults), so a save that re-renders the page without remounting it can't leave a stale
// "unsaved" state behind, and no form is matched to another by position.
test("a server-rendered form has changed when a control differs from the value it was rendered with", () => {
  const field = (value: string, defaultValue: string) => ({ name: "shared-address", type: "text", checked: false, value, defaultValue, defaultChecked: false });
  assert.equal(formChanged([field("1 Old St", "1 Old St")]), false);
  assert.equal(formChanged([field("12 New St", "1 Old St")]), true);
  assert.equal(formChanged([field("12 New St", "12 New St")]), false, "after a save re-renders it with the new value, it's clean again");
  const tick = (checked: boolean, defaultChecked: boolean) => ({ name: "follow", type: "checkbox", checked, value: "on", defaultValue: "on", defaultChecked });
  assert.equal(formChanged([tick(true, false)]), true);
  assert.equal(formChanged([tick(false, false)]), false);
  assert.equal(formChanged([{ ...field("x", "y"), type: "hidden" }]), false, "hidden fields never count");
});
