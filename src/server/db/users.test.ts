// E01-S12 — Users table, roles and user data-access (`src/server/db/users.ts`,
// `db/migrations/0003_users.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so
// importing `./users` throws and `freshDb()` has no `users` table — every test
// here fails until the builder adds them. That absence IS the point of test-first;
// do not implement anything to make these pass.
//
// These tests pin BEHAVIOUR (what the data-access functions DO and what the
// migration produces), never the source text of the module or the SQL file — a
// later rename that preserves behaviour must not redden them.
//
// The contract this task defines (the builder implements exactly this):
//
//   createUser(db, { email, wrappedDek }): Promise<User>
//     • inserts a person row storing the wrapped-DEK reference (design §4.1: the
//       per-person DEK is stored only WRAPPED) and returns the created user, whose
//       `role` DEFAULTS to 'member' (the data model carries roles so a later admin
//       app can report operational numbers with no path to vault contents — brief).
//   getUserById(db, id): Promise<User | null>
//     • returns ONLY the user with that id (WHERE id = $1), or null when none.
//   getUserByEmail(db, email): Promise<User | null>
//     • looks a user up by email with the email BOUND as a parameter (never
//       concatenated into the SQL text), or null when none.
//   User = { id: string; email: string; role: string; wrappedDek: string }
//   NewUser = { email: string; wrappedDek: string }
//
// Acceptance criteria → tests:
//   AC1 "A user row stores a wrapped-DEK reference and a role defaulting to 'member'."
//        — proven through createUser: the created user carries back the wrapped-DEK
//        reference it was given and role 'member' when none was asked for, and the
//        row persists (read back by id with the same values).
//   AC2 "Reading a user by id returns only that user, and email lookup is
//        parameterized." — getUserById returns the one matching user (not another),
//        null for an unknown id; getUserByEmail binds the email as a parameter.
//   AC3 "The migration second run changes nothing." — proven through the real
//        runner: after the project migrations the `users` relation exists, and
//        re-running every migration over the same database applies nothing new and
//        does not throw.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) "A handler rejects
//        malformed or oversized input with a 4xx, and a SQL-injection probe in an
//        input field cannot alter a query (parameter binding is used)." — the
//        VALIDATE half is reused from the already-built boundary (`../http/validate`);
//        here we prove it COMPOSES with this task's data-access: a handler built on
//        the boundary rejects malformed/oversized input with a 4xx before any query
//        runs, and a probe routed through createUser/getUserByEmail travels as a
//        bound value — it cannot drop or alter the table. The handlers below are test
//        fixtures (the intended usage pattern), not implementation files.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { createUser, getUserById, getUserByEmail } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { parseBody, HttpError } from "../http/validate";

// A stand-in for a wrapped DEK: opaque base64 to this module (the real wrapped form
// comes from the KeyWrapper seam; this task only stores and returns it verbatim).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// A db seam stand-in that records every call instead of running it, so a test can
// prove WHAT reached the query layer and HOW (bound value vs. spliced text). It
// returns no rows, which is all the SELECT lookups need to yield null. It satisfies
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

// Whether a relation of this exact name exists on this handle. `to_regclass` yields
// the relation name when it exists and NULL when it does not — a non-throwing probe
// scoped to the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// --- AC1: a user row stores a wrapped-DEK reference and role defaults to 'member' ---

test("createUser stores the wrapped-DEK reference and defaults role to 'member'", async () => {
  const db = await freshDb();
  try {
    const wrappedDek = wrappedDekFor("alice");
    const user = await createUser(db, { email: "alice@warthog.com.au", wrappedDek });

    assert.equal(typeof user.id, "string", "a created user carries a string id");
    assert.ok(user.id.length > 0, "the id must be non-empty");
    assert.equal(user.email, "alice@warthog.com.au", "the email is stored and returned");
    assert.equal(user.role, "member", "role defaults to 'member' when none is asked for");
    assert.equal(
      user.wrappedDek,
      wrappedDek,
      "the wrapped-DEK reference is stored and returned verbatim",
    );
  } finally {
    await db.close();
  }
});

