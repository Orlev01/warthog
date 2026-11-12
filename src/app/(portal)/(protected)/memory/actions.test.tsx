// E13-S11 — Memory page loader + actions
// (`src/app/(portal)/(protected)/memory/actions.ts`, mounted by the thin
// `memory/page.tsx`).
//
// RED-first: the memory-page actions seam does NOT exist yet, so importing
// `./actions` throws (ERR_MODULE_NOT_FOUND) and `tsc --noEmit` reddens on the
// missing module — every test here fails until the builder writes it. That absence
// IS the point of test-first; do NOT implement anything to make these pass. The
// builder writes `actions.ts` afterwards to satisfy exactly this contract and wires
// the thin `page.tsx` over it.
//
// These tests pin BEHAVIOUR (what the loader RETURNS and the view it mounts; what
// each mutation CHANGES in the database; what each one REFUSES) against an isolated
// in-memory PGlite with the REAL migrations (src/test/db) and the REAL already-built
// seams the actions compose — the memories store (`db/memories`, DEK-encrypted
// content + plaintext source/scope/time metadata, member-scoped by user id), the
// Memory page read (`server/memory/page-data`, list-all + search, E13-S09), the
// agents store (`db/agents`, to resolve a memory's source agent to a DISPLAY NAME)
// and the already-render-tested <MemoryView/> (E13-S10). No test asserts on the
// source text of any module, so a later behaviour-preserving refactor (a rename, a
// moved import, a reworded label) stays green.
//
// Where the task names an entry/page file, the testable seam lives in the plain
// SIBLING module `actions.ts` (the convention's `createXActions(deps)` factory, as
// `skills/actions.ts`, `vault/actions.ts`, `connectors/actions.ts` and
// `agents/actions.ts` do) — NEVER on the thin `page.tsx`, which may export only its
// framework fields (`next build` rejects any other export, OBS-025). These tests
// drive that factory directly with real seams; the page mounts a thin loader +
// `"use server"` wrappers over it. A server PAGE that reads the session cookie +
// database cannot be rendered without a live request scope, so — exactly like the
// sibling skills/vault/activity loader tests — the loader's data assembly is pinned
// on the factory's `load`, and the SCREEN it mounts is pinned by feeding `load`'s
// output straight into <MemoryView/>.
//
// WHY this exists (task E13-S11; brief §"Skills, preferences and shared memory";
// design §4.1; CLAUDE.md — memories are PERSONAL CONTENT stored DEK-encrypted and
// every member-scoped read/write takes userId from the session, never a client
// value). The memory triad reads the person's memories server-side and mounts the
// view; the actions add the person's own memory and edit / re-scope / delete any of
// the person's memories.
//
// ─── The contract this task defines (the builder implements exactly this) ───────────
//
//   type MemoryScope = "kept" | "shared";
//
//   // One memory shaped for the view: id, decrypted content, a PRE-FORMATTED saved-at
//   // label, the saving agent's DISPLAY NAME (null when the PERSON added it) and scope.
//   // (The same shape <MemoryView/> is mounted over — the loader output IS the view's
//   // input.)
//   interface MemoryViewItem { id; content; savedAt; sourceAgentName; scope }
//
//   createMemoryActions(deps: { db: Db; keyWrapper: KeyWrapper; clock: Clock }): {
//     // read ONLY the session user's memories (member-scoped by session.userId),
//     // content decrypted under their own DEK, each source agent resolved to a display
//     // name and each saved time formatted to a label — shaped into the props
//     // <MemoryView/> is mounted over. An optional search `query` filters to the
//     // matching memories (within the owner set) and is echoed back.
//     load(session, query?): Promise<{ memories: MemoryViewItem[]; query: string | null }>
//
//     // add the PERSON's OWN memory (no source agent). content + scope.
//     addMemory(session, { content; scope }): Promise<Result>
//
//     // replace an OWNED memory's content in place (id validated at the boundary; a
//     // memory that is not the session user's is refused and left unchanged).
//     editMemory(session, { id; content }): Promise<Result>
//
//     // change an OWNED memory's scope kept ⇄ shared (id validated; a foreign memory
//     // is refused and left unchanged).
//     rescopeMemory(session, { id; scope }): Promise<Result>
//
//     // delete an OWNED memory (id validated; a foreign memory is a safe no-op refusal).
//     deleteMemory(session, { id }): Promise<Result>
//   }
//
//   Result = { ok: true } | { ok: false; reason: string }   // never a silent success
//
//   • every read/write is member-scoped by session.userId (the project rule + INV-102):
//     another person's memories are never read, changed or removed by id.
//   • input is validated at the boundary (zod → a 4xx HttpError) BEFORE anything is
//     written, so malformed / oversized input writes nothing (INV-102). A malformed
//     memory id is rejected as a 4xx BEFORE it can reach `WHERE id = $1` as a cast
//     (OBS-049). Every value reaches storage bound as a query parameter (and the
//     content is additionally DEK-encrypted first), so a value shaped like SQL is
//     stored as data and cannot alter a query.
//   • the module reads no process.env and holds no secret (INV-103): the db, the
//     KeyWrapper and the Clock are INJECTED seams, so no ambient env value lands in
//     any output.
//
// ─── NOTE on the acceptance-criterion wording vs. this codebase ──────────────────────
// AC2 says "a memory id that is not a positive INTEGER is rejected with a 4xx". That
// phrasing is generic obligation boilerplate (serial catalogue ids); in Warthog
// `memories.id` is a `uuid` (db/migrations — the memories store generates it with
// `randomUUID()`), and the sibling stores/actions validate ids with `z.uuid()`. The
// obligation here is OBS-049 / validate-and-parameterize-input: a MALFORMED id is
// rejected at the boundary with a 4xx before it can reach `WHERE id = $1` as a cast.
// We honour the obligation using the ACTUAL id shape — and the malformed probes below
// include a bare integer, a negative, a decimal and the empty string, so "not a
// positive integer is rejected" holds true as a special case of "not a well-formed
// uuid is rejected".
//
// ─── Acceptance criteria → tests ────────────────────────────────────────────────────
//   AC1  the loader reads ONLY the session user's memories and mounts MemoryView over
//        them (wired to addMemory / editMemory / rescopeMemory / deleteMemory).
//   AC2  a malformed memory id is rejected with a 4xx (not a raw cast).
//   AC3  a signed-in user cannot READ or CHANGE another user's memories by id
//        (filtered by session user id).
//   AC4  a handler rejects malformed / oversized input with a 4xx, and a SQL-injection
//        probe in an input field cannot alter a query (parameter binding).  [validate-and-parameterize-input]
//   AC5  no secret value lands in a loaded/saved result; config is read from env.      [secrets-from-env]
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// test uses its own freshDb(). The signed-in person is a REAL user row (every member
// table's user_id is a foreign key to users(id)) whose stored wrapped DEK really
// unwraps under the test KeyWrapper, so content round-trips decrypted. We render
// MemoryView with `react-dom/server` (no DOM/jsdom — React component / E2E testing is
// a per-job ADR), exactly as the sibling view + loader tests do.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createMemoryActions } from "./actions";

