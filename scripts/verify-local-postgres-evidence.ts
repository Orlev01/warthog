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
    await upsertPermissions(runtime, { ...initialGrants(user.id, agent.connectionId, { template: "standard" }), resourceControls: { tasksWrite: false, recordsWrite: false, recordIds: [] } });
    const grants = await getConnectionPermissions(runtime, user.id, agent.connectionId);
    assert.deepEqual(grants?.accounts, []);
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
    // The single-shot undo guard: the runtime role wins a claim once, may record the approval a
    // held undo waits on (approval_id only), releases it, and can never rewrite anything else.
    const claim = "INSERT INTO activity_undo_claims (user_id, entry_seq, claimed_at) VALUES ($1, $2, $3::timestamptz) ON CONFLICT DO NOTHING RETURNING entry_seq";
    const claimed = await Promise.all([0, 1].map(() => runtime.query(claim, [user.id, 1, clock.now().toISOString()])));
    assert.equal(claimed.filter((result) => result.rows.length === 1).length, 1, "exactly one concurrent undo claim wins");
    const heldBy = randomUUID();
    await runtime.query("UPDATE activity_undo_claims SET approval_id=$3 WHERE user_id=$1 AND entry_seq=$2", [user.id, 1, heldBy]);
    assert.equal(String((await runtime.query("SELECT approval_id FROM activity_undo_claims WHERE user_id=$1 AND entry_seq=$2", [user.id, 1])).rows[0]!.approval_id), heldBy);
    for (const column of ["claimed_at = claimed_at", "user_id = user_id", "entry_seq = entry_seq"]) {
      await assert.rejects(runtime.query(`UPDATE activity_undo_claims SET ${column} WHERE user_id=$1`, [user.id]), /permission denied/, column);
    }
    await runtime.query("DELETE FROM activity_undo_claims WHERE user_id=$1 AND entry_seq=$2 AND approval_id=$3", [user.id, 1, heldBy]);
    await runtime.query(claim, [user.id, 2, clock.now().toISOString()]);
    await purge.query("DELETE FROM users WHERE id=$1", [user.id]);
    for (const table of ["data_imports", "data_import_parts", "activity_undo_claims"]) assert.equal(Number((await runtime.query(`SELECT count(*) AS n FROM ${table} WHERE user_id=$1`, [user.id])).rows[0]!.n), 0);
    console.log("PostgreSQL evidence: runtime grants, encrypted client observations, tool/resource controls, concurrent idempotent import, single-shot undo claims and staging cascade passed.");
  } finally { await purge.query("DELETE FROM users WHERE id=$1", [user.id]); }
}
