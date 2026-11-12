import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../src/server/db/index";
import { createUser } from "../src/server/db/users";
import { createAgent } from "../src/server/db/agents";
import { initialGrants } from "../src/server/agents/initial-grants";
import { getConnectionPermissions, upsertPermissions } from "../src/server/db/agent-permissions";
import { createRedactingRecorder } from "../src/server/mcp/recorder";
import { rememberClient, readClientObservation } from "../src/server/mcp/client-observation";
import { emptyTransferDocument } from "../src/domain/transfer-parts";
import { importParts } from "../src/server/import/parts";

export async function verifyPostgresEvidence(runtime: Db, purge: Db) {
  const dek = randomBytes(32), clock = { now: () => new Date("2026-11-12T00:00:00Z") };
  const user = await createUser(runtime, { email: `pg-evidence-${randomUUID()}@example.test`, wrappedDek: "synthetic" });
  try {
    const agent = await createAgent(runtime, { userId: user.id, connectionId: randomUUID(), displayName: "Evidence", platform: "other" }, clock);
    await upsertPermissions(runtime, { ...initialGrants(user.id, agent.connectionId, { template: "standard" }), connectorPolicies: { "google-gmail": { allowedTools: ["google-gmail__search"] } }, resourceControls: { tasksWrite: false, recordsWrite: false, recordIds: [] } });
    const grants = await getConnectionPermissions(runtime, user.id, agent.connectionId);
    assert.deepEqual(grants?.connectorPolicies?.["google-gmail"]?.allowedTools, ["google-gmail__search"]);
    assert.deepEqual(grants?.resourceControls, { tasksWrite: false, recordsWrite: false, recordIds: [] });
    await rememberClient(runtime, { userId: user.id, agentId: agent.id, connectionId: agent.connectionId, active: true }, { name: "Synthetic client", source: "client_reported" }, clock.now().toISOString(), dek, createRedactingRecorder({ db: runtime, clock, dekFor: async () => dek }));
    assert.equal((await readClientObservation(runtime, user.id, agent.id, dek))?.name, "Synthetic client");
    assert.doesNotMatch(String((await runtime.query("SELECT client_observation_ct FROM agents WHERE user_id=$1", [user.id])).rows[0]!.client_observation_ct), /Synthetic client/);
    const document = emptyTransferDocument(clock.now().toISOString()); document.memory = [{ content: "Import exactly once", scope: "shared" }];
    const id = (await importParts(runtime, user.id, { operation: "begin", partCount: 1 }, dek, clock)).id!;
    await Promise.all([0, 1].map(() => importParts(runtime, user.id, { operation: "part", id, seq: 0, part: { document } }, dek, clock)));
    await Promise.all([0, 1].map(() => importParts(runtime, user.id, { operation: "commit", id }, dek, clock)));
    assert.equal(Number((await runtime.query("SELECT count(*) AS n FROM memories WHERE user_id=$1", [user.id])).rows[0]!.n), 1);
    const pending = (await importParts(runtime, user.id, { operation: "begin", partCount: 1 }, dek, clock)).id!;
    await importParts(runtime, user.id, { operation: "part", id: pending, seq: 0, part: { document } }, dek, clock);
    await purge.query("DELETE FROM users WHERE id=$1", [user.id]);
    for (const table of ["data_imports", "data_import_parts"]) assert.equal(Number((await runtime.query(`SELECT count(*) AS n FROM ${table} WHERE user_id=$1`, [user.id])).rows[0]!.n), 0);
    console.log("PostgreSQL evidence: runtime grants, encrypted client observations, tool/resource controls, concurrent idempotent import and staging cascade passed.");
  } finally { await purge.query("DELETE FROM users WHERE id=$1", [user.id]); }
}