import { MemoryView } from "@/components/memory/memory-view";
import { createUser } from "@/server/db/users";
import { createAgent } from "@/server/db/agents";
import {
  createMemory as seedMemory,
  listMemoriesForUser,
  type MemoryScope,
} from "@/server/db/memories";
import { HttpError } from "@/server/http/validate";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock, systemClock, type Clock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

// --- fixtures -----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // a 256-bit key-encryption key for the local AES wrapper
const NOW = new Date("2026-06-01T00:00:00.000Z");

// A real local KeyWrapper (dev/test), exactly the one a non-production composition
// root selects — so wrap/unwrap is genuine, not a stub.
function makeKeyWrapper(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose stored wrapped-DEK really unwraps (under `keyWrapper`) to the
// returned `dek`, so content saved by the actions round-trips decrypted through the
// store, and the loader can decrypt what it reads back. Emails are uniquified so
// parallel test files never collide on users.email UNIQUE.
async function makeUserWithDek(
  db: Db,
  keyWrapper: KeyWrapper,
  who: string,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek,
  });
  return { userId: user.id, dek };
}

// Give `userId` one of their OWN agents and return it (its id is a valid source agent;
// its display name is what the loader must resolve a memory's source agent to).
async function makeAgent(db: Db, userId: string, name: string): Promise<{ id: string; displayName: string }> {
  const agent = await createAgent(
    db,
    { userId, connectionId: randomUUID(), displayName: name, platform: "claude" },
    systemClock,
  );
  return { id: agent.id, displayName: agent.displayName };
}

