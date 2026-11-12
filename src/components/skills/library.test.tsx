import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillsView } from "./skills-view";
import { PackageEditor } from "./package-editor";
import { makeSkillFile, parsePackage } from "../../domain/skills/package";

const houseSkill = { title: "Using Warthog", useThisWhen: "Use Warthog", alwaysIncluded: true as const };
test("library leads with search and readable private package cards; creating comes before importing", () => {
  const p = { ...parsePackage([{ path: "SKILL.md", content: makeSkillFile("Travel", "Plan trips", "Compare routes") }]), id: "p", revision: 1, members: [] };
  const html = renderToStaticMarkup(<SkillsView skills={[]} packages={[p]} preferences={null} houseSkill={houseSkill} />);
  assert.match(html, /<h1>Skills<\/h1>/, "the page is called Skills, like its tab and the sidebar");
  assert.match(html, /Search your library/);
  assert.match(html, /Import/);
  assert.match(html, /Travel/);
  assert.match(html, /Plan trips/);
  assert.ok(html.indexOf("Search your library") < html.indexOf(">Preferences</h2>"));
  assert.ok(html.indexOf(">Create a skill</h2>") < html.indexOf(">Import skills you already have</h2>"), "writing a skill comes first; importing is secondary");
  assert.doesNotMatch(html, /1 MB expanded|200 KB each/, "no package limits up front");
});

test("an empty library offers one next step and no dead search or filters", () => {
  const html = renderToStaticMarkup(<SkillsView skills={[]} packages={[]} preferences={null} houseSkill={houseSkill} />);
  assert.match(html, /No skills of your own yet/);
  assert.match(html, /href="\/skills\?view=add"[^>]*>Create or import a skill/);
  assert.doesNotMatch(html, /aria-label="Find skills"/, "no toolbar around an empty library");
  assert.match(html, /0 skills · 0 switched on/, "plugins are only counted once there is one");
});
test("editor shows source files as text and explains inactive plugin components", () => {
  const p = parsePackage([{ path: "commands/test.md", content: "<script>alert(1)</script>" }]);
  const html = renderToStaticMarkup(<PackageEditor draft={p} agents={[]} skills={[]} onClose={() => {}} onSaved={() => {}} />);
  assert.match(html, /commands\/test.md/);
  assert.match(html, /doesn’t run any scripts or commands/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});
