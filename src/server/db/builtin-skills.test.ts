// The person's settings for Warthog's skills (db/migrations/0126_builtin_skills.sql).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { changeBuiltinSkill, listBuiltinSkillSettings, restoreBuiltinSkill } from "./builtin-skills";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import type { Db } from "./index";

const person = async (db: Db, who: string) =>
  (await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek: Buffer.from(`w-${who}`).toString("base64") })).id;

test("a change makes the person's row; their wording is stored encrypted and read back", async () => {
  const db = await freshDb();
  try {
    const userId = await person(db, "builtin-a");
    const dek = randomBytes(32);
    assert.equal((await listBuiltinSkillSettings(db, userId, dek)).size, 0, "no row until something changes");

    await changeBuiltinSkill(db, userId, "weekly_check_in", { guidance: "Keep it to five lines.", basedOnVersion: 1 }, { state: "on" }, dek);
    const setting = (await listBuiltinSkillSettings(db, userId, dek)).get("weekly_check_in");
    assert.deepEqual(setting, { key: "weekly_check_in", state: "on", scope: { type: "all_agents" }, useThisWhen: null, guidance: "Keep it to five lines.", basedOnVersion: 1 });

    const raw = (await db.query("SELECT guidance FROM builtin_skills WHERE user_id = $1", [userId])).rows[0]!.guidance as string;
    assert.match(raw, /^v1:/);
    assert.ok(!raw.includes("five lines"), "never stored in plain text");

    await changeBuiltinSkill(db, userId, "weekly_check_in", { state: "off", scope: { type: "agents", agentIds: ["agent-1"] } }, { state: "on" }, dek);
    const later = (await listBuiltinSkillSettings(db, userId, dek)).get("weekly_check_in")!;
    assert.equal(later.state, "off");
    assert.deepEqual(later.scope, { type: "agents", agentIds: ["agent-1"] });
    assert.equal(later.guidance, "Keep it to five lines.", "a later change keeps the wording");

    await changeBuiltinSkill(db, userId, "weekly_check_in", { guidance: null }, { state: "on" }, dek);
    assert.equal((await listBuiltinSkillSettings(db, userId, dek)).get("weekly_check_in")!.basedOnVersion, null, "Warthog's wording needs no version");

    await restoreBuiltinSkill(db, userId, "weekly_check_in");
    assert.equal((await listBuiltinSkillSettings(db, userId, dek)).size, 0, "restore takes the row away");
  } finally {
    await db.close();
  }
});

test("a pack's first change starts from its default state, and one person's settings never reach another", async () => {
  const db = await freshDb();
  try {
    const a = await person(db, "builtin-b1");
    const b = await person(db, "builtin-b2");
    const dekA = randomBytes(32);
    await changeBuiltinSkill(db, a, "sole_trader", { scope: { type: "agents", agentIds: ["x"] } }, { state: "off" }, dekA);
    assert.equal((await listBuiltinSkillSettings(db, a, dekA)).get("sole_trader")!.state, "off");
    assert.equal((await listBuiltinSkillSettings(db, b, randomBytes(32))).size, 0);
    await restoreBuiltinSkill(db, b, "sole_trader");
    assert.equal((await listBuiltinSkillSettings(db, a, dekA)).size, 1, "restoring for one person leaves another's row");
  } finally {
    await db.close();
  }
});

test("the table refuses wording that isn't an envelope, or an edit without the version it started from", async () => {
  const db = await freshDb();
  try {
    const userId = await person(db, "builtin-c");
    await assert.rejects(db.query(
      "INSERT INTO builtin_skills (id, user_id, builtin_key, state, guidance, based_on_version) VALUES (gen_random_uuid(), $1, 'weekly_check_in', 'on', 'plain', 1)",
      [userId],
    ));
    await assert.rejects(db.query(
      "INSERT INTO builtin_skills (id, user_id, builtin_key, state, guidance) VALUES (gen_random_uuid(), $1, 'weekly_check_in', 'on', 'v1:x')",
      [userId],
    ));
  } finally {
    await db.close();
  }
});
