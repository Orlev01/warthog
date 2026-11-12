// E14-S04 — Tasks store (`src/server/db/tasks.ts`, `db/migrations/0035_tasks.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./tasks` fails and `freshDb()` has no `tasks` table — every test here fails until the builder
// adds them. That absence IS the point of test-first; do NOT implement anything to make these
// pass — the builder writes the module and the migration afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: the stored task, the owner
// list-all read, the agent-scoped read, the DEK-encrypted title and notes that round-trip only
// under the owner's key, the plaintext status/assignee/created-by metadata, who may read/write
// what, what a handler rejects, that every value is bound as a parameter), never the source text
// of the module or the SQL file — a later rename that preserves behaviour must not redden them.
//
// WHY this exists (task E14-S04; brief §"Tasks and hand-offs": a task list the person and agents
// share — the person (or an agent) creates a task, assigns it to a specific agent or "any agent",
// and agents pick it up, add notes and mark it done; this is how one agent's findings are handed
// to another agent to act on). A task's TITLE and NOTES are PERSONAL CONTENT, so they are stored
// only DEK-ENCRYPTED (`../crypto/envelope`, design §4.1 — "every personal-content column … tasks"):
// the row id is generated up front so each envelope's associated data binds the ciphertext to its
// exact (table, column, row), and the plaintext title/notes never land in a column. The ASSIGNEE
// (a specific agent id or 'any'), the STATUS (open|in_progress|done) and the CREATED-BY (person|
// agent) stay PLAINTEXT metadata (design §4.1) so the owner list and the agent-scoped read can
// filter WITHOUT decrypting another person's data.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type TaskStatus = "open" | "in_progress" | "done";   // PLAINTEXT metadata
//
//   type TaskActor =                     // who created a task / authored a note (plaintext metadata)
//     | { kind: "person" }               // the signed-in person
//     | { kind: "agent"; agentId: string };  // a connected agent (opaque id, like activity.agent_id)
//
//   interface TaskNote {                 // one note on a task — part of the DEK-ENCRYPTED notes blob
//     author: TaskActor;                 // who wrote it
//     text: string;                      // the note body
//   }
//
//   interface NewTask {                  // what createTask records
//     userId: string;                    // the OWNER (the session's / connection's id, NEVER a client value)
//     title: string;                     // the task title — stored DEK-ENCRYPTED
//     notes?: TaskNote[];                // the notes — stored DEK-ENCRYPTED; DEFAULTS to []
//     assignee: string;                  // "any" OR a specific agent id — PLAINTEXT metadata
//     status?: TaskStatus;               // DEFAULTS to "open" — PLAINTEXT metadata
//     createdBy: TaskActor;              // person | agent — PLAINTEXT metadata
//   }
//
//   interface Task {                     // a task as handed back to its owner / assigned agent
//     id: string; userId: string;
//     title: string;                     // decrypted on read
//     notes: TaskNote[];                 // decrypted on read
//     assignee: string; status: TaskStatus; createdBy: TaskActor;
//   }
//
//   createTask(db, input: NewTask, dek): Promise<Task>
//     • generates the id up front (so the title/notes envelopes bind to the row), stores the
//       title and notes DEK-encrypted plus the plaintext metadata (assignee, status — defaulting
//       to "open" — createdBy; notes defaulting to []), and returns the task assembled from its
//       inputs (no dependency on a RETURNING read).
//   listTasksForUser(db, userId, dek): Promise<Task[]>
//     • ALL of `userId`'s tasks (member-scoped: user_id bound), each title/notes DECRYPTED under
//       the owner's `dek`; never another person's. Empty array when the person has none.
//   tasksForAgent(db, userId, agentId, dek): Promise<Task[]>
//     • the AGENT-SCOPED read: the owner's tasks whose assignee is this `agentId` OR "any"
//       (member-scoped by user_id AND filtered by assignee), DECRYPTED. NEVER another person's
//       tasks, and NEVER a task assigned to a different specific agent.
//   updateTask(db, input: { userId, id, title, assignee, status }, dek): Promise<Task>
//     • MEMBER-SCOPED (WHERE id AND user_id bound): re-encrypts the title and updates the
//       plaintext metadata (assignee, status) for the owner's own task; LEAVES the notes
//       untouched; THROWS when no such task belongs to this user.
//   addNote(db, input: { userId, id, author, text }, dek): Promise<Task>
//     • MEMBER-SCOPED: APPENDS one note (author + text) to the owner's own task's notes, keeping
//       the existing notes; re-encrypts the notes blob; THROWS when no such task belongs to this
//       user. Returns the task with the note appended.
//   completeTask(db, input: { userId, id }): Promise<boolean>
//     • MEMBER-SCOPED (WHERE id AND user_id bound): marks the owner's own task's status "done".
//       DEK-FREE (status is plaintext metadata, so no title/notes are touched). Returns true when
//       it marked one, false when none matched — so one person can never complete another's task.
//
// Acceptance criteria → tests:
//   AC1 "Creating a task stores its title and notes DEK-encrypted with the assignee and status as
//        plaintext metadata, and listTasksForUser returns the owner's tasks." — createTask returns
//        the id and the recorded metadata; the plaintext title/notes never appear in a raw column
//        (encrypted at rest) yet round-trip under the owner's DEK; listTasksForUser returns all of
//        the owner's tasks decrypted.
//   AC2 "tasksForAgent returns only tasks assigned to that agent or to 'any' (never another
//        person's tasks), and completeTask marks a task done; add-note appends an agent's note." —
//        tasksForAgent returns the owner's tasks assigned to the agent or "any" (not to another
//        specific agent, not another person's); completeTask flips status to "done"; addNote
//        appends a note that round-trips decrypted.
//   AC3 "A user cannot read or change another user's tasks (filtered by session user id)." — B
//        never sees A's tasks in a list or an agent-scoped read; updateTask / addNote refuse
//        another person's task; completeTask on another person's task changes nothing; a handler
//        takes the owner from the SESSION, so a userId smuggled in the body never writes under
//        another person.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed input
//        with a 4xx before any query runs; a SQL-injection probe routed through the repo travels
//        as a BOUND value (placeholders, never concatenation) and cannot drop the table. The
//        handler below is a test fixture (the intended usage), not an implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — enforced by construction: the repo takes `db`
//        and the `dek` as injected dependencies, holds no key and reads no `process.env`. Shown
//        behaviourally: the title/notes are encrypted under the INJECTED dek (a different dek
//        cannot read them back — not a baked-in secret), and a decoy secret planted in the
//        environment never lands in a stored or returned task.
//   Migration: the `tasks` relation exists after the project migrations and a second run of every
//        migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db test
// uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so tests share
// no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import {
  createTask,
  listTasksForUser,
  tasksForAgent,
  updateTask,
  addNote,
  completeTask,
} from "./tasks";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a layer up; this
// repo only ever receives the already-unwrapped bytes.
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque base64; this module never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A db seam stand-in that records every call instead of running it, so a test can prove WHAT
// reached the query layer and HOW (bound value vs. spliced text). It returns no rows and satisfies
// the `Db` shape structurally (query + close).
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the relation
// name when it exists and NULL when it does not — a non-throwing probe scoped to the one table
// under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Assert a probe reached the query layer as a BOUND value and never as spliced SQL text, scoped to
// each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// A structural view of a returned task / note, so the helpers below do not depend on the (absent)
// module's exported types at the point they run.
interface TaskNoteLike {
  readonly author: { readonly kind: string; readonly agentId?: string };
  readonly text: string;
}
interface TaskLike {
  readonly id: string;
  readonly userId: string;
  readonly title: string;
  readonly notes: TaskNoteLike[];
  readonly assignee: string;
  readonly status: string;
  readonly createdBy: { readonly kind: string; readonly agentId?: string };
}