test("a created user persists and is read back by id with the same wrapped DEK and role", async () => {
  const db = await freshDb();
  try {
    const wrappedDek = wrappedDekFor("bob");
    const created = await createUser(db, { email: "bob@warthog.com.au", wrappedDek });

    const read = await getUserById(db, created.id);
    assert.ok(read != null, "the created user must be readable by its id");
    assert.equal(read?.id, created.id, "the same row comes back");
    assert.equal(read?.email, "bob@warthog.com.au", "the stored email round-trips");
    assert.equal(read?.role, "member", "the stored role round-trips");
    assert.equal(read?.wrappedDek, wrappedDek, "the stored wrapped-DEK reference round-trips");
  } finally {
    await db.close();
  }
});

// --- AC2: reading by id returns ONLY that user -------------------------------------

test("getUserById returns only the matching user, never another", async () => {
  const db = await freshDb();
  try {
    const a = await createUser(db, { email: "a@warthog.com.au", wrappedDek: wrappedDekFor("a") });
    const b = await createUser(db, { email: "b@warthog.com.au", wrappedDek: wrappedDekFor("b") });
    assert.notEqual(a.id, b.id, "two users have distinct ids");

    const readA = await getUserById(db, a.id);
    assert.ok(readA != null, "user A must be found by its id");
    assert.equal(readA?.id, a.id, "getUserById returns the requested user");
    assert.equal(readA?.email, "a@warthog.com.au", "it returns A's email, not B's");
    assert.notEqual(readA?.id, b.id, "it must not return the other user");

    const readB = await getUserById(db, b.id);
    assert.equal(readB?.email, "b@warthog.com.au", "B is read independently of A");
  } finally {
    await db.close();
  }
});

test("getUserById returns null for an unknown id (no row, not an error)", async () => {
  const db = await freshDb();
  try {
    await createUser(db, { email: "present@warthog.com.au", wrappedDek: wrappedDekFor("present") });
    const missing = await getUserById(db, "00000000-0000-0000-0000-000000000000");
    assert.equal(missing, null, "an id that matches no row yields null");
  } finally {
    await db.close();
  }
});

// --- AC2: email lookup ------------------------------------------------------------

test("getUserByEmail finds the matching user and returns null when there is no match", async () => {
  const db = await freshDb();
  try {
    const created = await createUser(db, {
      email: "carol@warthog.com.au",
      wrappedDek: wrappedDekFor("carol"),
    });

    const found = await getUserByEmail(db, "carol@warthog.com.au");
    assert.ok(found != null, "an existing email must resolve to its user");
    assert.equal(found?.id, created.id, "the email lookup returns the right user");

    const none = await getUserByEmail(db, "nobody@warthog.com.au");
    assert.equal(none, null, "an unknown email yields null");
  } finally {
    await db.close();
  }
});

// --- AC2/AC4: every lookup binds its input as a parameter (no spliced SQL) ---------

test("getUserByEmail binds the email as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "attacker@evil' OR '1'='1";

  const result = await getUserByEmail(db, probe);
  assert.equal(result, null, "no row matches (the recording db returns none)");

  assert.equal(db.calls.length, 1, "email lookup issues exactly one query");
  const call = db.calls[0]!;
  assert.deepEqual(call.values, [probe], "the email travels as a bound value");
  assert.ok(call.text.includes("$1"), "the statement uses a placeholder, not an inlined value");
  assert.ok(
    !call.text.includes(probe),
    "the email value is bound, never concatenated into the SQL text",
  );
  assert.ok(
    !call.text.includes("OR '1'='1"),
    "no injected condition appears in the statement text",
  );
});

test("getUserById binds the id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "x'; DROP TABLE users; --";

  const result = await getUserById(db, probe);
  assert.equal(result, null, "no row matches (the recording db returns none)");

  assert.equal(db.calls.length, 1, "lookup by id issues exactly one query");
  const call = db.calls[0]!;
  assert.deepEqual(call.values, [probe], "the id travels as a bound value");
  assert.ok(call.text.includes("$1"), "the statement uses a placeholder, not an inlined value");
  assert.ok(!call.text.includes(probe), "the id value is bound, never concatenated into the SQL");
  assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
});

