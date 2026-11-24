import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { withTransaction, type Db } from "../src/server/db/index";
import { createUser } from "../src/server/db/users";
import { createAgent } from "../src/server/db/agents";
import { createTask, listTasksForUser } from "../src/server/db/tasks";
import { changeTaskAsAgent } from "../src/server/db/task-handoffs";
import { createMemory, pageMemories } from "../src/server/db/memories";
import { assertCollectionCapacity } from "../src/server/db/collection-limits";
import { savePackage, getPackage } from "../src/server/db/skill-packages";
import { getSkillText } from "../src/server/db/skills";
import { setAgentSkillAccess } from "../src/server/agents/skill-access";
import { setAgentMemoryAccess } from "../src/server/agents/resource-access";
import { initialGrants } from "../src/server/agents/initial-grants";
import {
  upsertPermissions,
  getConnectionPermissions,
} from "../src/server/db/agent-permissions";
import { makeSkillFile } from "../src/domain/skills/package";

/** Actual PostgreSQL roles, row locks and additive migration behavior. Synthetic data only. */
export async function verifyPostgresAgentControls(runtime: Db, purge: Db) {
  const user = await createUser(runtime, {
    email: `pg-agent-${randomUUID()}@example.test`,
    wrappedDek: "synthetic",
  });
  const dek = randomBytes(32),
    clock = { now: () => new Date("2026-11-11T00:00:00Z") };
  try {
    const agents = await Promise.all(
      ["A", "B"].map((displayName) =>
        createAgent(
          runtime,
          {
            userId: user.id,
            connectionId: randomUUID(),
            displayName,
            platform: "Other",
          },
          clock,
        ),
      ),
    );
    const [a, b] = agents;
    assert.ok(a && b);
    await upsertPermissions(runtime, {
      ...initialGrants(user.id, a.connectionId, { template: "standard" }),
      identityFields: [],
      accounts: [],
    });
    const grants = await getConnectionPermissions(
      runtime,
      user.id,
      a.connectionId,
    );
    assert.deepEqual(grants?.identityFields, []);
    assert.deepEqual(grants?.accounts, []);

    const task = await createTask(
      runtime,
      {
        userId: user.id,
        title: "Concurrent hand-off",
        assignee: "any",
        createdBy: { kind: "person" },
      },
      dek,
    );
    const claims = await Promise.all(
      agents.map((agent) =>
        changeTaskAsAgent(
          runtime,
          {
            userId: user.id,
            agentId: agent.id,
            id: task.id,
            status: "in_progress",
            note: agent.displayName,
          },
          dek,
          clock.now(),
        ),
      ),
    );
    assert.equal(
      claims.filter(Boolean).length,
      1,
      "one concurrent claimant wins",
    );
    assert.equal(
      (await listTasksForUser(runtime, user.id, dek)).find(t => t.id === task.id)?.notes.length,
      1,
    );

    const attempts = await Promise.allSettled(
      [1, 2, 3].map((i) =>
        withTransaction(runtime, async (tx) => {
          await assertCollectionCapacity(
            tx,
            user.id,
            "memories",
            100,
            undefined,
            { rows: 2, bytes: 4096 },
          );
          return createMemory(
            tx,
            {
              userId: user.id,
              content: `Memory ${i}`,
              sourceAgentId: null,
              scope: "kept",
            },
            dek,
            clock,
          );
        }),
      ),
    );
    assert.equal(
      attempts.filter((r) => r.status === "fulfilled").length,
      2,
      "owner lock prevents quota races",
    );
    const memory = (await pageMemories(runtime, user.id, dek)).items[0]!;
    assert.equal(
      await setAgentMemoryAccess(runtime, user.id, a.id, [
        { id: memory.id, granted: true },
      ]),
      true,
    );
    assert.deepEqual(
      (await pageMemories(runtime, user.id, dek, { agentId: a.id })).items.map(
        (m) => m.id,
      ),
      [memory.id],
    );
    assert.equal(
      (await pageMemories(runtime, user.id, dek, { agentId: b.id })).items
        .length,
      0,
    );

    const files = [
      {
        path: "SKILL.md",
        content: makeSkillFile(
          "PG integration",
          "When testing",
          "Read references/example.md",
        ),
      },
      { path: "references/example.md", content: "Supporting instructions" },
    ];
    const pack = await savePackage(runtime, user.id, { files }, dek);
    const skillId = pack.members[0]!.skillId;
    await runtime.query(
      "UPDATE skills SET enabled=true WHERE user_id=$1 AND id=$2",
      [user.id, skillId],
    );
    await setAgentSkillAccess(runtime, user.id, a.id, [
      { id: skillId, granted: true },
    ]);
    await setAgentSkillAccess(runtime, user.id, b.id, [
      { id: skillId, granted: false },
    ]);
    assert.equal(
      await getSkillText(
        runtime,
        user.id,
        a.id,
        "PG integration",
        dek,
        "references/example.md",
        skillId,
      ),
      "Supporting instructions",
    );
    assert.equal(
      await getSkillText(
        runtime,
        user.id,
        b.id,
        "PG integration",
        dek,
        "references/example.md",
        skillId,
      ),
      null,
    );
    const edits = await Promise.allSettled(
      [1, 2].map(() =>
        savePackage(
          runtime,
          user.id,
          { id: pack.id, revision: pack.revision, files },
          dek,
        ),
      ),
    );
    assert.equal(
      edits.filter((r) => r.status === "fulfilled").length,
      1,
      "optimistic package revision serializes",
    );
    assert.deepEqual(
      (await getPackage(runtime, user.id, pack.id, dek))?.files,
      files,
    );

    await runtime.query(
      "INSERT INTO provider_mcp_flows(id,user_id,session_id,state_hash,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
      [
        randomUUID(),
        user.id,
        randomUUID(),
        randomUUID(),
        "synthetic-envelope",
        clock.now(),
      ],
    );
    await purge.query("DELETE FROM users WHERE id=$1", [user.id]);
    for (const table of [
      "agent_memory_access",
      "agent_skill_access",
      "skill_packages",
      "skill_package_members",
      "provider_mcp_flows",
    ]) {
      assert.equal(
        (
          await runtime.query(`SELECT user_id FROM ${table} WHERE user_id=$1`, [
            user.id,
          ])
        ).rows.length,
        0,
      );
    }
    console.log(
      "PostgreSQL agent controls: runtime grants, concurrent claims/quotas, audiences, package revisions/files and cascade purge passed.",
    );
  } finally {
    await purge.query("DELETE FROM users WHERE id=$1", [user.id]);
  }
}
