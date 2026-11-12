// UI/UX follow-up — rule sentences name real tools and services for people.
//
// A "Use a specific tool" rule stores the exact tool name the engine matches
// (`create_task`, `google-gmail__send`) and a service rule stores the catalogue id
// (`google-gmail`). People used to read those ids back ("Ask me before any agent uses
// create_task"); now the Rules page names a tool by its title and a service by its catalogue
// name — from the same tool registry and connector catalogue the builder's choices come from —
// and the builder's preview, built from those choices, reads exactly what the saved rule then
// reads. Agents still read the id form (get_context), so nothing they match on changes.
//
// Drives the REAL actions seam, stores against an isolated PGlite (`@/test/db`) and reads the
// real catalogue data files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createRulesActions } from "./actions";
import { catalogueFromDataFiles, ruleDisplayLabelsFor } from "./rule-targets";

import { ruleLabelsFromChoices } from "@/components/rules/rules-organise";
import { ruleSentence, type RuleAction } from "@/domain/rules/rules";
import { createUser } from "@/server/db/users";
import { createConnection } from "@/server/db/connections";
import { createRule as storeCreateRule } from "@/server/db/rules";
import { upsertPermissions } from "@/server/db/agent-permissions";
import { createGetContextTool } from "@/server/mcp/tools/get-context";
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
  const user = await createUser(db, { email: `labels-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const { session } = await createSession(db, user.id, { clock: fixedClock(NOW), random: systemRandom });
  // A connected Gmail account, so Gmail's tools are among the builder's choices.
  await createConnection(db, { userId: user.id, connectorId: "google-gmail", accountLabel: "me@example.com", credentials: {} }, dek, fixedClock(NOW));
  return { session, userId: user.id, dek, keyWrapper };
}

const askFirst = (action: RuleAction) => ({ kind: "ask_first" as const, scope: { type: "any_agent" as const }, action });

test("the Rules list names a tool by its title and a service by its catalogue name", async () => {
  const db = await freshDb();
  try {
    const { session, keyWrapper } = await setUp(db);
    const actions = createRulesActions({ db, clock: fixedClock(NOW), keyWrapper });
    for (const action of [
      { type: "specific_tool", tool: "create_task" },
      { type: "specific_tool", tool: "google-gmail__send" },
      { type: "service_tool", service: "google-gmail" },
      // Real, but not among the choices: a curated tool of a service that isn't connected,
      // a service's general request tool, and a service that isn't connected.
      { type: "specific_tool", tool: "google-calendar__create" },
      { type: "specific_tool", tool: "alpaca__request" },
      { type: "service_tool", service: "alpaca" },
    ] as const) {
      const result = await actions.createRule(session, askFirst(action));
      assert.deepEqual(result, { ok: true }, JSON.stringify(action));
    }
    const sentences = (await actions.load(session)).rules.map((rule) => rule.sentence).sort();
    assert.deepEqual(sentences, [
      "Ask me before any agent uses Alpaca: any request",
      "Ask me before any agent uses Create a task",
      "Ask me before any agent uses Gmail: Send email",
      "Ask me before any agent uses Google Calendar: create",
      "Ask me before any agent uses any Alpaca tool",
      "Ask me before any agent uses any Gmail tool",
    ]);
  } finally {
    await db.close();
  }
});

test("the builder's preview reads exactly what the saved rule reads, for every tool and service it offers", async () => {
  const db = await freshDb();
  try {
    const { session, keyWrapper } = await setUp(db);
    const actions = createRulesActions({ db, clock: fixedClock(NOW), keyWrapper });
    const before = await actions.load(session);
    // The preview is built from the choices the page hands the builder.
    const preview = ruleLabelsFromChoices(before.toolChoices, before.serviceChoices);
    const offered: RuleAction[] = [
      ...before.toolChoices.flatMap((group) => group.choices.map((choice): RuleAction => ({ type: "specific_tool", tool: choice.value }))),
      ...before.serviceChoices[0]!.choices.map((choice): RuleAction => ({ type: "service_tool", service: choice.value })),
      { type: "service_tool", service: before.serviceChoices[1]!.choices[0]!.value },
    ];
    const expected: string[] = [];
    for (const action of offered) {
      const draft = { ...askFirst(action), scope: { type: "agent" as const, agentId: randomUUID(), name: "Helper" } };
      expected.push(ruleSentence(draft, preview));
      assert.deepEqual(await actions.createRule(session, draft), { ok: true }, JSON.stringify(action));
    }
    const saved = (await actions.load(session)).rules.map((rule) => rule.sentence);
    assert.deepEqual([...saved].sort(), [...expected].sort());
    for (const sentence of saved) assert.doesNotMatch(sentence, /__|\bcreate_task\b/, `a person never reads a raw id: ${sentence}`);
  } finally {
    await db.close();
  }
});

test("a stored rule whose tool or service no longer exists reads back by its id", async () => {
  const db = await freshDb();
  try {
    const { session, userId, dek, keyWrapper } = await setUp(db);
    await storeCreateRule(db, { userId, ...askFirst({ type: "specific_tool", tool: "retired_tool" }) }, dek);
    await storeCreateRule(db, { userId, ...askFirst({ type: "service_tool", service: "gone-service" }) }, dek);
    const sentences = (await createRulesActions({ db, clock: fixedClock(NOW), keyWrapper }).load(session)).rules.map((rule) => rule.sentence).sort();
    assert.deepEqual(sentences, ["Ask me before any agent uses any gone-service tool", "Ask me before any agent uses retired_tool"]);
  } finally {
    await db.close();
  }
});

test("the display labels other screens use are the Rules page's own", async () => {
  const db = await freshDb();
  try {
    const { session, userId, dek, keyWrapper } = await setUp(db);
    const labels = await ruleDisplayLabelsFor(db, catalogueFromDataFiles(), userId, dek);
    const view = await createRulesActions({ db, clock: fixedClock(NOW), keyWrapper }).load(session);
    for (const choice of view.toolChoices.flatMap((group) => group.choices)) assert.equal(labels.toolTitle?.(choice.value), choice.label);
    for (const choice of view.serviceChoices.flatMap((group) => group.choices)) assert.equal(labels.serviceName?.(choice.value), choice.label);
    assert.equal(labels.toolTitle?.("retired_tool"), undefined);
    assert.equal(labels.serviceName?.("gone-service"), undefined);
  } finally {
    await db.close();
  }
});

test("agents still read the exact ids in get_context", async () => {
  const db = await freshDb();
  try {
    const { session, userId, keyWrapper } = await setUp(db);
    const actions = createRulesActions({ db, clock: fixedClock(NOW), keyWrapper });
    await actions.createRule(session, askFirst({ type: "specific_tool", tool: "create_task" }));
    await actions.createRule(session, askFirst({ type: "service_tool", service: "google-gmail" }));
    const connectionId = randomUUID();
    await upsertPermissions(db, {
      userId,
      connectionId,
      grantedConnectors: [],
      readTools: false,
      changeTools: "off",
      identityAccess: false,
      highTierAccess: false,
      cardAccess: false,
      cardBudget: null,
      skillsScope: [],
      memoryRead: false,
      sharing: false,
      rulesScope: [],
      rateLimit: 120,
      tasksAccess: false,
      recordsAccess: false,
    });
    const context = await createGetContextTool({ db, keyWrapper, clock: fixedClock(NOW) }).handle({
      userId,
      connectionId,
      agentId: connectionId,
      active: true,
    });
    assert.deepEqual([...context.rules].sort(), [
      "Ask me before any agent uses any google-gmail tool",
      "Ask me before any agent uses create_task",
    ]);
  } finally {
    await db.close();
  }
});
