// Renaming an agent from its Settings section (docs/adr/agent-names-and-providers.md): the new
// name, the copy each of its rules keeps and an "Agent renamed" entry commit together; the
// platform never changes; another person's agent, a malformed id and a name holding a private
// value change nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createRenameActions, renameNotice, renameNoticeKey } from "./rename";
import { createUser } from "@/server/db/users";
import { createAgent, getAgentById } from "@/server/db/agents";
import { createRule, listAllRules } from "@/server/db/rules";
import { listActivity } from "@/server/activity/list";
import { activityEvidence } from "@/domain/activity/evidence";
import { createSession, type Session } from "@/server/auth/session";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { HttpError } from "@/server/http/validate";
import { fixedClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

const NOW = new Date("2026-11-25T12:00:00.000Z");
const clock = fixedClock(NOW);
const SEND_EMAIL = { type: "send_message", channel: "email" } as const;

async function makePerson(db: Db, keyWrapper: KeyWrapper, who: string) {
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `${who}-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const session: Session = (await createSession(db, user.id, { clock, random: systemRandom })).session;
  return { userId: user.id, dek, session };
}

async function makeAgent(db: Db, userId: string, displayName: string, platform = "localhost") {
  const connectionId = randomUUID();
  return createAgent(db, { userId, connectionId, displayName, platform }, clock);
}

async function renamedEntries(db: Db, userId: string, dek: Uint8Array) {
  return (await listActivity(db, userId, {}, dek, { limit: 50 })).filter((entry) => entry.kind === "agent_renamed");
}

test("renaming changes the name, the agent's rules and records the change; the platform stays", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const agent = await makeAgent(db, alice.userId, "App on your computer");
    const other = await makeAgent(db, alice.userId, "Claude", "Claude");
    await createRule(db, { userId: alice.userId, kind: "ask_first", scope: { type: "agent", agentId: agent.connectionId, name: agent.displayName }, action: SEND_EMAIL }, alice.dek);
    await createRule(db, { userId: alice.userId, kind: "ask_first", scope: { type: "agent", agentId: other.connectionId, name: other.displayName }, action: SEND_EMAIL }, alice.dek);
    await createRule(db, { userId: alice.userId, kind: "never_allow", scope: { type: "any_agent" }, action: SEND_EMAIL }, alice.dek);

    const result = await createRenameActions({ db, clock, keyWrapper }).rename(alice.session, agent.id, "  Gemini CLI ·  research ");
    assert.deepEqual(result, { ok: true, changed: true });

    const after = await getAgentById(db, alice.userId, agent.id);
    assert.equal(after?.displayName, "Gemini CLI · research");
    assert.equal(after?.platform, "localhost", "a rename never touches the platform");
    assert.equal((await getAgentById(db, alice.userId, other.id))?.displayName, "Claude", "only this agent is renamed");

    const scopes = (await listAllRules(db, alice.userId, alice.dek)).map((rule) => rule.scope);
    assert.ok(scopes.some((scope) => scope.type === "agent" && scope.agentId === agent.connectionId && scope.name === "Gemini CLI · research"), "its rules carry the new name");
    assert.ok(scopes.some((scope) => scope.type === "agent" && scope.agentId === other.connectionId && scope.name === "Claude"), "another agent's rules keep theirs");

    const entries = await renamedEntries(db, alice.userId, alice.dek);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.agentId, agent.id);
    assert.equal(entries[0]!.source, "warthog");
    const evidence = activityEvidence(entries[0]!);
    assert.equal(evidence.facts.find((fact) => fact.label === "Name")?.value, "App on your computer → Gemini CLI · research");
    assert.equal(evidence.changedBy, "you");
  } finally {
    await db.close();
  }
});

test("the same name again changes nothing and records nothing", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const agent = await makeAgent(db, alice.userId, "Codex");
    assert.deepEqual(await createRenameActions({ db, clock, keyWrapper }).rename(alice.session, agent.id, " Codex "), { ok: true, changed: false });
    assert.equal((await renamedEntries(db, alice.userId, alice.dek)).length, 0);
  } finally {
    await db.close();
  }
});

test("another person's agent is never renamed", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const bob = await makePerson(db, keyWrapper, "bob");
    const bobs = await makeAgent(db, bob.userId, "Bob's helper");
    assert.deepEqual(await createRenameActions({ db, clock, keyWrapper }).rename(alice.session, bobs.id, "Mine now"), { ok: false, reason: "not_found" });
    assert.equal((await getAgentById(db, bob.userId, bobs.id))?.displayName, "Bob's helper");
    assert.equal((await renamedEntries(db, bob.userId, bob.dek)).length, 0);
    assert.equal((await renamedEntries(db, alice.userId, alice.dek)).length, 0);
  } finally {
    await db.close();
  }
});

test("a malformed id is refused at the boundary, and a bad name before anything is written", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const agent = await makeAgent(db, alice.userId, "Codex");
    const actions = createRenameActions({ db, clock, keyWrapper });
    for (const id of ["not-a-uuid", "1; DROP TABLE agents", ""]) {
      await assert.rejects(actions.rename(alice.session, id, "New name"), HttpError, JSON.stringify(id));
    }
    await assert.rejects(actions.rename(alice.session, agent.id, "x".repeat(5000)), HttpError, "a grossly oversized value");
    for (const name of ["", "   ", "Card 4111 1111 1111 1111", "y".repeat(201)]) {
      assert.deepEqual(await actions.rename(alice.session, agent.id, name), { ok: false, reason: "invalid_name" }, JSON.stringify(name).slice(0, 30));
    }
    assert.equal((await getAgentById(db, alice.userId, agent.id))?.displayName, "Codex");
    assert.equal((await renamedEntries(db, alice.userId, alice.dek)).length, 0);
  } finally {
    await db.close();
  }
});

test("when the activity entry can't be written, the rename and its rules roll back", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const agent = await makeAgent(db, alice.userId, "Codex");
    await createRule(db, { userId: alice.userId, kind: "ask_first", scope: { type: "agent", agentId: agent.connectionId, name: "Codex" }, action: SEND_EMAIL }, alice.dek);
    // A data key the recorder can't encrypt with makes the audit append throw inside the
    // transaction.
    const broken: KeyWrapper = { wrap: keyWrapper.wrap, unwrap: async () => new Uint8Array(3) };
    await assert.rejects(createRenameActions({ db, clock, keyWrapper: broken }).rename(alice.session, agent.id, "Renamed"));
    assert.equal((await getAgentById(db, alice.userId, agent.id))?.displayName, "Codex");
    const scope = (await listAllRules(db, alice.userId, alice.dek))[0]!.scope;
    assert.equal(scope.type === "agent" ? scope.name : null, "Codex");
  } finally {
    await db.close();
  }
});

test("each outcome has a notice in plain words, and nothing else is shown", () => {
  assert.equal(renameNoticeKey({ ok: true, changed: true }), "renamed");
  assert.equal(renameNoticeKey({ ok: true, changed: false }), "rename-unchanged");
  assert.equal(renameNoticeKey({ ok: false, reason: "invalid_name" }), "rename-problem");
  assert.equal(renameNoticeKey(null), "rename-problem");
  assert.equal(renameNotice("renamed")?.tone, "success");
  assert.equal(renameNotice("rename-problem")?.tone, "error");
  for (const raw of ["toString", "__proto__", "saved", undefined, ["renamed"]]) assert.equal(renameNotice(raw as string | undefined), null, String(raw));
});
