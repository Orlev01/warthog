// E13-S09 — Memory read for the page (list-all + search)
// (`src/server/memory/page-data.ts`).
//
// RED-first: the module under test does NOT exist yet, so importing `./page-data`
// throws and every test here fails until the builder writes it. That absence IS the
// point of test-first — do NOT implement anything to make these pass; the builder
// writes `page-data.ts` afterwards, composing the already-built, tested storage
// primitive (`listMemoriesForUser`) rather than re-running SQL or re-implementing
// decryption. The search decrypts IN THE APP within the already owner-filtered set
// (design §4.1: "Search over encrypted fields (memory, activity text) decrypts in the
// app within the already filtered set … — acceptable at v1 scale").
//
// These tests pin BEHAVIOUR (what the read RETURNS: which memories, each with its
// source agent, time and scope; which memories a search matches; who may read whose
// memories; that the owner id is bound as a parameter and a search term never reaches a
// query at all) — never the source text of the module or any SQL. A later rename that
// preserves behaviour must not redden them.
//
// WHY this exists (task E13-S09; design §4.1; brief "Skills, preferences and shared
// memory": "the person can view, search, edit, re-scope and delete any memory"): the
// Memory page needs ONE owner-scoped list-ALL read — every memory the person holds,
// whatever its scope ('kept' | 'shared') and source agent — PLUS a search that matches
// over the decrypted content. Both are for the OWNER and NEVER return another person's
// memories. A memory's content is PERSONAL CONTENT stored DEK-encrypted by its store, so
// this read decrypts it under the INJECTED per-person DEK (it holds no key and reads no
// `process.env`), and the search decrypts WITHIN the already member-filtered set.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type MemoryScope = "kept" | "shared";   // the memories store's scope
//
//   // One of the owner's memories as the Memory page shows it: its id, its decrypted
//   // content, its source agent (null when the PERSON added it), its scope and the time
//   // it was saved. A page read carrying AT LEAST these fields (extra fields allowed —
//   // these tests never assert the ABSENCE of other fields on an item).
//   interface MemoryPageItem {
//     id: string;
//     content: string;                 // decrypted under the owner's DEK
//     sourceAgentId: string | null;    // the agent that saved it; null when the PERSON did
//     scope: MemoryScope;              // "kept" | "shared"
//     createdAt: Date | string;        // the time it was saved
//   }
//
//   memoriesPageData(db, userId, dek): Promise<MemoryPageItem[]>
//     • Lists ALL of `userId`'s memories — any scope, any source — each content decrypted
//       under the injected `dek`, carrying its source agent, scope and created time, in the
//       canonical order of `listMemoriesForUser` (by created time). Member-scoped by the
//       `userId` the caller passes (the session's id, never a client value): another
//       person's memories are never returned. The user id is BOUND as a parameter.
//
//   searchMemories(db, userId, dek, query): Promise<MemoryPageItem[]>
//     • The subset of the owner's memories whose DECRYPTED content matches `query`
//       (case-insensitive substring), decrypting WITHIN the owner-filtered set. Same shape
//       and same member-scoping as the list; never another person's memory. The match runs
//       in the app, so `query` never reaches a query (it cannot alter any SQL).
//
// Acceptance criteria → tests:
//   AC1 "Lists all of the owner's memories with their source agent, time and scope, and
//        search returns matching memories decrypting within the owner-filtered set."
//   AC2 "A user never receives another user's memories."
//   AC3 [obligation:validate-and-parameterize-input] (INV-102) — a handler rejects
//        malformed / oversized input with a 4xx (nothing reaches a query); the owner id is
//        bound as a parameter and a SQL-injection probe in an input field travels as data
//        (or, for the search term, never reaches a query at all) and cannot alter a query.
//        The handler is a test fixture (the intended usage), not an implementation file.
//   AC4 [obligation:secrets-from-env] (INV-103) — the read runs from its INJECTED deps
//        alone (db, userId, dek): no secret, no ambient config. Shown behaviourally: the
//        content decrypts only under the injected DEK (a different DEK cannot read it back),
//        and a decoy secret planted in the environment never lands in the page.
//
// Every real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations) and closes it in a `finally`, so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import { memoriesPageData, searchMemories } from "./page-data";
import { createMemory, listMemoriesForUser } from "../db/memories";
import { createUser } from "../db/users";
import { fixedClock } from "../seams/clock";
import { freshDb } from "../../test/db";
import { parseBody, HttpError } from "../http/validate";
import type { Db } from "../db/index";

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a layer
// up; this read only ever receives the already-unwrapped bytes (like the store it uses).
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque; this read never unwraps it — it takes
// the already-unwrapped dek directly).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A structural view of a settable memory, so helpers below do not depend on the store's
// exported type. Scope defaults to 'shared', source defaults to an agent.
interface MemoryFields {
  readonly content: string;
  readonly sourceAgentId: string | null;
  readonly scope: "kept" | "shared";
}