// Find the one listed task carrying this exact decrypted title (list order is not pinned).
function taskWithTitle(tasks: TaskLike[], title: string): TaskLike | undefined {
  return tasks.find((t) => t.title === title);
}

// ===========================================================================
// AC1 — creating a task (title + notes DEK-encrypted, metadata plaintext);
// listTasksForUser returns all of the owner's tasks decrypted.
// ===========================================================================

test("createTask returns a task with an id and the recorded title, assignee, status and created-by", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const dek = freshDek();

    const saved = (await createTask(
      db,
      {
        userId,
        title: "Book flights to Sydney",
        assignee: "agent-claude-1",
        status: "open",
        createdBy: { kind: "person" },
      },
      dek,
    )) as TaskLike;

    assert.equal(typeof saved.id, "string", "createTask returns an id string");
    assert.ok(saved.id.length > 0, "the returned id is non-empty");
    assert.equal(saved.userId, userId, "the task belongs to the creating person");
    assert.equal(saved.title, "Book flights to Sydney", "the title is recorded");
    assert.equal(saved.assignee, "agent-claude-1", "the assignee is recorded");
    assert.equal(saved.status, "open", "the status is recorded");
    assert.equal(saved.createdBy.kind, "person", "the created-by actor is recorded");
    assert.deepEqual(saved.notes, [], "a task created without notes starts with none");
  } finally {
    await db.close();
  }
});

