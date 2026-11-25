// The Now view's loader (docs/adr/agent-runs.md, amendment of 25 November 2026): the session
// person's agents and their conversations from the last day, grouped by provider, with each
// conversation's latest action in Warthog's words; never another person's, never older ones.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createNowActions } from "./actions";
import { startRun, updateRunLabel } from "@/server/agents/runs";
import { createDbRecorder } from "@/server/activity/writer";
import { createAgent } from "@/server/db/agents";
import { createUser } from "@/server/db/users";
import { fixedClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Session } from "@/server/auth/session";
import type { Db } from "@/server/db/index";

const NOW = new Date("2026-11-25T12:00:00.000Z");
const at = (minutesAgo: number) => fixedClock(new Date(NOW.getTime() - minutesAgo * 60_000));

async function person(db: Db, who: string) {
  const user = await createUser(db, { email: `${who}-${randomUUID()}@warthog.com.au`, wrappedDek: "synthetic" });
  const session: Session = { id: `s-${who}`, userId: user.id, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: null };
  return { userId: user.id, dek: new Uint8Array(randomBytes(32)), session };
}

test("the loader groups the person's recent conversations by provider, with each one's latest action", async () => {
  const db = await freshDb();
  try {
    const me = await person(db, "now");
    const stranger = await person(db, "now-stranger");
    const claude = await createAgent(db, { userId: me.userId, connectionId: randomUUID(), displayName: "Claude Code · laptop", platform: "Claude", status: "connected" }, at(600));
    const gemini = await createAgent(db, { userId: me.userId, connectionId: randomUUID(), displayName: "Gemini CLI · research", platform: "localhost", status: "connected" }, at(600));
    const quiet = await createAgent(db, { userId: me.userId, connectionId: randomUUID(), displayName: "ChatGPT", platform: "ChatGPT", status: "connected" }, at(600));
    const theirs = await createAgent(db, { userId: stranger.userId, connectionId: randomUUID(), displayName: "Not yours", platform: "Claude", status: "connected" }, at(600));

    const tests = await startRun(db, { userId: me.userId, agentId: claude.id }, { label: "Fixing the website tests", via: "Claude Code" }, me.dek, at(30));
    await startRun(db, { userId: me.userId, agentId: claude.id }, { label: "Last week" }, me.dek, at(7 * 24 * 60));
    const research = await startRun(db, { userId: me.userId, agentId: gemini.id }, { label: "Coffee tables" }, me.dek, at(10));
    await updateRunLabel(db, { userId: me.userId, agentId: gemini.id }, research.id, "Comparing coffee table prices", me.dek, at(5), () => false, async () => {});
    await startRun(db, { userId: stranger.userId, agentId: theirs.id }, { label: "Theirs" }, stranger.dek, at(5));

    const record = (clockAt: ReturnType<typeof at>, fields: Parameters<ReturnType<typeof createDbRecorder>["record"]>[0]) =>
      createDbRecorder({ db, clock: clockAt, dekFor: async () => me.dek }).record(fields);
    await record(at(30), { userId: me.userId, agentId: claude.id, kind: "tool_call", source: "warthog", tool: "google-gmail__send", connectorId: "google-gmail", outcome: "pending_approval", runId: tests.id });
    await record(at(3), { userId: me.userId, agentId: gemini.id, kind: "tool_call", source: "warthog", tool: "search_memory", outcome: "executed" });
    await record(at(2), { userId: me.userId, agentId: gemini.id, kind: "tool_call", source: "warthog", tool: "remember", outcome: "executed" });

    const view = await createNowActions({ db, clock: fixedClock(NOW), dekFor: async () => me.dek, nameOf: (id) => (id === "google-gmail" ? "Gmail" : undefined) }).load(me.session);

    assert.deepEqual(view.providers.map((p) => p.label), ["Claude", "Gemini"]);
    const claudeRow = view.providers[0]!.agents[0]!;
    assert.equal(claudeRow.name, "Claude Code · laptop");
    assert.deepEqual(claudeRow.conversations.map((c) => c.label), ["Fixing the website tests"], "last week's conversation isn't listed");
    const row = claudeRow.conversations[0]!;
    assert.equal(row.via, "Claude Code");
    assert.equal(row.href, `/activity?run=${tests.id}`);
    assert.deepEqual(row.latest, { title: "Send", outcome: "Waiting for you", outcomeGroup: "waiting", service: "Gmail" });
    assert.equal(row.active, false, "last called 30 minutes ago");

    const geminiRow = view.providers[1]!.agents[0]!;
    assert.equal(geminiRow.conversations[0]!.label, "Comparing coffee table prices");
    assert.equal(geminiRow.conversations[0]!.statusChanged, "5 min ago");
    assert.equal(geminiRow.conversations[0]!.active, true);
    assert.deepEqual(geminiRow.unlinked, { count: 2, href: `/activity?agent=${gemini.id}&run=none`, lastCall: "2 min ago" });

    assert.deepEqual(view.quiet.map((a) => a.id), [quiet.id]);
    assert.equal(view.activeCount, 1);
    assert.ok(!JSON.stringify(view).includes("Theirs") && !JSON.stringify(view).includes(theirs.id), "another person's agent and runs never appear");
    assert.equal(view.updatedAtIso, NOW.toISOString());
  } finally {
    await db.close();
  }
});
