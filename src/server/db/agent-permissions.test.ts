// E07-S05 — Agent permission grants store (`src/server/db/agent-permissions.ts`,
// `db/migrations/0013_agent_permissions.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so
// importing `./agent-permissions` throws and `freshDb()` has no `agent_permissions`
// table — every test here fails until the builder adds them. That absence IS the
// point of test-first; do NOT implement anything to make these pass — the builder
// writes the module and the migration afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: the grants round-trip,
// who may read/change what, the card-budget rule, what a handler rejects, that every
// value is bound as a parameter), never the source text of the module or the SQL file —
// a later rename that preserves behaviour must not redden them.
//
// WHY this exists (design §7 connector engine, §8 policy step 2, brief "Per-agent
// permissions page"): one connection's grants live in exactly one place (constitution:
// one-source-of-truth). The consent screen and the per-agent permissions page read and
// write them here, and the policy pipeline (§8 step 2) reads them on every agent call.
// A connection's grants are PLAINTEXT METADATA (design §4.1: connector ids, tool-class
// settings, booleans, budget amount+currency+period, the request limit) — needed for
// filtering and the per-call policy check — so, unlike held-request args or approval
// detail, they are NOT DEK-encrypted and this module holds no key.
//
// The `connection_id` is an opaque uuid here: the connections table is created by a
// later migration (E09-S05), so — exactly like 0009/0011/0012 bind `agent_id`/
// `connection_id` as a plain column — this store binds `connection_id` by value, with
// ownership enforced by the session's `user_id`, not a foreign key to a table that does
// not exist yet.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type PeriodKind  = "day" | "week" | "month";          // the brief's budget periods
//   type ChangeTools = "off" | "allow" | "ask_first";      // change-making tool class
//
//   interface CardBudget {        // the agent's card spending budget
//     amount: number;             // major units, returned as a NUMBER (200 == A$200)
//     currency: string;          // the person's currency, e.g. "AUD"
//     period: PeriodKind;        // day | week | month
//   }
//
//   interface PermissionGrants {  // what upsertPermissions writes
//     userId: string;            // the person (the session's id, NEVER a client value)
//     connectionId: string;      // the connection these grants belong to
//     grantedConnectors: string[]; // which connected services the agent may use
//     readTools: boolean;        // read tools allowed
//     changeTools: ChangeTools;  // change-making tools setting (default "ask_first")
//     identityAccess: boolean;   // may read low-tier identity fields without asking
//     highTierAccess: boolean;   // may request high-tier identity fields
//     cardAccess: boolean;       // may request a card
//     cardBudget: CardBudget | null;  // its spending budget (null = none set)
//     skillsScope: string[];     // which skills it receives
//     memoryRead: boolean;       // whether it may read shared memory
//     sharing: boolean;          // whether what it learns is shared with other agents
//     rulesScope: string[];      // its own rules (the rule ids applied to this agent)
//     rateLimit: number;         // request limit per minute (default 120), a NUMBER
//   }
//
//   type ConnectionPermissions = PermissionGrants;  // read back in the same shape
//
//   getConnectionPermissions(db, userId, connectionId): Promise<ConnectionPermissions | null>
//     • the grants for this connection OWNED BY `userId` (member-scoped: connection_id
//       AND user_id both bound); null when none for this user. Another user's connection
//       id returns null (they cannot read it).
//   upsertPermissions(db, grants: PermissionGrants): Promise<ConnectionPermissions>
//     • writes the grants for (grants.userId, grants.connectionId), INSERTING a fresh
//       record or UPDATING the one already there (keyed on the (user, connection) pair,
//       so a second upsert overwrites in place, never duplicating). Returns the stored
//       grants. REJECTS (throws, never silently) when cardAccess is on but cardBudget is
//       null — "card access cannot be switched on without a budget" (brief / design §8).
//
// Acceptance criteria → tests:
//   AC1 "getConnectionPermissions returns the stored grants for a connection owned by
//        the session user, and upsertPermissions writes them." — a round-trip across
//        every grant field; a second upsert for the same (user, connection) overwrites
//        in place; an unknown connection reads back null.
//   AC2 "Upsert rejects card access enabled with no budget set." — cardAccess:true +
//        cardBudget:null is refused and writes no row; cardAccess:true + a real budget is
//        accepted and round-trips; cardAccess:false + no budget is fine.
//   AC3 "A user cannot read or change another user's connection permissions by connection
//        id (filtered by session user id)." — B's read of A's connection id returns null,
//        and B's upsert on the SAME connection id writes B's own row and leaves A's grants
//        untouched; the user id is bound as a parameter.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed/oversized/mis-shaped input with a
//        4xx before any query runs; a SQL-injection probe routed through the repo travels
//        as a BOUND value (placeholders, never concatenation) and cannot drop the table.
//        The handler below is a test fixture (the intended usage), not an implementation
//        file.
//   AC5 [obligation:secrets-from-env] (INV-103) — enforced by construction: the repo
//        takes `db` as its only dependency, holds no key and reads no `process.env`
//        (config flows from `src/server/config.ts` alone). Shown here behaviourally: the
//        grants read and write purely from the injected db with no app env configured,
//        and a decoy secret planted in the environment never lands in the stored or
//        returned grants.
//   Migration: the `agent_permissions` relation exists after the project migrations and a
//        second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { getConnectionPermissions, upsertPermissions } from "./agent-permissions";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { grantServices } from "../../test/grants";
import { loadMigrations, runMigrations, type Db } from "./index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

