// E13-S03 — Memory store
// (`src/server/db/memories.ts`, `db/migrations/0032_memories.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./memories` throws and `freshDb()` has no `memories` table — every test here fails
// until the builder adds them. That absence IS the point of test-first; do NOT implement
// anything to make these pass — the builder writes the module and the migration
// afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: the memories a person or
// an agent saves / edits / re-scopes / deletes, the DEK-encrypted content that round-trips
// only under the owner's key, the source agent and time that are recorded, the agent-scoped
// read that honours the per-memory sharing rule, who may read / change whose memories, what
// a handler rejects, that every value is bound as a parameter), never the source text of
// the module or the SQL file — a later rename that preserves behaviour must not redden them.
//
// WHY this exists (task E13-S03; brief §"Skills, preferences and shared memory": "Shared
// memory — agents with permission save memories (a short fact or note with the source agent
// and time); each memory is either kept to the agent that saved it or shared with the
// person's other permitted agents, following that agent's sharing setting unless the person
// changes it per memory; the person can view, search, edit, re-scope and delete any memory,
// and add their own.").
//
// PERSONAL CONTENT, SO DEK-ENCRYPTED. A memory's content is a short fact or note — personal
// content, NOT filterable metadata. design §4.1 lists the ONLY plaintext columns ("ids,
// timestamps, kinds, agent id, connector id, tool name, outcome, amounts …, card brand +
// last four") and memory text is NOT among them (it names "memories" as an encrypted
// personal-content column); constitution principle 19 forbids any operator path to "decrypt
// or display a person's … memory … contents"; CLAUDE.md: "Personal content is stored only
// DEK-encrypted … Plaintext columns are limited to the metadata listed in the design doc
// §4.1." So `content` is stored DEK-ENCRYPTED (`../crypto/envelope`), decrypted in the app
// within the already member-filtered set (design §4.1 — the same approach as encrypted
// memory/activity search). The `source_agent_id` (an "agent id" is explicitly §4.1
// metadata), the `scope` ('kept' | 'shared') and the `created_at` timestamp are PLAINTEXT
// METADATA — needed to attribute, order and filter the set that an agent may read — so they
// are NOT encrypted.
//
// TIME ENTERS THROUGH THE INJECTED CLOCK, NEVER SQL now() (the house rule every dated store
// here follows, e.g. agents.connectedAt): createMemory stamps `createdAt = clock.now()`, so
// a frozen clock makes the recorded instant deterministic.
//
// SOURCE AGENT IS OPAQUE §4.1 METADATA — like the skills store, this store treats an agent
// id as an opaque plaintext id; it needs no agents-table row (a bare UUID is a valid source
// or scope target), and `source_agent_id` is NOT a foreign key. When the PERSON saves their
// own memory there is no source agent, so `sourceAgentId` is `null`.
//
// THE PER-MEMORY OVERRIDE. The brief's "following that agent's sharing setting unless the
// person changes it per memory" means each memory carries its OWN scope: the agent's default
// sharing setting (which lives in the agent-permissions store, not here) decides the scope at
// save time, and the person can override it afterwards with `rescopeMemory`. This store's job
// is simply to honour each memory's own scope — the override is per-memory and lives here.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type MemoryScope = "kept" | "shared";   // kept to the SAVING agent, or shared with the person's other permitted agents
//
//   interface NewMemory {             // what createMemory records
//     userId: string;                 // the OWNER (the SESSION's id / the agent's person — NEVER a client value)
//     content: string;                // the short fact or note (stored DEK-encrypted)
//     sourceAgentId: string | null;   // the agent that saved it; null when the PERSON added it
//     scope: MemoryScope;             // 'kept' (to the saving agent) or 'shared'
//   }
//
//   interface Memory {                // a memory as handed back to its OWNER / a scoped agent (content DECRYPTED)
//     id: string;
//     userId: string;
//     content: string;
//     sourceAgentId: string | null;
//     scope: MemoryScope;
//     createdAt: Date | string;       // the time it was saved (= clock.now()); may round-trip as a Date or a string
//   }
//
//   createMemory(db, input: NewMemory, dek, clock): Promise<Memory>
//     • INSERTs a new row with a generated id (a person holds many memories). `content` is
//       stored DEK-encrypted; source/scope/createdAt are plaintext metadata; createdAt =
//       clock.now(). The returned Memory is assembled from the inputs (no dependency on a
//       RETURNING read). Member-scoped: the user id is BOUND. Works for an AGENT save
//       (sourceAgentId set) and the PERSON's own (sourceAgentId null).
//   editMemory(db, userId, id, content: string, dek): Promise<Memory>
//     • replaces an OWNED memory's content in place (same id), re-encrypting it; the source,
//       scope and createdAt are PRESERVED. Member-scoped (id AND user_id bound). THROWS
//       (never silently) when there is no such memory for this user.
//   rescopeMemory(db, userId, id, scope: MemoryScope): Promise<void>
//     • changes an OWNED memory's scope in place (the per-memory override); content, source
//       and createdAt untouched. Member-scoped. THROWS when there is no such memory for this
//       user, so a cross-user re-scope cannot silently no-op.
//   deleteMemory(db, userId, id): Promise<boolean>
//     • deletes an OWNED memory; true when a row was removed, false when there was none for
//       this user (so another person's delete is a no-op). Member-scoped.
//   listMemoriesForUser(db, userId, dek): Promise<Memory[]>
//     • ALL of the owner's memories — any scope, any source — decrypted under the owner's
//       dek, each carrying its source, scope and createdAt. Member-scoped; never another
//       person's. A wrong dek fails the GCM tag and rejects.
//   memoriesForAgent(db, userId, agentId, dek): Promise<Memory[]>
//     • the memories an agent MAY read: every SHARED memory (whatever its source) PLUS the
//       agent's OWN kept memories (sourceAgentId === agentId). NEVER another agent's kept
//       memory, and never a person-only kept memory. Decrypted under the owner's dek.
//       Member-scoped by userId: an agent never reads another person's memories.
//
// Acceptance criteria → tests:
//   AC1 "Saving a memory stores its content DEK-encrypted with the source agent, the time
//        and its scope (kept or shared); edit, re-scope and delete update it, and the person
//        can add their own." — each mutation is observable through listMemoriesForUser;
//        source / scope / createdAt round-trip; createMemory accepts an agent source AND a
//        null (person) source; content is stored encrypted (no plaintext column).
//   AC2 "memoriesForAgent returns only memories shared with that agent plus the agent's own,
//        never another agent's kept memories." — the scoped read includes shared memories
//        (any source) and the agent's own kept memories, and excludes another agent's kept
//        memories and person-only kept memories; another agent's kept content never leaks.
//   AC3 "A user cannot read or change another user's memories (filtered by session user
//        id)." — B never sees A's memories; B's edit/re-scope on A's id throws and leaves
//        A's untouched; B's delete on A's id is a no-op; an agent of B never reads A's
//        memories; the user id is bound.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed
//        input with a 4xx before any query; a SQL-injection probe routed through the repo
//        travels as a BOUND value and cannot drop the table. The handler is a test fixture
//        (the intended usage), not an implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — the repo takes `db`, `dek` and `clock` as
//        injected dependencies, holds no key and reads no `process.env`. Shown behaviourally:
//        content is encrypted under the INJECTED dek (a different dek cannot read it back),
//        the store reads/writes purely from the injected db with no app env configured, and a
//        decoy secret planted in the environment never lands in a stored or returned memory.
//   Migration: the `memories` relation exists after the project migrations and a second run
//        of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  createMemory,
  editMemory,
  rescopeMemory,
  deleteMemory,
  listMemoriesForUser,
  memoriesForAgent,
} from "./memories";
// Documentary type anchors — the exact names/shapes the implementation exports. Erased at
// runtime (and test files are excluded from `tsc`), so a rename cannot break these tests; the
// runtime assertions below are what actually gate behaviour.
import type { Memory, NewMemory, MemoryScope } from "./memories";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// The instant every createMemory in these tests stamps, via a frozen clock — so the
// recorded time is deterministic and comparable.
const T0 = new Date("2026-03-01T08:00:00.000Z");

