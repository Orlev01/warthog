// E10-S01 — Agents store (`src/server/db/agents.ts`, `db/migrations/0020_agents.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./agents` throws and `freshDb()` has no `agents` table — every test here fails until
// the builder adds them. That absence IS the point of test-first; do NOT implement
// anything to make these pass — the builder writes the module and the migration
// afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: the stored identity,
// the list-all read, who may read/mutate what, the activity bump, what a handler
// rejects, that every value is bound as a parameter), never the source text of the
// module or the SQL file — a later rename that preserves behaviour must not redden them.
//
// WHY this exists (brief "Agent list" / "Home" / "spending"; CLAUDE.md vocabulary:
// an *agent* is a connected AI client, `agentId`, ONE ROW PER CONNECTION): the agent
// list, Home and the spending view read an agent's identity (display name, platform,
// status, connected date) and its activity (last-active time, request count). The agent
// is born from its OAuth connection (design §6.1), so one row here is linked to one
// connection. These fields are PLAINTEXT METADATA (design §4.1) — needed for the list
// and for filtering — so, unlike held-request args or approval detail, they are NOT
// DEK-encrypted and this module holds no key and reads no `process.env`.
//
// The `connectionId` is an opaque uuid here: the connections table is created by a
// later migration, so — exactly like 0009/0011/0012/0013 bind `agent_id`/`connection_id`
// as a plain column — this store binds `connectionId` by value, with ownership enforced
// by the session's `user_id`, not a foreign key to a table that does not exist yet.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type AgentStatus = "connected" | "disconnected";  // a connected agent vs. a
//                                                      // disconnected (revoked) one
//
//   interface NewAgent {        // what createAgent records
//     userId: string;           // the owner (the session's / connection's id, NEVER a
//                               // client value)
//     connectionId: string;     // the OAuth connection this agent IS (one row per connection)
//     displayName: string;      // the agent's display name
//     platform: string;         // the platform: claude | chatgpt | gemini | grok | llama
//                               // (a free string in the store — not constrained here)
//     status?: AgentStatus;     // defaults to "connected" (a freshly connected agent)
//   }
//
//   interface Agent {           // an agent as handed back to callers
//     id: string;               // the agentId — identifies the agent in the portal
//     userId: string;
//     connectionId: string;
//     displayName: string;
//     platform: string;
//     status: AgentStatus;
//     connectedAt: Date | string;         // the connected date (= clock.now() on create)
//     lastActiveAt: Date | string | null; // null until the first recorded tool call
//     requestCount: number;               // 0 on create; +1 per recordAgentActivity
//   }
//
//   createAgent(db, input: NewAgent, clock): Promise<Agent>
//     • records name / platform / status / connectedAt (= clock.now()) linked to
//       `connectionId`, with requestCount 0 and lastActiveAt null, and returns the Agent
//       (carrying a generated, non-empty id). Assembles the returned Agent from its
//       inputs (it does not depend on a RETURNING read), like createHeldRequest.
//   listAgentsForUser(db, userId): Promise<Agent[]>
//     • ALL of `userId`'s agents (member-scoped: WHERE user_id bound); never another
//       person's. Empty array when the person has none.
//   getAgentById(db, userId, id): Promise<Agent | null>
//     • the one agent OWNED BY `userId` (member-scoped: id AND user_id both bound); null
//       when none for this user — so another person's agent id returns null.
//   recordAgentActivity(db, { userId, id }, clock): Promise<Agent>
//     • member-scoped: for the owned agent, increments requestCount by 1 and sets
//       lastActiveAt = clock.now() (connectedAt and the rest untouched); returns the
//       updated Agent. THROWS (never silently) when no agent with that id belongs to
//       this user — so one person can never mutate another's agent.
//
// Acceptance criteria → tests:
//   AC1 "Creating an agent records name, platform, status and connected date linked to a
//        connection, and listAgentsForUser returns all of the owner's agents." —
//        createAgent returns an id and the recorded identity; listAgentsForUser returns
//        every one of the owner's agents and none of anyone else's.
//   AC2 "last-active and request count update when the agent calls a tool." —
//        recordAgentActivity bumps requestCount and stamps lastActiveAt from the injected
//        clock; repeated calls accumulate; connectedAt is untouched.
//   AC3 "A user cannot read or mutate another user's agent by id (filtered by session
//        user id)." — B's getAgentById on A's id returns null, B never sees A's agents in
//        a list, and B's recordAgentActivity on A's id is refused and leaves A's agent
//        untouched; the user id is bound as a parameter.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed
//        input with a 4xx before any query runs; a SQL-injection probe routed through the
//        repo travels as a BOUND value (placeholders, never concatenation) and cannot drop
//        the table. The handler below is a test fixture (the intended usage), not an
//        implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — enforced by construction: the repo takes
//        `db` as its data dependency, holds no key and reads no `process.env` (config
//        flows from `src/server/config.ts` alone). Shown behaviourally: the agents read
//        and write purely from the injected db with no app env configured, and a decoy
//        secret planted in the environment never lands in the stored or returned agent.
//   Migration: the `agents` relation exists after the project migrations and a second run
//        of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { createAgent, listAgentsForUser, getAgentById, recordAgentActivity } from "./agents";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