test("createTask defaults the status to 'open' when none is given", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-default-status");
    const dek = freshDek();

    const saved = (await createTask(
      db,
      { userId, title: "Draft the itinerary", assignee: "any", createdBy: { kind: "person" } },
      dek,
    )) as TaskLike;

    assert.equal(saved.status, "open", "a task created without a status is open");
  } finally {
    await db.close();
  }
});

test("createTask gives each task a distinct id", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-ids");
    const dek = freshDek();
    const one = (await createTask(
      db,
      { userId, title: "A", assignee: "any", createdBy: { kind: "person" } },
      dek,
    )) as TaskLike;
    const two = (await createTask(
      db,
      { userId, title: "B", assignee: "any", createdBy: { kind: "person" } },
      dek,
    )) as TaskLike;
    assert.notEqual(one.id, two.id, "two saved tasks have different ids");
  } finally {
    await db.close();
  }
});

test("an agent-created task records its created-by agent id as plaintext metadata", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-agentcreated");
    const dek = freshDek();

    await createTask(
      db,
      {
        userId,
        title: "Shortlist hotels near the venue",
        assignee: "any",
        createdBy: { kind: "agent", agentId: "agent-research-7" },
      },
      dek,
    );

    const tasks = (await listTasksForUser(db, userId, dek)) as TaskLike[];
    assert.equal(tasks.length, 1, "the agent-created task is listed");
    assert.equal(tasks[0]!.createdBy.kind, "agent", "its created-by is an agent");
    assert.equal(tasks[0]!.createdBy.agentId, "agent-research-7", "with the exact agent id");
  } finally {
    await db.close();
  }
});

test("the title and notes are stored DEK-encrypted: the plaintext never appears in a raw column", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-atrest");
    const dek = freshDek();
    // Unique markers placed INSIDE the encrypted title and note (the metadata columns — assignee,
    // status, created-by — are deliberately plaintext, so the markers must live only there).
    const titleSecret = "LEAKCHECK_task_title_9x7Q confidential merger plan";
    const noteSecret = "LEAKCHECK_task_note_4b2K bank login is user/secret.example";

    const saved = (await createTask(
      db,
      { userId, title: titleSecret, assignee: "agent-claude-1", createdBy: { kind: "person" } },
      dek,
    )) as TaskLike;
    await addNote(
      db,
      { userId, id: saved.id, author: { kind: "agent", agentId: "agent-claude-1" }, text: noteSecret },
      dek,
    );

    // Scan every cell of the one table under test. Each value is unique and lives only in an
    // encrypted column, so any raw occurrence is a genuine plaintext leak. Scoped to `tasks`
    // alone — the same value may legitimately live (encrypted) elsewhere.
    const all = await db.query("SELECT * FROM tasks");
    assert.ok(all.rows.length >= 1, "the task row was stored");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(titleSecret), "the plaintext title must never be written to a column");
          assert.ok(!cell.includes(noteSecret), "the plaintext note must never be written to a column");
        }
      }
    }
  } finally {
    await db.close();
  }
});

test("listTasksForUser round-trips the stored title and notes decrypted under the owner's DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-roundtrip");
    const dek = freshDek();

    const saved = (await createTask(
      db,
      {
        userId,
        title: "Compare travel options",
        notes: [{ author: { kind: "person" }, text: "Prefer a morning departure" }],
        assignee: "agent-claude-1",
        status: "in_progress",
        createdBy: { kind: "person" },
      },
      dek,
    )) as TaskLike;

    const tasks = (await listTasksForUser(db, userId, dek)) as TaskLike[];
    assert.equal(tasks.length, 1, "the owner's one task is listed");
    assert.equal(tasks[0]!.id, saved.id, "the listed task is the one saved");
    assert.equal(tasks[0]!.title, "Compare travel options", "the title decrypts back to what was stored");
    assert.equal(tasks[0]!.status, "in_progress", "the status round-trips");
    assert.equal(tasks[0]!.assignee, "agent-claude-1", "the assignee round-trips");
    assert.equal(tasks[0]!.notes.length, 1, "the initial note round-trips");
    assert.equal(tasks[0]!.notes[0]!.text, "Prefer a morning departure", "the note text decrypts");
    assert.equal(tasks[0]!.notes[0]!.author.kind, "person", "the note author round-trips");
  } finally {
    await db.close();
  }
});

