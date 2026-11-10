import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SkillsView } from "./skills-view";
import { PackageEditor } from "./package-editor";
import { makeSkillFile, parsePackage } from "../../domain/skills/package";

const houseSkill = { title: "Using Warthog", useThisWhen: "Use Warthog", alwaysIncluded: true as const };
test("library leads with import, search and readable private package cards", () => {
  const p = { ...parsePackage([{ path: "SKILL.md", content: makeSkillFile("Travel", "Plan trips", "Compare routes") }]), id: "p", revision: 1, members: [] };
  const html = renderToStaticMarkup(<SkillsView skills={[]} packages={[p]} preferences={null} houseSkill={houseSkill} />);
  assert.match(html, /Skills &amp; plugins/);
  assert.match(html, /Search your library/);
  assert.match(html, /Import/);
  assert.match(html, /Travel/);
  assert.match(html, /Plan trips/);
  assert.ok(html.indexOf("Search your library") < html.indexOf("Your style profile"));
});
test("editor shows source files as text and explains inactive plugin components", () => {
  const p = parsePackage([{ path: "commands/test.md", content: "<script>alert(1)</script>" }]);
  const html = renderToStaticMarkup(<PackageEditor draft={p} agents={[]} skills={[]} onClose={() => {}} onSaved={() => {}} />);
  assert.match(html, /commands\/test.md/);
  assert.match(html, /Warthog does not run/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
});