// Connection ids are uuids (an opaque uuid column, like agent_id / connection_id
// elsewhere); use valid uuids so a `uuid` column accepts them.
const CONN_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CONN_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CONN_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const CONN_D = "dddddddd-dddd-dddd-dddd-dddddddddddd";

// Instants deliberately in the past relative to the wall clock, so anything that wrongly
// read Date.now() instead of the injected clock would diverge here. T0 is the connected
// date; T1/T2 are later tool-call instants.
const T0 = new Date("2026-03-01T09:00:00.000Z");
const T1 = new Date("2026-03-01T10:30:00.000Z");
const T2 = new Date("2026-03-02T14:15:00.000Z");

// Compare the moment, not the representation: connectedAt / lastActiveAt may come back as
// a Date or an ISO string — either is a reasonable choice and must not redden a test.
const ms = (value: Date | string | number): number => new Date(value as never).getTime();

// requestCount is a number in the contract, but a driver may hand an integer column back
// as a string; normalise before comparing so the representation does not redden a test.
const count = (value: unknown): number => Number(value);

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
// AC1 — creating records an agent's identity linked to a connection; listAgentsForUser
// returns all of the owner's agents.
// ===========================================================================

test("createAgent returns an agent with an id, the recorded identity, and the injected connected date", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");

    const created = await createAgent(
      db,
      { userId, connectionId: CONN_A, displayName: "My Claude", platform: "claude" },
      fixedClock(T0),
    );

    assert.equal(typeof created.id, "string", "createAgent returns an id string");
    assert.ok(created.id.length > 0, "the returned id is non-empty");
    assert.equal(created.userId, userId, "the agent belongs to the creating person");
    assert.equal(created.connectionId, CONN_A, "it is linked to its OAuth connection");
    assert.equal(created.displayName, "My Claude", "the display name is recorded");
    assert.equal(created.platform, "claude", "the platform is recorded");
    assert.equal(created.status, "connected", "a freshly connected agent defaults to connected");
    assert.equal(ms(created.connectedAt), ms(T0), "connectedAt is the injected clock instant");
    assert.equal(count(created.requestCount), 0, "a new agent has made no requests yet");
    assert.equal(created.lastActiveAt ?? null, null, "a new agent has no last-active time yet");
  } finally {
    await db.close();
  }
});

test("createAgent records an explicitly supplied status", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-status");

    const created = await createAgent(
      db,
      { userId, connectionId: CONN_A, displayName: "Old Grok", platform: "grok", status: "disconnected" },
      fixedClock(T0),
    );

    assert.equal(created.status, "disconnected", "an explicit status is recorded verbatim");

    const reloaded = await getAgentById(db, userId, created.id);
    assert.equal(reloaded!.status, "disconnected", "and it is persisted");
  } finally {
    await db.close();
  }
});