// Save a memory for `userId` directly through the store (DEK-encrypted), stamping its
// created time from a frozen clock so ordering is deterministic. Returns its id.
// A caller that omits `sourceAgentId` gets an agent-shaped source; one that passes
// `null` keeps null (the PERSON saved it).
async function seedOne(
  db: Db,
  userId: string,
  dek: Uint8Array,
  fields: { content: string; sourceAgentId?: string | null; scope?: MemoryScope },
  when: Date = new Date("2026-11-07T00:00:00.000Z"),
): Promise<string> {
  const sourceAgentId: string | null =
    "sourceAgentId" in fields ? (fields.sourceAgentId ?? null) : randomUUID();
  const mem = await seedMemory(
    db,
    { userId, content: fields.content, sourceAgentId, scope: fields.scope ?? "shared" },
    dek,
    fixedClock(when),
  );
  return mem.id;
}

// A plain signed-in session for `userId` — the page resolves this from the
// `__Host-wh_session` cookie; the seam only needs its user id.
function sessionFor(userId: string): Session {
  return {
    id: `sess-${userId}`,
    userId,
    createdAt: new Date(NOW.getTime() - 60_000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    steppedUpAt: null,
  };
}

// Build the memory actions under test with the real db + keyWrapper + clock seams.
function makeActions(db: Db, keyWrapper: KeyWrapper, clock: Clock = fixedClock(NOW)) {
  return createMemoryActions({ db, keyWrapper, clock });
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields
// the relation name when it exists and NULL when it does not — a non-throwing probe
// scoped to the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Visible text with tags stripped: the words a sighted reader sees (no attributes).
function strip(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&middot;|&#xb7;/gi, "·")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- types/casts derived from the factory (so tests don't hard-code a type NAME) ----
type Actions = ReturnType<typeof createMemoryActions>;
type SaveResult = Awaited<ReturnType<Actions["addMemory"]>>;
type LoadedItem = Awaited<ReturnType<Actions["load"]>>["memories"][number];

// Cast a loose object (what an untrusted form body could carry) to a method's input
// type, so a test can pass a partial, a malformed value, or a smuggled rogue key
// without a type error — exactly what an untrusted body could carry.
const addInput = (o: Record<string, unknown>): Parameters<Actions["addMemory"]>[1] =>
  o as unknown as Parameters<Actions["addMemory"]>[1];
const editInput = (o: Record<string, unknown>): Parameters<Actions["editMemory"]>[1] =>
  o as unknown as Parameters<Actions["editMemory"]>[1];
const rescopeInput = (o: Record<string, unknown>): Parameters<Actions["rescopeMemory"]>[1] =>
  o as unknown as Parameters<Actions["rescopeMemory"]>[1];
const deleteInput = (o: Record<string, unknown>): Parameters<Actions["deleteMemory"]>[1] =>
  o as unknown as Parameters<Actions["deleteMemory"]>[1];

const okOf = (r: unknown): boolean => (r as { ok: boolean }).ok;

// Assert that awaiting `fn()` rejects with a 4xx HttpError (the validation boundary).
async function assertRejects4xx(label: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    assert.ok(
      err instanceof HttpError,
      `${label}: must be rejected at the validation boundary (HttpError), got ${String(err)}`,
    );
    assert.ok(
      (err as HttpError).status >= 400 && (err as HttpError).status < 500,
      `${label}: the rejection must carry a 4xx status, got ${(err as HttpError).status}`,
    );
  }
  assert.ok(threw, `${label}: must be rejected (nothing was thrown)`);
}

// Assert a mutation is REFUSED — either a thrown 4xx HttpError or a reported
// { ok: false } refusal, never a silent success and never an uncontrolled 500. (An
// ownership refusal that depends on stored state may legitimately be reported rather
// than thrown; this accepts both, but a thrown plain Error — a raw 500 — fails.)
async function assertRejected(label: string, fn: () => Promise<SaveResult>): Promise<void> {
  let result: SaveResult | undefined;
  try {
    result = await fn();
  } catch (err) {
    assert.ok(
      err instanceof HttpError && err.status >= 400 && err.status < 500,
      `${label}: a thrown rejection must be a 4xx HttpError (not a raw 500), got ${String(err)}`,
    );
    return;
  }
  assert.equal(
    okOf(result),
    false,
    `${label}: the mutation must be refused (ok:false), not a silent success`,
  );
}

// =====================================================================================
// AC1 — the loader reads ONLY the session user's memories and mounts MemoryView over
// them (wired to addMemory / editMemory / rescopeMemory / deleteMemory).
// =====================================================================================

test("the loader returns the session user's memories, shaped for the view, and mounts MemoryView over them", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "loader-ok");
    const claude = await makeAgent(db, userId, "Claude");

    // An agent-sourced SHARED memory and a PERSON-added KEPT memory, at distinct times.
    const AGENT_CONTENT = "Moving on 1 Dec to the new house by the river";
    const OWN_CONTENT = "Allergic to penicillin";
    const agentMem = await seedOne(
      db,
      userId,
      dek,
      { content: AGENT_CONTENT, sourceAgentId: claude.id, scope: "shared" },
      new Date("2026-11-01T09:00:00.000Z"),
    );
    const ownMem = await seedOne(
      db,
      userId,
      dek,
      { content: OWN_CONTENT, sourceAgentId: null, scope: "kept" },
      new Date("2026-11-02T09:00:00.000Z"),
    );

    const data = await makeActions(db, keyWrapper).load(sessionFor(userId));
    const byId = new Map(data.memories.map((m: LoadedItem) => [m.id, m]));

    // Both of the owner's memories come back, content decrypted, scope carried.
    assert.equal(data.memories.length, 2, "both of the owner's memories are listed");
    assert.equal(byId.get(agentMem)!.content, AGENT_CONTENT, "the agent memory's content round-trips decrypted");
    assert.equal(byId.get(ownMem)!.content, OWN_CONTENT, "the person memory's content round-trips decrypted");
    assert.equal(byId.get(agentMem)!.scope, "shared", "the agent memory carries scope 'shared'");
    assert.equal(byId.get(ownMem)!.scope, "kept", "the person memory carries scope 'kept'");

    // The source agent id is resolved to the agent's DISPLAY NAME; a person-added
    // memory has no source agent name (null).
    assert.equal(
      byId.get(agentMem)!.sourceAgentName,
      "Claude",
      "the agent memory's source agent id is resolved to its display name",
    );
    assert.equal(
      byId.get(ownMem)!.sourceAgentName,
      null,
      "the person-added memory has no source agent name (null)",
    );

    // Each carries a PRE-FORMATTED saved-at label (a non-empty string — the view shows
    // it verbatim, so it must be ready to render, not a raw Date).
    for (const m of data.memories as LoadedItem[]) {
      assert.equal(typeof m.savedAt, "string", `memory ${m.id} carries a string saved-at label`);
      assert.ok((m.savedAt as string).length > 0, `memory ${m.id}'s saved-at label is non-empty`);
    }

    // "mounts MemoryView": the loader's output IS the screen's data — feeding it
    // straight into the already-render-tested view renders the owner's memory screen.
    const markup = renderToStaticMarkup(<MemoryView memories={data.memories} query={data.query} />);
    const text = strip(markup);
    assert.ok(text.includes(AGENT_CONTENT), "mounting MemoryView renders the agent memory's content");
    assert.ok(text.includes(OWN_CONTENT), "mounting MemoryView renders the person memory's content");
    assert.ok(text.includes("Claude"), "the resolved source-agent name renders");
    assert.ok(
      text.includes(byId.get(agentMem)!.savedAt as string),
      "the pre-formatted saved-at label renders verbatim",
    );
  } finally {
    await db.close();
  }
});

