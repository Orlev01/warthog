// Review fix W2.3 (follow-through, review medium "per-agent permissions page always renders empty
// Connectors, Skills and Rules sections") — the page lists the agent's OWN rules (brief
// "Per-agent permissions page … its own rules"): the active rules the person scoped to this
// agent, each read back as its exact sentence naming the agent by its current name. Rules for
// all agents live on the Rules page; another agent's rules and another person's never show.
//
// Driven through the REAL actions over an isolated PGlite with the real migrations, rendered
// through the real <PermissionsView>.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createPermissionsActions } from "./actions";
import { PermissionsView } from "@/components/agents/permissions-view";
import { createAgent } from "@/server/db/agents";
import { upsertPermissions } from "@/server/db/agent-permissions";
import { createRule, pauseRule } from "@/server/db/rules";
import { createUser } from "@/server/db/users";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const SEND_EMAIL = { type: "send_message", channel: "email" } as const;
const SEND_CHAT = { type: "send_message", channel: "chat" } as const;

async function makePerson(db: Db, keyWrapper: KeyWrapper, who: string) {
  const dek = randomBytes(32);
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: await keyWrapper.wrap(dek),
  });
  return { userId: user.id, dek };
}

function sessionFor(userId: string): Session {
  return { id: `sess-${userId}`, userId, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: null };
}

async function seedAgent(db: Db, userId: string, displayName: string) {
  const connectionId = randomUUID();
  const agent = await createAgent(
    db,
    { userId, connectionId, displayName, platform: "Claude", status: "connected" },
    fixedClock(NOW),
  );
  await upsertPermissions(db, {
    userId,
    connectionId,
    grantedConnectors: [],
    readTools: false,
    changeTools: "off",
    identityAccess: true,
    highTierAccess: false,
    cardAccess: false,
    cardBudget: null,
    skillsScope: [],
    memoryRead: false,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
  });
  return { agentId: agent.id, connectionId };
}

function strip(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/&#x27;|&rsquo;/g, "'").replace(/\s+/g, " ").trim();
}

test("the page lists the agent's own active rules, naming the agent by its current name", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const claude = await seedAgent(db, alice.userId, "Claude on my laptop");
    const gpt = await seedAgent(db, alice.userId, "ChatGPT");

    // Claude's own rule (stored under its raw connection id as its name), a paused one, a rule
    // for all agents, and ChatGPT's own rule.
    await createRule(
      db,
      { userId: alice.userId, kind: "never_allow", scope: { type: "agent", agentId: claude.connectionId, name: claude.connectionId }, action: SEND_EMAIL },
      alice.dek,
    );
    const paused = await createRule(
      db,
      { userId: alice.userId, kind: "ask_first", scope: { type: "agent", agentId: claude.connectionId, name: "Claude" }, action: SEND_CHAT },
      alice.dek,
    );
    await pauseRule(db, alice.userId, paused.id);
    await createRule(db, { userId: alice.userId, kind: "ask_first", scope: { type: "any_agent" }, action: SEND_CHAT }, alice.dek);
    await createRule(
      db,
      { userId: alice.userId, kind: "ask_first", scope: { type: "agent", agentId: gpt.connectionId, name: "ChatGPT" }, action: SEND_EMAIL },
      alice.dek,
    );

    const props = await createPermissionsActions({ db, keyWrapper }).load(sessionFor(alice.userId), claude.agentId);
    assert.equal(props!.rules.length, 2, "Claude’s own rule and the inherited global rule");
    assert.ok(props!.rules.some(rule => rule.scope.type === "any_agent"));
    const text = strip(renderToStaticMarkup(<PermissionsView {...props!} />));
    assert.ok(text.includes("Claude on my laptop"), text);
    assert.ok(!text.includes(claude.connectionId), "the raw connection id never shows");
    assert.ok(!text.includes("ChatGPT"), "another agent's rule is not listed here");
  } finally {
    await db.close();
  }
});

test("with no rules of its own the section says so and points to the Rules page", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const alice = await makePerson(db, keyWrapper, "alice");
    const claude = await seedAgent(db, alice.userId, "Claude");

    const props = await createPermissionsActions({ db, keyWrapper }).load(sessionFor(alice.userId), claude.agentId);
    assert.deepEqual(props!.rules, []);
    const markup = renderToStaticMarkup(<PermissionsView {...props!} />);
    assert.match(strip(markup), /No rules just for Claude yet/);
    assert.match(markup, /href="\/rules"/);
  } finally {
    await db.close();
  }
});
