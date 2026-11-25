// UI/UX follow-up — deleting a skill asks first, in the page (not the browser's confirm()).
//
// The same danger confirmation as removing a passkey or disconnecting an agent: the card's
// Delete is a plain button that opens a dialog naming the skill and saying what deleting it
// means; the safe choice comes first and takes focus; only the dialog's "Delete skill"
// (danger-solid) posts, through the guarded ActionForm, to the unchanged delete action with
// the skill's id. Escape and focus return are the native modal dialog's (checked in the
// browser); this pins the markup. Rendered with react-dom/server, read as markup (no DOM).

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { SkillsView, type SkillsViewSkill } from "./skills-view";
import { DeleteSkillControl, deleteSkillCopy } from "./delete-skill";

const SKILL: SkillsViewSkill = {
  id: "sk-groceries",
  title: "Weekly grocery run",
  useThisWhen: "when I ask you to restock the kitchen",
  fullText: "Check the pantry first.",
  scope: "all",
  scopedAgentIds: [],
  enabled: true,
};

const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const dialogOf = (html: string) => /<dialog\b[\s\S]*?<\/dialog>/.exec(html)?.[0] ?? "";

test("the dialog names the skill and says plainly what deleting it means", () => {
  const copy = deleteSkillCopy("Weekly grocery run");
  assert.equal(copy.title, "Delete Weekly grocery run?");
  assert.match(copy.body, /agents lose access to it straight away/);
  assert.match(copy.body, /can't be undone/);
});

test("a skill card's Delete opens the confirmation; it never posts on its own", () => {
  const html = renderToStaticMarkup(<SkillsView skills={[SKILL]} preferences={null} deleteSkillAction={async () => {}} />);
  const trigger = /<button[^>]*aria-haspopup="dialog"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
  assert.match(trigger, /type="button"/, "the card's Delete is not a submit");
  assert.match(text(trigger), /^Delete Weekly grocery run$/, "its name says which skill");
  const dialog = dialogOf(html);
  assert.match(dialog, /aria-labelledby="[^"]+"/);
  assert.match(dialog, /aria-describedby="[^"]+"/);
  assert.match(text(dialog), /Delete Weekly grocery run\?/);
  assert.match(text(dialog), /agents lose access to it straight away/);
  assert.doesNotMatch(html, /window\.confirm|onsubmit/i);
});

test("only the dialog's danger button posts the skill's id; the safe choice comes first and takes focus", () => {
  const html = renderToStaticMarkup(<DeleteSkillControl skillId="sk-groceries" title="Weekly grocery run" action={async () => {}} />);
  assert.match(html, /^<form\b/, "one form, so the guarded ActionForm wraps the dialog's submit");
  assert.match(html, /<input type="hidden" name="id" value="sk-groceries"\/>/);
  const dialog = dialogOf(html);
  const submits = dialog.match(/<button[^>]*type="submit"[^>]*>[\s\S]*?<\/button>/g) ?? [];
  assert.equal(submits.length, 1, "exactly one control posts");
  assert.match(text(submits[0]!), /^Delete skill$/);
  assert.match(submits[0]!, /bg-danger/, "the final step is danger-solid");
  const keep = /<button[^>]*>Keep skill<\/button>/.exec(dialog)?.[0] ?? "";
  assert.match(keep, /type="button"/, "the safe choice never posts");
  assert.match(keep, /autofocus/i, "the safe choice takes focus when the dialog opens");
  assert.ok(dialog.indexOf("Keep skill") < dialog.indexOf("Delete skill"), "the safe choice comes first in reading order");
});

test("an empty library offers no delete confirmation", () => {
  const html = renderToStaticMarkup(<SkillsView skills={[]} preferences={null} />);
  assert.doesNotMatch(html, /<dialog\b[^>]*aria-labelledby/);
  assert.doesNotMatch(text(html), /Delete skill/);
});