// Compare the MOMENT, not the representation: a timestamptz may come back as a Date or a
// string depending on the driver (the same pattern agents.test.ts uses for connectedAt).
const ms = (value: Date | string | number): number => new Date(value as never).getTime();

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a layer up;
// this repo only ever receives the already-unwrapped bytes.
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

// A fresh agent id. The memory store treats an agent id as an opaque plaintext id (§4.1
// metadata); it needs no agents-table row, so a bare UUID is a valid source / scope target.
function agentId(): string {
  return randomUUID();
}

// Local scope type, decoupled from the (absent) module's exported type. Mirrors MemoryScope.
type Scope = "kept" | "shared";

// A structural view of a memory's settable fields, so helpers below do not depend on the
// (absent) module's exported type.
interface MemoryFields {
  readonly content: string;
  readonly sourceAgentId: string | null;
  readonly scope: Scope;
}

// A sample memory; override fields per test. Defaults to a short fact saved by an agent and
// kept to that agent. Each test passes a distinct `content` so a round-trip proves the field
// is stored and read independently.
function sampleMemory(overrides: Partial<MemoryFields> = {}): MemoryFields {
  return {
    content: "The person is moving house on 1 December to 14 Warthog Lane.",
    sourceAgentId: null,
    scope: "shared",
    ...overrides,
  };
}