test("createAgent gives each agent a distinct id", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-ids");
    const one = await createAgent(
      db,
      { userId, connectionId: CONN_A, displayName: "Claude", platform: "claude" },
      fixedClock(T0),
    );
    const two = await createAgent(
      db,
      { userId, connectionId: CONN_B, displayName: "ChatGPT", platform: "chatgpt" },
      fixedClock(T0),
    );
    assert.notEqual(one.id, two.id, "two created agents have different ids");
  } finally {
    await db.close();
  }
});

test("listAgentsForUser returns every one of the owner's agents with their recorded identity", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-list");
    await createAgent(db, { userId, connectionId: CONN_A, displayName: "Claude", platform: "claude" }, fixedClock(T0));
    await createAgent(db, { userId, connectionId: CONN_B, displayName: "ChatGPT", platform: "chatgpt" }, fixedClock(T0));
    await createAgent(db, { userId, connectionId: CONN_C, displayName: "Gemini", platform: "gemini" }, fixedClock(T0));

    const agents = await listAgentsForUser(db, userId);
    assert.equal(agents.length, 3, "all three of the owner's agents are listed");

    // Order is not pinned (over-constraining); compare as sets of the recorded identity.
    const byConnection = new Map(agents.map((a) => [a.connectionId, a]));
    assert.equal(byConnection.get(CONN_A)!.displayName, "Claude", "the first agent's identity is listed");
    assert.equal(byConnection.get(CONN_B)!.platform, "chatgpt", "the second agent's platform is listed");
    assert.equal(byConnection.get(CONN_C)!.displayName, "Gemini", "the third agent's identity is listed");
    for (const agent of agents) {
      assert.equal(agent.userId, userId, "every listed agent belongs to the owner");
      assert.equal(agent.status, "connected", "each is connected");
      assert.equal(count(agent.requestCount), 0, "each starts with no requests");
    }
  } finally {
    await db.close();
  }
});

test("listAgentsForUser returns an empty array for a person with no agents", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-empty");
    const agents = await listAgentsForUser(db, userId);
    assert.deepEqual(agents, [], "a person with no agents gets an empty list");
  } finally {
    await db.close();
  }
});

test("getAgentById reads one created agent back by its id for its owner", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-byid");
    const created = await createAgent(
      db,
      { userId, connectionId: CONN_A, displayName: "My Claude", platform: "claude" },
      fixedClock(T0),
    );

    const loaded = await getAgentById(db, userId, created.id);
    assert.ok(loaded, "the created agent is readable by its owner via its id");
    assert.equal(loaded!.id, created.id, "the same agent id is returned");
    assert.equal(loaded!.connectionId, CONN_A, "its connection is preserved");
    assert.equal(loaded!.displayName, "My Claude", "its display name is preserved");
    assert.equal(loaded!.platform, "claude", "its platform is preserved");
    assert.equal(ms(loaded!.connectedAt), ms(T0), "its connected date is preserved");
  } finally {
    await db.close();
  }
});

test("getAgentById returns null for an id that does not exist", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-missing");
    const loaded = await getAgentById(db, userId, "99999999-9999-9999-9999-999999999999");
    assert.equal(loaded, null, "an unknown agent id returns null");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — last-active and request count update when the agent calls a tool.
// ===========================================================================

test("recordAgentActivity bumps the request count and stamps the injected last-active time", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2");
    const created = await createAgent(
      db,
      { userId, connectionId: CONN_A, displayName: "Claude", platform: "claude" },
      fixedClock(T0),
    );
    assert.equal(count(created.requestCount), 0, "it starts with no requests");

    const afterOne = await recordAgentActivity(db, { userId, id: created.id }, fixedClock(T1));
    assert.equal(count(afterOne.requestCount), 1, "the first tool call makes the count 1");
    assert.ok(afterOne.lastActiveAt != null, "the first tool call stamps a last-active time");
    assert.equal(ms(afterOne.lastActiveAt as Date | string), ms(T1), "lastActiveAt is the injected clock instant");
    assert.equal(ms(afterOne.connectedAt), ms(T0), "the connected date is untouched by activity");
    assert.equal(afterOne.status, "connected", "the status is untouched by activity");
  } finally {
    await db.close();
  }
});