// Connection ids are uuids (an opaque uuid column, like agent_id); use valid uuids so a
// `uuid` column accepts them.
const CONN_A = "33333333-3333-3333-3333-333333333333";
const CONN_B = "44444444-4444-4444-4444-444444444444";

// The grant shape the tester pins (mirrors the contract above). Built via a helper so
// each test starts from a sensible, fully-populated set and overrides only what it is
// about — a non-literal value passed to upsertPermissions, so excess-property checks
// never bite.
type PeriodKind = "day" | "week" | "month";
type ChangeTools = "off" | "allow" | "ask_first";
interface CardBudget {
  amount: number;
  currency: string;
  period: PeriodKind;
}
interface Grants {
  userId: string;
  connectionId: string;
  grantedConnectors: string[];
  readTools: boolean;
  changeTools: ChangeTools;
  identityAccess: boolean;
  highTierAccess: boolean;
  cardAccess: boolean;
  cardBudget: CardBudget | null;
  skillsScope: string[];
  memoryRead: boolean;
  sharing: boolean;
  rulesScope: string[];
  rateLimit: number;
}

function baseGrants(userId: string, connectionId: string, overrides: Partial<Grants> = {}): Grants {
  return {
    userId,
    connectionId,
    grantedConnectors: ["gmail", "google-calendar"],
    readTools: true,
    changeTools: "ask_first",
    identityAccess: true,
    highTierAccess: false,
    cardAccess: false,
    cardBudget: null,
    skillsScope: ["house-skill", "trip-planner"],
    memoryRead: true,
    sharing: false,
    rulesScope: ["rule-1", "rule-2"],
    rateLimit: 120,
    ...overrides,
  };
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

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (bound value vs. spliced text). It returns no
// rows and satisfies the `Db` shape structurally (query + close).
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

// How many permission rows exist for one (user, connection) — proves upsert updates in
// place rather than duplicating. A stored-state assertion (behaviour), not source text.
async function rowCount(db: Db, userId: string, connectionId: string): Promise<number> {
  const result = await db.query(
    "SELECT count(*) AS n FROM agent_permissions WHERE user_id = $1 AND connection_id = $2",
    [userId, connectionId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

// ===========================================================================
// AC1 — upsert writes a connection's grants; getConnectionPermissions reads
// them back for the owner, across every grant field, and upsert overwrites.
// ===========================================================================

test("upsertPermissions writes a connection's grants and getConnectionPermissions reads them back", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const grants = baseGrants(userId, CONN_A, {
      grantedConnectors: ["gmail", "notion", "linear"],
      readTools: true,
      changeTools: "allow",
      identityAccess: true,
      highTierAccess: true,
      cardAccess: true,
      cardBudget: { amount: 500, currency: "AUD", period: "week" },
      skillsScope: ["house-skill", "expense-filer"],
      memoryRead: true,
      sharing: true,
      rulesScope: ["r-abc", "r-def"],
      rateLimit: 60,
    });

    const saved = await grantServices(db, grants);
    // upsert returns the grants it wrote.
    assert.equal(saved.userId, userId, "the saved grants belong to the person");
    assert.equal(saved.connectionId, CONN_A, "the saved grants are for the connection");

    const loaded = await getConnectionPermissions(db, userId, CONN_A);
    assert.ok(loaded, "a connection's grants are readable by their owner");
    assert.equal(loaded!.userId, userId, "scoped to the person");
    assert.equal(loaded!.connectionId, CONN_A, "and to the connection");
    assert.deepEqual(loaded!.grantedConnectors, ["gmail", "linear", "notion"], "granted services round-trip, through their accounts");
    assert.equal(loaded!.readTools, true, "read-tools setting round-trips");
    assert.equal(loaded!.changeTools, "allow", "change-tools setting round-trips");
    assert.equal(loaded!.identityAccess, true, "low-tier identity access round-trips");
    assert.equal(loaded!.highTierAccess, true, "high-tier access round-trips");
    assert.equal(loaded!.cardAccess, true, "card access round-trips");
    assert.deepEqual(
      loaded!.cardBudget,
      { amount: 500, currency: "AUD", period: "week" },
      "the card budget (amount as a number, currency and period) round-trips",
    );
    assert.deepEqual(loaded!.skillsScope, ["house-skill", "expense-filer"], "skills scope round-trips");
    assert.equal(loaded!.memoryRead, true, "memory-read setting round-trips");
    assert.equal(loaded!.sharing, true, "sharing setting round-trips");
    assert.deepEqual(loaded!.rulesScope, ["r-abc", "r-def"], "rules scope round-trips");
    assert.equal(loaded!.rateLimit, 60, "the request rate limit round-trips as a number");
  } finally {
    await db.close();
  }
});

test("getConnectionPermissions returns null for a connection with no grants stored", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-none");
    const loaded = await getConnectionPermissions(db, userId, CONN_B);
    assert.equal(loaded, null, "an unknown connection has no grants");
  } finally {
    await db.close();
  }
});

