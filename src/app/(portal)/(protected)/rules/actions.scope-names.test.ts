// Review fix W2.1 — a rule scoped to a chosen agent always reads back by the agent's CURRENT
// name on the Rules page, never by a raw connection id.
//
// The create path resolves the name when the rule is made (E18-S20), but a rule's stored
// scope name could still be a raw connection id: an edit posts the scope control's value
// (the connection id) as both id and name, and rules restored from an import or written
// before that fix carry whatever name they were stored with. The Rules page now resolves
// every chosen-agent scope from the person's OWN agents (member-scoped by the session) when
// it loads, and an edit stores the resolved name too.
//
// Driven through the REAL rules actions over an isolated PGlite with the real migrations.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createRulesActions } from "./actions";
import { createUser } from "@/server/db/users";
import { createAgent } from "@/server/db/agents";
import { createRule, listAllRules } from "@/server/db/rules";
import { createSession, type Session } from "@/server/auth/session";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

const NOW = new Date("2026-11-15T12:00:00.000Z");

async function makePerson(db: Db, keyWrapper: KeyWrapper, who: string) {
  const dek = randomBytes(32);
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: await keyWrapper.wrap(dek),
  });
  const session: Session = (await createSession(db, user.id, { clock: fixedClock(NOW), random: systemRandom })).session;
  return { userId: user.id, dek, session };
}

const SEND_EMAIL = { type: "send_message", channel: "email" } as const;

test("a chosen-agent rule stored under a raw connection id reads back naming the agent", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const connectionId = randomUUID();
    await createAgent(
      db,
      { userId: alice.userId, connectionId, displayName: "Claude on my laptop", platform: "Claude" },
      fixedClock(NOW),
    );
    // A rule whose stored scope name is the raw id (an old row, an import, an edit).
    await createRule(
      db,
      { userId: alice.userId, kind: "ask_first", scope: { type: "agent", agentId: connectionId, name: connectionId }, action: SEND_EMAIL },
      alice.dek,
    );

    const view = await createRulesActions({ db, clock: fixedClock(NOW), keyWrapper }).load(alice.session);
    const rule = view.rules[0]!;
    assert.ok(rule.sentence.includes("Claude on my laptop"), `sentence="${rule.sentence}"`);
    assert.ok(!rule.sentence.includes(connectionId), "the raw connection id never shows in the sentence");
    assert.deepEqual(rule.scope, { type: "agent", agentId: connectionId, name: "Claude on my laptop" });
  } finally {
    await db.close();
  }
});

test("a rule scoped to an agent that is not the person's keeps its stored name (never another person's)", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const bob = await makePerson(db, keyWrapper, "bob");
    const bobsConnection = randomUUID();
    await createAgent(
      db,
      { userId: bob.userId, connectionId: bobsConnection, displayName: "Bob's private agent", platform: "Claude" },
      fixedClock(NOW),
    );
    await createRule(
      db,
      { userId: alice.userId, kind: "never_allow", scope: { type: "agent", agentId: bobsConnection, name: "an old agent" }, action: SEND_EMAIL },
      alice.dek,
    );

    const view = await createRulesActions({ db, clock: fixedClock(NOW), keyWrapper }).load(alice.session);
    assert.ok(view.rules[0]!.sentence.includes("an old agent"), view.rules[0]!.sentence);
    assert.ok(!view.rules[0]!.sentence.includes("Bob's private agent"), "another person's agent is never named");
  } finally {
    await db.close();
  }
});

test("editing a chosen-agent rule stores the agent's name, not the connection id the form posts", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const connectionId = randomUUID();
    await createAgent(
      db,
      { userId: alice.userId, connectionId, displayName: "ChatGPT", platform: "OpenAI" },
      fixedClock(NOW),
    );
    const stored = await createRule(
      db,
      { userId: alice.userId, kind: "ask_first", scope: { type: "any_agent" }, action: SEND_EMAIL },
      alice.dek,
    );

    const actions = createRulesActions({ db, clock: fixedClock(NOW), keyWrapper });
    const result = await actions.updateRule(alice.session, stored.id, {
      kind: "ask_first",
      scope: { type: "agent", agentId: connectionId, name: connectionId },
      action: SEND_EMAIL,
    });
    assert.equal(result.ok, true);

    const [rule] = await listAllRules(db, alice.userId, alice.dek);
    assert.deepEqual(rule!.scope, { type: "agent", agentId: connectionId, name: "ChatGPT" });
  } finally {
    await db.close();
  }
});
