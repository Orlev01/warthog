// E14-S08 — the `list_records` / `save_record` / `update_record` core tools
// (`src/server/mcp/tools/records.ts`, design §6.2 MCP core tools; brief §"Life admin":
// records that agents and the person both maintain — subscriptions (service, cost,
// billing cycle, next renewal, how to cancel, status), receipts and warranties, and
// renewals and appointments; "agents add and update records through Warthog";
// constitution principle 14 "Warthog … SHALL record every tool call itself at the
// moment it handles it").
//
// RED-first: `./records` does not exist yet, so importing the three tool factories
// throws and every test here fails until the builder writes the minimum code to pass.
// That absence IS the point of test-first; do NOT implement anything to make these pass
// — the builder writes `records.ts` afterwards. (The life-admin records STORE these
// tools read/write — `createRecord` / `updateRecord` / `listRecordsForUser` — the
// permission store `getConnectionPermissions` / `upsertPermissions`, the registry and
// the pipeline they route through all ALREADY exist and are driven here as real, tested
// seams.)
//
// These tests pin BEHAVIOUR (what each tool DOES: the record row it stores, the set it
// hands an agent, who it refuses, the person's-own scope, and that it runs through the
// pipeline so a tool call is recorded), never the source text of any module — a later
// rename that preserves behaviour must not redden them.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   import { z } from "zod";
//   import type { Db } from "../../db/index";
//   import type { KeyWrapper } from "../../crypto/key-wrapper";
//   import type { Clock } from "../../seams/clock";
//   import type { AgentConnection } from "../context";
//
//   interface RecordsToolDeps {
//     readonly db: Db;                 // the parameterizing db seam (permissions + the records store)
//     readonly keyWrapper: KeyWrapper; // unwraps the person's DEK (encrypt fields / decrypt on read)
//     readonly clock?: Clock;          // harmless if unused — the records store takes no clock
//   }
//
//   // list_records — hand the agent the person's records it may READ (via the store's
//   // `listRecordsForUser`), each fields-blob DECRYPTED. Refused when the connection has
//   // no records permission.
//   type ListRecordsResult =
//     | { status: "ok"; records: ReadonlyArray<{ id; kind; fields; dueDate; status; source }> }
//     | { status: "refused"; reason: string };
//   function createListRecordsTool(deps): { name: "list_records"; inputSchema; handle(input, connection) };
//
//   // save_record — create a subscription / receipt / renewal record FOR the connection's
//   // person, with its `fields` (DEK-encrypted at rest), an optional `dueDate` + `status`,
//   // SOURCE = the connection's AGENT. Refused when the connection has no records permission.
//   type SaveRecordResult =
//     | { status: "saved"; id: string }
//     | { status: "refused"; reason: string };
//   function createSaveRecordTool(deps): { name: "save_record"; inputSchema; handle(input, connection) };
//
//   // update_record — change a record the person OWNS (member-scoped by the connection's
//   // userId): its new `fields` and optional `status` / `dueDate`. Refused without the
//   // records permission; a refusal (NOT a throw) when no such record belongs to the person.
//   type UpdateRecordResult =
//     | { status: "updated"; id: string }
//     | { status: "refused"; reason: string };
//   function createUpdateRecordTool(deps): { name: "update_record"; inputSchema; handle(input, connection) };
//
// THE RECORDS PERMISSION. The connection's grants carry no dedicated "records" flag (the
// brief lists read tools and change-making tools separately); so a READ (`list_records`)
// needs the connection's `readTools` grant and a CHANGE (`save_record` / `update_record`)
// needs its `changeTools` grant to be on. A connection that can NEITHER read NOR change —
// `readTools:false` AND `changeTools:"off"` — has no records permission and every tool
// refuses it with a plain reason. (The refusal lives INSIDE the tool, like the task tools'
// gate: the policy engine does not gate a core tool whose `connector` is null, so the tool
// checks its own permission.)
//
// The OWNING person and the agent are ALWAYS taken from the session `connection`
// (`connection.userId` owns; `connection.agentId` is the record's SOURCE; the permission
// key is `connection.connectionId`), never a value in the input — so one agent can never
// save against, read, or change another person's records.
//
// "records an activity entry" (an AC) is pinned by routing `save_record` through a real
// `createAgentCallPipeline` (the production path: it is a core tool the registry routes
// through the pipeline), which writes ONE `source:"warthog"` activity entry for the call
// BEFORE the response — Warthog writes the record itself (principle 14). "exposed through
// the core tool registry" is pinned by building the real registry and finding the three
// tool names in its always-available core.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations). Tests
// never touch the network, Azure or a real database.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import {
  createListRecordsTool,
  createSaveRecordTool,
  createUpdateRecordTool,
} from "./records";
import { createRecord, listRecordsForUser } from "../../db/life-admin-records";
import { createToolRegistry } from "./registry";
import { createAgentCallPipeline, type AgentCall, type AgentCallResult, type AgentCallPipeline } from "../pipeline";
import { createRateLimiter } from "../rate-limit";
import { createInMemoryRecorder, type ActivityEntryInput } from "../../activity/recorder";
import { createUser } from "../../db/users";
import { upsertPermissions } from "../../db/agent-permissions";
import { freshDb } from "../../../test/db";
import { localAesKeyWrapper, type KeyWrapper } from "../../crypto/key-wrapper";
import { fixedClock, type Clock } from "../../seams/clock";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