test("the loader exposes add / edit / re-scope / delete, each wired to the memories store", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "wiring");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    // The four mutation controls the page wires into MemoryView all exist as callable
    // seam methods (a dead control would be one that is missing or never persists).
    for (const name of ["addMemory", "editMemory", "rescopeMemory", "deleteMemory"] as const) {
      assert.equal(typeof actions[name], "function", `the actions expose ${name}`);
    }

    // add → a new person-added memory exists, with the given content and scope and NO
    // source agent (the person authored it).
    const added = await actions.addMemory(session, addInput({ content: "Prefers morning meetings", scope: "shared" }));
    assert.equal(okOf(added), true, "addMemory succeeds for the session user");
    let stored = await listMemoriesForUser(db, userId, dek);
    const mine = stored.find((m) => m.content === "Prefers morning meetings");
    assert.ok(mine != null, "the added memory is stored, decrypted content round-trips");
    assert.equal(mine!.sourceAgentId, null, "a person-added memory has no source agent");
    assert.equal(mine!.scope, "shared", "the added memory carries the chosen scope");

    // edit → the content is replaced in place (same id).
    const edited = await actions.editMemory(session, editInput({ id: mine!.id, content: "Prefers afternoon meetings" }));
    assert.equal(okOf(edited), true, "editMemory succeeds on the owner's memory");
    stored = await listMemoriesForUser(db, userId, dek);
    const afterEdit = stored.find((m) => m.id === mine!.id);
    assert.equal(afterEdit!.content, "Prefers afternoon meetings", "the edit replaced the content in place");

    // re-scope → the scope flips, content preserved.
    const rescoped = await actions.rescopeMemory(session, rescopeInput({ id: mine!.id, scope: "kept" }));
    assert.equal(okOf(rescoped), true, "rescopeMemory succeeds on the owner's memory");
    stored = await listMemoriesForUser(db, userId, dek);
    const afterRescope = stored.find((m) => m.id === mine!.id);
    assert.equal(afterRescope!.scope, "kept", "the re-scope changed the scope");
    assert.equal(afterRescope!.content, "Prefers afternoon meetings", "the re-scope preserved the content");

    // delete → the memory is gone.
    const deleted = await actions.deleteMemory(session, deleteInput({ id: mine!.id }));
    assert.equal(okOf(deleted), true, "deleteMemory succeeds on the owner's memory");
    stored = await listMemoriesForUser(db, userId, dek);
    assert.ok(!stored.some((m) => m.id === mine!.id), "the deleted memory is gone");
  } finally {
    await db.close();
  }
});