// A structural view of a returned memory, decoupled from the (absent) module's type.
interface MemoryLike {
  readonly id: string;
  readonly userId: string;
  readonly content: string;
  readonly sourceAgentId: string | null;
  readonly scope: string;
  readonly createdAt: Date | string;
}

// Assert a returned memory carries exactly the given content / source / scope.
function assertMemoryContent(memory: MemoryLike, fields: MemoryFields): void {
  assert.equal(memory.content, fields.content, "content round-trips");
  assert.equal(memory.sourceAgentId, fields.sourceAgentId, "the source agent round-trips");
  assert.equal(memory.scope, fields.scope, "the scope round-trips");
}

// Find exactly one memory with this content in a list (content is decrypted by the read).
function byContent(memories: MemoryLike[], content: string): MemoryLike {
  const matches = memories.filter((m) => m.content === content);
  assert.equal(matches.length, 1, `expected exactly one memory with content "${content}"`);
  return matches[0];
}

// A db seam stand-in that records every call instead of running it, so a test can prove WHAT
// reached the query layer and HOW (bound value vs. spliced text). It returns no rows and
// satisfies the `Db` shape structurally (query + close).
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

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the
// relation name when it exists and NULL when it does not — a non-throwing probe scoped to the
// one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Assert the probe reached the query layer as a BOUND value and never as spliced SQL text,
// scoped to each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// ===========================================================================
// AC1 — saving a memory records its content (DEK-encrypted), source, time and scope;
// edit / re-scope / delete update it; the person can add their own.
// ===========================================================================

test("createMemory records an agent's memory with the owner, a generated id, source, scope and time", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-create");
    const claude = agentId();
    const fields = sampleMemory({ sourceAgentId: claude, scope: "kept" });

    const saved = (await createMemory(db, { userId, ...fields }, freshDek(), fixedClock(T0))) as MemoryLike;

    assert.ok(saved.id, "a memory id was generated");
    assert.equal(saved.userId, userId, "the memory belongs to the owning person");
    assertMemoryContent(saved, fields);
    assert.equal(ms(saved.createdAt), ms(T0), "createdAt is the injected clock instant");
  } finally {
    await db.close();
  }
});

test("listMemoriesForUser returns the owner's memories with source, scope and time, decrypted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-list");
    const dek = freshDek();
    const claude = agentId();

    const shared = sampleMemory({
      content: "Prefers aisle seats on flights.",
      sourceAgentId: claude,
      scope: "shared",
    });
    const kept = sampleMemory({
      content: "Is nervous about the dentist — go gently when booking.",
      sourceAgentId: claude,
      scope: "kept",
    });
    await createMemory(db, { userId, ...shared }, dek, fixedClock(T0));
    await createMemory(db, { userId, ...kept }, dek, fixedClock(T0));

    const memories = (await listMemoriesForUser(db, userId, dek)) as MemoryLike[];
    assert.equal(memories.length, 2, "both of the owner's memories are listed");
    for (const m of memories) {
      assert.equal(m.userId, userId, "every listed memory belongs to the owner");
      assert.equal(ms(m.createdAt), ms(T0), "the recorded time round-trips");
    }
    assertMemoryContent(byContent(memories, shared.content), shared);
    assertMemoryContent(byContent(memories, kept.content), kept);
  } finally {
    await db.close();
  }
});

test("createMemory lets the person add their own memory (no source agent)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-person");
    const dek = freshDek();
    const own = sampleMemory({
      content: "I want to be briefed in plain Australian English.",
      sourceAgentId: null,
      scope: "shared",
    });

    const saved = (await createMemory(db, { userId, ...own }, dek, fixedClock(T0))) as MemoryLike;
    assert.equal(saved.sourceAgentId, null, "a person-authored memory has no source agent");

    const memories = (await listMemoriesForUser(db, userId, dek)) as MemoryLike[];
    assert.equal(memories.length, 1, "the person's own memory persists");
    assertMemoryContent(memories[0], own);
    assert.equal(memories[0].sourceAgentId, null, "it round-trips with a null source agent");
  } finally {
    await db.close();
  }
});