// --- AC4: end-to-end — a probe stored and looked up cannot alter the query ---------

test("a SQL-injection probe in an email is stored as data and cannot drop the users table", async () => {
  const db = await freshDb();
  try {
    const safe = await createUser(db, {
      email: "dave@warthog.com.au",
      wrappedDek: wrappedDekFor("dave"),
    });
    // A probe email created through the data-access layer: if it were concatenated
    // rather than bound, the trailing statement would drop the table.
    const probeEmail = "eve'); DROP TABLE users; --";
    const probeUser = await createUser(db, { email: probeEmail, wrappedDek: wrappedDekFor("eve") });

    // The table survived (the injection was data, not SQL) and both rows are intact.
    assert.equal(await tableExists(db, "users"), true, "the users table must still exist");
    assert.equal((await getUserById(db, safe.id))?.email, "dave@warthog.com.au");

    // The probe round-trips verbatim as an ordinary email value.
    const back = await getUserByEmail(db, probeEmail);
    assert.ok(back != null, "the probe email is stored and found as literal data");
    assert.equal(back?.id, probeUser.id, "it resolves to the user it was stored against");

    // A classic match-all probe matches nobody — it was bound, not interpreted.
    const matchAll = await getUserByEmail(db, "' OR '1'='1' --");
    assert.equal(matchAll, null, "a match-all probe returns no user (bound, not evaluated)");
  } finally {
    await db.close();
  }
});

// --- AC4: a handler on the validation boundary rejects bad input and binds probes --
//
// A route handler validates external input at the boundary (`parseBody`), then calls
// this task's parameterized data-access. A rejected input maps to a 4xx Response and
// NEVER reaches a query. These handlers are test fixtures that EXERCISE the modules —
// they are not implementation files.

function createSignupHandler(db: Db): (req: Request) => Promise<Response> {
  const schema = z.object({ email: z.string().min(3).max(320) });
  return async (req: Request): Promise<Response> => {
    try {
      const { email } = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const user = await createUser(db, { email, wrappedDek: wrappedDekFor("signup") });
      return new Response(JSON.stringify({ id: user.id }), { status: 201 });
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
  return new Request("https://warthog.com.au/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("a handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createSignupHandler(db);

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("a handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createSignupHandler(db);

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ email: "a".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("a handler accepts a well-formed signup and persists the user", async () => {
  const db = await freshDb();
  try {
    const handler = createSignupHandler(db);

    const res = await handler(jsonRequest(JSON.stringify({ email: "frank@warthog.com.au" })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const stored = await getUserByEmail(db, "frank@warthog.com.au");
    assert.ok(stored != null, "a valid signup creates a user");
    assert.equal(stored?.role, "member", "the created user is a 'member' by default");
  } finally {
    await db.close();
  }
});

test("a handler cannot be SQL-injected: a probe email is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const handler = createSignupHandler(db);
    const probeEmail = "grace'); DROP TABLE users; --";

    const res = await handler(jsonRequest(JSON.stringify({ email: probeEmail })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) email is accepted");
    assert.equal(await tableExists(db, "users"), true, "the users table must still exist");
    const stored = await getUserByEmail(db, probeEmail);
    assert.ok(stored != null, "the probe is stored as an ordinary email value");
    assert.equal(stored?.email, probeEmail, "it is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// --- AC3: the migration applies and a second run changes nothing -------------------

test("the users migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    // 0003_users applied: the `users` relation exists (a non-throwing existence probe
    // scoped to the one table under test — behaviour, not source text).
    assert.equal(
      await tableExists(db, "users"),
      true,
      "the users table must exist after the project migrations",
    );

    // The project migration set includes the users migration (its recorded name is
    // the task's named deliverable, stable once applied).
    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0003_users"),
      "db/migrations/0003_users.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0003's CREATE would throw "already exists", so an empty result AND
    // no throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