test("recordAgentActivity accumulates across repeated tool calls and persists", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-accumulate");
    const created = await createAgent(
      db,
      { userId, connectionId: CONN_A, displayName: "Claude", platform: "claude" },
      fixedClock(T0),
    );

    await recordAgentActivity(db, { userId, id: created.id }, fixedClock(T1));
    const afterTwo = await recordAgentActivity(db, { userId, id: created.id }, fixedClock(T2));
    assert.equal(count(afterTwo.requestCount), 2, "a second tool call makes the count 2");
    assert.equal(ms(afterTwo.lastActiveAt as Date | string), ms(T2), "lastActiveAt advances to the latest call");

    const reloaded = await getAgentById(db, userId, created.id);
    assert.equal(count(reloaded!.requestCount), 2, "the request count is persisted");
    assert.equal(ms(reloaded!.lastActiveAt as Date | string), ms(T2), "the last-active time is persisted");
  } finally {
    await db.close();
  }
});

test("recordAgentActivity only touches the agent it names, not the person's other agents", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-isolated");
    const busy = await createAgent(db, { userId, connectionId: CONN_A, displayName: "Claude", platform: "claude" }, fixedClock(T0));
    const idle = await createAgent(db, { userId, connectionId: CONN_B, displayName: "ChatGPT", platform: "chatgpt" }, fixedClock(T0));

    await recordAgentActivity(db, { userId, id: busy.id }, fixedClock(T1));

    const idleReloaded = await getAgentById(db, userId, idle.id);
    assert.equal(count(idleReloaded!.requestCount), 0, "the untouched agent's count stays 0");
    assert.equal(idleReloaded!.lastActiveAt ?? null, null, "and its last-active time stays unset");
  } finally {
    await db.close();
  }
});

test("recordAgentActivity throws when no agent with that id exists", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-missing");
    await assert.rejects(
      async () => {
        await recordAgentActivity(db, { userId, id: "99999999-9999-9999-9999-999999999999" }, fixedClock(T1));
      },
      "recording activity for a non-existent agent is refused, never silent",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: a second signed-in person can never read, list or mutate another's
// agent. The user id is bound from the session, never the client.
// ===========================================================================

test("listAgentsForUser never returns another person's agents", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-alice");
    const bob = await makeUser(db, "owner-bob");
    await createAgent(db, { userId: alice, connectionId: CONN_A, displayName: "Alice Claude", platform: "claude" }, fixedClock(T0));
    await createAgent(db, { userId: alice, connectionId: CONN_B, displayName: "Alice ChatGPT", platform: "chatgpt" }, fixedClock(T0));
    await createAgent(db, { userId: bob, connectionId: CONN_C, displayName: "Bob Gemini", platform: "gemini" }, fixedClock(T0));

    const aliceAgents = await listAgentsForUser(db, alice);
    assert.equal(aliceAgents.length, 2, "Alice sees exactly her own two agents");
    assert.ok(aliceAgents.every((a) => a.userId === alice), "every agent in Alice's list is hers");
    assert.ok(!aliceAgents.some((a) => a.connectionId === CONN_C), "Bob's agent never appears in Alice's list");

    const bobAgents = await listAgentsForUser(db, bob);
    assert.equal(bobAgents.length, 1, "Bob sees exactly his own agent");
    assert.equal(bobAgents[0]!.connectionId, CONN_C, "Bob sees his own agent");
  } finally {
    await db.close();
  }
});

