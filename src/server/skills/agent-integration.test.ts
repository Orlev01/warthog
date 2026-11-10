import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { getSkillText, listSkillsForUser } from "../db/skills";
import { savePackage } from "../db/skill-packages";
import { createLibraryActions } from "./library";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { systemClock } from "../seams/clock";
import { effectiveSkillAudiences, setAgentSkillAccess } from "../agents/skill-access";

test("library and workspace changes share effective access, including package files", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32), wrapper = localAesKeyWrapper(randomBytes(32));
    const user = await createUser(db, { email: "integration@example.test", wrappedDek: await wrapper.wrap(dek) });
    const a = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "A", platform: "Other" }, systemClock);
    const b = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "B", platform: "Other" }, systemClock);
    const p = await savePackage(db, user.id, { files: [{path:"SKILL.md",content:"---\nname: Shared\ndescription: When needed\n---\nInstructions"},{path:"help.md",content:"Supporting instructions"}] }, dek);
    const id = p.members[0]!.skillId;
    const session = { id: randomUUID(), userId: user.id, createdAt: new Date(), lastSeenAt: new Date(), steppedUpAt: null };
    const library = createLibraryActions({db,keyWrapper:wrapper});
    await library.access(session,{id,enabled:true,scope:"all",scopedAgentIds:[]});
    await setAgentSkillAccess(db,user.id,a.id,[{id,granted:false}]);
    const view = await effectiveSkillAudiences(db,user.id,await listSkillsForUser(db,user.id,dek));
    assert.deepEqual(view[0]!.scopedAgentIds,[b.id]);
    await setAgentSkillAccess(db,user.id,a.id,[{id,granted:true}]);
    await library.access(session,{id,enabled:true,scope:"chosen",scopedAgentIds:[b.id]});
    assert.equal(await getSkillText(db,user.id,a.id,"Shared",dek,"help.md"),null);
    assert.equal(await getSkillText(db,user.id,b.id,"Shared",dek,"help.md"),"Supporting instructions");
    await setAgentSkillAccess(db,user.id,a.id,[{id,granted:true}]);
    assert.equal(await getSkillText(db,user.id,a.id,"Shared",dek,"help.md"),"Supporting instructions");
    await library.access(session,{id,enabled:false,scope:"all",scopedAgentIds:[]});
    assert.equal(await getSkillText(db,user.id,a.id,"Shared",dek,"help.md"),null);
  } finally {await db.close();}
});