test("editMemory replaces an owned memory's content in place, preserving its id, source, scope and time", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-edit");
    const dek = freshDek();
    const claude = agentId();
    const original = sampleMemory({
      content: "Moving on 1 Dec.",
      sourceAgentId: claude,
      scope: "shared",
    });
    const created = (await createMemory(db, { userId, ...original }, dek, fixedClock(T0))) as MemoryLike;

    const newContent = "Moving on 8 Dec (date changed) to 14 Warthog Lane.";
    const updated = (await editMemory(db, userId, created.id, newContent, dek)) as MemoryLike;

    assert.equal(updated.id, created.id, "edit keeps the same id (replace in place, not a new row)");
    assert.equal(updated.content, newContent, "the content is replaced");
    assert.equal(updated.sourceAgentId, claude, "edit preserves the source agent");
    assert.equal(updated.scope, "shared", "edit preserves the scope");
    assert.equal(ms(updated.createdAt), ms(T0), "edit preserves the original created time");

    // Still exactly one memory for the person, now carrying the edited content.
    const memories = (await listMemoriesForUser(db, userId, dek)) as MemoryLike[];
    assert.equal(memories.length, 1, "edit did not create a second row");
    assert.equal(memories[0].content, newContent, "the stored content is the edited one");
    assert.equal(memories[0].scope, "shared", "the stored scope is unchanged");
  } finally {
    await db.close();
  }
});

test("rescopeMemory changes an owned memory's scope in place, leaving content, source and time", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-rescope");
    const dek = freshDek();
    const claude = agentId();
    const fields = sampleMemory({
      content: "Allergic to penicillin.",
      sourceAgentId: claude,
      scope: "kept",
    });
    const created = (await createMemory(db, { userId, ...fields }, dek, fixedClock(T0))) as MemoryLike;

    await rescopeMemory(db, userId, created.id, "shared");

    const memories = (await listMemoriesForUser(db, userId, dek)) as MemoryLike[];
    assert.equal(memories.length, 1, "re-scope did not create or remove a row");
    assert.equal(memories[0].id, created.id, "the same memory is re-scoped");
    assert.equal(memories[0].scope, "shared", "the scope is now shared (the per-memory override)");
    assert.equal(memories[0].content, fields.content, "the content is untouched by a re-scope");
    assert.equal(memories[0].sourceAgentId, claude, "the source agent is untouched by a re-scope");
    assert.equal(ms(memories[0].createdAt), ms(T0), "the created time is untouched by a re-scope");
  } finally {
    await db.close();
  }
});

test("deleteMemory removes an owned memory and returns true; listMemoriesForUser no longer shows it", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-delete");
    const dek = freshDek();
    const a = (await createMemory(
      db,
      { userId, ...sampleMemory({ content: "Alpha fact" }) },
      dek,
      fixedClock(T0),
    )) as MemoryLike;
    await createMemory(db, { userId, ...sampleMemory({ content: "Beta fact" }) }, dek, fixedClock(T0));

    const removed = await deleteMemory(db, userId, a.id);
    assert.equal(removed, true, "deleting an owned memory reports a removal");

    const memories = (await listMemoriesForUser(db, userId, dek)) as MemoryLike[];
    assert.equal(memories.length, 1, "only the remaining memory is listed");
    assert.equal(memories[0].content, "Beta fact", "the deleted memory is gone, the other remains");
  } finally {
    await db.close();
  }
});

test("editMemory on a memory that does not exist for this user throws (never a silent no-op)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-edit-missing");
    await assert.rejects(
      async () => {
        await editMemory(db, userId, randomUUID(), "nothing to edit", freshDek());
      },
      "editing a non-existent memory must throw, not silently do nothing",
    );
  } finally {
    await db.close();
  }
});

test("rescopeMemory on a memory that does not exist for this user throws (never a silent no-op)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-rescope-missing");
    await assert.rejects(
      async () => {
        await rescopeMemory(db, userId, randomUUID(), "shared");
      },
      "re-scoping a non-existent memory must throw, not silently do nothing",
    );
  } finally {
    await db.close();
  }
});

test("deleteMemory returns false when there is no such memory for this user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-delete-missing");
    const removed = await deleteMemory(db, userId, randomUUID());
    assert.equal(removed, false, "deleting a non-existent memory removes nothing and reports false");
  } finally {
    await db.close();
  }
});