test("listTasksForUser returns every one of the owner's tasks, decrypted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-list");
    const dek = freshDek();

    await createTask(db, { userId, title: "One", assignee: "any", createdBy: { kind: "person" } }, dek);
    await createTask(db, { userId, title: "Two", assignee: "agent-a", status: "in_progress", createdBy: { kind: "person" } }, dek);
    await createTask(db, { userId, title: "Three", assignee: "agent-b", createdBy: { kind: "agent", agentId: "agent-b" } }, dek);

    const tasks = (await listTasksForUser(db, userId, dek)) as TaskLike[];
    assert.equal(tasks.length, 3, "all three of the owner's tasks are listed");
    for (const t of tasks) {
      assert.equal(t.userId, userId, "every listed task belongs to the owner");
    }
    const titles = new Set(tasks.map((t) => t.title));
    assert.ok(titles.has("One") && titles.has("Two") && titles.has("Three"), "every title decrypts");
  } finally {
    await db.close();
  }
});

test("listTasksForUser returns an empty array for a person with no tasks", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-empty");
    const tasks = await listTasksForUser(db, userId, freshDek());
    assert.deepEqual(tasks, [], "a person with no tasks gets an empty list");
  } finally {
    await db.close();
  }
});

// The Tasks view groups the list by status but keeps the order inside each group, so the
// owner list-all must come back in a stable order: oldest first, then by id for tasks
// created at the same instant — never whatever order the heap happens to return after an
// update moved a row.
test("listTasksForUser returns the owner's tasks oldest first, ties broken by id, even after updates", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "order");
    const dek = freshDek();
    const created: { id: string; title: string }[] = [];
    for (const title of ["Newest", "Oldest", "Tie A", "Tie B"]) {
      const task = await createTask(db, { userId, title, assignee: "any", createdBy: { kind: "person" } }, dek);
      created.push({ id: task.id, title });
    }
    const at: Record<string, string> = {
      Newest: "2026-11-03T00:00:00Z",
      Oldest: "2026-11-01T00:00:00Z",
      "Tie A": "2026-11-02T00:00:00Z",
      "Tie B": "2026-11-02T00:00:00Z",
    };
    for (const task of created) {
      await db.query("UPDATE tasks SET created_at = $1 WHERE id = $2", [at[task.title], task.id]);
    }
    // Touch the oldest so its row version moves in the heap.
    const oldest = created.find((t) => t.title === "Oldest")!;
    await completeTask(db, { userId, id: oldest.id });

    const ties = created.filter((t) => t.title.startsWith("Tie")).sort((a, b) => (a.id < b.id ? -1 : 1));
    const expected = ["Oldest", ...ties.map((t) => t.title), "Newest"];
    const titles = (await listTasksForUser(db, userId, dek)).map((t) => t.title);
    assert.deepEqual(titles, expected);
    assert.deepEqual((await listTasksForUser(db, userId, dek)).map((t) => t.title), expected, "the order repeats");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — the agent-scoped read; completeTask; add-note.
// ===========================================================================

test("tasksForAgent returns the owner's tasks assigned to that agent or to 'any', decrypted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-foragent");
    const dek = freshDek();

    const mine = (await createTask(db, { userId, title: "Assigned to me", assignee: "agent-claude-1", createdBy: { kind: "person" } }, dek)) as TaskLike;
    const anyOne = (await createTask(db, { userId, title: "Anyone can take", assignee: "any", createdBy: { kind: "person" } }, dek)) as TaskLike;
    const other = (await createTask(db, { userId, title: "For another agent", assignee: "agent-other-2", createdBy: { kind: "person" } }, dek)) as TaskLike;

    const forAgent = (await tasksForAgent(db, userId, "agent-claude-1", dek)) as TaskLike[];
    const ids = new Set(forAgent.map((t) => t.id));
    assert.ok(ids.has(mine.id), "a task assigned to this agent is returned");
    assert.ok(ids.has(anyOne.id), "a task assigned to 'any' is returned");
    assert.ok(!ids.has(other.id), "a task assigned to a DIFFERENT specific agent is NOT returned");
    assert.equal(forAgent.length, 2, "exactly the agent's task and the 'any' task are returned");

    // The agent-scoped read decrypts the content it hands the agent to act on.
    assert.equal(taskWithTitle(forAgent, "Assigned to me")!.title, "Assigned to me", "its title decrypts");
    assert.equal(taskWithTitle(forAgent, "Anyone can take")!.assignee, "any", "the 'any' task's assignee is plaintext");
  } finally {
    await db.close();
  }
});

