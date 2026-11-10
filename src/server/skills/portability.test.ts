import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { savePackage, listPackages } from "../db/skill-packages";
import { listSkillsForUser } from "../db/skills";
import { buildExportDocument } from "../export/build";
import { importExportDocument } from "../import/import";
import { systemClock } from "../seams/clock";
import { makeSkillFile } from "../../domain/skills/package";

test("account export/import retains packages and supporting files without duplicate skill projections", async () => {
  const db = await freshDb();
  try {
    const a = await createUser(db, { email: "export@example.test", wrappedDek: "wrapped" });
    const b = await createUser(db, { email: "import@example.test", wrappedDek: "wrapped" });
    const keyA = randomBytes(32), keyB = randomBytes(32);
    const files = [{ path: "SKILL.md", content: makeSkillFile("Portable", "When needed", "Read references/help.md") }, { path: "references/help.md", content: "Keep this file." }];
    await savePackage(db, a.id, { files }, keyA);
    const exported = await buildExportDocument(db, a.id, keyA, systemClock);
    assert.equal(exported.skillPackages?.length, 1);
    assert.equal(exported.skills.length, 1, "older readers still receive the plain skill instructions");
    await importExportDocument(db, b.id, exported, keyB, systemClock);
    assert.deepEqual((await listPackages(db, b.id, keyB))[0].files, files);
    const skills = await listSkillsForUser(db, b.id, keyB);
    assert.equal(skills.length, 1); assert.equal(skills[0].enabled, false);
  } finally { await db.close(); }
});
