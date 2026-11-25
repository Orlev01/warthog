import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { freshDb } from "../../test/db";
import { createUser } from "./users";
import { savePackage, listPackages, listPackageSummaries, deletePackage, packageFileForSkill } from "./skill-packages";
import { listSkillsForUser, skillsForAgent, getSkillText } from "./skills";
import { makeSkillFile } from "../../domain/skills/package";

test("packages encrypt all file content, scope reads, preserve IDs and reject stale edits atomically", async () => {
  const db = await freshDb();
  try {
    const owner = await createUser(db, { email: "owner@example.test", wrappedDek: "wrapped", role: "member" });
    const other = await createUser(db, { email: "other@example.test", wrappedDek: "wrapped", role: "member" });
    const dek = randomBytes(32);
    const files = [{ path: "SKILL.md", content: makeSkillFile("Private trip", "When planning", "Use references/list.md") }, { path: "references/list.md", content: "private supporting text" }];
    const saved = await savePackage(db, owner.id, { files }, dek);
    const summaries = await listPackageSummaries(db, owner.id, dek);
    assert.equal(summaries[0].fileCount, 2);
    assert.equal(summaries[0].name, "Private trip");
    assert.ok(!JSON.stringify(summaries).includes("private supporting text"));
    assert.ok(!JSON.stringify(summaries).includes("Use references/list.md"));
    const rows = await db.query("SELECT content_ct FROM skill_packages WHERE user_id = $1", [owner.id]);
    assert.ok(!JSON.stringify(rows).includes("private supporting text"));
    assert.equal((await listPackages(db, other.id, dek)).length, 0);
    await assert.rejects(() => listPackages(db, owner.id, randomBytes(32)));
    let skills = await listSkillsForUser(db, owner.id, dek);
    assert.equal(skills.length, 1); assert.equal(skills[0].enabled, false);
    assert.deepEqual(await skillsForAgent(db, owner.id, "agent", dek), []);
    assert.equal(await getSkillText(db, owner.id, "agent", "Private trip", dek, "references/list.md"), null);
    assert.equal(await packageFileForSkill(db, other.id, skills[0].id, "references/list.md", dek), null);
    assert.equal(await packageFileForSkill(db, owner.id, skills[0].id, "../SKILL.md", dek), null);
    assert.equal(await packageFileForSkill(db, owner.id, skills[0].id, "references/list.md", dek), "private supporting text");
    const id = skills[0].id;
    await db.query("UPDATE skills SET enabled = true WHERE id = $1", [id]);
    assert.equal(await getSkillText(db, owner.id, "agent", "Private trip", dek, "references/list.md"), "private supporting text");
    assert.match((await getSkillText(db, owner.id, "agent", "Private trip", dek))!, /references\/list.md/);
    await db.query("UPDATE skills SET scope = 'chosen' WHERE id = $1", [id]);
    assert.equal(await getSkillText(db, owner.id, "agent", "Private trip", dek, "references/list.md"), null);
    await db.query("UPDATE skills SET scope = 'all' WHERE id = $1", [id]);
    const changed = await savePackage(db, owner.id, { id: saved.id, revision: saved.revision, files: files.map((f) => f.path === "SKILL.md" ? { ...f, content: makeSkillFile("Renamed", "When planning", "New instructions") } : f) }, dek);
    skills = await listSkillsForUser(db, owner.id, dek);
    assert.equal(skills[0].id, id); assert.equal(skills[0].enabled, true); assert.equal(skills[0].fullText, "New instructions");
    await assert.rejects(() => savePackage(db, owner.id, { id: saved.id, revision: saved.revision, files }, dek), /changed/);
    await assert.rejects(() => savePackage(db, other.id, { id: saved.id, revision: changed.revision, files }, dek), /not found/);
    assert.equal(await deletePackage(db, other.id, saved.id, changed.revision), false);
    assert.equal(await deletePackage(db, owner.id, saved.id, changed.revision), true);
    assert.equal((await listSkillsForUser(db, owner.id, dek)).length, 0);
  } finally { await db.close(); }
});