test("the loader filters to the matching memories when a search query is given, and echoes the query", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "loader-search");
    const actions = makeActions(db, keyWrapper);

    const moving = await seedOne(
      db,
      userId,
      dek,
      { content: "Moving on 1 Dec to the new address" },
      new Date("2026-11-01T00:00:00.000Z"),
    );
    await seedOne(
      db,
      userId,
      dek,
      { content: "Prefers an aisle seat when booking flights" },
      new Date("2026-11-02T00:00:00.000Z"),
    );

    // No query → all memories, and no active search echoed back (null / undefined / "").
    const all = await actions.load(sessionFor(userId));
    assert.equal(all.memories.length, 2, "with no query the loader returns all of the owner's memories");
    assert.ok(all.query == null || all.query === "", "with no query the echoed query is empty (no active search)");

    // A query → only the matching memory, and the query is echoed back so the search
    // box stays prefilled.
    const hits = await actions.load(sessionFor(userId), "address");
    assert.deepEqual(
      hits.memories.map((m: LoadedItem) => m.id),
      [moving],
      "the loader returns only the memory whose content matches the query",
    );
    assert.equal(hits.query, "address", "the search query is echoed back");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — a malformed memory id is rejected with a 4xx before any query (OBS-049): it
// never reaches `WHERE id = $1` as a cast. (A bare integer is rejected, which subsumes
// the criterion's "not a positive integer is rejected".)
// =====================================================================================