// --- loose result shapes so the (absent) module's exact types do not gate compile. The
// tests assert on `status` + the field a status carries, leaving the builder free to pin
// the exact discriminated-union members as long as the behaviour holds.
interface RecordView {
  readonly id?: string;
  readonly kind?: string;
  readonly fields?: Record<string, unknown>;
  readonly dueDate?: string | Date | null;
  readonly status?: string;
  readonly source?: unknown;
}
interface ListRecordsResult {
  readonly status: string;
  readonly records?: ReadonlyArray<RecordView>;
  readonly reason?: string;
}
interface SaveRecordResult {
  readonly status: string;
  readonly id?: string;
  readonly reason?: string;
}
interface UpdateRecordResult {
  readonly status: string;
  readonly id?: string;
  readonly reason?: string;
}

type Grants = Parameters<typeof upsertPermissions>[1];

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 KEK the KeyWrapper seam wraps the DEK under

// The frozen instant the tools (and the pipeline) read time through. Mid-month noon UTC,
// so the pipeline's budget-period / rate-limit buckets are unambiguous in UTC arithmetic.
const NOW = new Date("2026-11-15T12:00:00.000Z");

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose wrapped DEK REALLY unwraps under `keyWrapper` (the tool resolves
// the DEK from the user row through the wrapper), returning their id and the raw DEK — so
// reading records back under that same raw key proves a tool stored / read under the
// person's OWN key.
async function makePerson(
  db: Db,
  who: string,
  keyWrapper: KeyWrapper,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

// The resolved connection a tool acts for. Built as a variable (not a literal at the call
// site) so a superset of fields stays assignable to the tool's param type. `agentId`
// defaults to `connectionId` (the E07-S09 shape).
function connectionFor(
  userId: string,
  opts: { connectionId?: string; agentId?: string; active?: boolean } = {},
): AgentConnection {
  const connectionId = opts.connectionId ?? randomUUID();
  return {
    userId,
    connectionId,
    agentId: opts.agentId ?? connectionId,
    active: opts.active ?? true,
  };
}

// The tool deps, built via a helper (a non-literal) so an excess-property check never
// bites whichever subset the builder's factory declares (clock is harmless if unused).
function recordsDeps(db: Db, keyWrapper: KeyWrapper, clock: Clock) {
  return { db, keyWrapper, clock };
}

// A fully-populated grants record for a connection; a test overrides only what it is
// about (readTools gates `list_records`; changeTools gates the change tools). Built via a
// helper (a non-literal) so excess-property checks never bite.
function baseGrants(userId: string, connectionId: string, overrides: Partial<Grants> = {}): Grants {
  return {
    userId,
    connectionId,
    grantedConnectors: [],
    readTools: true,
    changeTools: "ask_first",
    identityAccess: true,
    highTierAccess: false,
    cardAccess: false,
    cardBudget: null,
    skillsScope: [],
    memoryRead: true,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
    ...overrides,
  } as Grants;
}

// Grant one connection the records permission (it may both read and change) — so every
// record tool is allowed. Keyed by connectionId, exactly as the tool reads it.
async function grantRecords(db: Db, userId: string, connectionId: string): Promise<void> {
  await upsertPermissions(db, baseGrants(userId, connectionId, { readTools: true, changeTools: "allow" }));
}

// Grant one connection NO records permission: it may neither read nor change — so every
// record tool refuses it, whichever class a given tool checks.
async function grantNoRecords(db: Db, userId: string, connectionId: string): Promise<void> {
  await upsertPermissions(db, baseGrants(userId, connectionId, { readTools: false, changeTools: "off" }));
}

// A recorder that wraps the REAL in-memory recorder (so redaction + chaining really
// happen) and captures each input, so the pipeline test can prove the tool call was
// recorded.
function spyRecorder(clock: Clock) {
  const base = createInMemoryRecorder({ clock });
  const inputs: ActivityEntryInput[] = [];
  const recorder = {
    async record(input: ActivityEntryInput) {
      inputs.push(input);
      return base.record(input);
    },
  };
  return { recorder, inputs };
}

// A pipeline spy for the registry-exposure test: it only needs to satisfy the
// AgentCallPipeline shape the registry closes over.
function spyPipeline(): AgentCallPipeline {
  return {
    async handleAgentCall(): Promise<AgentCallResult> {
      return { status: "executed", result: { ok: true } };
    },
    async executeApprovedHold() {
      return { status: "refused" as const, reason: "unused in these tests" };
    },
  };
}

// Narrowing helper (assert.fail is `never`, so the result narrows after).
function expectExecuted(r: AgentCallResult) {
  if (r.status !== "executed") {
    assert.fail(`expected an executed result, got "${r.status}": ${JSON.stringify(r)}`);
  }
  return r;
}

// Find the one record in a decrypted owner-list whose `fields[key]` matches.
function byField(
  records: ReadonlyArray<{ fields: Record<string, unknown> }>,
  key: string,
  value: unknown,
) {
  return records.find((r) => r.fields[key] === value);
}

// ===========================================================================
// AC1 — save_record creates a record FOR the connection's person, with its fields,
// its kind / due date / status metadata, SOURCE = the connection's agent. The STORED
// row (read back under the owner's key) is the proof.
// ===========================================================================

test("save_record creates a record for the person with its fields, due date, status, source = the agent", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "save-subscription", keyWrapper);
    const conn = connectionFor(userId);
    await grantRecords(db, userId, conn.connectionId);

    const tool = createSaveRecordTool(recordsDeps(db, keyWrapper, fixedClock(NOW)));
    const fields = { service: "Streamflix", cost: "A$19.99", billingCycle: "monthly", howToCancel: "account › cancel" };
    const result = (await tool.handle(
      { kind: "subscription", fields, dueDate: "2027-01-15", status: "active" },
      conn,
    )) as SaveRecordResult;
    assert.equal(result.status, "saved", "a permitted save_record reports it saved the record");
    assert.equal(typeof result.id, "string", "it hands back the new record's id");

    // Read it back under the person's OWN key.
    const stored = await listRecordsForUser(db, userId, dek);
    assert.equal(stored.length, 1, "exactly one record was written for the person");
    const record = stored[0];
    assert.equal(record.kind, "subscription", "the kind is stored as plaintext metadata");
    assert.deepEqual(record.fields, fields, "the fields round-trip (DEK-encrypted at rest)");
    assert.equal(record.dueDate, "2027-01-15", "the due date (reminder anchor) is stored");
    assert.equal(record.status, "active", "the status is stored");
    assert.deepEqual(record.source, { kind: "agent", agentId: conn.agentId }, "the record's source is the connection's agent");
    assert.equal(record.id, result.id, "the returned id is the stored record's id");
  } finally {
    await db.close();
  }
});

