import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { freshDb } from "../../test/db";
import {
  createSkill,
  pageSkillsForAgent,
  pageSkillChoices,
  getSkillText,
} from "./skills";
import { createAgent } from "./agents";
import { setAgentSkillAccess } from "../agents/skill-access";
import { setAgentMemoryAccess } from "../agents/resource-access";
import { createUser } from "./users";
import { withTransaction } from "./index";
import { createMemory, pageMemories } from "./memories";
import { fixedClock } from "../seams/clock";
import { assertCollectionCapacity } from "./collection-limits";

test("keyset pages are bounded and do not duplicate same-time memories or expose foreign rows", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32),
      a = await createUser(db, {
        email: "pages-a@test.test",
        wrappedDek: "unused",
      }),
      b = await createUser(db, {
        email: "pages-b@test.test",
        wrappedDek: "unused",
      });
    const clock = fixedClock(new Date("2026-11-11T00:00:00Z"));
    for (let i = 0; i < 7; i++)
      await createMemory(
        db,
        {
          userId: a.id,
          content: `Memory ${i}`,
          scope: "shared",
          sourceAgentId: null,
        },
        dek,
        clock,
      );
    await createMemory(
      db,
      {
        userId: b.id,
        content: "Foreign",
        scope: "shared",
        sourceAgentId: null,
      },
      dek,
      clock,
    );
    const stored = (await pageMemories(db, a.id, dek)).items;
    // PostgreSQL timestamps carry microseconds; a JavaScript Date cursor loses them.
    for (let i = 0; i < stored.length; i++)
      await db.query("UPDATE memories SET created_at=$1 WHERE id=$2", [
        `2026-11-11T00:00:00.12345${i}Z`,
        stored[i]!.id,
      ]);
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await pageMemories(db, a.id, dek, { limit: 3, cursor });
      assert.ok(page.items.length <= 3);
      ids.push(...page.items.map((m) => m.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(ids.length, 7);
    assert.equal(new Set(ids).size, 7);
    await assert.rejects(() =>
      pageMemories(db, a.id, dek, { cursor: "invalid" }),
    );
  } finally {
    await db.close();
  }
});

test("collection quotas serialize concurrent creations and account for replacements", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32),
      user = await createUser(db, {
        email: "quota@test.test",
        wrappedDek: "unused",
      });
    const limits = { rows: 2, bytes: 4096 };
    const results = await Promise.allSettled(
      [1, 2, 3].map((i) =>
        withTransaction(db, async (tx) => {
          await assertCollectionCapacity(
            tx,
            user.id,
            "memories",
            100,
            undefined,
            limits,
          );
          return createMemory(
            tx,
            {
              userId: user.id,
              content: `Item ${i}`,
              scope: "kept",
              sourceAgentId: null,
            },
            dek,
            fixedClock(new Date()),
          );
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
    const id = (await pageMemories(db, user.id, dek)).items[0]!.id;
    await withTransaction(db, (tx) =>
      assertCollectionCapacity(tx, user.id, "memories", 10, id, limits),
    );
    await assert.rejects(
      () =>
        withTransaction(db, (tx) =>
          assertCollectionCapacity(tx, user.id, "memories", 5000, id, limits),
        ),
      /storage limit/,
    );
  } finally {
    await db.close();
  }
});

test("paged resources apply agent overrides and partial edits preserve another page", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32),
      user = await createUser(db, {
        email: "paged-grants@test.test",
        wrappedDek: "unused",
      });
    const clock = fixedClock(new Date("2026-11-11T00:00:00Z"));
    const agent = await createAgent(
      db,
      {
        userId: user.id,
        connectionId: randomUUID(),
        displayName: "Paged agent",
        platform: "Other",
      },
      clock,
    );
    const skills = [];
    for (let i = 0; i < 5; i++)
      skills.push(
        await createSkill(
          db,
          {
            userId: user.id,
            title: `Skill ${i}`,
            useThisWhen: "Testing",
            fullText: "Private instructions",
            scope: "all",
          },
          dek,
        ),
      );
    await setAgentSkillAccess(db, user.id, agent.id, [
      { id: skills[0]!.id, granted: false },
    ]);
    const first = await pageSkillChoices(db, user.id, agent.id, dek, {
      limit: 2,
    });
    const second = await pageSkillChoices(db, user.id, agent.id, dek, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    await setAgentSkillAccess(
      db,
      user.id,
      agent.id,
      first.items.map((s) => ({ id: s.id, granted: false })),
    );
    assert.deepEqual(
      (
        await pageSkillChoices(db, user.id, agent.id, dek, {
          limit: 2,
          cursor: first.nextCursor!,
        })
      ).items,
      second.items,
    );
    const visible = await pageSkillsForAgent(db, user.id, agent.id, dek, {
      limit: 2,
    });
    assert.ok(!visible.items.some((s) => s.id === skills[0]!.id));
    assert.ok(
      visible.items.every((s) => !first.items.some((x) => s.id === x.id)),
    );
    for (const skill of visible.items)
      assert.equal(
        await getSkillText(
          db,
          user.id,
          agent.id,
          skill.title,
          dek,
          undefined,
          skill.id,
        ),
        "Private instructions",
      );
    assert.equal(
      await getSkillText(
        db,
        user.id,
        agent.id,
        skills[0]!.title,
        dek,
        undefined,
        skills[0]!.id,
      ),
      null,
    );
    const own = await createMemory(
      db,
      {
        userId: user.id,
        content: "Private",
        scope: "kept",
        sourceAgentId: null,
      },
      dek,
      clock,
    );
    const shared = await createMemory(
      db,
      {
        userId: user.id,
        content: "Shared",
        scope: "shared",
        sourceAgentId: null,
      },
      dek,
      clock,
    );
    await setAgentMemoryAccess(db, user.id, agent.id, [
      { id: own.id, granted: true },
      { id: shared.id, granted: false },
    ]);
    assert.deepEqual(
      (
        await pageMemories(db, user.id, dek, { agentId: agent.id, limit: 1 })
      ).items.map((m) => m.id),
      [own.id],
    );
  } finally {
    await db.close();
  }
});
