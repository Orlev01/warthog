// Review fix W2.1 — the Home feed reads what each agent did, in plain words.
//
// An agent call's activity entry carries no `summary` (the pipeline records the tool, its
// outcome and the redacted params), so the Home feed listed blank lines for everything an
// agent did. The line now reads as the entry's title — the tool's plain name for an agent
// call ("Save a memory") — with the outcome alongside, and the agent named by the name the
// person gave it. An entry with its own summary keeps it.
//
// Driven through the REAL Home loader over an isolated PGlite with the real migrations,
// rendered through the real <DashboardView>.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createHomeActions } from "./actions";
import { DashboardView } from "@/components/home/dashboard-view";
import { createUser } from "@/server/db/users";
import { createSession } from "@/server/auth/session";
import { createAgent } from "@/server/db/agents";
import { createDbRecorder } from "@/server/activity/writer";
import { localAesKeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const clock = fixedClock(NOW);
const keyWrapper = localAesKeyWrapper(randomBytes(32));

function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
}

test("an agent call shows on Home as its tool's plain name and outcome, under the agent's name", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32);
    const user = await createUser(db, { email: `alice-${randomUUID()}@people.example`, wrappedDek: await keyWrapper.wrap(dek) });
    const session = (await createSession(db, user.id, { clock, random: systemRandom })).session;
    const agent = await createAgent(
      db,
      { userId: user.id, connectionId: randomUUID(), displayName: "Claude on my laptop", platform: "Claude" },
      clock,
    );
    const recorder = createDbRecorder({ db, clock, dekFor: async () => dek });
    await recorder.record({
      userId: user.id,
      kind: "tool_call",
      source: "warthog",
      agentId: agent.id,
      tool: "create_task",
      outcome: "denied",
      payload: { params: { title: "Renew rego" } },
    });

    const view = await createHomeActions({ db, keyWrapper, clock }).load(session);
    assert.equal(view.activity.length, 1);
    assert.equal(view.activity[0]!.summary, "Add a task");
    assert.equal(view.activity[0]!.outcome, "Denied");
    assert.equal(view.activity[0]!.agent, "Claude on my laptop");

    const shown = text(renderToStaticMarkup(<DashboardView {...view} />));
    assert.ok(shown.includes("Add a task"), shown);
    assert.ok(shown.includes("Denied"), "the outcome is in words, so a refused call never reads as done");
    assert.ok(shown.includes("Claude on my laptop"));
    assert.ok(!shown.includes(agent.id), "the raw agent id is never shown");
  } finally {
    await db.close();
  }
});