test("save_record can save each of the three record kinds (receipt / renewal)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "save-kinds", keyWrapper);
    const conn = connectionFor(userId);
    await grantRecords(db, userId, conn.connectionId);
    const tool = createSaveRecordTool(recordsDeps(db, keyWrapper, fixedClock(NOW)));

    const receipt = (await tool.handle(
      { kind: "receipt_warranty", fields: { merchant: "Hardware Co", item: "Drill", amount: "A$149" }, status: "kept" },
      conn,
    )) as SaveRecordResult;
    assert.equal(receipt.status, "saved", "a receipt/warranty record is saved");

    const renewal = (await tool.handle(
      { kind: "renewal_appointment", fields: { what: "Car rego", where: "Service NSW" }, dueDate: "2027-03-01", status: "due" },
      conn,
    )) as SaveRecordResult;
    assert.equal(renewal.status, "saved", "a renewal/appointment record is saved");

    const stored = await listRecordsForUser(db, userId, dek);
    const kinds = new Set(stored.map((r) => r.kind));
    assert.ok(kinds.has("receipt_warranty"), "the receipt kind landed");
    assert.ok(kinds.has("renewal_appointment"), "the renewal kind landed");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — list_records returns the person's records (decrypted). Seeded through the tested
// store so the read is exercised alone.
// ===========================================================================

test("list_records returns the person's records, decrypted", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "list-mine", keyWrapper);
    const conn = connectionFor(userId);

    await createRecord(db, { userId, kind: "subscription", fields: { service: "Gym" }, status: "active", source: { kind: "person" } }, dek);
    await createRecord(db, { userId, kind: "renewal_appointment", fields: { what: "Passport" }, dueDate: "2027-06-01", status: "due", source: { kind: "agent", agentId: conn.agentId } }, dek);

    await grantRecords(db, userId, conn.connectionId);

    const tool = createListRecordsTool(recordsDeps(db, keyWrapper, fixedClock(NOW)));
    const result = (await tool.handle({}, conn)) as ListRecordsResult;
    assert.equal(result.status, "ok", "a permitted list_records returns a list");

    const records = result.records ?? [];
    assert.equal(records.length, 2, "both of the person's records are returned");
    const gym = byField(records as ReadonlyArray<{ fields: Record<string, unknown> }>, "service", "Gym");
    const passport = byField(records as ReadonlyArray<{ fields: Record<string, unknown> }>, "what", "Passport");
    assert.ok(gym, "the subscription is returned with its fields decrypted");
    assert.ok(passport, "the renewal is returned with its fields decrypted");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — update_record changes a record the person owns: its new fields are stored, read
// back under the owner's key; the record's KIND is untouched by a fields update.
// ===========================================================================

test("record tools reject impossible dates and preserve omitted dates while allowing explicit clearing", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "record-date-validation", keyWrapper);
    const conn = connectionFor(userId);
    await grantRecords(db, userId, conn.connectionId);
    const save = createSaveRecordTool(recordsDeps(db, keyWrapper, fixedClock(NOW)));
    const update = createUpdateRecordTool(recordsDeps(db, keyWrapper, fixedClock(NOW)));
    for (const dueDate of ["0000-01-01", "2026-02-30", "tomorrow", "2026-11-10T12:00:00Z"]) {
      await assert.rejects(save.handle({ kind: "subscription", fields: {}, dueDate }, conn));
      await assert.rejects(update.handle({ id: "record", fields: {}, dueDate }, conn));
    }
    const record = await createRecord(db, { userId, kind: "subscription", fields: {}, dueDate: "2026-11-20", status: "active", source: { kind: "person" } }, dek);
    await update.handle({ id: record.id, fields: { note: "changed" } }, conn);
    assert.equal((await listRecordsForUser(db, userId, dek))[0]!.dueDate, "2026-11-20");
    await update.handle({ id: record.id, fields: {}, dueDate: null }, conn);
    assert.equal((await listRecordsForUser(db, userId, dek))[0]!.dueDate, null);
  } finally { await db.close(); }
});

