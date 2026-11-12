import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { upsertPermissions } from "../db/agent-permissions";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import { createSession } from "../auth/session";
import { systemRandom } from "../seams/random";
import { createDbRecorder } from "./writer";
import { createDisputeRepo } from "./disputes";
import { createAgentCallPipeline } from "../mcp/pipeline";
import { createRateLimiter } from "../mcp/rate-limit";
import { createActivityActions } from "../../app/(portal)/(protected)/activity/actions";

// Contract tests use the real writer, policy pipeline and portal loader.
test("pipeline evidence is readable, searchable, disputed and reachable beyond the first page", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(new Date("2026-11-12T01:30:00Z"));
    const keyWrapper = localAesKeyWrapper(randomBytes(32)), dek = randomBytes(32);
    const user = await createUser(db, { email: "audit-contract@example.test", wrappedDek: await keyWrapper.wrap(dek) });
    const connectionId = randomUUID();
    const agent = await createAgent(db, { userId: user.id, connectionId, displayName: "Review agent", platform: "other" }, clock);
    const connection = { userId: user.id, connectionId, agentId: agent.id, active: true };
    await upsertPermissions(db, { userId: user.id, connectionId, grantedConnectors: ["google-gmail"], readTools: true, changeTools: "ask_first", identityAccess: true, highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false, rulesScope: [], rateLimit: 120 });
    const recorder = createDbRecorder({ db, clock, dekFor: async () => dek });
    const disputes = createDisputeRepo({ db, clock, dekFor: async () => dek });
    const session = (await createSession(db, user.id, { clock, random: systemRandom })).session;
    const loader = createActivityActions({ db, disputes, undo: { undo: async () => ({ ok: false, reason: "unused" }) }, keyWrapper, pageLimit: 2 });
    const pipeline = createAgentCallPipeline({ db, keyWrapper, clock, recorder, rateLimiter: createRateLimiter(clock), executeTool: async () => ({ status: 200, body: '{"messages":[{"id":"message-one"}]}', truncated: false }) });
    for (const reason of ["Find the appointment", "Second search", "Third search"]) {
      await pipeline.handleAgentCall(connection, { connector: "google-gmail", tool: "google-gmail__search", makesChange: false, reason, params: { query: { q: "in:inbox" }, token: "do-not-display" } });
    }
    const first = await loader.load(session, {});
    assert.match(first.entries[0].summary, /Third search/);
    assert.match(first.entries[0].detail, /in:inbox/);
    assert.doesNotMatch(first.entries[0].detail, /do-not-display/);
    assert.ok(first.nextHref);
    const nextParams = Object.fromEntries(new URL(first.nextHref!, "https://example.test").searchParams);
    const next = await loader.load(session, nextParams);
    assert.ok(next.entries.some(e => e.summary.includes("appointment")));
    const old = next.entries.find(e => e.summary.includes("appointment"))!;
    const direct = await loader.load(session, { entry: String(old.seq) });
    assert.equal(direct.entries[0].seq, old.seq);
    const search = await loader.load(session, { ...nextParams, q: "appointment" });
    assert.equal(search.entries.length, 1);
    await disputes.fileDispute({ userId: user.id, entrySeq: old.seq, note: "Please investigate this request" });
    const disputed = await loader.load(session, { entry: String(old.seq) });
    assert.equal(disputed.entries[0].disputes?.[0].note, "Please investigate this request");
    const other = await createUser(db, { email: "other-review@example.test", wrappedDek: await keyWrapper.wrap(dek) });
    const otherSession = (await createSession(db, other.id, { clock, random: systemRandom })).session;
    assert.equal((await loader.load(otherSession, { entry: String(old.seq) })).entries.length, 0);
  } finally { await db.close(); }
});