// Save a memory for `userId`, stamping its created time from a frozen clock so ordering
// is deterministic. Returns the created memory's id.
async function makeMemory(
  db: Db,
  userId: string,
  dek: Uint8Array,
  fields: Partial<MemoryFields>,
  when: Date = new Date("2026-11-07T00:00:00.000Z"),
): Promise<string> {
  // `??` would turn an EXPLICIT null (a person-saved memory) into a random UUID, so key
  // off presence: a caller that omits `sourceAgentId` gets an agent; one that passes
  // `null` keeps null (the person saved it).
  const sourceAgentId: string | null = "sourceAgentId" in fields
    ? (fields.sourceAgentId ?? null)
    : randomUUID();
  const mem = await createMemory(
    db,
    {
      userId,
      content: fields.content ?? "A short fact the agent saved",
      sourceAgentId,
      scope: fields.scope ?? "shared",
    },
    dek,
    fixedClock(when),
  );
  return mem.id;
}

// A structural view of a returned memory-page item, decoupled from the (absent) type.
// Extra fields are allowed; these tests never assert that an item has ONLY these fields.
interface MemoryPageItemLike {
  readonly id: string;
  readonly content: string;
  readonly sourceAgentId: string | null;
  readonly scope: string;
  readonly createdAt: Date | string;
}

function asItems(value: unknown): MemoryPageItemLike[] {
  return value as MemoryPageItemLike[];
}

// Milliseconds of an instant that may round-trip as a Date or a string, so createdAt can
// be compared driver-agnostically.
function ms(value: Date | string): number {
  return new Date(value).getTime();
}

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (bound value vs. spliced text). It returns no rows
// and satisfies the `Db` shape structurally (query + close).
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
// relation name when it exists and NULL when it does not — a non-throwing probe scoped to
// the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Assert a value reached the query layer as a BOUND value and never as spliced SQL text,
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
// AC1 — all of the owner's memories, each carrying its source agent, created time and
// scope ('kept' | 'shared'); and a search that matches over the decrypted content.
// ===========================================================================

test("memoriesPageData lists all of the owner's memories with source agent, time and scope", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const dek = freshDek();

    const claude = randomUUID();
    const chatgpt = randomUUID();

    // Three memories across the full matrix of source + scope, at distinct times so the
    // canonical (by-created-time) order is deterministic.
    const shared = await makeMemory(
      db,
      userId,
      dek,
      { content: "Moving on 1 Dec to the new address", sourceAgentId: claude, scope: "shared" },
      new Date("2026-11-01T09:00:00.000Z"),
    );
    const kept = await makeMemory(
      db,
      userId,
      dek,
      { content: "Prefers an aisle seat when booking flights", sourceAgentId: chatgpt, scope: "kept" },
      new Date("2026-11-02T09:00:00.000Z"),
    );
    // A memory the PERSON saved themselves: no source agent.
    const mine = await makeMemory(
      db,
      userId,
      dek,
      { content: "My cat's name is Biscuit", sourceAgentId: null, scope: "kept" },
      new Date("2026-11-03T09:00:00.000Z"),
    );

    const page = asItems(await memoriesPageData(db, userId, dek));
    const byId = new Map(page.map((m) => [m.id, m]));

    // Every memory is listed — any scope, any source — and no extra.
    assert.equal(page.length, 3, "all three of the owner's memories are listed");
    for (const id of [shared, kept, mine]) {
      assert.ok(byId.has(id), `memory ${id} is listed`);
    }

    // The decrypted content comes through.
    assert.equal(byId.get(shared)!.content, "Moving on 1 Dec to the new address", "a shared memory's content round-trips decrypted");
    assert.equal(byId.get(kept)!.content, "Prefers an aisle seat when booking flights", "a kept memory's content round-trips decrypted");

    // Scope distinguishes kept from shared.
    assert.equal(byId.get(shared)!.scope, "shared", "the shared memory carries scope 'shared'");
    assert.equal(byId.get(kept)!.scope, "kept", "the kept memory carries scope 'kept'");

    // Source agent attributes each memory; a person-saved memory has none.
    assert.equal(byId.get(shared)!.sourceAgentId, claude, "the shared memory carries its source agent");
    assert.equal(byId.get(kept)!.sourceAgentId, chatgpt, "the kept memory carries its source agent");
    assert.equal(byId.get(mine)!.sourceAgentId, null, "the person-saved memory has no source agent (null)");

    // Each carries the time it was saved.
    assert.equal(ms(byId.get(shared)!.createdAt), Date.parse("2026-11-01T09:00:00.000Z"), "the created time round-trips");
    assert.equal(ms(byId.get(mine)!.createdAt), Date.parse("2026-11-03T09:00:00.000Z"), "the person-saved memory's created time round-trips");
  } finally {
    await db.close();
  }
});