test("plugin updates remove missing skills, add disabled skills, and reject ambiguous names", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "kit@example.test", wrappedDek: "wrapped", role: "member" });
    const dek = randomBytes(32);
    const files = ["one", "two"].map((name) => ({ path: `skills/${name}/SKILL.md`, content: makeSkillFile(name, "When needed", "Do work") }));
    const kit = await savePackage(db, user.id, { files, name: "Kit" }, dek);
    assert.deepEqual((await listSkillsForUser(db, user.id, dek)).map((s) => s.title).sort(), ["Kit / one", "Kit / two"]);
    await assert.rejects(() => savePackage(db, user.id, { files, name: "Kit" }, dek), /already/);
    await savePackage(db, user.id, { id: kit.id, revision: kit.revision, files: files.slice(1), name: "Kit" }, dek);
    assert.equal((await listSkillsForUser(db, user.id, dek)).length, 1);
    await db.query("DELETE FROM users WHERE id = $1", [user.id]);
    assert.equal((await db.query("SELECT id FROM skill_packages")).rows.length, 0);
  } finally { await db.close(); }
});

test("supporting-file reads cannot cross into nested skills or root plugin configuration", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "nested@example.test", wrappedDek: "wrapped", role: "member" });
    const dek = randomBytes(32);
    const files = [
      { path: ".claude-plugin/plugin.json", content: JSON.stringify({ name: "Nested kit" }) },
      { path: "SKILL.md", content: makeSkillFile("Root", "When needed", "Use references/root.md") },
      { path: "references/root.md", content: "root reference" },
      { path: "commands/private.md", content: "private command" },
      { path: ".mcp.json", content: "{}" },
      { path: "skills/child/SKILL.md", content: makeSkillFile("Child", "When needed", "Use references/child.md") },
      { path: "skills/child/references/child.md", content: "child reference" },
      { path: "skills/child/nested/SKILL.md", content: makeSkillFile("Nested", "When needed", "Nested instructions") },
      { path: "skills/child/nested/private.md", content: "nested private reference" },
    ];
    const kit = await savePackage(db, user.id, { files }, dek);
    for (const member of kit.members.filter((m) => m.path !== "skills/child/nested/SKILL.md")) {
      await db.query("UPDATE skills SET enabled = true WHERE id = $1 AND user_id = $2", [member.skillId, user.id]);
    }
    assert.equal(await getSkillText(db, user.id, "agent", "Nested kit / Root", dek, "references/root.md"), "root reference");
    for (const path of ["skills/child/SKILL.md", "skills/child/references/child.md", "commands/private.md", ".mcp.json", ".claude-plugin/plugin.json"]) {
      assert.equal(await getSkillText(db, user.id, "agent", "Nested kit / Root", dek, path), null, path);
    }
    assert.equal(await getSkillText(db, user.id, "agent", "Nested kit / Child", dek, "references/child.md"), "child reference");
    assert.equal(await getSkillText(db, user.id, "agent", "Nested kit / Child", dek, "nested/private.md"), null);
    assert.equal(await getSkillText(db, user.id, "agent", "Nested kit / Child", dek, "nested/SKILL.md"), null);
    const rootText = await getSkillText(db, user.id, "agent", "Nested kit / Root", dek);
    assert.match(rootText!, /references\/root.md/);
    assert.doesNotMatch(rootText!, /child|commands|plugin.json|\.mcp.json/);
    assert.doesNotMatch((await getSkillText(db, user.id, "agent", "Nested kit / Child", dek))!, /nested\//);
  } finally { await db.close(); }
});

// docs/adr/editable-builtin-skills.md and review, 25 Nov 2026: a package saved from the Skills page
// can't take a Warthog skill's title, but one that already had it still opens, exports and saves.
test("a Warthog skill's title is refused for a new package skill, never for one that already had it", async () => {
  const db = await freshDb();
  try {
    const owner = await createUser(db, { email: "reserved@example.test", wrappedDek: "wrapped", role: "member" });
    const dek = randomBytes(32);
    const taxTime = [{ path: "SKILL.md", content: makeSkillFile("Tax time", "When it's tax time", "My way") }];
    await assert.rejects(savePackage(db, owner.id, { files: taxTime }, dek, { refuseNewReservedNames: true }), /one of Warthog's skills/);
    // An import (or a package saved before the name was Warthog's) keeps it.
    const kept = await savePackage(db, owner.id, { files: taxTime }, dek);
    assert.equal((await listPackages(db, owner.id, dek)).length, 1, "it still lists");
    const edited = [{ path: "SKILL.md", content: makeSkillFile("Tax time", "When it's tax time", "My newer way") }];
    await savePackage(db, owner.id, { id: kept.id, revision: kept.revision, files: edited }, dek, { refuseNewReservedNames: true });
  } finally {
    await db.close();
  }
});