test("listMemoriesForUser returns an empty array for a person with no memories", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-empty");
    const memories = await listMemoriesForUser(db, userId, freshDek());
    assert.deepEqual(memories, [], "a person with no memories reads an empty list");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 (at rest) — content is stored DEK-encrypted (design §4.1 personal content;
// constitution principle 19 — operators cannot read a person's memory contents). Its
// plaintext never appears in a raw column; it round-trips only under the owner's dek.
// ===========================================================================

test("memory content is stored DEK-encrypted: no plaintext of the content in a raw column", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-atrest");
    const dek = freshDek();
    // A unique sentinel in the content, so any raw occurrence is a genuine plaintext leak.
    const fields = sampleMemory({ content: "LEAKCHECK_content_7k2 the person's private note" });
    await createMemory(db, { userId, ...fields }, dek, fixedClock(T0));

    // Scan every cell of the one table under test. Scoped to `memories` alone — the same
    // value could legitimately live (encrypted) elsewhere.
    const all = await db.query("SELECT * FROM memories");
    assert.ok(all.rows.length >= 1, "the memory row was stored");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(
            !cell.includes("LEAKCHECK_content_7k2"),
            "the plaintext of the memory content must never be written to a column",
          );
        }
      }
    }

    // …yet the content round-trips under the owner's dek.
    const memories = (await listMemoriesForUser(db, userId, dek)) as MemoryLike[];
    assertMemoryContent(memories[0], fields);
  } finally {
    await db.close();
  }
});

test("listMemoriesForUser cannot decrypt a memory with a different DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-wrongdek");
    const dek = freshDek();
    await createMemory(db, { userId, ...sampleMemory() }, dek, fixedClock(T0));

    const wrongDek = freshDek();
    await assert.rejects(
      async () => {
        await listMemoriesForUser(db, userId, wrongDek);
      },
      "a memory is bound to the person's own DEK, not any ambient/hardcoded key",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — memoriesForAgent honours the per-memory sharing rule: SHARED memories (any source)
// PLUS the agent's OWN kept memories, never another agent's kept memory, never a
// person-only kept memory.
// ===========================================================================

test("memoriesForAgent returns shared memories (any source) plus the agent's own kept, and nothing else", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-scope");
    const dek = freshDek();
    const claude = agentId();
    const chatgpt = agentId();

    // Visible to `claude`:
    const sharedByClaude = sampleMemory({
      content: "SHARED by claude: moving on 1 Dec",
      sourceAgentId: claude,
      scope: "shared",
    });
    const sharedByChatgpt = sampleMemory({
      content: "SHARED by chatgpt: prefers morning appointments",
      sourceAgentId: chatgpt,
      scope: "shared",
    });
    const sharedByPerson = sampleMemory({
      content: "SHARED by the person: brief me in plain English",
      sourceAgentId: null,
      scope: "shared",
    });
    const keptByClaude = sampleMemory({
      content: "KEPT by claude: claude's own working note",
      sourceAgentId: claude,
      scope: "kept",
    });
    // NOT visible to `claude`:
    const keptByChatgpt = sampleMemory({
      content: "KEPT by chatgpt: chatgpt's own private note",
      sourceAgentId: chatgpt,
      scope: "kept",
    });
    const keptByPerson = sampleMemory({
      content: "KEPT by the person: a note only I should see",
      sourceAgentId: null,
      scope: "kept",
    });

    for (const m of [sharedByClaude, sharedByChatgpt, sharedByPerson, keptByClaude, keptByChatgpt, keptByPerson]) {
      await createMemory(db, { userId, ...m }, dek, fixedClock(T0));
    }

    const forClaude = (await memoriesForAgent(db, userId, claude, dek)) as MemoryLike[];
    const contents = forClaude.map((m) => m.content).sort();
    assert.deepEqual(
      contents,
      [
        sharedByChatgpt.content,
        sharedByClaude.content,
        sharedByPerson.content,
        keptByClaude.content,
      ].sort(),
      "claude reads every shared memory plus only its OWN kept memory",
    );

    // Another agent's kept content, and the person-only kept content, never leak into the
    // agent-scoped read (scoped to this read's output).
    const serialised = JSON.stringify(forClaude);
    assert.ok(!serialised.includes("KEPT by chatgpt"), "another agent's kept memory never leaks to this agent");
    assert.ok(!serialised.includes("KEPT by the person"), "a person-only kept memory never leaks to an agent");
  } finally {
    await db.close();
  }
});

