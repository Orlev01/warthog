import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import { createSession } from "../auth/session";
import { systemRandom } from "../seams/random";
import { readActivity } from "./writer";
import { createRulesActions } from "../../app/(portal)/(protected)/rules/actions";
import { createMemoryActions } from "../../app/(portal)/(protected)/memory/actions";
import type { Db } from "../db/index";

test("owner rule and memory mutations are audited atomically and never attributed to an agent", async () => {
 const db = await freshDb();
 try {
  const clock = fixedClock(new Date("2026-11-12T00:00:00Z")), keyWrapper = localAesKeyWrapper(randomBytes(32)), dek = randomBytes(32);
  const user = await createUser(db, { email: "owner-audit@example.test", wrappedDek: await keyWrapper.wrap(dek) });
  const session = (await createSession(db, user.id, {clock, random: systemRandom})).session;
  const rule = { kind: "never_allow", scope: { type: "any_agent" }, action: { type: "any_change" } };
  await createRulesActions({db, clock, keyWrapper}).createRule(session, rule);
  await createMemoryActions({db, clock, keyWrapper}).addMemory(session, {content: "Private memory content", scope: "shared"});
  const events = await readActivity(db, user.id, dek);
  assert.deepEqual(events.map(event => event.kind), ["rule_created", "memory_created"]);
  assert.ok(events.every(event => !event.agentId && event.source === "warthog"));
  assert.doesNotMatch(JSON.stringify(events), /Private memory content/);
  const failing: Db = { ...db, query: db.query.bind(db), close: async () => {}, transaction: fn => db.transaction!(tx => fn({ ...tx, query: async (sql, values) => { if (/INSERT INTO activity_entries/.test(sql)) throw new Error("audit offline"); return tx.query(sql, values); } })) };
  await assert.rejects(() => createMemoryActions({db: failing, clock, keyWrapper}).addMemory(session, {content: "Must roll back", scope: "shared"}), /audit offline/);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM memories WHERE user_id = $1", [user.id])).rows[0]!.n), 1);
  assert.equal((await readActivity(db, user.id, dek)).length, 2);
 } finally {await db.close();}
});