test("tasksForAgent never returns another person's tasks (even for the same agent id or 'any')", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac2-alice");
    const bob = await makeUser(db, "ac2-bob");
    const dek = freshDek();

    // Bob has a task assigned to the SAME agent-id string and a task assigned to "any".
    await createTask(db, { userId: bob, title: "Bob's agent task", assignee: "agent-shared", createdBy: { kind: "person" } }, dek);
    await createTask(db, { userId: bob, title: "Bob's any task", assignee: "any", createdBy: { kind: "person" } }, dek);
    // Alice has one of each.
    const aliceAgent = (await createTask(db, { userId: alice, title: "Alice's agent task", assignee: "agent-shared", createdBy: { kind: "person" } }, dek)) as TaskLike;
    const aliceAny = (await createTask(db, { userId: alice, title: "Alice's any task", assignee: "any", createdBy: { kind: "person" } }, dek)) as TaskLike;

    const forAlicesAgent = (await tasksForAgent(db, alice, "agent-shared", dek)) as TaskLike[];
    const ids = new Set(forAlicesAgent.map((t) => t.id));
    assert.equal(forAlicesAgent.length, 2, "only Alice's own agent-and-any tasks are returned");
    assert.ok(ids.has(aliceAgent.id) && ids.has(aliceAny.id), "both of Alice's are returned");
    assert.ok(!forAlicesAgent.some((t) => t.userId === bob), "none of Bob's tasks appear (member-scoped by owner)");
    assert.ok(!taskWithTitle(forAlicesAgent, "Bob's agent task"), "Bob's same-id task never appears");
    assert.ok(!taskWithTitle(forAlicesAgent, "Bob's any task"), "Bob's 'any' task never appears");
  } finally {
    await db.close();
  }
});

test("completeTask marks the owner's task done and returns true", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-complete");
    const dek = freshDek();

    const saved = (await createTask(db, { userId, title: "Finish me", assignee: "any", createdBy: { kind: "person" } }, dek)) as TaskLike;
    assert.equal(saved.status, "open", "it starts open");

    const marked = await completeTask(db, { userId, id: saved.id });
    assert.equal(marked, true, "completeTask reports it marked a task");

    const tasks = (await listTasksForUser(db, userId, dek)) as TaskLike[];
    assert.equal(tasks[0]!.status, "done", "the task is now done");
  } finally {
    await db.close();
  }
});

test("completeTask returns false for a task that does not belong to the user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-complete-absent");
    const dek = freshDek();
    const saved = (await createTask(db, { userId, title: "Mine", assignee: "any", createdBy: { kind: "person" } }, dek)) as TaskLike;

    const marked = await completeTask(db, { userId: "11111111-1111-1111-1111-111111111111", id: saved.id });
    assert.equal(marked, false, "completing a task under a different user marks nothing");

    const tasks = (await listTasksForUser(db, userId, dek)) as TaskLike[];
    assert.equal(tasks[0]!.status, "open", "the owner's task is untouched");
  } finally {
    await db.close();
  }
});

test("addNote appends an agent's note to the owner's task, decrypted on read", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-addnote");
    const dek = freshDek();

    const saved = (await createTask(db, { userId, title: "Travel research", assignee: "agent-claude-1", createdBy: { kind: "person" } }, dek)) as TaskLike;

    const afterFirst = (await addNote(
      db,
      { userId, id: saved.id, author: { kind: "agent", agentId: "agent-claude-1" }, text: "Found 3 morning flights" },
      dek,
    )) as TaskLike;
    assert.equal(afterFirst.notes.length, 1, "the returned task carries the appended note");
    assert.equal(afterFirst.notes[0]!.text, "Found 3 morning flights", "with its text");
    assert.equal(afterFirst.notes[0]!.author.kind, "agent", "attributed to the agent");
    assert.equal(afterFirst.notes[0]!.author.agentId, "agent-claude-1", "with the exact agent id");

    // A second note APPENDS, keeping the first (order preserved).
    await addNote(
      db,
      { userId, id: saved.id, author: { kind: "person" }, text: "Book the 7am one" },
      dek,
    );

    const tasks = (await listTasksForUser(db, userId, dek)) as TaskLike[];
    const texts = tasks[0]!.notes.map((n) => n.text);
    assert.deepEqual(texts, ["Found 3 morning flights", "Book the 7am one"], "both notes persist, in order");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Update — the owner edits a task's title and metadata; member-scoped; notes survive.
// ===========================================================================

test("updateTask changes the title, assignee and status and round-trips decrypted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "update-ok");
    const dek = freshDek();

    const saved = (await createTask(db, { userId, title: "Old title", assignee: "any", status: "open", createdBy: { kind: "person" } }, dek)) as TaskLike;

    const updated = (await updateTask(
      db,
      { userId, id: saved.id, title: "New title", assignee: "agent-claude-1", status: "in_progress" },
      dek,
    )) as TaskLike;
    assert.equal(updated.id, saved.id, "the same task is updated");
    assert.equal(updated.title, "New title", "the returned task carries the new title");
    assert.equal(updated.assignee, "agent-claude-1", "the returned task carries the new assignee");
    assert.equal(updated.status, "in_progress", "the returned task carries the new status");

    const tasks = (await listTasksForUser(db, userId, dek)) as TaskLike[];
    assert.equal(tasks.length, 1, "still one task (an update, not an insert)");
    assert.equal(tasks[0]!.title, "New title", "the new title is persisted and decrypts");
    assert.equal(tasks[0]!.assignee, "agent-claude-1", "the new assignee is persisted");
    assert.equal(tasks[0]!.status, "in_progress", "the new status is persisted");
  } finally {
    await db.close();
  }
});

