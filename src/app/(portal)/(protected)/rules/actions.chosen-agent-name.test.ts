// E18-S20 — a chosen-agent rule reads back by the agent's DISPLAY NAME, never its raw
// connection id (the E12-S17 review veto: a chosen-agent scope read back as a raw UUID
// in the rule sentence).
//
// RED-first: today the create path (`scopeFromForm`, behind `ruleInputFromForm`) sets the
// scope's `name` to the posted connection id, so a chosen-agent rule is STORED with its id
// as its name and `ruleSentence` reads that id back INTO the sentence ("Ask me before
// <uuid> …"). The create path must instead resolve the agent's display name from the
// person's OWN agent record (member-scoped, so a client-forged name can't be trusted) so
// the rule reads back naming the agent. The sibling `actions.test.ts` already pins the
// all-agents / validation / ownership paths; this file adds ONLY the new chosen-agent
// read-back contract, driving the REAL actions seam + rules/agents stores against an
// isolated PGlite with the real migrations (via `@/test/db`). Behaviour, not source text,
// so a later behaviour-preserving refactor stays green.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createRulesActions, ruleInputFromForm } from "./actions";

import { createUser } from "@/server/db/users";
import { createAgent } from "@/server/db/agents";
import { createSession, type Session } from "@/server/auth/session";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

const DEK_BYTES = 32;
const KEK_BYTES = 32;
const NOW = new Date("2026-11-15T12:00:00.000Z");

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

async function makePerson(
  db: Db,
  keyWrapper: KeyWrapper,
  who: string,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: await keyWrapper.wrap(dek),
  });
  return { userId: user.id, dek };
}

async function sessionFor(db: Db, userId: string): Promise<Session> {
  const created = await createSession(db, userId, { clock: fixedClock(NOW), random: systemRandom });
  return created.session;
}

// A real /rules create FormData scoped to a chosen agent: the scope control posts the
// agent's CONNECTION ID as `rule-scope` (the value the policy engine matches a rule's
// chosen-agent scope on), exactly as the screen does.
function chosenAgentForm(connectionId: string): FormData {
  const fd = new FormData();
  fd.set("rule-template", "ask_first");
  fd.set("rule-action", "send_message");
  fd.set("rule-channel", "email");
  fd.set("rule-condition", "none");
  fd.set("rule-scope", connectionId);
  return fd;
}

test("a rule scoped to a chosen agent reads back naming the agent, never its connection id", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const session = await sessionFor(db, alice.userId);
    const actions = createRulesActions({ db, clock: fixedClock(NOW), keyWrapper });

    // Alice's connected agent — a connection id (uuid) distinct from its display name.
    const connectionId = randomUUID();
    await createAgent(
      db,
      { userId: alice.userId, connectionId, displayName: "Claude", platform: "anthropic" },
      fixedClock(NOW),
    );

    // She creates a rule scoped to that agent, exactly as the Rules screen posts it.
    const created = await actions.createRule(session, ruleInputFromForm(chosenAgentForm(connectionId)));
    assert.equal(created.ok, true, "the chosen-agent rule is created");

    // It reads back on the Rules page naming the AGENT, with no uuid in its sentence.
    const view = await actions.load(session);
    const rule = view.rules.find((r) => r.scope.type === "agent")!;
    assert.ok(rule, "the chosen-agent rule is loaded for its owner");
    assert.ok(
      rule.sentence.includes("Claude"),
      `the rule must read back the agent's display name; sentence="${rule.sentence}"`,
    );
    assert.ok(
      !rule.sentence.includes(connectionId),
      `the agent's raw connection id must never appear in the rule sentence; sentence="${rule.sentence}"`,
    );
  } finally {
    await db.close();
  }
});
