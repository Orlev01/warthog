import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePackage, validateFiles, makeSkillFile, updateSkillFile, duplicatePackage } from "./package";

test("recognises a wrapped skill and preserves frontmatter and supporting files", () => {
  const source = "---\r\nname: 'Travel planner'\r\ndescription: >-\r\n  Plan my trips\r\n  and compare routes\r\ncustom: keep-me\r\n---\r\nUse references/checklist.md.\r\n";
  const p = parsePackage([{ path: "travel/SKILL.md", content: source }, { path: "travel/references/checklist.md", content: "Check dates" }]);
  assert.equal(p.kind, "skill");
  assert.equal(p.name, "Travel planner");
  assert.equal(p.skills[0].description, "Plan my trips and compare routes");
  assert.equal(p.files[0].content, source);
  assert.equal(p.files[1].path, "references/checklist.md");
});

test("keeps a one-skill plugin a plugin and inventories inert components", () => {
  const p = parsePackage([
    { path: ".claude-plugin/plugin.json", content: '{"name":"Work kit","description":"My toolkit"}' },
    { path: "skills/review/SKILL.md", content: makeSkillFile("Review", "Review changes", "Read the diff.") },
    { path: "hooks/hooks.json", content: "{}" }, { path: ".mcp.json", content: "{}" },
    { path: "agents/reviewer.md", content: "Review" },
  ]);
  assert.equal(p.kind, "plugin");
  assert.equal(p.name, "Work kit");
  assert.equal(p.skills.length, 1);
  assert.equal(p.components.hooks, 1);
  assert.equal(p.components.connectors, 1);
  assert.equal(p.components.agents, 1);
});

test("accepts a plugin with only commands, without pretending they run in Warthog", () => {
  const p = parsePackage([{ path: "commands/hello.md", content: "Hello" }]);
  assert.equal(p.kind, "plugin");
  assert.equal(p.skills.length, 0);
});

test("rejects unsafe, duplicate, oversized and malformed package files", () => {
  for (const path of ["../secret", "/SKILL.md", "C:/SKILL.md", "a\\b", "a//b", "a/./b", "a\u0000b"]) {
    assert.throws(() => validateFiles([{ path, content: "text" }]));
  }
  assert.throws(() => validateFiles([{ path: "x", content: "a" }, { path: "X", content: "b" }]), /Duplicate/);
  assert.throws(() => validateFiles([{ path: "x", content: "a".repeat(200_001) }]), /large/);
  assert.throws(() => parsePackage([{ path: "SKILL.md", content: "no frontmatter" }]), /frontmatter/);
  assert.throws(() => parsePackage([{ path: ".claude-plugin/plugin.json", content: "not json" }]), /manifest/);
  assert.throws(() => parsePackage([{ path: "SKILL.md", content: makeSkillFile("Using Warthog", "Reserved", "Text") }]), /one of Warthog's skills/);
  assert.throws(() => parsePackage([{ path: "SKILL.md", content: makeSkillFile("building a profile", "Mine", "Text") }]), /one of Warthog's skills/, "every Warthog skill's title, whatever the case");
});

test("skill authoring escapes quoted fields and requires instructions", () => {
  const p = parsePackage([{ path: "SKILL.md", content: makeSkillFile('A "quoted" title', "Use: when needed", "Do this") }]);
  assert.equal(p.name, 'A "quoted" title');
  assert.throws(() => parsePackage([{ path: "SKILL.md", content: makeSkillFile("Title", "When", " ") }]), /instructions/);
});

test("form edits and copies retain unknown frontmatter and supporting files", () => {
  const original = "---\nname: Original\ndescription: >-\n  Old description\nallowed-tools: [Read]\nmetadata:\n  owner: me\n---\nOld body";
  const updated = updateSkillFile(original, "New name", "New description", "New body");
  assert.match(updated, /allowed-tools: \[Read\]/);
  assert.match(updated, /metadata:\n  owner: me/);
  const parsed = parsePackage([{ path: "SKILL.md", content: updated }, { path: "help.md", content: "Help" }]);
  assert.equal(parsed.skills[0].body, "New body");
  const copy = duplicatePackage(parsed);
  assert.equal(copy.name, "New name copy");
  assert.equal(copy.files[1].content, "Help");
  assert.match(copy.files[0].content, /allowed-tools/);
});