test("updating the title does not wipe the task's notes (shared-row invariant)", async () => {
  // A task carries BOTH its DEK-encrypted title and its DEK-encrypted notes on one row. An update
  // that touched the notes column would silently drop the notes — exactly the shared-state defect
  // the invariant test guards (OBS-022). Exercised across a sequence of mutations.
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "invariant-notes");
    const dek = freshDek();

    const saved = (await createTask(db, { userId, title: "Plan trip", assignee: "agent-claude-1", createdBy: { kind: "person" } }, dek)) as TaskLike;
    await addNote(db, { userId, id: saved.id, author: { kind: "agent", agentId: "agent-claude-1" }, text: "note one" }, dek);
    await updateTask(db, { userId, id: saved.id, title: "Plan trip (revised)", assignee: "agent-claude-1", status: "in_progress" }, dek);
    await addNote(db, { userId, id: saved.id, author: { kind: "person" }, text: "note two" }, dek);
    await completeTask(db, { userId, id: saved.id });

    const tasks = (await listTasksForUser(db, userId, dek)) as TaskLike[];
    assert.equal(tasks.length, 1, "still exactly one task through the whole sequence");
    const t = tasks[0]!;
    assert.equal(t.title, "Plan trip (revised)", "the updated title survives the later note + complete");
    assert.equal(t.status, "done", "the completion survives");
    assert.deepEqual(t.notes.map((n) => n.text), ["note one", "note two"], "both notes survive the title update and the completion");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: a second person can never read or change another's tasks.
// ===========================================================================

test("listTasksForUser and tasksForAgent never return another person's tasks", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-alice");
    const bob = await makeUser(db, "owner-bob");
    const dek = freshDek();

    await createTask(db, { userId: alice, title: "Alice A", assignee: "agent-x", createdBy: { kind: "person" } }, dek);
    await createTask(db, { userId: alice, title: "Alice B", assignee: "any", createdBy: { kind: "person" } }, dek);
    await createTask(db, { userId: bob, title: "Bob B", assignee: "agent-x", createdBy: { kind: "person" } }, dek);

    const aliceAll = (await listTasksForUser(db, alice, dek)) as TaskLike[];
    assert.equal(aliceAll.length, 2, "Alice sees exactly her own two tasks");
    assert.ok(aliceAll.every((t) => t.userId === alice), "every task in Alice's list is hers");
    assert.ok(!taskWithTitle(aliceAll, "Bob B"), "Bob's task never appears in Alice's list");

    const bobAll = (await listTasksForUser(db, bob, dek)) as TaskLike[];
    assert.equal(bobAll.length, 1, "Bob sees exactly his own task");
    assert.equal(bobAll[0]!.title, "Bob B", "Bob sees his own task");
  } finally {
    await db.close();
  }
});

test("updateTask refuses to edit another person's task (and leaves it unchanged)", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "update-alice");
    const bob = await makeUser(db, "update-bob");
    const dek = freshDek();

    const aliceTask = (await createTask(db, { userId: alice, title: "Alice original", assignee: "any", status: "open", createdBy: { kind: "person" } }, dek)) as TaskLike;

    // Bob tries to update Alice's task id under his own user id — member scope must refuse.
    await assert.rejects(
      async () => {
        await updateTask(db, { userId: bob, id: aliceTask.id, title: "Hijacked", assignee: "agent-bob", status: "done" }, dek);
      },
      "one person cannot update another's task",
    );

    const aliceTasks = (await listTasksForUser(db, alice, dek)) as TaskLike[];
    assert.equal(aliceTasks.length, 1, "Alice still has her task");
    assert.equal(aliceTasks[0]!.title, "Alice original", "its title is unchanged");
    assert.equal(aliceTasks[0]!.status, "open", "its status is unchanged");
    assert.equal(aliceTasks[0]!.assignee, "any", "its assignee is unchanged");
  } finally {
    await db.close();
  }
});