test("getAgentById never returns another person's agent by id", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "byid-alice");
    const bob = await makeUser(db, "byid-bob");
    const alices = await createAgent(db, { userId: alice, connectionId: CONN_A, displayName: "Alice Claude", platform: "claude" }, fixedClock(T0));

    assert.ok(await getAgentById(db, alice, alices.id), "Alice can read her own agent by id");
    assert.equal(
      await getAgentById(db, bob, alices.id),
      null,
      "Bob cannot read Alice's agent by its id",
    );
  } finally {
    await db.close();
  }
});

test("recordAgentActivity cannot mutate another person's agent, and leaves it unchanged", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "mut-alice");
    const bob = await makeUser(db, "mut-bob");
    const alices = await createAgent(db, { userId: alice, connectionId: CONN_A, displayName: "Alice Claude", platform: "claude" }, fixedClock(T0));

    // Bob tries to bump Alice's agent by its id: member-scoped, so there is no such agent
    // FOR BOB — recordAgentActivity must refuse (never silently touch it).
    await assert.rejects(
      async () => {
        await recordAgentActivity(db, { userId: bob, id: alices.id }, fixedClock(T1));
      },
      "Bob cannot record activity against an agent that is not his",
    );

    const stillAlices = await getAgentById(db, alice, alices.id);
    assert.equal(count(stillAlices!.requestCount), 0, "Alice's request count is untouched by Bob's attempt");
    assert.equal(stillAlices!.lastActiveAt ?? null, null, "and its last-active time is still unset");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("createAgent binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "a'); DROP TABLE agents; --";

  // The recording db returns no rows; createAgent may throw if it reads back a row — either
  // way the INSERT it issued must have BOUND the probe, which is what this test checks.
  try {
    await createAgent(
      db,
      { userId: probe, connectionId: probe, displayName: probe, platform: probe },
      fixedClock(T0),
    );
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("listAgentsForUser binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE agents; --";

  const result = await listAgentsForUser(db, probe);
  assert.deepEqual(result, [], "the recording db returns no rows, so the list is empty");

  assertBoundNotSpliced(db, probe);
});

test("getAgentById binds the id and user id as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "p'); DROP TABLE agents; --";

  const result = await getAgentById(db, probe, probe);
  assert.equal(result, null, "the recording db returns no rows, so the lookup is empty");

  assertBoundNotSpliced(db, probe);
});