test("a malformed memory id is rejected with a 4xx before any query — edit / re-scope / delete", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId } = await makeUserWithDek(db, keyWrapper, "bad-id");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    // Not a well-formed uuid — a bare integer, a negative, a decimal, the empty string,
    // whitespace, a non-uuid word and a SQL-shaped id. Each is rejected at the boundary
    // BEFORE it can reach `WHERE id = $1` as a cast (so it never surfaces as a 500, and
    // the SQL-shaped id never reaches a query).
    const badIds = ["5", "-1", "1.5", "", "   ", "not-a-uuid", "x'; DROP TABLE memories; --"];
    for (const badId of badIds) {
      await assertRejects4xx(`editMemory(id=${JSON.stringify(badId)})`, () =>
        actions.editMemory(session, editInput({ id: badId, content: "x" })),
      );
      await assertRejects4xx(`rescopeMemory(id=${JSON.stringify(badId)})`, () =>
        actions.rescopeMemory(session, rescopeInput({ id: badId, scope: "kept" })),
      );
      await assertRejects4xx(`deleteMemory(id=${JSON.stringify(badId)})`, () =>
        actions.deleteMemory(session, deleteInput({ id: badId })),
      );
    }

    // The table is intact — no SQL-shaped id was ever executed.
    assert.equal(await tableExists(db, "memories"), true, "the memories table survives a SQL-shaped id");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a signed-in user cannot READ or CHANGE another person's memories by id
// (filtered by session user id).
// =====================================================================================

test("the loader reads ONLY the session user's memories — another person's never appear", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const alice = await makeUserWithDek(db, keyWrapper, "read-victim");
    const bob = await makeUserWithDek(db, keyWrapper, "read-other");
    const actions = makeActions(db, keyWrapper);

    await seedOne(db, alice.userId, alice.dek, { content: "Alice only secret note" });
    const bobMem = await seedOne(db, bob.userId, bob.dek, { content: "Bob own note" });

    const bobsScreen = await actions.load(sessionFor(bob.userId));

    assert.ok(
      bobsScreen.memories.some((m: LoadedItem) => m.id === bobMem),
      "Bob sees his own memory",
    );
    const whole = JSON.stringify(bobsScreen);
    assert.ok(!whole.includes("Alice only secret note"), "Alice's memory never appears on Bob's screen");
  } finally {
    await db.close();
  }
});

test("a signed-in user cannot CHANGE another person's memory by id — it is untouched", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const alice = await makeUserWithDek(db, keyWrapper, "change-victim");
    const bob = await makeUserWithDek(db, keyWrapper, "change-attacker");
    const actions = makeActions(db, keyWrapper);

    const alicesMem = await seedOne(
      db,
      alice.userId,
      alice.dek,
      { content: "Alice secret memory", scope: "shared" },
    );

    // Bob, holding Alice's real (well-formed) memory id, tries every mutation on it.
    // Each is refused (member-scoped by Bob's session id) — never an uncontrolled 500.
    await assertRejected("editMemory(bob → alice's memory)", () =>
      actions.editMemory(sessionFor(bob.userId), editInput({ id: alicesMem, content: "hijacked" })),
    );
    await assertRejected("rescopeMemory(bob → alice's memory)", () =>
      actions.rescopeMemory(sessionFor(bob.userId), rescopeInput({ id: alicesMem, scope: "kept" })),
    );
    await assertRejected("deleteMemory(bob → alice's memory)", () =>
      actions.deleteMemory(sessionFor(bob.userId), deleteInput({ id: alicesMem })),
    );

    // Alice's memory is unchanged: still present, same content, still shared.
    const alices = await listMemoriesForUser(db, alice.userId, alice.dek);
    const stillThere = alices.find((m) => m.id === alicesMem);
    assert.ok(stillThere != null, "Alice's memory still exists after Bob's refused attempts");
    assert.equal(stillThere!.content, "Alice secret memory", "Alice's memory content is unchanged");
    assert.equal(stillThere!.scope, "shared", "Alice's memory scope was not changed by Bob");

    // Bob's borrowed-id delete removed nothing and gained him nothing.
    assert.equal(alices.length, 1, "Alice still has exactly her one memory");
    assert.deepEqual(await listMemoriesForUser(db, bob.userId, bob.dek), [], "Bob gained no memory from the borrowed id");
  } finally {
    await db.close();
  }
});