test("memoriesForAgent gives each agent only its own kept memory, not the other's", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-own-kept");
    const dek = freshDek();
    const claude = agentId();
    const chatgpt = agentId();
    await createMemory(
      db,
      { userId, ...sampleMemory({ content: "claude kept note", sourceAgentId: claude, scope: "kept" }) },
      dek,
      fixedClock(T0),
    );
    await createMemory(
      db,
      { userId, ...sampleMemory({ content: "chatgpt kept note", sourceAgentId: chatgpt, scope: "kept" }) },
      dek,
      fixedClock(T0),
    );

    const forClaude = (await memoriesForAgent(db, userId, claude, dek)) as MemoryLike[];
    assert.deepEqual(
      forClaude.map((m) => m.content),
      ["claude kept note"],
      "claude sees its own kept note and not chatgpt's",
    );

    const forChatgpt = (await memoriesForAgent(db, userId, chatgpt, dek)) as MemoryLike[];
    assert.deepEqual(
      forChatgpt.map((m) => m.content),
      ["chatgpt kept note"],
      "chatgpt sees its own kept note and not claude's",
    );
  } finally {
    await db.close();
  }
});

test("re-scoping a kept memory to shared makes it visible to other agents", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-rescope-visible");
    const dek = freshDek();
    const claude = agentId();
    const chatgpt = agentId();
    const created = (await createMemory(
      db,
      { userId, ...sampleMemory({ content: "a fact claude kept", sourceAgentId: claude, scope: "kept" }) },
      dek,
      fixedClock(T0),
    )) as MemoryLike;

    // Before the override: chatgpt cannot see claude's kept memory.
    assert.deepEqual(await memoriesForAgent(db, userId, chatgpt, dek), [], "chatgpt sees nothing while it is kept");

    await rescopeMemory(db, userId, created.id, "shared");

    const forChatgpt = (await memoriesForAgent(db, userId, chatgpt, dek)) as MemoryLike[];
    assert.deepEqual(
      forChatgpt.map((m) => m.content),
      ["a fact claude kept"],
      "after re-scoping to shared, another agent can read it",
    );
  } finally {
    await db.close();
  }
});

test("memoriesForAgent is empty for an agent of a person with no readable memories", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-empty");
    const dek = freshDek();
    const claude = agentId();
    const chatgpt = agentId();
    // Only chatgpt's kept memory exists — nothing claude may read.
    await createMemory(
      db,
      { userId, ...sampleMemory({ content: "chatgpt only", sourceAgentId: chatgpt, scope: "kept" }) },
      dek,
      fixedClock(T0),
    );

    const index = await memoriesForAgent(db, userId, claude, dek);
    assert.deepEqual(index, [], "an agent with nothing it may read sees an empty list");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: a second signed-in person (and their agents) can never read or change
// another's memories. The user id is bound from the session, never the client.
// ===========================================================================

test("listMemoriesForUser never returns another person's memories", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "own-alice");
    const bob = await makeUser(db, "own-bob");
    const dek = freshDek();

    const aliceMemory = sampleMemory({ content: "Alice only" });
    await createMemory(db, { userId: alice, ...aliceMemory }, dek, fixedClock(T0));

    assert.deepEqual(await listMemoriesForUser(db, bob, dek), [], "Bob sees none of Alice's memories");
    const aliceList = (await listMemoriesForUser(db, alice, dek)) as MemoryLike[];
    assert.equal(aliceList.length, 1, "Alice sees exactly her own");
    assertMemoryContent(aliceList[0], aliceMemory);
  } finally {
    await db.close();
  }
});

test("memoriesForAgent never hands an agent another person's memories (member-scoped by userId)", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "agent-alice");
    const bob = await makeUser(db, "agent-bob");
    const dek = freshDek();
    const bobAgent = agentId();
    // Alice has a SHARED memory; Bob's agent (a different person's agent) asks for memories.
    await createMemory(
      db,
      { userId: alice, ...sampleMemory({ content: "alice shared secret", scope: "shared" }) },
      dek,
      fixedClock(T0),
    );

    assert.deepEqual(
      await memoriesForAgent(db, bob, bobAgent, dek),
      [],
      "Bob's agent cannot read Alice's memories, even shared ones — they belong to Alice",
    );
  } finally {
    await db.close();
  }
});

