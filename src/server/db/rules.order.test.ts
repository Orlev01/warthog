// The Rules page reads every rule through `listAllRules` and groups them by scope. Without an
// ORDER BY a database may hand rows back in any order (Postgres makes no promise, and the
// order can change after an update), so the page's rows would shuffle between visits. These
// tests pin a deterministic order: rules for all agents first, then rules for a chosen agent
// by its stored name, then active before paused, then "ask first" before "never allow", with
// the rule id as the final tie-break. Behaviour only — the SQL text is never asserted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createRule, listAllRules, pauseRule, updateRule } from "./rules";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import type { Db } from "./index";

const ANY_AGENT = { type: "any_agent" } as const;
const SEND_EMAIL = { type: "send_message", channel: "email" } as const;
const CARD_REQUEST = { type: "card_request" } as const;
const ALPHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BRAVO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return user.id;
}

function agentScope(agentId: string, name: string) {
  return { type: "agent", agentId, name } as const;
}

test("listAllRules returns all-agents rules first, then each agent's by name, active before paused, ask-first before never-allow", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "alice");
    const dek = randomBytes(32);
    // Created deliberately out of the expected order.
    const bravoNever = await createRule(db, { userId, kind: "never_allow", scope: agentScope(BRAVO, "Bravo"), action: SEND_EMAIL }, dek);
    const globalPausedAsk = await createRule(db, { userId, kind: "ask_first", scope: ANY_AGENT, action: CARD_REQUEST }, dek);
    const alphaAsk = await createRule(db, { userId, kind: "ask_first", scope: agentScope(ALPHA, "Alpha"), action: SEND_EMAIL }, dek);
    const globalNever = await createRule(db, { userId, kind: "never_allow", scope: ANY_AGENT, action: SEND_EMAIL }, dek);
    const globalAsk = await createRule(db, { userId, kind: "ask_first", scope: ANY_AGENT, action: SEND_EMAIL }, dek);
    await pauseRule(db, userId, globalPausedAsk.id);

    const ids = (await listAllRules(db, userId, dek)).map((rule) => rule.id);
    assert.deepEqual(ids, [globalAsk.id, globalNever.id, globalPausedAsk.id, alphaAsk.id, bravoNever.id]);
  } finally {
    await db.close();
  }
});

test("listAllRules breaks ties by rule id, so identical rules keep one stable order across reads and edits", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "alice");
    const dek = randomBytes(32);
    const created = [];
    for (let i = 0; i < 6; i += 1) {
      created.push(await createRule(db, { userId, kind: "ask_first", scope: ANY_AGENT, action: SEND_EMAIL }, dek));
    }
    const expected = created.map((rule) => rule.id).sort();

    const first = (await listAllRules(db, userId, dek)).map((rule) => rule.id);
    assert.deepEqual(first, expected, "same-looking rules are ordered by id");

    // An in-place update rewrites the row; the order must not move.
    await updateRule(db, userId, created[0]!.id, { kind: "ask_first", scope: ANY_AGENT, action: SEND_EMAIL }, dek);
    const second = (await listAllRules(db, userId, dek)).map((rule) => rule.id);
    assert.deepEqual(second, expected, "an update does not reshuffle the list");
  } finally {
    await db.close();
  }
});