test("upsertPermissions overwrites the same (user, connection) in place, never duplicating", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-upsert");

    await grantServices(db, baseGrants(userId, CONN_A, { rateLimit: 120, changeTools: "ask_first" }));
    await grantServices(
      db,
      baseGrants(userId, CONN_A, { rateLimit: 30, changeTools: "off", grantedConnectors: ["dropbox"] }),
    );

    const loaded = await getConnectionPermissions(db, userId, CONN_A);
    assert.equal(loaded!.rateLimit, 30, "the second upsert's value wins");
    assert.equal(loaded!.changeTools, "off", "every field reflects the latest upsert");
    assert.deepEqual(loaded!.grantedConnectors, ["dropbox"], "the connector list is replaced, not merged");
    assert.equal(await rowCount(db, userId, CONN_A), 1, "upsert updates in place — exactly one row remains");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — card access cannot be switched on without a budget.
// ===========================================================================

test("upsertPermissions rejects card access enabled with no budget set, and writes no row", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-reject");

    await assert.rejects(
      async () => {
        await grantServices(db, baseGrants(userId, CONN_A, { cardAccess: true, cardBudget: null }));
      },
      "card access cannot be switched on without a budget",
    );

    assert.equal(
      await getConnectionPermissions(db, userId, CONN_A),
      null,
      "the refused upsert must write no grants (never a silent half-write)",
    );
  } finally {
    await db.close();
  }
});

test("upsertPermissions accepts card access when a budget is set", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-ok");

    await upsertPermissions(
      db,
      baseGrants(userId, CONN_A, { cardAccess: true, cardBudget: { amount: 200, currency: "AUD", period: "month" } }),
    );

    const loaded = await getConnectionPermissions(db, userId, CONN_A);
    assert.equal(loaded!.cardAccess, true, "card access is on");
    assert.deepEqual(
      loaded!.cardBudget,
      { amount: 200, currency: "AUD", period: "month" },
      "with its budget stored",
    );
  } finally {
    await db.close();
  }
});

