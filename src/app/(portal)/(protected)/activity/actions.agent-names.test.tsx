// Review fix W2.1 / W2.4 — the Activity page names agents and tools in plain words.
//
// The build's E2E found every agent call on the Activity page listed as "Tool call" over a
// raw id ("28e3dfa1-7fc1-… · 8 Nov 2026"). An activity entry stores the acting agent's id
// and the tool's code; the loader now resolves the agent's name from the person's OWN
// agents (member-scoped by the session user id) and titles an agent call by its tool's
// plain name. The agent filter offers the agents by name while still filtering by id.
//
// Driven through the REAL loader over an isolated PGlite with the real migrations, a real
// agents row and the real DB writer, then rendered through the real <ActivityView>.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createActivityActions } from "./actions";
import { ActivityView } from "@/components/activity/activity-view";
import { createDbRecorder } from "@/server/activity/writer";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { createUser } from "@/server/db/users";
import { createAgent } from "@/server/db/agents";
import { createSession, type Session } from "@/server/auth/session";
import { fixedClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

const NOW = new Date("2026-11-08T00:41:00.000Z");
const clock = fixedClock(NOW);

async function makePerson(db: Db, keyWrapper: KeyWrapper, who: string) {
  const dek = randomBytes(32);
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@people.example`,
    wrappedDek: await keyWrapper.wrap(dek),
  });
  const session: Session = (await createSession(db, user.id, { clock, random: systemRandom })).session;
  return { userId: user.id, dek, session };
}

async function makeAgent(db: Db, userId: string, displayName: string) {
  return createAgent(db, { userId, connectionId: randomUUID(), displayName, platform: "Claude" }, clock);
}

function loaderFor(db: Db, keyWrapper: KeyWrapper) {
  return createActivityActions({
    db,
    keyWrapper,
    disputes: { fileDispute: async () => undefined },
    undo: { undo: async () => ({ ok: false, reason: "unused" }) },
  });
}

function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

test("an agent call is titled by its tool and names its agent, never a raw id or 'Tool call'", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const alice = await makePerson(db, keyWrapper, "alice");
    const agent = await makeAgent(db, alice.userId, "Claude on my laptop");
    const recorder = createDbRecorder({ db, clock, dekFor: async () => alice.dek });

    await recorder.record({
      userId: alice.userId,
      kind: "tool_call",
      source: "warthog",
      agentId: agent.id,
      tool: "remember",
      outcome: "executed",
      payload: { params: { content: "likes oat milk" } },
    });

    const view = await loaderFor(db, keyWrapper).load(alice.session, {});
    assert.equal(view.entries.length, 1);
    assert.equal(view.entries[0]!.agent, "Claude on my laptop");
    assert.equal(view.entries[0]!.title, "Save a memory");

    const shown = text(renderToStaticMarkup(<ActivityView {...view} />));
    assert.ok(shown.includes("Save a memory"), `the tool's plain name is shown: ${shown}`);
    assert.ok(shown.includes("Claude on my laptop"), "the agent's name is shown");
    assert.ok(!shown.includes(agent.id), "the raw agent id is never shown");
    assert.ok(!shown.includes("Tool call"), "the entry is not titled 'Tool call'");
  } finally {
    await db.close();
  }
});

test("an agent-reported note reads 'Reported by <name>'", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const alice = await makePerson(db, keyWrapper, "alice");
    const agent = await makeAgent(db, alice.userId, "ChatGPT");
    const recorder = createDbRecorder({ db, clock, dekFor: async () => alice.dek });
    await recorder.record({
      userId: alice.userId,
      kind: "agent_note",
      source: "agent_reported",
      agentId: agent.id,
      payload: { summary: "Booked the plumber" },
    });

    const view = await loaderFor(db, keyWrapper).load(alice.session, {});
    const shown = text(renderToStaticMarkup(<ActivityView {...view} />));
    assert.ok(shown.includes("Reported by ChatGPT"), shown);
    assert.ok(!shown.includes(agent.id));
  } finally {
    await db.close();
  }
});