test("update_record changes the fields of the person's own record (kind untouched)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "update-fields", keyWrapper);
    const conn = connectionFor(userId);
    await grantRecords(db, userId, conn.connectionId);

    const seeded = await createRecord(
      db,
      { userId, kind: "subscription", fields: { service: "Streamflix", cost: "A$9.99" }, status: "active", source: { kind: "person" } },
      dek,
    );

    const tool = createUpdateRecordTool(recordsDeps(db, keyWrapper, fixedClock(NOW)));
    const newFields = { service: "Streamflix", cost: "A$14.99", note: "price went up" };
    const result = (await tool.handle({ id: seeded.id, fields: newFields, status: "active" }, conn)) as UpdateRecordResult;
    assert.equal(result.status, "updated", "a permitted update_record reports it updated the record");

    const stored = await listRecordsForUser(db, userId, dek);
    assert.equal(stored.length, 1, "still exactly one record");
    assert.equal(stored[0].id, seeded.id, "it is the same record (updated in place, not duplicated)");
    assert.deepEqual(stored[0].fields, newFields, "the fields were replaced with the new content");
    assert.equal(stored[0].kind, "subscription", "a fields update does not change the record's kind");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — every tool is refused with a plain reason for a connection WITHOUT the records
// permission (it can neither read nor change), and a refused save writes nothing.
// ===========================================================================

test("every record tool refuses a connection without the records permission (with a plain reason)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "no-perm", keyWrapper);
    const conn = connectionFor(userId);
    await grantNoRecords(db, userId, conn.connectionId);

    // A record already exists (seeded by the person), so a refusal can only be the gate.
    const seeded = await createRecord(
      db,
      { userId, kind: "subscription", fields: { service: "Untouchable" }, status: "active", source: { kind: "person" } },
      dek,
    );

    const deps = recordsDeps(db, keyWrapper, fixedClock(NOW));

    const listed = (await createListRecordsTool(deps).handle({}, conn)) as ListRecordsResult;
    assert.equal(listed.status, "refused", "list_records is refused without the records permission");
    assert.ok((listed.reason ?? "").length > 0, "the refusal carries a plain reason");

    const saved = (await createSaveRecordTool(deps).handle(
      { kind: "subscription", fields: { service: "Should never be stored" }, status: "active" },
      conn,
    )) as SaveRecordResult;
    assert.equal(saved.status, "refused", "save_record is refused");
    assert.ok((saved.reason ?? "").length > 0, "with a plain reason");

    const updated = (await createUpdateRecordTool(deps).handle(
      { id: seeded.id, fields: { service: "Hijacked" }, status: "cancelled" },
      conn,
    )) as UpdateRecordResult;
    assert.equal(updated.status, "refused", "update_record is refused");

    // Nothing changed: still ONE record, still its original field, and no second
    // (refused) record was written.
    const stored = await listRecordsForUser(db, userId, dek);
    assert.equal(stored.length, 1, "a refused save wrote nothing");
    assert.equal(stored[0].fields.service, "Untouchable", "a refused update changed nothing");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2/AC3 — the owner and the agent come ONLY from the CONNECTION (the input carries no
// identity field): the record belongs to the connection's person, its source is the
// connection's agent, and it never lands against any other person.
// ===========================================================================

test("save_record owns the record to the connection's person and never to another", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const me = await makePerson(db, "owner-me", keyWrapper);
    const other = await makePerson(db, "other-person", keyWrapper);
    const conn = connectionFor(me.userId);
    await grantRecords(db, me.userId, conn.connectionId);

    const tool = createSaveRecordTool(recordsDeps(db, keyWrapper, fixedClock(NOW)));
    await tool.handle({ kind: "subscription", fields: { service: "Routed by the connection, not the body" }, status: "active" }, conn);

    const mine = await listRecordsForUser(db, me.userId, me.dek);
    assert.equal(mine.length, 1, "the record is owned by the connection's person");
    assert.deepEqual(mine[0].source, { kind: "agent", agentId: conn.agentId }, "its source is the connection's agent");

    const theirs = await listRecordsForUser(db, other.userId, other.dek);
    assert.equal(theirs.length, 0, "nothing was written against any other person");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — a tool call cannot READ another person's records: the person comes from the
// connection, so one person's agent never sees another person's records.
// ===========================================================================

test("list_records never returns another person's records (userId comes from the connection)", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await makePerson(db, "person-a", keyWrapper);
    const b = await makePerson(db, "person-b", keyWrapper);

    const A_SERVICE = "Person A's private subscription";
    await createRecord(db, { userId: a.userId, kind: "subscription", fields: { service: A_SERVICE }, status: "active", source: { kind: "person" } }, a.dek);

    // B's agent is fully permitted FOR B, and asks — but B owns no records, and A's never cross.
    const bConn = connectionFor(b.userId);
    await grantRecords(db, b.userId, bConn.connectionId);

    const tool = createListRecordsTool(recordsDeps(db, keyWrapper, fixedClock(NOW)));
    const result = (await tool.handle({}, bConn)) as ListRecordsResult;

    assert.equal(result.status, "ok", "B's permitted agent gets a (possibly empty) list, not a refusal");
    const services = (result.records ?? []).map((r) => (r.fields ?? {}).service);
    assert.ok(!services.includes(A_SERVICE), "A's record never crosses to another person's agent");
    assert.equal((result.records ?? []).length, 0, "B has no records of their own, so the list is empty");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — a tool call cannot CHANGE another person's records: update_record on another
// person's record id is refused (NOT a throw) and leaves that record untouched.
// ===========================================================================

test("update_record cannot change another person's record", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const a = await makePerson(db, "owner-a", keyWrapper);
    const b = await makePerson(db, "intruder-b", keyWrapper);

    const A_SERVICE = "Person A's subscription";
    const aRecord = await createRecord(
      db,
      { userId: a.userId, kind: "subscription", fields: { service: A_SERVICE }, status: "active", source: { kind: "person" } },
      a.dek,
    );

    // B is a fully-permitted agent OF B — the only thing stopping them is the member scope.
    const bConn = connectionFor(b.userId);
    await grantRecords(db, b.userId, bConn.connectionId);
    const deps = recordsDeps(db, keyWrapper, fixedClock(NOW));

    const updated = (await createUpdateRecordTool(deps).handle(
      { id: aRecord.id, fields: { service: "Hijacked by B" }, status: "cancelled" },
      bConn,
    )) as UpdateRecordResult;
    assert.notEqual(updated.status, "updated", "B cannot update A's record");

    // A's record is exactly as A left it.
    const aRecords = await listRecordsForUser(db, a.userId, a.dek);
    assert.equal(aRecords.length, 1, "A still has their one record");
    assert.equal(aRecords[0].fields.service, A_SERVICE, "A's record fields are untouched by B");
    assert.equal(aRecords[0].status, "active", "A's record status is untouched by B");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — the three record tools are exposed to the agent through the core tool registry.
// ===========================================================================

test("the three record tools are exposed through the core tool registry", async () => {
  const registry = createToolRegistry({ pipeline: spyPipeline() });
  const coreNames = new Set(registry.coreTools.map((t) => t.name));

  for (const name of ["list_records", "save_record", "update_record"]) {
    assert.ok(coreNames.has(name), `${name} is one of the always-available core tools`);
    assert.ok(registry.get(name), `${name} is resolvable by name from the registry`);
  }
});

// ===========================================================================
// AC1 — the tool call is RECORDED. Routed through a real pipeline (the production path
// for a core tool), an allowed save_record executes (creates the record) and Warthog
// writes ONE `source:"warthog"` activity entry for the call.
// ===========================================================================

test("through the pipeline: an allowed save_record creates the record and records ONE Warthog entry", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const { userId, dek } = await makePerson(db, "pipe-save", keyWrapper);
    const conn = connectionFor(userId);
    await grantRecords(db, userId, conn.connectionId);

    const tool = createSaveRecordTool(recordsDeps(db, keyWrapper, fixedClock(NOW)));
    const rec = spyRecorder(fixedClock(NOW));
    let runs = 0;
    const pipeline = createAgentCallPipeline({
      db,
      keyWrapper,
      clock: fixedClock(NOW),
      rateLimiter: createRateLimiter(fixedClock(NOW)),
      recorder: rec.recorder,
      // The pipeline executes save_record by dispatching to the tool body, taking the
      // agent / person from the resolved connection it is handed — never from the body.
      executeTool: async (call: AgentCall, connection: AgentConnection) => {
        runs += 1;
        return tool.handle(call.params, connection);
      },
    });

    const call: AgentCall = {
      connector: null,
      tool: "save_record",
      makesChange: true,
      params: { kind: "subscription", fields: { service: "Found a forgotten subscription" }, status: "active" },
    };
    const outcome = expectExecuted(await pipeline.handleAgentCall(conn, call));
    const body = outcome.result as SaveRecordResult;
    assert.equal(body.status, "saved", "the allowed call saved the record");
    assert.equal(runs, 1, "the tool body ran exactly once");

    // The record really landed.
    const stored = await listRecordsForUser(db, userId, dek);
    assert.equal(stored.length, 1, "the record write persisted through the pipeline");

    // Warthog recorded the call itself — ONE entry, labelled source "warthog".
    const entries = rec.inputs.filter((e) => e.tool === "save_record");
    assert.equal(entries.length, 1, "the call is recorded as exactly ONE activity entry");
    assert.equal(entries[0].source, "warthog", "Warthog writes the record itself (not the agent)");
    assert.equal(entries[0].userId, userId, "the entry is scoped to the connection's person");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Envelope — the tools name themselves and carry the right input schema. save_record
// requires a `kind` (one of the three kinds) and a `fields` object; update_record
// requires a non-empty `id` and a `fields` object; every tool carries the universal
// OPTIONAL `reason` (design §6.2).
// ===========================================================================

test("the record tools are named and their input schemas require the right fields", async () => {
  const db = await freshDb();
  const keyWrapper = keyWrapperFor();
  try {
    const deps = recordsDeps(db, keyWrapper, fixedClock(NOW));
    const list = createListRecordsTool(deps);
    const save = createSaveRecordTool(deps);
    const update = createUpdateRecordTool(deps);

    assert.equal(list.name, "list_records", "the read tool names itself list_records");
    assert.equal(save.name, "save_record", "the save tool names itself save_record");
    assert.equal(update.name, "update_record", "the update tool names itself update_record");

    // Every tool carries the universal OPTIONAL `reason`.
    for (const tool of [list, save, update]) {
      const reason = subschema(tool.inputSchema, "reason");
      assert.ok(reason, `${tool.name} exposes a \`reason\` field`);
      assert.equal(reason!.safeParse(undefined).success, true, `\`reason\` is OPTIONAL on ${tool.name}`);
      assert.equal(reason!.safeParse(123).success, false, `\`reason\` rejects a non-string on ${tool.name}`);
    }

    // save_record: `kind` is REQUIRED and must be one of the three record kinds.
    const kind = subschema(save.inputSchema, "kind");
    assert.ok(kind, "save_record exposes a `kind` field");
    assert.equal(kind!.safeParse("subscription").success, true, "`kind` accepts a known kind");
    assert.equal(kind!.safeParse("receipt_warranty").success, true, "`kind` accepts receipt_warranty");
    assert.equal(kind!.safeParse("renewal_appointment").success, true, "`kind` accepts renewal_appointment");
    assert.equal(kind!.safeParse("not-a-kind").success, false, "`kind` rejects an unknown kind");
    assert.equal(kind!.safeParse(undefined).success, false, "`kind` is REQUIRED");

    // save_record: `fields` is REQUIRED and must be an object.
    const saveFields = subschema(save.inputSchema, "fields");
    assert.ok(saveFields, "save_record exposes a `fields` field");
    assert.equal(saveFields!.safeParse({ service: "Netflix" }).success, true, "`fields` accepts an object");
    assert.equal(saveFields!.safeParse(undefined).success, false, "`fields` is REQUIRED");
    assert.equal(saveFields!.safeParse("not an object").success, false, "`fields` rejects a non-object");
    assert.equal(saveFields!.safeParse(42).success, false, "`fields` rejects a number");

    // update_record: `id` is REQUIRED and must be a non-empty string; `fields` is an object.
    const id = subschema(update.inputSchema, "id");
    assert.ok(id, "update_record exposes an `id` field");
    assert.equal(id!.safeParse("record-1").success, true, "`id` accepts a non-empty string");
    assert.equal(id!.safeParse(undefined).success, false, "`id` is REQUIRED");
    assert.equal(id!.safeParse("").success, false, "`id` rejects the empty string");

    const updateFields = subschema(update.inputSchema, "fields");
    assert.ok(updateFields, "update_record exposes a `fields` field");
    assert.equal(updateFields!.safeParse({ service: "Netflix" }).success, true, "`fields` accepts an object");
    assert.equal(updateFields!.safeParse(undefined).success, false, "`fields` is REQUIRED on update_record (the agent resupplies the content)");
    assert.equal(updateFields!.safeParse(42).success, false, "`fields` rejects a number");
  } finally {
    await db.close();
  }
});

// --- small helpers ----------------------------------------------------------------

// Read a named sub-schema of the input's z.object `.shape` defensively (the schema
// exposes `.shape` at runtime). Returns undefined when absent, so a test asserts a
// HELPFUL failure rather than throwing.
function subschema(
  schema: unknown,
  field: string,
): { safeParse(v: unknown): { success: boolean } } | undefined {
  const shape = (schema as { shape?: Record<string, { safeParse(v: unknown): { success: boolean } }> } | null)
    ?.shape;
  return shape?.[field];
}