test("editMemory on another person's memory throws and leaves it untouched", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "edit-alice");
    const bob = await makeUser(db, "edit-bob");
    const dek = freshDek();
    const aliceFields = sampleMemory({ content: "Alice original" });
    const aliceMemory = (await createMemory(db, { userId: alice, ...aliceFields }, dek, fixedClock(T0))) as MemoryLike;

    await assert.rejects(
      async () => {
        await editMemory(db, bob, aliceMemory.id, "hijacked", dek);
      },
      "Bob cannot edit a memory that is not his",
    );

    const aliceList = (await listMemoriesForUser(db, alice, dek)) as MemoryLike[];
    assert.equal(aliceList.length, 1);
    assertMemoryContent(aliceList[0], aliceFields);
  } finally {
    await db.close();
  }
});

test("rescopeMemory on another person's memory throws and leaves its scope unchanged", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "rescope-alice");
    const bob = await makeUser(db, "rescope-bob");
    const dek = freshDek();
    const aliceMemory = (await createMemory(
      db,
      { userId: alice, ...sampleMemory({ content: "alice kept", scope: "kept" }) },
      dek,
      fixedClock(T0),
    )) as MemoryLike;

    await assert.rejects(
      async () => {
        await rescopeMemory(db, bob, aliceMemory.id, "shared");
      },
      "Bob cannot re-scope a memory that is not his",
    );

    const aliceList = (await listMemoriesForUser(db, alice, dek)) as MemoryLike[];
    assert.equal(aliceList[0].scope, "kept", "Alice's memory is still kept — Bob's re-scope did nothing");
  } finally {
    await db.close();
  }
});

test("deleteMemory on another person's memory is a no-op (returns false) and does not remove it", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "del-alice");
    const bob = await makeUser(db, "del-bob");
    const dek = freshDek();
    const aliceMemory = (await createMemory(db, { userId: alice, ...sampleMemory() }, dek, fixedClock(T0))) as MemoryLike;

    const removed = await deleteMemory(db, bob, aliceMemory.id);
    assert.equal(removed, false, "Bob's delete of Alice's memory removes nothing");

    const aliceList = (await listMemoriesForUser(db, alice, dek)) as MemoryLike[];
    assert.equal(aliceList.length, 1, "Alice's memory still exists");
  } finally {
    await db.close();
  }
});

// Binding (the parameterize half of INV-102): the member-scope key travels as a bound value,
// never spliced into the SQL text — even when it is shaped like an injection.

test("createMemory binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE memories; --";

  try {
    await createMemory(db, { userId: probe, ...sampleMemory() }, freshDek(), fixedClock(T0));
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("listMemoriesForUser binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "l'); DROP TABLE memories; --";

  const result = await listMemoriesForUser(db, probe, freshDek());
  assert.deepEqual(result, [], "the recording db returns no rows, so the list is empty");

  assertBoundNotSpliced(db, probe);
});

test("memoriesForAgent binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "a'); DROP TABLE memories; --";

  const result = await memoriesForAgent(db, probe, agentId(), freshDek());
  assert.deepEqual(result, [], "the recording db returns no rows, so the read is empty");

  assertBoundNotSpliced(db, probe);
});