test("memoriesPageData returns the owner's memories in the canonical store order", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-order");
    const dek = freshDek();

    // Saved out of time order; the canonical read orders by created time.
    await makeMemory(db, userId, dek, { content: "second" }, new Date("2026-11-02T00:00:00.000Z"));
    await makeMemory(db, userId, dek, { content: "first" }, new Date("2026-11-01T00:00:00.000Z"));
    await makeMemory(db, userId, dek, { content: "third" }, new Date("2026-11-03T00:00:00.000Z"));

    const page = asItems(await memoriesPageData(db, userId, dek));

    // Behaviour-anchored to the canonical list read: same memories, same order, same
    // decrypted content — not a re-implementation of the query or the decryption.
    const canonical = await listMemoriesForUser(db, userId, dek);
    assert.deepEqual(
      page.map((m) => m.id),
      canonical.map((m) => m.id),
      "the page lists the same memories in the same order as the canonical store read",
    );
    assert.deepEqual(
      page.map((m) => m.content),
      canonical.map((m) => m.content),
      "and the decrypted content matches the canonical read",
    );
    assert.deepEqual(
      page.map((m) => m.content),
      ["first", "second", "third"],
      "ordered by the time each memory was saved",
    );
  } finally {
    await db.close();
  }
});

test("memoriesPageData returns an empty list for a person who has no memories", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-empty");
    const page = asItems(await memoriesPageData(db, userId, freshDek()));
    assert.deepEqual(page, [], "no memories → an empty list, not an error");
  } finally {
    await db.close();
  }
});

test("searchMemories returns only the memories whose decrypted content matches, within the owner set", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-search");
    const dek = freshDek();

    const moving = await makeMemory(
      db,
      userId,
      dek,
      { content: "Moving on 1 Dec to the new address" },
      new Date("2026-11-01T00:00:00.000Z"),
    );
    const flights = await makeMemory(
      db,
      userId,
      dek,
      { content: "Prefers an aisle seat when booking flights" },
      new Date("2026-11-02T00:00:00.000Z"),
    );
    await makeMemory(
      db,
      userId,
      dek,
      { content: "My cat's name is Biscuit" },
      new Date("2026-11-03T00:00:00.000Z"),
    );

    // A term that appears in exactly one memory's content returns just that memory.
    const addressHits = asItems(await searchMemories(db, userId, dek, "address"));
    assert.deepEqual(addressHits.map((m) => m.id), [moving], "only the memory containing 'address' matches");
    assert.equal(addressHits[0]!.content, "Moving on 1 Dec to the new address", "the match carries its decrypted content");

    // The match is a case-insensitive substring over the decrypted content ("book" is
    // within "booking"), so case and word boundaries do not hide a match.
    const bookHits = asItems(await searchMemories(db, userId, dek, "BOOK"));
    assert.deepEqual(bookHits.map((m) => m.id), [flights], "a case-insensitive substring of the content matches");

    // A term in none of the memories matches nothing.
    const none = asItems(await searchMemories(db, userId, dek, "xyzzy-no-such-term"));
    assert.deepEqual(none, [], "a term that appears in no memory returns an empty list");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a person NEVER receives another person's memories (neither the list nor the
// search ever crosses the owner boundary, even when the content would match).
// ===========================================================================

test("memoriesPageData returns only the owner's memories — never another person's", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    const dekA = freshDek();
    const dekB = freshDek();

    const aliceMem = await makeMemory(db, alice, dekA, { content: "Alice only secret note" });
    const bobMem = await makeMemory(db, bob, dekB, { content: "Bob only secret note" });

    const alicePage = asItems(await memoriesPageData(db, alice, dekA));
    const aliceIds = alicePage.map((m) => m.id);
    assert.ok(aliceIds.includes(aliceMem), "Alice sees her memory");
    assert.ok(!aliceIds.includes(bobMem), "Alice never sees Bob's memory");

    const bobPage = asItems(await memoriesPageData(db, bob, dekB));
    const bobIds = bobPage.map((m) => m.id);
    assert.ok(bobIds.includes(bobMem), "Bob sees his memory");
    assert.ok(!bobIds.includes(aliceMem), "Bob never sees Alice's memory");
  } finally {
    await db.close();
  }
});