test("names resolve only from the session person's own agents: another person's agent reads as unknown", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const alice = await makePerson(db, keyWrapper, "alice");
    const bob = await makePerson(db, keyWrapper, "bob");
    const bobsAgent = await makeAgent(db, bob.userId, "Bob's private agent");
    const recorder = createDbRecorder({ db, clock, dekFor: async () => alice.dek });

    // An entry in Alice's record naming Bob's agent id (never written by Warthog, but the
    // loader must not reach across people to name it).
    await recorder.record({
      userId: alice.userId,
      kind: "tool_call",
      source: "warthog",
      agentId: bobsAgent.id,
      tool: "search_memory",
      outcome: "executed",
    });

    const view = await loaderFor(db, keyWrapper).load(alice.session, {});
    assert.ok(view.entries[0]!.agent?.startsWith("Unknown agent"), String(view.entries[0]!.agent));
    const shown = text(renderToStaticMarkup(<ActivityView {...view} />));
    assert.ok(!shown.includes("Bob's private agent"), "another person's agent name never shows");
    assert.ok(!shown.includes(bobsAgent.id), "nor its raw id");
  } finally {
    await db.close();
  }
});

test("the agent filter offers agents by name and still filters by id", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const alice = await makePerson(db, keyWrapper, "alice");
    const claude = await makeAgent(db, alice.userId, "Claude");
    const gpt = await makeAgent(db, alice.userId, "ChatGPT");
    const recorder = createDbRecorder({ db, clock, dekFor: async () => alice.dek });
    for (const agent of [claude, gpt]) {
      await recorder.record({
        userId: alice.userId,
        kind: "tool_call",
        source: "warthog",
        agentId: agent.id,
        tool: "list_tasks",
        outcome: "executed",
      });
    }

    const loader = loaderFor(db, keyWrapper);
    const all = await loader.load(alice.session, {});
    const options = [...all.filterOptions.agents].map((o) => (typeof o === "string" ? { value: o, label: o } : o));
    assert.deepEqual(
      options.sort((a, b) => a.label.localeCompare(b.label)),
      [
        { value: gpt.id, label: "ChatGPT" },
        { value: claude.id, label: "Claude" },
      ],
      "each agent is offered by name, with its id as the value the filter posts",
    );

    const filtered = await loader.load(alice.session, { agent: claude.id });
    assert.equal(filtered.entries.length, 1, "filtering still narrows by the agent id");
    assert.equal(filtered.entries[0]!.agent, "Claude");

    const markup = renderToStaticMarkup(<ActivityView {...filtered} />);
    assert.match(markup, new RegExp(`<option value="${claude.id}" selected="">Claude</option>`));
    const shown = text(markup);
    assert.ok(shown.includes("Agent: Claude"), `the applied filter is named by the agent's name: ${shown}`);
    assert.ok(!shown.includes(`Agent: ${claude.id}`), "never by its raw id");
  } finally {
    await db.close();
  }
});

test("a connected service is shown and offered by its catalogue name, and still filtered by its id", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const alice = await makePerson(db, keyWrapper, "alice");
    const recorder = createDbRecorder({ db, clock, dekFor: async () => alice.dek });
    await recorder.record({
      userId: alice.userId,
      kind: "tool_call",
      source: "warthog",
      connectorId: "google-calendar",
      tool: "google-calendar__list_events",
      outcome: "executed",
    });

    const loader = createActivityActions({
      db,
      keyWrapper,
      disputes: { fileDispute: async () => undefined },
      undo: { undo: async () => ({ ok: false, reason: "unused" }) },
      serviceName: (id) => (id === "google-calendar" ? "Google Calendar" : undefined),
    });
    const view = await loader.load(alice.session, { service: "google-calendar" });
    assert.equal(view.entries.length, 1, "the service filter still narrows by the connector id");
    assert.equal(view.entries[0]!.service, "Google Calendar");
    assert.equal(view.entries[0]!.title, "List events");
    assert.deepEqual(view.filterOptions.services, [{ value: "google-calendar", label: "Google Calendar" }]);
    const shown = text(renderToStaticMarkup(<ActivityView {...view} />));
    assert.ok(shown.includes("Service: Google Calendar"), shown);
  } finally {
    await db.close();
  }
});