test("addMemory takes the owner from the session — a userId smuggled in the input is ignored", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const session = await makeUserWithDek(db, keyWrapper, "scope-session");
    const victim = await makeUserWithDek(db, keyWrapper, "scope-victim");
    const actions = makeActions(db, keyWrapper);

    // The input tries to write under the victim's id.
    const saved = await actions.addMemory(
      sessionFor(session.userId),
      addInput({ content: "Smuggled memory", scope: "shared", userId: victim.userId }),
    );
    assert.equal(okOf(saved), true, "the add succeeds under the session user");

    // It landed under the SESSION user, never the smuggled victim id.
    assert.ok(
      (await listMemoriesForUser(db, session.userId, session.dek)).some((m) => m.content === "Smuggled memory"),
      "the memory is stored under the session user",
    );
    assert.deepEqual(
      await listMemoriesForUser(db, victim.userId, victim.dek),
      [],
      "the smuggled userId never redirected the write to another person",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — a handler rejects malformed / oversized input with a 4xx, and a SQL-injection
// probe in an input field is bound as data (parameter binding).
// [obligation:validate-and-parameterize-input]
// =====================================================================================

test("malformed input is rejected with a 4xx and nothing is persisted", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "malformed");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    // addMemory: an unknown scope value, a missing content, a content that is not a string.
    await assertRejects4xx("addMemory(unknown scope)", () =>
      actions.addMemory(session, addInput({ content: "x", scope: "everyone" })),
    );
    await assertRejects4xx("addMemory(missing content)", () =>
      actions.addMemory(session, addInput({ scope: "shared" })),
    );
    await assertRejects4xx("addMemory(content not a string)", () =>
      actions.addMemory(session, addInput({ content: 42, scope: "shared" })),
    );
    await assertRejects4xx("addMemory(missing scope)", () =>
      actions.addMemory(session, addInput({ content: "x" })),
    );
    // rescopeMemory: an unknown scope value (with a well-formed id so it is the scope,
    // not the id, that is rejected).
    await assertRejects4xx("rescopeMemory(unknown scope)", () =>
      actions.rescopeMemory(session, rescopeInput({ id: randomUUID(), scope: "everyone" })),
    );
    // editMemory: a missing / non-string content (with a well-formed id).
    await assertRejects4xx("editMemory(content not a string)", () =>
      actions.editMemory(session, editInput({ id: randomUUID(), content: 7 })),
    );

    // Nothing was persisted by any rejected call.
    assert.deepEqual(await listMemoriesForUser(db, userId, dek), [], "no malformed memory was stored");
  } finally {
    await db.close();
  }
});

test("content of only spaces is refused like empty content, on add and on edit (interaction-02)", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "blank");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    for (const content of ["", "    ", "\n\t  \n"]) {
      await assertRejects4xx(`addMemory(${JSON.stringify(content)})`, () =>
        actions.addMemory(session, addInput({ content, scope: "shared" })),
      );
    }
    assert.deepEqual(await listMemoriesForUser(db, userId, dek), [], "no blank memory was stored");

    await actions.addMemory(session, addInput({ content: "  Prefers aisle seats  ", scope: "shared" }));
    const [saved] = await listMemoriesForUser(db, userId, dek);
    assert.equal(saved!.content, "Prefers aisle seats", "the stored memory is trimmed");
    await assertRejects4xx("editMemory(spaces only)", () =>
      actions.editMemory(session, editInput({ id: saved!.id, content: "   " })),
    );
    assert.equal((await listMemoriesForUser(db, userId, dek))[0]!.content, "Prefers aisle seats", "a blank edit changes nothing");
  } finally {
    await db.close();
  }
});

