// The agent workspace's Activity section (12 November; contained in the UI/UX pass): one
// agent's activity, organised — exact counts by type over its whole record (each a link into
// the filtered Activity page), what needs attention, and the recent entries in one list-group
// panel per day, each finished change once and in plain outcome words. Driven through the
// real workspace loader over PGlite and rendered through the real <AgentAuditLog>.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentAuditLog } from "./agent-audit-log";
import { agentWorkspaceData } from "@/server/agents/workspace-data";
import { createDbRecorder } from "@/server/activity/writer";
import { upsertPermissions } from "@/server/db/agent-permissions";
import { createAgent } from "@/server/db/agents";
import { createUser } from "@/server/db/users";
import { fixedClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";

const NOW = new Date("2026-11-12T03:00:00.000Z");

test("an agent's Activity shows exact type counts, what needs attention and recent entries by day", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(NOW);
    const dek = randomBytes(32);
    const user = await createUser(db, { email: `audit-${randomUUID()}@people.example`, wrappedDek: "x" });
    const connectionId = randomUUID();
    const agent = await createAgent(db, { userId: user.id, connectionId, displayName: "Claude", platform: "Claude" }, clock);
    const other = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "ChatGPT", platform: "ChatGPT" }, clock);
    await upsertPermissions(db, { userId: user.id, connectionId, grantedConnectors: [], readTools: true, changeTools: "ask_first", identityAccess: false, highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false, rulesScope: [], rateLimit: 60 });
    const at = (iso: string) => createDbRecorder({ db, clock: fixedClock(new Date(iso)), dekFor: async () => dek });
    await at("2026-11-11T01:00:00Z").record({ userId: user.id, agentId: agent.id, kind: "tool_call", source: "warthog", tool: "search_memory", outcome: "executed", payload: {} });
    await at("2026-11-12T01:00:00Z").record({ userId: user.id, agentId: agent.id, kind: "tool_call", source: "warthog", tool: "remember", outcome: "denied", payload: {} });
    await at("2026-11-12T02:00:00Z").record({ userId: user.id, agentId: agent.id, kind: "agent_report", source: "agent_reported", payload: { summary: "Booked it" } });
    await at("2026-11-12T02:00:00Z").record({ userId: user.id, agentId: other.id, kind: "tool_call", source: "warthog", tool: "remember", outcome: "executed", payload: {} });
    // A change and the intent record written just before it ran: the change is listed once.
    await at("2026-11-12T02:30:00Z").record({ userId: user.id, agentId: agent.id, kind: "tool_attempt", source: "warthog", tool: "save_record", outcome: "attempted", payload: { attemptId: "attempt-one" } });
    await at("2026-11-12T02:30:01Z").record({ userId: user.id, agentId: agent.id, kind: "tool_call", source: "warthog", tool: "save_record", outcome: "executed", payload: { attemptId: "attempt-one", resultEvidence: { outcome: "executed" } } });

    const data = await agentWorkspaceData(db, user.id, agent.id, dek, clock, "activity");
    assert.ok(data);
    assert.equal(data.auditSummary?.total, 4, "only this agent's entries are counted, each change once");
    const html = renderToStaticMarkup(<AgentAuditLog data={data} />);
    const shown = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    assert.match(html, new RegExp(`href="/activity\\?agent=${agent.id}&amp;via=agents&amp;type=read"`));
    assert.match(shown, /Reads 1/);
    assert.match(shown, /Changes 2/);
    assert.match(shown, /Agent reports 1/);
    assert.match(shown, /Needs attention: 1 blocked/);
    assert.ok(shown.indexOf("Today") < shown.indexOf("Yesterday"));
    assert.match(shown, /Reported by Claude\. Warthog did not observe this\./);
    assert.match(shown, /Open all of Claude’s activity/);
    assert.equal(shown.split("Save a record").length - 1, 1, "the change is listed once, without its intent record");
    assert.ok(!shown.includes("Started:"), "no matched intent record");
    const row = shown.slice(shown.indexOf("Save a record"), shown.indexOf("Agent report "));
    assert.match(row, /\bDone\b/, `outcomes read in plain words: ${row}`);
    assert.ok(!/Executed|Attempted/.test(shown), "never the engine's outcome codes");
    assert.equal((html.match(/class="wh-list-group"/g) ?? []).length, 2, "one list-group panel per day");
    assert.ok(!shown.includes("ChatGPT"), "another agent's entries are not listed");
  } finally {
    await db.close();
  }
});