test("addNote refuses to annotate another person's task (and leaves it unchanged)", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "addnote-alice");
    const bob = await makeUser(db, "addnote-bob");
    const dek = freshDek();

    const aliceTask = (await createTask(db, { userId: alice, title: "Alice's", assignee: "any", createdBy: { kind: "person" } }, dek)) as TaskLike;

    await assert.rejects(
      async () => {
        await addNote(db, { userId: bob, id: aliceTask.id, author: { kind: "agent", agentId: "agent-bob" }, text: "sneaky note" }, dek);
      },
      "one person cannot add a note to another's task",
    );

    const aliceTasks = (await listTasksForUser(db, alice, dek)) as TaskLike[];
    assert.deepEqual(aliceTasks[0]!.notes, [], "no note was added to Alice's task");
  } finally {
    await db.close();
  }
});

test("completeTask cannot complete another person's task", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "complete-alice");
    const bob = await makeUser(db, "complete-bob");
    const dek = freshDek();

    const aliceTask = (await createTask(db, { userId: alice, title: "Alice's", assignee: "any", createdBy: { kind: "person" } }, dek)) as TaskLike;

    const marked = await completeTask(db, { userId: bob, id: aliceTask.id });
    assert.equal(marked, false, "Bob cannot mark Alice's task done");

    const aliceTasks = (await listTasksForUser(db, alice, dek)) as TaskLike[];
    assert.equal(aliceTasks[0]!.status, "open", "Alice's task is still open");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("createTask binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE tasks; --";

  // The recording db returns no rows; createTask assembles its result from the inputs, so the
  // INSERT it issued must have BOUND the probe (here the owner id), which is checked below.
  try {
    await createTask(
      db,
      { userId: probe, title: "x", assignee: "any", createdBy: { kind: "person" } },
      freshDek(),
    );
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("updateTask binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "p'); DROP TABLE tasks; --";

  try {
    await updateTask(
      db,
      { userId: probe, id: "some-id", title: "x", assignee: "any", status: "open" },
      freshDek(),
    );
  } catch {
    /* an empty RETURNING may throw "not found" — the binding is asserted regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("addNote binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "n'); DROP TABLE tasks; --";

  try {
    await addNote(
      db,
      { userId: probe, id: "some-id", author: { kind: "person" }, text: "x" },
      freshDek(),
    );
  } catch {
    /* a no-row read may throw "not found" — the binding is asserted regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("listTasksForUser binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "l'); DROP TABLE tasks; --";

  const result = await listTasksForUser(db, probe, freshDek());
  assert.deepEqual(result, [], "the recording db returns no rows, so the list is empty");

  assertBoundNotSpliced(db, probe);
});

test("tasksForAgent binds the agent id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "a'); DROP TABLE tasks; --";

  const result = await tasksForAgent(db, "session-user", probe, freshDek());
  assert.deepEqual(result, [], "the recording db returns no rows, so the list is empty");

  assertBoundNotSpliced(db, probe);
});

test("completeTask binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "c'); DROP TABLE tasks; --";

  const marked = await completeTask(db, { userId: probe, id: "some-id" });
  assert.equal(marked, false, "the recording db matches no row, so nothing is marked");

  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe in the title is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const dek = freshDek();
    const probe = "Grace'); DROP TABLE tasks; --";

    await createTask(db, { userId, title: probe, assignee: "any", createdBy: { kind: "person" } }, dek);

    assert.equal(
      await tableExists(db, "tasks"),
      true,
      "the tasks table must still exist (the probe was stored as data, not run as SQL)",
    );

    const tasks = (await listTasksForUser(db, userId, dek)) as TaskLike[];
    assert.ok(taskWithTitle(tasks, probe), "the probe round-trips verbatim as data");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input and binds probes.
//
// A route handler validates external input HERE (`parseBody`), then calls this task's
// parameterized data-access with the SESSION's user id (NEVER a body value) and the injected dek.
// A rejected input maps to a 4xx Response and never reaches a query. This handler is a test
// fixture that EXERCISES the modules — it is not an implementation file.
// ===========================================================================

const STATUSES = ["open", "in_progress", "done"] as const;

const actorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person") }),
  z.object({ kind: z.literal("agent"), agentId: z.string().min(1).max(128) }),
]);

function createTaskHandler(
  db: Db,
  dek: Uint8Array,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries the title, optional notes, the assignee, an optional status and the
  // created-by actor; the user id comes from the session, never the body. Lengths are capped so an
  // absurd value is rejected, but generous enough that a probe can still REACH the query to prove
  // it is bound.
  const schema = z.object({
    title: z.string().min(1).max(500),
    notes: z
      .array(z.object({ author: actorSchema, text: z.string().min(1).max(4000) }))
      .max(100)
      .optional(),
    assignee: z.string().min(1).max(128),
    status: z.enum(STATUSES).optional(),
    createdBy: actorSchema,
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 8 * 1024 });
      const saved = await createTask(
        db,
        {
          userId: sessionUserId,
          title: body.title,
          notes: body.notes,
          assignee: body.assignee,
          status: body.status,
          createdBy: body.createdBy,
        },
        dek,
      );
      return new Response(JSON.stringify({ id: saved.id }), { status: 201 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test sees the
      // raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function validBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: "Book flights to Sydney",
    assignee: "agent-claude-1",
    status: "open",
    createdBy: { kind: "person" },
    ...over,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createTaskHandler(db, freshDek(), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createTaskHandler(db, freshDek(), "session-user");

  // ~20 KiB title, well over the handler's 8 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(validBody({ title: "a".repeat(20 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createTaskHandler(db, freshDek(), "session-user");

  // No title — a task must carry its DEK-encrypted title.
  const res = await handler(jsonRequest(JSON.stringify({ assignee: "any", status: "open", createdBy: { kind: "person" } })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects an unknown status with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createTaskHandler(db, freshDek(), "session-user");

  const res = await handler(jsonRequest(validBody({ status: "archived" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an out-of-enum status must never reach a query");
});

test("the handler rejects a mis-typed field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createTaskHandler(db, freshDek(), "session-user");

  // title must be a string — a number is a schema violation.
  const res = await handler(jsonRequest(validBody({ title: 12345 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler accepts a well-formed body and records the task for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const handler = createTaskHandler(db, dek, userId);

    const res = await handler(jsonRequest(validBody()));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };
    assert.ok(typeof id === "string" && id.length > 0, "the handler returns the stored task id");

    const tasks = (await listTasksForUser(db, userId, dek)) as TaskLike[];
    assert.equal(tasks.length, 1, "a valid body is persisted for the session user");
    assert.equal(tasks[0]!.id, id, "the stored task matches the returned id");
    assert.equal(tasks[0]!.title, "Book flights to Sydney", "with the submitted title, decrypted");
    assert.equal(tasks[0]!.assignee, "agent-claude-1", "and the submitted assignee");
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body (no cross-user write)", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const dek = freshDek();
    const handler = createTaskHandler(db, dek, sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(jsonRequest(validBody({ userId: attacker })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal(
      (await listTasksForUser(db, sessionUser, dek)).length,
      1,
      "the task is recorded under the SESSION user",
    );
    assert.deepEqual(
      await listTasksForUser(db, attacker, dek),
      [],
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe value is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const dek = freshDek();
    const handler = createTaskHandler(db, dek, userId);
    const probe = "oren'); DROP TABLE tasks; --";

    const res = await handler(jsonRequest(validBody({ title: probe })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "tasks"), true, "the tasks table must still exist");

    const tasks = (await listTasksForUser(db, userId, dek)) as TaskLike[];
    assert.ok(taskWithTitle(tasks, probe), "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the title/notes are encrypted under the INJECTED dek, not a baked-in secret (a different
// dek cannot read them back); the repo reads no process.env and holds no key (INV-103), shown
// behaviourally with a decoy secret in the environment.
// ===========================================================================

test("listTasksForUser cannot decrypt the title/notes with a different DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-wrongdek");
    const dek = freshDek();
    await createTask(
      db,
      {
        userId,
        title: "Secret title",
        notes: [{ author: { kind: "person" }, text: "secret note" }],
        assignee: "any",
        createdBy: { kind: "person" },
      },
      dek,
    );

    // A different DEK is the wrong key; the GCM tag must fail rather than return other bytes — so
    // reading the tasks under it rejects.
    const wrongDek = freshDek();
    await assert.rejects(
      async () => {
        await listTasksForUser(db, userId, wrongDek);
      },
      "the title/notes are bound to the person's own DEK, not any ambient/hardcoded key",
    );
  } finally {
    await db.close();
  }
});

test("the repo reads no process.env: a decoy secret in the environment never lands in a task", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5");
    const dek = freshDek();
    await createTask(
      db,
      { userId, title: "A normal task", assignee: "any", createdBy: { kind: "person" } },
      dek,
    );

    const tasks = (await listTasksForUser(db, userId, dek)) as TaskLike[];
    assert.equal(tasks.length, 1, "the task reads and writes purely from the injected db — no app env needed");
    assert.ok(
      !JSON.stringify(tasks).includes(DECOY),
      "no ambient env value is folded into the returned tasks",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the same value
    // could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM tasks");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(DECOY), "no ambient env value is written to a column");
        }
      }
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===========================================================================
// Migration — the table applies and a second run changes nothing.
// ===========================================================================

test("the tasks migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "tasks"),
      true,
      "the tasks table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0035_tasks"),
      "db/migrations/0035_tasks.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw — re-executing
    // 0035's CREATE would throw "already exists", so an empty result AND no throw together prove the
    // migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
