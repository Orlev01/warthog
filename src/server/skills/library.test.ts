import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { createLibraryActions, previewUpload } from "./library";
import { listSkillsForUser, getSkillText } from "../db/skills";
import { createSkillsActions } from "../../app/(portal)/(protected)/skills/actions";
import { makeSkillFile } from "../../domain/skills/package";
import type { Session } from "../auth/session";

test("library actions bind owner, validate access, download and protect the package source", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32)), dek = randomBytes(32);
    const owner = await createUser(db, { email: "library@example.test", wrappedDek: await keyWrapper.wrap(dek) });
    const other = await createUser(db, { email: "other@example.test", wrappedDek: await keyWrapper.wrap(randomBytes(32)) });
    const session = (userId: string): Session => ({ id: randomUUID(), userId, createdAt: new Date(), lastSeenAt: new Date(), steppedUpAt: null });
    const a = createLibraryActions({ db, keyWrapper }), s = session(owner.id);
    const p = await a.save(s, { userId: other.id, files: [{ path: "SKILL.md", content: makeSkillFile("Research", "When researching", "Read sources") }] });
    assert.ok((await a.download(s, { id: p.id })).base64);
    await assert.rejects(() => a.download(session(other.id), { id: p.id }), /not found/);
    await assert.rejects(() => a.save(s, { files: [], id: "bad" }));
    const skill = (await listSkillsForUser(db, owner.id, dek))[0];
    await assert.rejects(() => a.access(s, { id: skill.id, enabled: true, scope: "chosen", scopedAgentIds: [randomUUID()] }), /agent/);
    await assert.rejects(() => a.access(session(other.id), { id: skill.id, enabled: true, scope: "all", scopedAgentIds: [] }), /not found/);
    await a.access(s, { id: skill.id, enabled: true, scope: "all", scopedAgentIds: [] });
    assert.equal(await getSkillText(db, owner.id, "agent", "Research", dek), "Read sources");
    const legacy = createSkillsActions({ db, keyWrapper });
    assert.equal((await legacy.deleteSkill(s, { id: skill.id })).ok, false);
    assert.equal((await legacy.editSkill(s, { ...skill, title: "Drift" })).ok, false);
    assert.equal((await legacy.duplicateSkill(s, { id: skill.id })).ok, false);
  } finally { await db.close(); }
});

test("upload preview preserves folder paths and reports excluded files without persisting", async () => {
  const form = new FormData();
  form.append("files", new File([makeSkillFile("Notes", "When writing", "Be concise")], "SKILL.md"));
  form.append("paths", "notes/SKILL.md");
  form.append("files", new File(["private"], ".env")); form.append("paths", "notes/.env");
  const p = await previewUpload(form);
  assert.equal(p.package.files[0].path, "SKILL.md");
  assert.deepEqual(p.skipped, ["notes/.env"]);
});
