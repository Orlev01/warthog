// UI/UX pass (interaction-11) — a rule can only name a REAL tool or service.
//
// A "Use a specific tool" rule matches the exact tool name an agent calls, and a "Use any
// tool of a service" rule matches the service's catalogue id. Typed from memory, a typo
// ("totally_made_up_tool") used to be saved and confirmed as enforced while protecting
// nothing. Now the builder offers the real names (Warthog's own tools from the MCP tool
// registry, connected services' tools, every catalogue service) and createRule / updateRule
// refuse any other name before anything is stored, with a plain notice. What a rule matches
// on is unchanged: the stored value is still exactly the name the engine compares.
//
// Drives the REAL actions seam and stores against an isolated PGlite (`@/test/db`) and the
// real catalogue data files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createRulesActions, rulesCreateReturnHref, rulesMutationNotice, rulesNotice, type ActionResult } from "./actions";

import { createUser } from "@/server/db/users";
import { createConnection } from "@/server/db/connections";
import { listAllRules } from "@/server/db/rules";
import { createSession, type Session } from "@/server/auth/session";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

const NOW = new Date("2026-11-15T12:00:00.000Z");

async function setUp(db: Db): Promise<{ session: Session; userId: string; dek: Uint8Array; keyWrapper: KeyWrapper }> {
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `targets-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const { session } = await createSession(db, user.id, { clock: fixedClock(NOW), random: systemRandom });
  return { session, userId: user.id, dek, keyWrapper };
}

const rule = (action: unknown) => ({ kind: "never_allow", scope: { type: "any_agent" }, action });

function refusal(result: ActionResult): string | null {
  return result.ok ? null : result.reason;
}

test("a rule naming a tool or service that doesn't exist is refused and nothing is stored", async () => {
  const db = await freshDb();
  try {
    const { session, userId, dek, keyWrapper } = await setUp(db);
    const actions = createRulesActions({ db, clock: fixedClock(NOW), keyWrapper });

    assert.equal(refusal(await actions.createRule(session, rule({ type: "specific_tool", tool: "totally_made_up_tool" }))), "unknown_tool");
    assert.equal(refusal(await actions.createRule(session, rule({ type: "specific_tool", tool: "create_tsak" }))), "unknown_tool", "a typo of a real tool");
    assert.equal(refusal(await actions.createRule(session, rule({ type: "specific_tool", tool: "google-gmail__sned" }))), "unknown_tool");
    assert.equal(refusal(await actions.createRule(session, rule({ type: "service_tool", service: "gmial" }))), "unknown_service");
    assert.deepEqual(await listAllRules(db, userId, dek), [], "no rule that protects nothing was stored");
  } finally {
    await db.close();
  }
});

test("a rule naming a real tool or service is stored exactly as the engine matches it", async () => {
  const db = await freshDb();
  try {
    const { session, userId, dek, keyWrapper } = await setUp(db);
    const actions = createRulesActions({ db, clock: fixedClock(NOW), keyWrapper });

    // Warthog's own tool, a curated service tool and a service's general request tool are
    // real whether or not the service is connected yet; so is any catalogue service.
    for (const action of [
      { type: "specific_tool", tool: "create_task" },
      { type: "specific_tool", tool: "google-gmail__send" },
      { type: "specific_tool", tool: "alpaca__request" },
      { type: "service_tool", service: "google-gmail" },
    ]) {
      assert.equal(refusal(await actions.createRule(session, rule(action))), null, JSON.stringify(action));
    }
    const stored = (await listAllRules(db, userId, dek)).map(({ action }) =>
      action.type === "specific_tool" ? `tool:${action.tool}` : action.type === "service_tool" ? `service:${action.service}` : action.type,
    );
    assert.deepEqual(stored.sort(), ["service:google-gmail", "tool:alpaca__request", "tool:create_task", "tool:google-gmail__send"]);
  } finally {
    await db.close();
  }
});

test("updating a rule to an unknown tool is refused and the rule is left as it was", async () => {
  const db = await freshDb();
  try {
    const { session, userId, dek, keyWrapper } = await setUp(db);
    const actions = createRulesActions({ db, clock: fixedClock(NOW), keyWrapper });
    assert.equal(refusal(await actions.createRule(session, rule({ type: "specific_tool", tool: "create_task" }))), null);
    const [created] = await listAllRules(db, userId, dek);
    assert.equal(refusal(await actions.updateRule(session, created!.id, rule({ type: "specific_tool", tool: "made_up" }))), "unknown_tool");
    assert.deepEqual((await listAllRules(db, userId, dek))[0]!.action, { type: "specific_tool", tool: "create_task" });
  } finally {
    await db.close();
  }
});

test("the builder's choices are the real tools and services, by their plain names", async () => {
  const db = await freshDb();
  try {
    const { session, userId, dek, keyWrapper } = await setUp(db);
    // A connected Gmail account: its tools join Warthog's own, and it leads the services.
    await createConnection(db, { userId, connectorId: "google-gmail", accountLabel: "me@example.com", credentials: {} }, dek, fixedClock(NOW));
    const view = await createRulesActions({ db, clock: fixedClock(NOW), keyWrapper }).load(session);

    const warthog = view.toolChoices.find((group) => group.label === "Warthog");
    assert.ok(warthog?.choices.some((choice) => choice.value === "create_task" && choice.label === "Create a task"));
    const gmail = view.toolChoices.find((group) => group.label === "Gmail");
    assert.ok(gmail?.choices.some((choice) => choice.value === "google-gmail__send"), JSON.stringify(view.toolChoices.map((g) => g.label)));
    assert.equal(view.serviceChoices[0]!.label, "Your connected services");
    assert.deepEqual(view.serviceChoices[0]!.choices, [{ value: "google-gmail", label: "Gmail" }]);
    const others = view.serviceChoices[1]!.choices;
    assert.ok(others.length > 50 && others.every((choice) => choice.value !== "google-gmail"), "every other catalogue service");
    // No choice ever shows a raw id as its label.
    for (const choice of [...view.toolChoices, ...view.serviceChoices].flatMap((group) => group.choices)) {
      assert.doesNotMatch(choice.label, /__/, `a plain label: ${choice.label}`);
    }
  } finally {
    await db.close();
  }
});

test("a refused rule explains itself in plain words and returns to the builder; an added one lands on the list", () => {
  for (const reason of ["unknown_tool", "unknown_service"]) {
    const code = rulesMutationNotice({ ok: false, reason }, "created");
    assert.equal(code, reason);
    assert.equal(rulesNotice(code)?.tone, "problem");
    assert.match(rulesNotice(code)!.text, /^No rule was added: Warthog has no (tool|service) with that name\./);
    assert.equal(rulesCreateReturnHref(code), `/rules?notice=${reason}&view=new`);
  }
  assert.equal(rulesCreateReturnHref(rulesMutationNotice({ ok: true }, "created")), "/rules?notice=created");
});
