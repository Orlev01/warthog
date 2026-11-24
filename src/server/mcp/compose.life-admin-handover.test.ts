// The motorcycle-insurance hand-over, end to end through the real MCP dispatch
// (docs/adr/life-admin-journal.md): Instinct saves the bike and its insurance with a decision and
// a next step; Muse, a different agent, gets the hand-over line from get_context, reads the log,
// takes the item over, closes the step and links a task to it. Every call's activity entry is
// linked to the items it touched, so Activity can show one item's whole story.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createMcpDispatch } from "./compose";
import { loadConfig, type Config } from "../config";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { upsertPermissions } from "../db/agent-permissions";
import { listActivity } from "../activity/list";
import { freshDb } from "../../test/db";
import { mcpRequest } from "../../test/mcp-request";

function devConfig(): Config {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "https://warthog.example",
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: Buffer.alloc(48, 0x2a).toString("base64"),
    WARTHOG_DEV_KEK: Buffer.alloc(32, 0x5c).toString("base64"),
  } as NodeJS.ProcessEnv);
}

async function callTool(dispatch: ReturnType<typeof createMcpDispatch>, connectionId: string, name: string, args: unknown): Promise<Record<string, unknown>> {
  const res = await dispatch(connectionId, mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));
  const text = await res.text();
  const frame = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1)!
    : text;
  const rpc = JSON.parse(frame) as { result: { isError?: boolean; content: { text: string }[] } };
  const body = rpc.result.content[0]!.text;
  // A refusal comes back as an error result in words.
  return rpc.result.isError ? { isError: true, text: body } : JSON.parse(body) as Record<string, unknown>;
}

test("Instinct hands the motorcycle insurance to Muse through the real dispatch, and Activity links every call to the item", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const keyWrapper = localAesKeyWrapper(config.devKek!);
    const dek = randomBytes(32);
    const user = await createUser(db, { email: `rider-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
    const clock = fixedClock(new Date("2026-11-18T01:00:00Z"));
    const agents: Record<string, { connectionId: string; id: string }> = {};
    for (const name of ["Instinct", "Muse"]) {
      const agent = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: name, platform: "other" }, clock);
      await upsertPermissions(db, {
        userId: user.id, connectionId: agent.connectionId, grantedConnectors: [], readTools: true, changeTools: "allow", identityAccess: true,
        highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false, rulesScope: [], rateLimit: 120,
        recordsAccess: true, tasksAccess: true,
      } as Parameters<typeof upsertPermissions>[1]);
      agents[name] = { connectionId: agent.connectionId, id: agent.id };
    }
    const dispatch = createMcpDispatch({ db, config });
    // The dispatch runs on the real clock, so the dates are relative to today.
    const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

    const saved = await callTool(dispatch, agents.Instinct!.connectionId, "save_record", { records: [
      { ref: "bike", type: "vehicles.vehicle", fields: { name: "Honda CB500X", body: "motorcycle", plate: "BX12AB" } },
      { parentRef: "bike", type: "vehicles.insurance", fields: { name: "Motorcycle insurance", provider: "Swann", reference: "S-1", amount: "780", cycle: "yearly" }, dueDate: inDays(9),
        journal: { decision: "Chose Swann over Bikesure: agreed value $9,000, $212/yr cheaper.", next: { text: "Get the roadworthy at Ryde Motorcycles and send it to Swann", due: inDays(5) } } },
    ] });
    const [bike, insurance] = (saved.results as { id: string }[]).map((result) => result.id);
    assert.ok(bike && insurance);

    const context = await callTool(dispatch, agents.Muse!.connectionId, "get_context", {});
    const handover = (context.lifeAdmin as { handover?: { items: { id: string; line: string }[] } }).handover!;
    assert.equal(handover.items.length, 1);
    assert.equal(handover.items[0]!.id, insurance);
    assert.match(handover.items[0]!.line, /^Motorcycle insurance · renews .*, in (8|9) days · decided: Chose Swann over Bikesure.*\(Instinct, .+\) · next: Get the roadworthy at Ryde Motorcycles and send it to Swann, due .+ · handled by Instinct · last touched today by Instinct$/);

    const log = await callTool(dispatch, agents.Muse!.connectionId, "list_records", { id: insurance, journal: "full" });
    const next = ((log.journal as { entries: { id: string; kind: string }[] }).entries).find((entry) => entry.kind === "next")!;
    const taken = await callTool(dispatch, agents.Muse!.connectionId, "update_record", { id: insurance, takeOver: true, journal: { decision: "Paid in the Swann app after the roadworthy passed.", doneNextIds: [next.id] } });
    assert.equal((taken.journal as { tookOverFrom?: string }).tookOverFrom, "Instinct");
    const task = await callTool(dispatch, agents.Muse!.connectionId, "create_task", { title: "Save the Swann certificate", recordId: insurance });
    assert.equal(task.status, "created");
    const refused = await callTool(dispatch, agents.Muse!.connectionId, "create_task", { title: "x", recordId: randomUUID() });
    assert.equal(refused.isError, true);
    assert.match(String(refused.text), /No life-admin record with that id/, "a task can only be about a record this agent can see");

    const after = await callTool(dispatch, agents.Instinct!.connectionId, "get_context", {});
    assert.equal((after.lifeAdmin as { handover?: unknown }).handover, undefined, "nothing left open for anyone");

    // Activity: the batch save is linked to both records; the take-over to the insurance (reads are not linked).
    const forInsurance = await listActivity(db, user.id, { recordId: insurance }, dek);
    assert.deepEqual(forInsurance.map((entry) => entry.tool).sort(), ["save_record", "update_record"]);
    const forBike = await listActivity(db, user.id, { recordId: bike }, dek);
    assert.deepEqual(forBike.map((entry) => entry.tool), ["save_record"]);
    const saveEntry = forInsurance.find((entry) => entry.tool === "save_record")!;
    const evidence = (saveEntry.payload as { resultEvidence?: { effects?: unknown } }).resultEvidence;
    assert.deepEqual(evidence?.effects, { created: 2 });
  } finally {
    await db.close();
  }
});
