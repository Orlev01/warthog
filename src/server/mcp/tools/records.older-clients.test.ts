// Agents whose client cached an older list of Warthog's tools (ChatGPT keeps one until the
// person refreshes the connector) can only send save_record's older parameters — kind, fields,
// dueDate, status — so they put the newer ones inside fields, or send them as JSON text. Their
// records must still be filed as the kind they meant, with the source Warthog checks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createListRecordsTool, createSaveRecordTool, createUpdateRecordTool } from "./records";
import { liftOlderClientInput } from "./older-clients";
import { listRecordsForUser } from "../../db/life-admin-records";
import { createUser } from "../../db/users";
import { createAgent } from "../../db/agents";
import { upsertPermissions } from "../../db/agent-permissions";
import { freshDb } from "../../../test/db";
import { mcpRequest } from "../../../test/mcp-request";
import { localAesKeyWrapper } from "../../crypto/key-wrapper";
import { fixedClock } from "../../seams/clock";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

const NOW = new Date("2026-11-23T01:00:00.000Z");
const clock = fixedClock(NOW);

async function setup() {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const connectionId = randomUUID();
  const agent = await createAgent(db, { userId: user.id, connectionId, displayName: "ChatGPT", platform: "chatgpt" }, clock);
  await upsertPermissions(db, {
    userId: user.id, connectionId, grantedConnectors: [], readTools: true, changeTools: "allow", identityAccess: true,
    highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false,
    rulesScope: [], rateLimit: 120, recordsAccess: true,
  } as Parameters<typeof upsertPermissions>[1]);
  const connection = { userId: user.id, connectionId, agentId: agent.id, active: true } as unknown as AgentConnection;
  const deps = { db, keyWrapper, clock };
  return { db, dek, connection, userId: user.id, save: createSaveRecordTool(deps), list: createListRecordsTool(deps), update: createUpdateRecordTool(deps) };
}

async function closing(db: Db, body: () => Promise<void>) {
  try { await body(); } finally { await db.close(); }
}

test("ChatGPT's shape — the older kind, with type and source inside fields — saves the kind it meant", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    const result = await t.save.handle({
      kind: "renewal_appointment",
      fields: {
        type: "vehicles.registration",
        name: "Registration renewal",
        provider: "Service NSW",
        plate: "HLC32",
        state: "NSW",
        amount: 91,
        currency: "AUD",
        source: { service: "Gmail", messageId: "1a1c1821ab76a23f", date: "2026-11-09", sender: "Service NSW <noreply@service.nsw.gov.au>" },
      },
      dueDate: "2026-11-24",
      status: "needs renewal",
    }, t.connection);
    assert.equal(result.status, "saved");
    const [record] = await listRecordsForUser(t.db, t.userId, t.dek);
    assert.equal(record!.type, "vehicles.registration");
    assert.equal(record!.fields.type, undefined, "type is the record's kind, not one of its fields");
    assert.equal(record!.fields.source, undefined, "source is where it was found, not one of its fields");
    assert.equal(record!.fields.plate, "HLC32");
    assert.equal(record!.dueDate, "2026-11-24");
    assert.equal(record!.foundIn?.service, "Gmail");
    assert.equal(record!.foundIn?.date, "2026-11-09");
  });
});

test("parameters sent as JSON text (a client that only knows the older ones) are read as what they say", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    const result = await t.save.handle({
      kind: "renewal_appointment",
      type: "health.insurance",
      fields: { provider: "Medibank", reference: "M-1", amount: 148.25, currency: "AUD", cycle: "monthly" },
      source: JSON.stringify({ service: "gmail", date: "2026-03-19", sender: "medibank.com.au" }),
      details: JSON.stringify([{ label: "Hospital", value: "Bronze Plus" }]),
      journal: JSON.stringify({ note: "Premium went up on 1 April." }),
    }, t.connection);
    assert.equal(result.status, "saved");
    if (result.status === "saved") assert.equal(result.journal?.added.length, 1);
    const [record] = await listRecordsForUser(t.db, t.userId, t.dek);
    assert.equal(record!.type, "health.insurance", "type wins over the older kind an older client must send");
    assert.equal(record!.foundIn?.sender, "medibank.com.au");

    const batch = await t.save.handle({
      kind: "subscription",
      fields: {},
      records: JSON.stringify([
        { type: "subscriptions.service", fields: { name: "Netflix", provider: "Netflix", amount: 18.99, currency: "AUD", cycle: "monthly" } },
        { type: "subscriptions.service", fields: { name: "Spotify", provider: "Spotify", amount: 13.99, currency: "AUD", cycle: "monthly" } },
      ]),
    }, t.connection);
    assert.equal(batch.status, "ok", "a batch sent as text, with the older required kind and empty fields, is a batch");

    const listed = await t.list.handle({ limit: "1", type: "subscriptions.service" }, t.connection);
    assert.equal(listed.status, "ok");
    if (listed.status === "ok" && "records" in listed) assert.equal(listed.records.length, 1, "a number sent as text is read as the number");
  });
});