test("recordAgentActivity binds the id and user id as parameters, never splicing SQL", async () => {
  const db = recordingDb();
  const probe = "x'); DROP TABLE agents; --";

  // No row comes back, so recordAgentActivity cannot find an owned agent and must refuse —
  // but the statement it issued must have BOUND the probe, not spliced it.
  await assert.rejects(async () => {
    await recordAgentActivity(db, { userId: probe, id: probe }, fixedClock(T0));
  }, "recordAgentActivity refuses when no owned agent exists");

  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe in the display name is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const probe = "Grace'); DROP TABLE agents; --";

    const created = await createAgent(
      db,
      { userId, connectionId: CONN_A, displayName: probe, platform: "claude" },
      fixedClock(T0),
    );

    assert.equal(
      await tableExists(db, "agents"),
      true,
      "the agents table must still exist (the probe was stored as data, not run as SQL)",
    );

    const loaded = await getAgentById(db, userId, created.id);
    assert.equal(loaded!.id, created.id, "the same agent is read back");
    assert.equal(loaded!.displayName, probe, "the probe round-trips verbatim as data");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input and binds probes.
//
// A route handler validates external input HERE (`parseBody`), then calls this task's
// parameterized data-access with the SESSION's user id (NEVER a body value). A rejected
// input maps to a 4xx Response and never reaches a query. This handler is a test fixture
// that EXERCISES the modules — it is not an implementation file.
// ===========================================================================

function connectAgentHandler(
  db: Db,
  clock: Clock,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries the connection the agent is and its identity; the user id comes from
  // the session, never the body. Lengths are capped so an absurd value is rejected, but
  // generous enough that a probe can still REACH the query to prove it is bound.
  const schema = z.object({
    connectionId: z.string().min(1).max(64),
    displayName: z.string().min(1).max(200),
    platform: z.string().min(1).max(64),
    status: z.enum(["connected", "disconnected"]).optional(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const created = await createAgent(
        db,
        {
          userId: sessionUserId,
          connectionId: body.connectionId,
          displayName: body.displayName,
          platform: body.platform,
          status: body.status,
        },
        clock,
      );
      return new Response(JSON.stringify({ id: created.id }), { status: 201 });
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
  return new Request("https://warthog.com.au/api/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = connectAgentHandler(db, fixedClock(T0), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = connectAgentHandler(db, fixedClock(T0), "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest(JSON.stringify({ connectionId: CONN_A, displayName: "a".repeat(10 * 1024), platform: "claude" })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = connectAgentHandler(db, fixedClock(T0), "session-user");

  // No connectionId — an agent must name the connection it is.
  const res = await handler(jsonRequest(JSON.stringify({ displayName: "Claude", platform: "claude" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = connectAgentHandler(db, fixedClock(T0), "session-user");

  // platform must be a string — a number is a schema violation, rejected before any query.
  const res = await handler(
    jsonRequest(JSON.stringify({ connectionId: CONN_A, displayName: "Claude", platform: 123 })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler accepts a well-formed body and records the agent for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const handler = connectAgentHandler(db, fixedClock(T0), userId);

    const res = await handler(
      jsonRequest(JSON.stringify({ connectionId: CONN_A, displayName: "My Claude", platform: "claude" })),
    );

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };

    const stored = await getAgentById(db, userId, id);
    assert.ok(stored, "a valid body is persisted for the session user");
    assert.equal(stored!.id, id, "the stored agent matches the returned id");
    assert.equal(stored!.displayName, "My Claude", "with the submitted display name");
    assert.equal(stored!.platform, "claude", "and the submitted platform");
    assert.equal(stored!.status, "connected", "and the default status");
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const handler = connectAgentHandler(db, fixedClock(T0), sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(
      jsonRequest(JSON.stringify({ userId: attacker, connectionId: CONN_A, displayName: "Claude", platform: "claude" })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal((await listAgentsForUser(db, sessionUser)).length, 1, "the agent is recorded under the SESSION user");
    assert.deepEqual(
      await listAgentsForUser(db, attacker),
      [],
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe display name is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const handler = connectAgentHandler(db, fixedClock(T0), userId);
    const probe = "Claude'); DROP TABLE agents; --";

    const res = await handler(
      jsonRequest(JSON.stringify({ connectionId: CONN_A, displayName: probe, platform: "claude" })),
    );

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "agents"), true, "the agents table must still exist");

    const { id } = (await res.json()) as { id: string };
    const stored = await getAgentById(db, userId, id);
    assert.equal(stored!.displayName, probe, "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the repo reads no process.env and holds no secret (INV-103). Enforced by
// construction; shown behaviourally: a decoy secret in the environment never lands in the
// stored or returned agent, and the agents read/write from the injected db alone with no
// app env configured.
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in the agent", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5");
    const created = await createAgent(
      db,
      { userId, connectionId: CONN_A, displayName: "Claude", platform: "claude" },
      fixedClock(T0),
    );
    await recordAgentActivity(db, { userId, id: created.id }, fixedClock(T1));

    const loaded = await getAgentById(db, userId, created.id);
    assert.ok(loaded, "the agent reads and writes purely from the injected db — no app env needed");
    assert.ok(
      !JSON.stringify(loaded).includes(DECOY),
      "no ambient env value is folded into the returned agent",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the
    // same value could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM agents");
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

test("the agents migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "agents"),
      true,
      "the agents table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0020_agents"),
      "db/migrations/0020_agents.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0020's CREATE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
