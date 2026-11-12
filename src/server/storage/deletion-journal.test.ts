import assert from "node:assert/strict";
import { test } from "node:test";
import { azureJournalWriter, selectDeletionJournal } from "./deletion-journal";
import { createDeletionJournal } from "../account/deletion-journal";

test("journal upload is conditional and never overwrites an existing marker", async () => {
  let seen: unknown;
  const writer = azureJournalWriter(async () => ({ getBlockBlobClient: name => ({
    async uploadData(bytes, options) { seen = { name, body: Buffer.from(bytes).toString(), options }; },
  }) }));
  await writer.create("v1/example/requested.json", "{}");
  assert.deepEqual(seen, { name: "v1/example/requested.json", body: "{}", options: {
    conditions: { ifNoneMatch: "*" }, blobHTTPHeaders: { blobContentType: "application/json" },
  } });
});

test("only exact existing-blob responses acknowledge a conditional journal retry", async () => {
  for (const error of [
    { statusCode: 412, code: "ConditionNotMet" },
    { statusCode: 403, code: "UnauthorizedBlobOverwrite" },
    { statusCode: 403, code: "AuthorizationPermissionMismatch" },
    { statusCode: 403, code: "AuthorizationFailure" },
    { statusCode: 403, code: "AuthenticationFailed" },
    { statusCode: 403, code: "ConditionNotMet" },
    { statusCode: 412, code: "UnauthorizedBlobOverwrite" },
    { statusCode: 412, code: "LeaseIdMissing" },
    { statusCode: 409, code: "BlobAlreadyExists" },
    { statusCode: 409, code: "BlobImmutableDueToPolicy" },
    { statusCode: 500 }, new Error("private credential sentinel"), null,
  ]) {
    const writer = azureJournalWriter(async () => ({ getBlockBlobClient: () => ({ async uploadData() { throw error; } }) }));
    if (error && "statusCode" in error && (
      error.statusCode === 412 && error.code === "ConditionNotMet"
      || error.statusCode === 403 && error.code === "UnauthorizedBlobOverwrite"
    )) await writer.create("record", "{}");
    else await assert.rejects(writer.create("record", "{}"), /^Error: Deletion journal write failed$/);
  }
});

test("a client setup error cannot acknowledge a journal write that was never attempted", async () => {
  for (const error of [
    { statusCode: 412, code: "ConditionNotMet" },
    { statusCode: 403, code: "UnauthorizedBlobOverwrite" },
  ]) {
    const writer = azureJournalWriter(async () => { throw error; });
    await assert.rejects(writer.create("record", "{}"), /^Error: Deletion journal write failed$/);
  }
});

test("add-only Azure retries preserve first coverage and deletion timestamps across process restarts", async () => {
  const records = new Map<string, string>();
  let attempts = 0;
  const container = { getBlockBlobClient: (name: string) => ({
    async uploadData(bytes: Uint8Array, options: { conditions: { ifNoneMatch: string } }) {
      assert.equal(options.conditions.ifNoneMatch, "*");
      attempts++;
      if (records.has(name)) throw { statusCode: 403, code: "UnauthorizedBlobOverwrite" };
      records.set(name, Buffer.from(bytes).toString());
    },
  }) };
  const id = "11111111-1111-4111-8111-111111111111";
  for (const time of ["2026-11-12T00:00:00.000Z", "2026-11-12T00:01:00.000Z"]) {
    const journal = createDeletionJournal(azureJournalWriter(async () => container), () => new Date(time));
    await journal.initialize();
    await journal.requested(id);
    await journal.completed(id);
  }
  assert.equal(attempts, 6);
  assert.equal(records.size, 3);
  assert.deepEqual(JSON.parse(records.get("coverage.json")!), {
    version: 1, coverageFrom: "2026-11-12T00:00:00.000Z", retentionDays: 42,
  });
  for (const event of ["requested", "completed"]) {
    assert.deepEqual(JSON.parse(records.get(`v1/${id}/${event}.json`)!), {
      version: 1, userId: id, event, at: "2026-11-12T00:00:00.000Z",
    });
  }
});

test("production never falls back to an in-memory deletion journal", async () => {
  const journal = selectDeletionJournal({ nodeEnv: "production" });
  await assert.rejects(journal.requested("11111111-1111-4111-8111-111111111111"), /Deletion journal write failed/);
});

test("a lost upload response fails closed and a later retry acknowledges only the original marker", async () => {
  let stored: string | undefined;
  let attempts = 0;
  const writer = azureJournalWriter(async () => ({ getBlockBlobClient: () => ({
    async uploadData(bytes, options) {
      assert.equal(options.conditions.ifNoneMatch, "*");
      attempts++;
      if (stored !== undefined) throw { statusCode: 403, code: "UnauthorizedBlobOverwrite" };
      stored = Buffer.from(bytes).toString();
      throw new Error("transport closed after upload; private sentinel");
    },
  }) }));
  await assert.rejects(writer.create("coverage.json", "original"), /^Error: Deletion journal write failed$/);
  assert.equal(attempts, 1);
  await writer.create("coverage.json", "later retry");
  assert.equal(attempts, 2);
  assert.equal(stored, "original");
});
