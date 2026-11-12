import assert from "node:assert/strict";
import { test } from "node:test";
import { azureJournalWriter, selectDeletionJournal } from "./deletion-journal";

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

test("only a create precondition conflict counts as an acknowledged retry", async () => {
  for (const error of [
    { statusCode: 412, code: "ConditionNotMet" },
    { statusCode: 403, code: "AuthorizationPermissionMismatch" },
    { statusCode: 409, code: "BlobImmutableDueToPolicy" },
    { statusCode: 500 }, new Error("private credential sentinel"), null,
  ]) {
    const writer = azureJournalWriter(async () => ({ getBlockBlobClient: () => ({ async uploadData() { throw error; } }) }));
    if (error && "statusCode" in error && error.statusCode === 412) await writer.create("record", "{}");
    else await assert.rejects(writer.create("record", "{}"), /^Error: Deletion journal write failed$/);
  }
});

test("production never falls back to an in-memory deletion journal", async () => {
  const journal = selectDeletionJournal({ nodeEnv: "production" });
  await assert.rejects(journal.requested("11111111-1111-4111-8111-111111111111"), /Deletion journal write failed/);
});