test("oversized input is rejected with a 4xx and nothing is persisted", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "oversized");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);
    const HUGE = "x".repeat(200_000);

    await assertRejects4xx("addMemory(oversized content)", () =>
      actions.addMemory(session, addInput({ content: HUGE, scope: "shared" })),
    );
    await assertRejects4xx("editMemory(oversized content)", () =>
      actions.editMemory(session, editInput({ id: randomUUID(), content: HUGE })),
    );

    assert.deepEqual(await listMemoriesForUser(db, userId, dek), [], "no oversized memory was stored");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in a memory's content is bound as data: the table survives and the value round-trips", async () => {
  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "sqli-add");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    // If the content were concatenated into the statement text it would corrupt the
    // query (or run the trailing statement); bound as a parameter it is inert — and here
    // additionally DEK-encrypted before it is bound.
    const probe = "Robert'); DROP TABLE memories; --";
    const added = await actions.addMemory(session, addInput({ content: probe, scope: "shared" }));
    assert.equal(okOf(added), true, "a content shaped like SQL is accepted and stored as data");

    assert.equal(await tableExists(db, "memories"), true, "the memories table survives the add probe");
    const stored = await listMemoriesForUser(db, userId, dek);
    const row = stored.find((m) => m.content === probe);
    assert.ok(row != null, "the SQL-shaped content round-trips verbatim as data (decrypted)");

    // The same probe through an EDIT is also bound as data, not executed.
    const probe2 = "x'); DROP TABLE memories; --";
    const edited = await actions.editMemory(session, editInput({ id: row!.id, content: probe2 }));
    assert.equal(okOf(edited), true, "a SQL-shaped edit content is accepted and stored as data");
    assert.equal(await tableExists(db, "memories"), true, "the memories table survives the edit probe");
    const afterEdit = (await listMemoriesForUser(db, userId, dek)).find((m) => m.id === row!.id);
    assert.equal(afterEdit!.content, probe2, "the SQL-shaped edit content round-trips verbatim as data");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC5 — no secret value lands in a loaded/saved result; config is read from env.
// [obligation:secrets-from-env] — the module reads no process.env and holds no secret,
// so no ambient env value can leak into what it stores or the screen it loads.
// =====================================================================================

test("no ambient env secret leaks into any stored row or the loaded screen; the actions run from their injected seams alone", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prevDecoy = process.env.WARTHOG_DECOY_SECRET;
  const prevDbUrl = process.env.DATABASE_URL;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  // Prove the actions do not reach for an ambient database URL: point it at a decoy and
  // rely solely on the injected db seam.
  process.env.DATABASE_URL = `postgres://decoy:${DECOY}@127.0.0.1:1/decoy`;

  const db = await freshDb();
  const keyWrapper = makeKeyWrapper();
  try {
    const { userId, dek } = await makeUserWithDek(db, keyWrapper, "env-user");
    const actions = makeActions(db, keyWrapper);
    const session = sessionFor(userId);

    const added = await actions.addMemory(session, addInput({ content: "An ordinary memory", scope: "shared" }));
    assert.equal(okOf(added), true, "the add works from the injected seams with a decoy env present");

    // The decoy appears in neither the loaded screen…
    const data = await actions.load(session);
    assert.ok(
      data.memories.some((m: LoadedItem) => m.content === "An ordinary memory"),
      "the loader works from its injected inputs alone",
    );
    assert.ok(!JSON.stringify(data).includes(DECOY), "no ambient env value is folded into the loaded screen");

    // …nor the stored rows.
    assert.ok(
      !JSON.stringify(await listMemoriesForUser(db, userId, dek)).includes(DECOY),
      "no ambient env value is folded into the stored memory",
    );
  } finally {
    await db.close();
    if (prevDecoy === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prevDecoy;
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
  }
});