test("searchMemories never matches another person's memory, even when the content matches the term", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice-search");
    const bob = await makeUser(db, "bob-search");
    const dekA = freshDek();
    const dekB = freshDek();

    // Both own a memory containing the SAME searchable word.
    const aliceMem = await makeMemory(db, alice, dekA, { content: "renewal due in March" });
    const bobMem = await makeMemory(db, bob, dekB, { content: "renewal due in April" });

    // Alice searching "renewal" gets only HER memory — never Bob's, though his matches too.
    const aliceHits = asItems(await searchMemories(db, alice, dekA, "renewal"));
    assert.deepEqual(aliceHits.map((m) => m.id), [aliceMem], "Alice's search returns only her matching memory");
    assert.ok(!aliceHits.some((m) => m.id === bobMem), "Alice's search never returns Bob's matching memory");

    const bobHits = asItems(await searchMemories(db, bob, dekB, "renewal"));
    assert.deepEqual(bobHits.map((m) => m.id), [bobMem], "Bob's search returns only his matching memory");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 [obligation:validate-and-parameterize-input] (INV-102)
//
// A route handler validates the request HERE (`parseBody`), then reads/searches the
// SESSION's memories — NEVER a user id from the request body. A rejected input maps to a
// 4xx Response and never reaches a query. The owner id is bound as a parameter (no spliced
// SQL); the search term runs in the app and never reaches a query at all. This handler is
// a test fixture that EXERCISES the modules — not an implementation file.
// ===========================================================================

function memoryHandler(
  db: Db,
  dek: Uint8Array,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body is OPTIONAL. A `userId` in the body is accepted by the shape but IGNORED (it
  // must never widen the scope); a `query`, when present, drives the search. The size cap
  // keeps an absurd body out before it is parsed.
  const schema = z.object({
    userId: z.string().max(256).optional(),
    query: z.string().max(512).optional(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const items = body.query
        ? asItems(await searchMemories(db, sessionUserId, dek, body.query))
        : asItems(await memoriesPageData(db, sessionUserId, dek));
      return new Response(JSON.stringify({ memoryIds: items.map((m) => m.id) }), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/memory/page", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("memoriesPageData binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE memories; --";

  const page = asItems(await memoriesPageData(db, probe, freshDek()));
  assert.deepEqual(page, [], "the recording db returns no rows, so the memory list is empty");

  assertBoundNotSpliced(db, probe);
});

test("searchMemories binds the user id as a parameter and the search term never reaches a query", async () => {
  const db = recordingDb();
  const userProbe = "u'); DROP TABLE memories; --";
  const termProbe = "q'); DROP TABLE memories; --";

  const hits = asItems(await searchMemories(db, userProbe, freshDek(), termProbe));
  assert.deepEqual(hits, [], "the recording db returns no rows, so the search matches nothing");

  // The owner id is bound (the member filter is a real query); it is never spliced.
  assertBoundNotSpliced(db, userProbe);

  // The search term matches in the app over the already-filtered set, so it reaches NO
  // query at all — neither spliced into SQL text nor sent as a bound value.
  for (const call of db.calls) {
    assert.ok(!call.text.includes(termProbe), "the search term is never concatenated into the SQL");
    assert.ok(!call.values.includes(termProbe), "the search term is never sent to the query layer");
  }
});

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = memoryHandler(db, freshDek(), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = memoryHandler(db, freshDek(), "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ filler: "a".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler reads the SESSION user's memories and ignores a user id supplied in the body", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "handler-alice");
    const bob = await makeUser(db, "handler-bob");
    const dekA = freshDek();
    const dekB = freshDek();

    const aliceMem = await makeMemory(db, alice, dekA, { content: "alice note" });
    const bobMem = await makeMemory(db, bob, dekB, { content: "bob note" });

    // The handler is Alice's session; the body tries to pass BOB's id.
    const handler = memoryHandler(db, dekA, alice);
    const res = await handler(jsonRequest(JSON.stringify({ userId: bob })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const payload = (await res.json()) as { memoryIds: string[] };
    assert.ok(payload.memoryIds.includes(aliceMem), "the handler reads the session (Alice's) memories");
    assert.ok(!payload.memoryIds.includes(bobMem), "the body's user id is ignored — never widens the scope");
  } finally {
    await db.close();
  }
});

test("the handler searches only the SESSION user's memories when a query is supplied", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "handler-alice-q");
    const bob = await makeUser(db, "handler-bob-q");
    const dekA = freshDek();
    const dekB = freshDek();

    const aliceMatch = await makeMemory(db, alice, dekA, { content: "dentist appointment on Tuesday" });
    await makeMemory(db, alice, dekA, { content: "unrelated grocery list" });
    const bobMatch = await makeMemory(db, bob, dekB, { content: "dentist appointment on Friday" });

    const handler = memoryHandler(db, dekA, alice);
    const res = await handler(jsonRequest(JSON.stringify({ query: "dentist", userId: bob })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const payload = (await res.json()) as { memoryIds: string[] };
    assert.deepEqual(payload.memoryIds, [aliceMatch], "the search returns only Alice's matching memory");
    assert.ok(!payload.memoryIds.includes(bobMatch), "Bob's matching memory is never returned to Alice");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in a memory's content round-trips through the read and search as inert data", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const dek = freshDek();
    const probe = "Grace'); DROP TABLE memories; --";
    const created = await makeMemory(db, userId, dek, { content: probe });

    const page = asItems(await memoriesPageData(db, userId, dek));

    assert.equal(await tableExists(db, "memories"), true, "the memories table survives the read (the probe is data, not SQL)");
    const item = page.find((m) => m.id === created);
    assert.ok(item, "the memory is read back");
    assert.equal(item!.content, probe, "the probe content round-trips verbatim as data");

    // Searching a fragment of the probe finds it — the in-app match treats it as data,
    // and the table still survives.
    const hits = asItems(await searchMemories(db, userId, dek, "DROP TABLE"));
    assert.ok(hits.some((m) => m.id === created), "a fragment of the probe matches as data in the search");
    assert.equal(await tableExists(db, "memories"), true, "the memories table survives the search too");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 [obligation:secrets-from-env] (INV-103) — the read runs from its INJECTED deps
// alone (db, userId, dek): no secret, no ambient config; the content decrypts only under
// the injected DEK, so a different DEK cannot read it back (the key is injected, not baked
// in); and a decoy secret in the environment never lands in the page.
// ===========================================================================

test("memoriesPageData runs from injected deps alone: no secret and no ambient configuration", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "obl-secrets");
    const dek = freshDek();
    const created = await makeMemory(db, userId, dek, { content: "injected-deps-only" });

    // Only db / userId / dek — no connection string, no key read from env.
    const page = asItems(await memoriesPageData(db, userId, dek));

    assert.ok(page.some((m) => m.id === created), "the page reads the memory with no secret or env handed to it");
  } finally {
    await db.close();
  }
});

test("memoriesPageData cannot decrypt the owner's content with a different DEK (the key is injected, not baked in)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "obl-wrongdek");
    const realDek = freshDek();
    await makeMemory(db, userId, realDek, { content: "secret under the real dek" });

    const wrongDek = freshDek();
    await assert.rejects(
      () => memoriesPageData(db, userId, wrongDek),
      "a DEK that did not encrypt the content cannot read it back",
    );
  } finally {
    await db.close();
  }
});

test("searchMemories decrypts within the filtered set and rejects a DEK that cannot read the content", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "obl-search-wrongdek");
    const realDek = freshDek();
    await makeMemory(db, userId, realDek, { content: "renewal due in March under the real dek" });

    // The search decrypts WITHIN the owner-filtered set, so a wrong DEK fails the GCM tag
    // and rejects rather than silently matching nothing.
    const wrongDek = freshDek();
    await assert.rejects(
      () => searchMemories(db, userId, wrongDek, "renewal"),
      "a wrong DEK cannot decrypt the filtered set, so the search rejects",
    );
  } finally {
    await db.close();
  }
});

test("memoriesPageData folds no ambient env value into the page: a decoy secret in the environment never appears", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "obl-decoy");
    const dek = freshDek();
    await makeMemory(db, userId, dek, { content: "an ordinary memory" });

    const page = asItems(await memoriesPageData(db, userId, dek));

    assert.equal(page.length, 1, "the read works purely from the injected db — no app env needed");
    assert.ok(
      !JSON.stringify(page).includes(DECOY),
      "no ambient env value is folded into the returned page data",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