test("editMemory binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "e'); DROP TABLE memories; --";

  try {
    await editMemory(db, probe, randomUUID(), "new content", freshDek());
  } catch {
    /* a no-row UPDATE throws "no such memory"; the binding is asserted below regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("rescopeMemory binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "r'); DROP TABLE memories; --";

  try {
    await rescopeMemory(db, probe, randomUUID(), "shared");
  } catch {
    /* a no-row UPDATE throws "no such memory"; the binding is asserted below regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("deleteMemory binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "d'); DROP TABLE memories; --";

  const removed = await deleteMemory(db, probe, randomUUID());
  assert.equal(removed, false, "the recording db removes no rows, so delete reports false");

  assertBoundNotSpliced(db, probe);
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input and binds probes.
//
// A route handler validates external input HERE (`parseBody`), then calls this task's
// parameterized data-access with the SESSION's user id (NEVER a body value), the injected dek
// and clock. This models the PERSON saving their own memory from the signed-in app, so the
// source agent is null and the scope comes from the body. A rejected input maps to a 4xx
// Response and never reaches a query. This handler is a test fixture that EXERCISES the
// modules — it is not an implementation file.
// ===========================================================================

function createMemoryHandler(
  db: Db,
  dek: Uint8Array,
  clock: Clock,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries the memory's content + scope; the user id comes from the session, never
  // the body, and a person-authored memory has no source agent. Lengths are capped so an
  // absurd value is rejected, but generous enough that a probe can still REACH the query to
  // prove it is bound.
  const schema = z.object({
    content: z.string().min(1).max(10_000),
    scope: z.enum(["kept", "shared"]),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 64 * 1024 });
      const saved = await createMemory(
        db,
        { userId: sessionUserId, content: body.content, sourceAgentId: null, scope: body.scope },
        dek,
        clock,
      );
      return new Response(JSON.stringify({ id: saved.id }), { status: 201 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test
      // sees the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/memories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function memoryBody(overrides: Partial<{ content: string; scope: Scope }> = {}): string {
  return JSON.stringify({ content: sampleMemory().content, scope: "shared", ...overrides });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createMemoryHandler(db, freshDek(), fixedClock(T0), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createMemoryHandler(db, freshDek(), fixedClock(T0), "session-user");

  // ~200 KiB content, well over the handler's 64 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(memoryBody({ content: "a".repeat(200 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createMemoryHandler(db, freshDek(), fixedClock(T0), "session-user");

  // Omit `content` — a memory must have some, so a missing content is a schema violation.
  const res = await handler(jsonRequest(JSON.stringify({ scope: "shared" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createMemoryHandler(db, freshDek(), fixedClock(T0), "session-user");

  // `content` must be a string — a number is a schema violation, rejected before any query.
  const res = await handler(jsonRequest(JSON.stringify({ content: 42, scope: "shared" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler rejects an invalid scope value with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createMemoryHandler(db, freshDek(), fixedClock(T0), "session-user");

  // `scope` must be 'kept' | 'shared' — any other value is a schema violation.
  const res = await handler(jsonRequest(JSON.stringify({ content: "a fact", scope: "everyone" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an out-of-range scope must never reach a query");
});

test("the handler accepts a well-formed body and records the memory for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const handler = createMemoryHandler(db, dek, fixedClock(T0), userId);

    const res = await handler(jsonRequest(memoryBody({ content: "a well-formed fact", scope: "shared" })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const memories = (await listMemoriesForUser(db, userId, dek)) as MemoryLike[];
    assert.equal(memories.length, 1, "the memory was recorded");
    assert.equal(memories[0].content, "a well-formed fact", "its content round-trips");
    assert.equal(memories[0].scope, "shared", "its scope round-trips");
    assert.equal(memories[0].sourceAgentId, null, "a person-saved memory has no source agent");
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
    const handler = createMemoryHandler(db, dek, fixedClock(T0), sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(
      jsonRequest(JSON.stringify({ userId: attacker, content: "smuggled", scope: "shared" })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    const forSession = (await listMemoriesForUser(db, sessionUser, dek)) as MemoryLike[];
    assert.equal(forSession.length, 1, "the memory is recorded under the SESSION user");
    assert.deepEqual(
      await listMemoriesForUser(db, attacker, dek),
      [],
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe in an input field is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const dek = freshDek();
    const handler = createMemoryHandler(db, dek, fixedClock(T0), userId);
    const probe = "Grace'); DROP TABLE memories; --";

    const res = await handler(jsonRequest(memoryBody({ content: probe, scope: "shared" })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "memories"), true, "the memories table must still exist");

    const memories = (await listMemoriesForUser(db, userId, dek)) as MemoryLike[];
    assert.equal(memories.length, 1, "the memory is readable after the probe");
    assert.equal(
      memories[0].content,
      probe,
      "the probe round-trips verbatim as data, not interpreted as SQL",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the repo reads no process.env and holds no key (INV-103), shown behaviourally with a
// decoy secret in the environment.
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in a memory", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-decoy");
    const dek = freshDek();
    await createMemory(db, { userId, ...sampleMemory() }, dek, fixedClock(T0));

    const memories = (await listMemoriesForUser(db, userId, dek)) as MemoryLike[];
    assert.equal(memories.length, 1, "the memory reads and writes purely from the injected db — no app env needed");
    assert.ok(
      !JSON.stringify(memories).includes(DECOY),
      "no ambient env value is folded into the returned memory",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly).
    const all = await db.query("SELECT * FROM memories");
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

test("the memories migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "memories"),
      true,
      "the memories table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0032_memories"),
      "db/migrations/0032_memories.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0032's CREATE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});

// Type anchors referenced so the type-only imports are not flagged as unused by linters that
// check it; erased at runtime.
export type _MemoryAnchors = [Memory, NewMemory, MemoryScope];
