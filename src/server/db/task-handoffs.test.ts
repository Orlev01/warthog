import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { freshDb } from "../../test/db";
import { createUser } from "./users";
import { createAgent } from "./agents";
import { systemClock } from "../seams/clock";
import { createTask, addNote, listTasksForUser, updateTask } from "./tasks";
import { validTaskAssignee, changeTaskAsAgent } from "./task-handoffs";

test("task assignees must be connected agents owned by the task owner", async () => {
  const db = await freshDb();
  try {
    const a = await createUser(db, {
      email: "a@tasks.test",
      wrappedDek: "unused",
    });
    const b = await createUser(db, {
      email: "b@tasks.test",
      wrappedDek: "unused",
    });
    const agent = await createAgent(
      db,
      {
        userId: a.id,
        connectionId: randomUUID(),
        displayName: "A",
        platform: "Other",
      },
      systemClock,
    );
    assert.equal(await validTaskAssignee(db, a.id, "any"), true);
    assert.equal(await validTaskAssignee(db, a.id, agent.id), true);
    assert.equal(await validTaskAssignee(db, b.id, agent.id), false);
    assert.equal(await validTaskAssignee(db, a.id, randomUUID()), false);
    assert.equal(await validTaskAssignee(db, a.id, "invalid' id"), false);
    await db.query("UPDATE agents SET status = 'disconnected' WHERE id = $1", [
      agent.id,
    ]);
    assert.equal(await validTaskAssignee(db, a.id, agent.id), false);
  } finally {
    await db.close();
  }
});

test("concurrent note appends preserve every note", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32),
      user = await createUser(db, {
        email: "notes@tasks.test",
        wrappedDek: "unused",
      });
    const task = await createTask(
      db,
      {
        userId: user.id,
        title: "Notes",
        assignee: "any",
        createdBy: { kind: "person" },
      },
      dek,
    );
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        addNote(
          db,
          {
            userId: user.id,
            id: task.id,
            author: { kind: "person" },
            text: `Note ${i}`,
          },
          dek,
        ),
      ),
    );
    assert.equal(
      (await listTasksForUser(db, user.id, dek))[0]!.notes.length,
      8,
    );
  } finally {
    await db.close();
  }
});

test("shared task changes claim atomically, renew, expire and yield to the owner", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32),
      user = await createUser(db, {
        email: "claims@tasks.test",
        wrappedDek: "unused",
      });
    const task = await createTask(
      db,
      {
        userId: user.id,
        title: "Claim",
        assignee: "any",
        createdBy: { kind: "person" },
      },
      dek,
    );
    const now = new Date("2026-11-11T00:00:00Z"),
      a = randomUUID(),
      b = randomUUID();
    const input = {
      userId: user.id,
      id: task.id,
      status: "in_progress" as const,
    };
    const results = await Promise.all(
      [a, b].map((agentId) =>
        changeTaskAsAgent(db, { ...input, agentId }, dek, now),
      ),
    );
    assert.equal(results.filter(Boolean).length, 1);
    const winner = results[0] ? a : b,
      loser = winner === a ? b : a;
    assert.equal(
      await changeTaskAsAgent(
        db,
        { ...input, agentId: loser, note: "lost" },
        dek,
        now,
      ),
      null,
    );
    assert.ok(
      await changeTaskAsAgent(
        db,
        { ...input, agentId: winner, note: "renewed" },
        dek,
        new Date(+now + 60_000),
      ),
    );
    assert.ok(
      await changeTaskAsAgent(
        db,
        { ...input, agentId: loser, note: "after expiry" },
        dek,
        new Date(+now + 700_000),
      ),
    );
    await updateTask(
      db,
      {
        userId: user.id,
        id: task.id,
        title: "Reassigned",
        assignee: winner,
        status: "open",
      },
      dek,
    );
    assert.equal(
      await changeTaskAsAgent(
        db,
        { ...input, agentId: loser, status: "done" },
        dek,
        new Date(+now + 800_000),
      ),
      null,
    );
    assert.ok(
      await changeTaskAsAgent(
        db,
        { ...input, agentId: winner, status: "done" },
        dek,
        new Date(+now + 800_000),
      ),
    );
    assert.deepEqual(
      (await listTasksForUser(db, user.id, dek))[0]!.notes.map((n) => n.text),
      ["renewed", "after expiry"],
    );
  } finally {
    await db.close();
  }
});