test("a field named type that isn't a kind stays a field, and the older kind is saved as before", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    const result = await t.save.handle({ kind: "renewal_appointment", fields: { name: "Boat licence", type: "general", where: "Service NSW" } }, t.connection);
    assert.equal(result.status, "saved");
    const [record] = await listRecordsForUser(t.db, t.userId, t.dek);
    assert.equal(record!.kind, "renewal_appointment");
    assert.equal(record!.fields.type, "general");
  });
});

test("update_record with the older fields form moves an older record into the kind named inside it", async () => {
  const t = await setup();
  await closing(t.db, async () => {
    await t.save.handle({ kind: "renewal_appointment", fields: { name: "Mondial HPS 300", plate: "HLC32" } }, t.connection);
    const [legacy] = await listRecordsForUser(t.db, t.userId, t.dek);
    const result = await t.update.handle({
      id: legacy!.id,
      fields: { type: "vehicles.vehicle", name: "Mondial HPS 300", body: "Motorcycle", plate: "HLC32", state: "NSW", source: { service: "gmail", date: "2026-11-09" } },
    }, t.connection);
    assert.equal(result.status, "updated");
    const [record] = await listRecordsForUser(t.db, t.userId, t.dek);
    assert.equal(record!.type, "vehicles.vehicle");
    assert.equal(record!.fields.type, undefined);
    assert.equal(record!.fields.source, undefined);
    assert.equal(record!.fields.plate, "HLC32");
  });
});

test("liftOlderClientInput leaves a current call exactly as it was", () => {
  const current = { type: "vehicles.vehicle", fields: { name: "Bike", type: "naked" }, source: { service: "gmail" } };
  assert.deepEqual(liftOlderClientInput(current), current, "a current call's own type and source win; a field named type stays");
  assert.equal(liftOlderClientInput("not an object"), "not an object");
  assert.deepEqual(liftOlderClientInput({ fields: { source: "an email" } }), { fields: { source: "an email" } }, "a source that isn't one stays a field");
  assert.deepEqual(liftOlderClientInput({ source: "{not json" }), { source: "{not json" }, "text that isn't JSON is left for the schema to refuse");
});

test("through the real MCP dispatch, the SDK accepts an older client's call and files the kind it meant", async () => {
  const { createMcpDispatch } = await import("../compose");
  const { loadConfig } = await import("../../config");
  const config = loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "https://warthog.example",
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: Buffer.alloc(48, 0x2a).toString("base64"),
    WARTHOG_DEV_KEK: Buffer.alloc(32, 0x5c).toString("base64"),
  } as NodeJS.ProcessEnv);
  const db = await freshDb();
  await closing(db, async () => {
    const keyWrapper = localAesKeyWrapper(config.devKek!);
    const dek = randomBytes(32);
    const user = await createUser(db, { email: `${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
    const agent = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "ChatGPT", platform: "chatgpt" }, clock);
    await upsertPermissions(db, {
      userId: user.id, connectionId: agent.connectionId, grantedConnectors: [], readTools: true, changeTools: "allow", identityAccess: true,
      highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false, rulesScope: [], rateLimit: 120,
      recordsAccess: true,
    } as Parameters<typeof upsertPermissions>[1]);
    const dispatch = createMcpDispatch({ db, config });
    const call = async (name: string, args: unknown) => {
      const res = await dispatch(agent.connectionId, mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));
      const text = await res.text();
      const frame = (res.headers.get("content-type") ?? "").includes("text/event-stream")
        ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1)!
        : text;
      const rpc = JSON.parse(frame) as { result?: { isError?: boolean; content: { text: string }[] }; error?: { message: string } };
      assert.ok(rpc.result && !rpc.result.isError, rpc.error?.message ?? rpc.result?.content[0]?.text);
      return JSON.parse(rpc.result.content[0]!.text) as Record<string, unknown>;
    };

    const saved = await call("save_record", {
      kind: "renewal_appointment",
      fields: { type: "vehicles.vehicle", name: "Mondial HPS 300", body: "Motorcycle", plate: "HLC32", source: { service: "Gmail", date: "2026-11-09", sender: "Service NSW" } },
    });
    assert.equal(saved.status, "saved");
    const listed = await call("list_records", { limit: "5", journal: "none" });
    const records = listed.records as { type: string; fields: Record<string, unknown> }[];
    assert.equal(records.length, 1);
    assert.equal(records[0]!.type, "vehicles.vehicle");
    assert.equal(records[0]!.fields.type, undefined);
  });
});