test("upsertPermissions allows card access OFF with no budget", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-off");

    await grantServices(db, baseGrants(userId, CONN_A, { cardAccess: false, cardBudget: null }));

    const loaded = await getConnectionPermissions(db, userId, CONN_A);
    assert.equal(loaded!.cardAccess, false, "card access off needs no budget");
    assert.equal(loaded!.cardBudget, null, "and the budget stays unset");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: a second signed-in person can never read or change another's
// connection permissions. The user id is bound from the session, never the client.
// ===========================================================================

test("getConnectionPermissions never returns another user's connection permissions", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-alice");
    const bob = await makeUser(db, "owner-bob");

    await grantServices(db, baseGrants(alice, CONN_A, { rateLimit: 90 }));

    assert.ok(await getConnectionPermissions(db, alice, CONN_A), "Alice can read her own connection's grants");
    assert.equal(
      await getConnectionPermissions(db, bob, CONN_A),
      null,
      "Bob cannot read Alice's connection permissions by her connection id",
    );
  } finally {
    await db.close();
  }
});

test("upsertPermissions cannot change another user's connection permissions by connection id", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "change-alice");
    const bob = await makeUser(db, "change-bob");

    await grantServices(db, baseGrants(alice, CONN_A, { rateLimit: 120, changeTools: "allow" }));

    // Bob upserts the SAME connection id — member-scoped, so this writes BOB's own row
    // and must not touch Alice's grants for that connection id.
    await grantServices(db, baseGrants(bob, CONN_A, { rateLimit: 10, changeTools: "off" }));

    const alicePerms = await getConnectionPermissions(db, alice, CONN_A);
    assert.equal(alicePerms!.rateLimit, 120, "Alice's grants are untouched by Bob's upsert on the same connection id");
    assert.equal(alicePerms!.changeTools, "allow", "none of Alice's settings changed");

    const bobPerms = await getConnectionPermissions(db, bob, CONN_A);
    assert.equal(bobPerms!.rateLimit, 10, "Bob's upsert wrote his OWN row, scoped to his user id");
    assert.equal(bobPerms!.changeTools, "off", "with his own settings");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("upsertPermissions binds the user id and connection id as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "a'; DROP TABLE agent_permissions; --";

  // The recording db returns no rows, so an upsert reading a row back may reject — either
  // way, the query it issued must have BOUND the probe, not spliced it.
  try {
    await grantServices(db, baseGrants(probe, probe));
  } catch {
    // no row came back from the recording db; irrelevant to what we assert below.
  }

  assert.ok(db.calls.length >= 1, "an upsert issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("getConnectionPermissions binds the user id and connection id as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "p'; DROP TABLE agent_permissions; --";

  const result = await getConnectionPermissions(db, probe, probe);
  assert.equal(result, null, "the recording db returns no rows, so the lookup is empty");

  assert.ok(db.calls.length >= 1, "the lookup issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("a SQL-injection probe in a granted connector is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const probe = "gmail'); DROP TABLE agent_permissions; --";

    await grantServices(db, baseGrants(userId, CONN_A, { grantedConnectors: ["gmail", probe] }));

    assert.equal(
      await tableExists(db, "agent_permissions"),
      true,
      "the agent_permissions table must still exist (the probe was stored as data, not run as SQL)",
    );

    const loaded = await getConnectionPermissions(db, userId, CONN_A);
    assert.deepEqual([...loaded!.grantedConnectors].sort(), ["gmail", probe].sort(), "the probe round-trips verbatim as data");
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

function permissionsHandler(db: Db, sessionUserId: string): (req: Request) => Promise<Response> {
  // The body carries the connection id and the grants; the user id comes from the
  // session. Lengths/counts are capped so an absurd value is rejected, but generous
  // enough that a probe can still REACH the query to prove it is bound.
  const cardBudgetSchema = z.object({
    amount: z.number(),
    currency: z.string().min(1).max(8),
    period: z.enum(["day", "week", "month"]),
  });
  const schema = z.object({
    connectionId: z.string().min(1).max(64),
    grantedConnectors: z.array(z.string().max(128)).max(200),
    readTools: z.boolean(),
    changeTools: z.enum(["off", "allow", "ask_first"]),
    identityAccess: z.boolean(),
    highTierAccess: z.boolean(),
    cardAccess: z.boolean(),
    cardBudget: cardBudgetSchema.nullable(),
    skillsScope: z.array(z.string().max(128)).max(200),
    memoryRead: z.boolean(),
    sharing: z.boolean(),
    rulesScope: z.array(z.string().max(128)).max(200),
    rateLimit: z.number().int().min(1).max(100000),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const saved = await grantServices(db, { userId: sessionUserId, ...body });
      return new Response(JSON.stringify({ connectionId: saved.connectionId }), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a
      // test sees the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/agent-permissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

// A fully-valid request body (connection id + every grant field), for the tests that
// vary one thing about it.
function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    connectionId: CONN_A,
    grantedConnectors: ["gmail"],
    readTools: true,
    changeTools: "ask_first",
    identityAccess: true,
    highTierAccess: false,
    cardAccess: false,
    cardBudget: null,
    skillsScope: ["house-skill"],
    memoryRead: true,
    sharing: false,
    rulesScope: ["rule-1"],
    rateLimit: 120,
    ...overrides,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = permissionsHandler(db, "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = permissionsHandler(db, "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(validBody({ grantedConnectors: ["x".repeat(10 * 1024)] })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = permissionsHandler(db, "session-user");

  // No connectionId — the grants must name the connection they are for.
  const bad = JSON.parse(validBody()) as Record<string, unknown>;
  delete bad.connectionId;
  const res = await handler(jsonRequest(JSON.stringify(bad)));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = permissionsHandler(db, "session-user");

  // rateLimit must be a number — a string is a schema violation, rejected before any query.
  const res = await handler(jsonRequest(validBody({ rateLimit: "lots" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler accepts a well-formed body and upserts the grants for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const handler = permissionsHandler(db, userId);

    const res = await handler(jsonRequest(validBody({ rateLimit: 45, grantedConnectors: ["gmail", "outlook"] })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { connectionId } = (await res.json()) as { connectionId: string };
    assert.equal(connectionId, CONN_A, "the handler reports the connection it wrote");

    const stored = await getConnectionPermissions(db, userId, CONN_A);
    assert.ok(stored, "a valid body is persisted for the session user");
    assert.equal(stored!.rateLimit, 45, "with the submitted settings");
    assert.deepEqual(stored!.grantedConnectors, ["gmail", "outlook"], "and the submitted connectors");
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const handler = permissionsHandler(db, sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(jsonRequest(validBody({ userId: attacker, rateLimit: 77 })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.ok(
      await getConnectionPermissions(db, sessionUser, CONN_A),
      "the grants are written under the SESSION user",
    );
    assert.equal(
      await getConnectionPermissions(db, attacker, CONN_A),
      null,
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe connector is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const handler = permissionsHandler(db, userId);
    const probe = "gmail'); DROP TABLE agent_permissions; --";

    const res = await handler(jsonRequest(validBody({ grantedConnectors: ["gmail", probe] })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "agent_permissions"), true, "the agent_permissions table must still exist");

    const stored = await getConnectionPermissions(db, userId, CONN_A);
    assert.deepEqual(stored!.grantedConnectors, ["gmail", probe], "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the repo reads no process.env and holds no secret (INV-103). Enforced by
// construction; shown behaviourally: a decoy secret in the environment never lands
// in the stored or returned grants, and the grants read/write from the injected db
// alone with no app env configured.
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in the grants", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5");
    await upsertPermissions(
      db,
      baseGrants(userId, CONN_A, { cardAccess: true, cardBudget: { amount: 200, currency: "AUD", period: "month" } }),
    );

    const loaded = await getConnectionPermissions(db, userId, CONN_A);
    assert.ok(loaded, "the grants read and write purely from the injected db — no app env needed");
    assert.ok(
      !JSON.stringify(loaded).includes(DECOY),
      "no ambient env value is folded into the returned grants",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the
    // same value could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM agent_permissions");
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

test("the agent_permissions migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "agent_permissions"),
      true,
      "the agent_permissions table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0013_agent_permissions"),
      "db/migrations/0013_agent_permissions.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0013's CREATE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
