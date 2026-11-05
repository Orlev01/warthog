// E09-S14 — Connector requests store (`src/server/db/connector-requests.ts`,
// `db/migrations/0019_connector_requests.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./connector-requests` throws and `freshDb()` has no `connector_requests` table —
// every test here fails until the builder adds them. That absence IS the point of
// test-first; do NOT implement anything to make these pass — the builder writes the
// module and the migration AFTERWARDS.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: the stored request and
// its status, the member-scoped read, the system-wide pending scan, the mark-matched
// transition, who may read what, that every value is bound as a parameter), never the
// source text of the module or the SQL file — a later rename that preserves behaviour
// must not redden them.
//
// WHY this exists (task E09-S14; brief "Request a connector"; design §7): a person can
// REQUEST a service that is not yet in the catalogue. The request is recorded "Requested"
// for that person; when a catalogue entry whose name/aliases match is LATER added, the
// request is marked "matched" and the person is told (the match-notify lives in the
// connectors service — this is only its store). A person sees ONLY their own requests
// (member-scoped), while the match-notify must scan EVERYONE's pending requests (a
// distinct system primitive, never reusing the member read — conventions "list all" vs
// "list visible").
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type ConnectorRequestStatus = "requested" | "matched";
//
//   interface NewConnectorRequest {       // what createConnectorRequest records
//     userId: string;                     // the owner (the session's id, NEVER a client value)
//     serviceName: string;                // the requested service name (free text the person typed)
//   }
//
//   interface ConnectorRequest {          // a request as handed back:
//     id: string;                         // the request id (generated on create)
//     userId: string;                     // its owner
//     serviceName: string;                // the requested name, stored VERBATIM (member data)
//     status: ConnectorRequestStatus;     // "requested" on create; "matched" once satisfied
//     requestedAt: Date | string;         // = clock.now() on create
//     matchedConnectorId: string | null;  // the catalogue slug that satisfied it (null until matched)
//     matchedAt: Date | string | null;    // = clock.now() when matched (null until matched)
//   }
//
//   createConnectorRequest(db, input: NewConnectorRequest, clock): Promise<ConnectorRequest>
//     • records a "requested" row (requestedAt = clock.now(), matched* null) and returns the
//       ConnectorRequest assembled from its inputs (does not depend on a RETURNING read),
//       like createConnection / createAgent.
//   listConnectorRequestsForUser(db, userId): Promise<ConnectorRequest[]>
//     • ALL of `userId`'s requests REGARDLESS OF STATUS (member-scoped: WHERE user_id bound);
//       never another person's. Empty array when none.
//   listPendingConnectorRequests(db): Promise<ConnectorRequest[]>
//     • EVERY person's still-"requested" request (status = 'requested'), across all users —
//       the system scan the match-notify runs when a catalogue entry is added. NOT
//       member-scoped (it is a system job, not a session). A matched request is excluded.
//   markConnectorRequestMatched(db, { id, connectorId }, clock): Promise<ConnectorRequest>
//     • transitions the request with `id` from "requested" to "matched", recording
//       matchedConnectorId = connectorId and matchedAt = clock.now(), leaving serviceName /
//       requestedAt / userId intact; returns the updated ConnectorRequest. Only a row that is
//       still "requested" is affected (idempotent re-match is a no-op that THROWS, never a
//       silent second mark) — so running the match-notify twice marks nothing new.
//
// Acceptance criteria → tests:
//   AC "Creating a request records it Requested for the user" — createConnectorRequest returns
//        an id + the recorded fields with status "requested" and null matched* fields, and it
//        round-trips through listConnectorRequestsForUser.
//   AC "a non-matching entry leaves requests Requested" / mark transition — markConnectorRequestMatched
//        flips exactly a pending row to matched (connector + matchedAt recorded); listPending
//        then excludes it; a second mark of the same row is refused.
//   AC "A user sees only their own requests." — listConnectorRequestsForUser returns only the
//        caller's rows (user id bound), never another person's; the system pending scan DOES
//        span users.
//   AC [obligation:validate-and-parameterize-input] (INV-102) — every statement binds its
//        input as a parameter (no spliced SQL); a SQL-injection probe in serviceName is stored
//        as data and the table survives.
//   AC [obligation:secrets-from-env] (INV-103) — the repo takes `db` and `clock` as injected
//        dependencies and reads no `process.env`; a decoy secret planted in the environment
//        never lands in a stored or returned request.
//   Migration: the `connector_requests` relation exists after the project migrations and a
//        second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createConnectorRequest,
  listConnectorRequestsForUser,
  listPendingConnectorRequests,
  markConnectorRequestMatched,
} from "./connector-requests";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { fixedClock } from "../seams/clock";

// --- fixtures ---------------------------------------------------------------------

// Instants deliberately in the past relative to the wall clock, so anything that wrongly
// read Date.now() instead of the injected clock would diverge here.
const T0 = new Date("2026-05-01T09:00:00.000Z");
const T1 = new Date("2026-05-08T14:30:00.000Z");

// Compare the moment, not the representation: a timestamp may come back as a Date or an ISO
// string — either is a reasonable driver choice and must not redden a test.
const ms = (value: Date | string | number): number => new Date(value as never).getTime();

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
// Creating a request records it "Requested" for the person.
// ===========================================================================

test("createConnectorRequest returns a request with an id, the recorded fields, status Requested and the injected date", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "create");

    const created = await createConnectorRequest(
      db,
      { userId, serviceName: "Dropbox" },
      fixedClock(T0),
    );

    assert.equal(typeof created.id, "string", "createConnectorRequest returns an id string");
    assert.ok(created.id.length > 0, "the returned id is non-empty");
    assert.equal(created.userId, userId, "the request belongs to the creating person");
    assert.equal(created.serviceName, "Dropbox", "the requested service name is recorded");
    assert.equal(created.status, "requested", "a fresh request is Requested");
    assert.equal(created.matchedConnectorId, null, "nothing has matched it yet");
    assert.equal(created.matchedAt, null, "it has no matched date yet");
    assert.equal(ms(created.requestedAt), ms(T0), "requestedAt is the injected clock instant");
  } finally {
    await db.close();
  }
});

test("createConnectorRequest gives each request a distinct id", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ids");
    const one = await createConnectorRequest(db, { userId, serviceName: "Dropbox" }, fixedClock(T0));
    const two = await createConnectorRequest(db, { userId, serviceName: "Notion" }, fixedClock(T0));
    assert.notEqual(one.id, two.id, "two created requests have different ids");
  } finally {
    await db.close();
  }
});

test("a created request round-trips through listConnectorRequestsForUser as Requested", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "roundtrip");
    const created = await createConnectorRequest(
      db,
      { userId, serviceName: "Figma" },
      fixedClock(T0),
    );

    const [loaded] = await listConnectorRequestsForUser(db, userId);
    assert.ok(loaded, "the created request is readable back for its owner");
    assert.equal(loaded!.id, created.id, "the same request id comes back");
    assert.equal(loaded!.serviceName, "Figma", "the requested name is preserved");
    assert.equal(loaded!.status, "requested", "it is still Requested");
    assert.equal(loaded!.matchedConnectorId, null, "and carries no matched connector");
    assert.equal(loaded!.matchedAt, null, "and no matched date");
    assert.equal(ms(loaded!.requestedAt), ms(T0), "its requested date is preserved");
  } finally {
    await db.close();
  }
});

test("listConnectorRequestsForUser returns an empty array for a person with no requests", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "empty");
    assert.deepEqual(await listConnectorRequestsForUser(db, userId), [], "no requests → empty list");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// A user sees only their OWN requests (member-scoped by user id).
// ===========================================================================

test("listConnectorRequestsForUser never returns another person's requests", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "see-alice");
    const bob = await makeUser(db, "see-bob");
    await createConnectorRequest(db, { userId: alice, serviceName: "Dropbox" }, fixedClock(T0));
    await createConnectorRequest(db, { userId: alice, serviceName: "Notion" }, fixedClock(T0));
    await createConnectorRequest(db, { userId: bob, serviceName: "Linear" }, fixedClock(T0));

    const alices = await listConnectorRequestsForUser(db, alice);
    assert.equal(alices.length, 2, "Alice sees exactly her own two requests");
    assert.ok(alices.every((r) => r.userId === alice), "every request in Alice's list is hers");
    assert.ok(!alices.some((r) => r.serviceName === "Linear"), "Bob's request never appears in Alice's list");

    const bobs = await listConnectorRequestsForUser(db, bob);
    assert.equal(bobs.length, 1, "Bob sees exactly his own request");
    assert.equal(bobs[0]!.serviceName, "Linear", "Bob sees his own request");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// The system-wide pending scan spans users; a matched request drops out of it.
// ===========================================================================

test("listPendingConnectorRequests returns every person's still-Requested request, across users", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "pend-alice");
    const bob = await makeUser(db, "pend-bob");
    await createConnectorRequest(db, { userId: alice, serviceName: "Dropbox" }, fixedClock(T0));
    await createConnectorRequest(db, { userId: bob, serviceName: "Notion" }, fixedClock(T0));

    const pending = await listPendingConnectorRequests(db);
    assert.equal(pending.length, 2, "the system scan sees pending requests from BOTH people");
    assert.ok(pending.every((r) => r.status === "requested"), "every row in the scan is Requested");
    const owners = new Set(pending.map((r) => r.userId));
    assert.ok(owners.has(alice) && owners.has(bob), "the scan is NOT member-scoped — it spans users");
  } finally {
    await db.close();
  }
});

test("listPendingConnectorRequests excludes a request that has been matched", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "pend-drop");
    const req = await createConnectorRequest(db, { userId: alice, serviceName: "Dropbox" }, fixedClock(T0));
    await createConnectorRequest(db, { userId: alice, serviceName: "Notion" }, fixedClock(T0));

    await markConnectorRequestMatched(db, { id: req.id, connectorId: "dropbox" }, fixedClock(T1));

    const pending = await listPendingConnectorRequests(db);
    assert.equal(pending.length, 1, "only the still-Requested request remains in the scan");
    assert.equal(pending[0]!.serviceName, "Notion", "the matched request has dropped out of the pending scan");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// markConnectorRequestMatched: the Requested → matched transition.
// ===========================================================================

test("markConnectorRequestMatched flips a pending request to matched, recording the connector and matched date", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "mark");
    const req = await createConnectorRequest(db, { userId, serviceName: "Dropbox" }, fixedClock(T0));

    const matched = await markConnectorRequestMatched(
      db,
      { id: req.id, connectorId: "dropbox" },
      fixedClock(T1),
    );

    assert.equal(matched.id, req.id, "the same request is returned");
    assert.equal(matched.status, "matched", "its status is now matched");
    assert.equal(matched.matchedConnectorId, "dropbox", "the connector that satisfied it is recorded");
    assert.equal(ms(matched.matchedAt!), ms(T1), "matchedAt is the injected clock instant");
    assert.equal(matched.serviceName, "Dropbox", "the requested name is untouched");
    assert.equal(matched.userId, userId, "the owner is untouched");
    assert.equal(ms(matched.requestedAt), ms(T0), "the original requested date is untouched");

    const [reloaded] = await listConnectorRequestsForUser(db, userId);
    assert.equal(reloaded!.status, "matched", "the matched status is persisted");
    assert.equal(reloaded!.matchedConnectorId, "dropbox", "the matched connector is persisted");
  } finally {
    await db.close();
  }
});

test("markConnectorRequestMatched refuses a second mark of the same request (no silent re-mark)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "remark");
    const req = await createConnectorRequest(db, { userId, serviceName: "Dropbox" }, fixedClock(T0));
    await markConnectorRequestMatched(db, { id: req.id, connectorId: "dropbox" }, fixedClock(T1));

    // A second mark finds no still-Requested row with that id — it must be refused (never a
    // silent second mark that would notify the person twice).
    await assert.rejects(
      async () => {
        await markConnectorRequestMatched(db, { id: req.id, connectorId: "dropbox-again" }, fixedClock(T1));
      },
      "re-matching an already-matched request is refused",
    );

    // And the original match is unchanged — the refused second mark did not overwrite it.
    const [still] = await listConnectorRequestsForUser(db, userId);
    assert.equal(still!.matchedConnectorId, "dropbox", "the original matched connector is intact");
  } finally {
    await db.close();
  }
});

test("markConnectorRequestMatched throws when no request with that id exists", async () => {
  const db = await freshDb();
  try {
    await makeUser(db, "mark-missing");
    await assert.rejects(
      async () => {
        await markConnectorRequestMatched(
          db,
          { id: "99999999-9999-9999-9999-999999999999", connectorId: "x" },
          fixedClock(T1),
        );
      },
      "marking a non-existent request is refused, never silent",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// [obligation:validate-and-parameterize-input] — every statement binds its input.
// ===========================================================================

test("createConnectorRequest binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "a'); DROP TABLE connector_requests; --";

  // The recording db returns no rows; createConnectorRequest assembles its result from the
  // inputs (like createConnection), so it does not depend on a RETURNING read.
  await createConnectorRequest(db, { userId: probe, serviceName: probe }, fixedClock(T0));

  assertBoundNotSpliced(db, probe);
});

test("listConnectorRequestsForUser binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE connector_requests; --";

  const result = await listConnectorRequestsForUser(db, probe);
  assert.deepEqual(result, [], "the recording db returns no rows, so the list is empty");

  assertBoundNotSpliced(db, probe);
});

test("markConnectorRequestMatched binds the id and connector as parameters, never splicing SQL", async () => {
  const db = recordingDb();
  const probe = "x'); DROP TABLE connector_requests; --";

  // No row comes back, so markConnectorRequestMatched cannot find a pending request and must
  // refuse — but the statement it issued must have BOUND the probe, not spliced it.
  await assert.rejects(async () => {
    await markConnectorRequestMatched(db, { id: probe, connectorId: probe }, fixedClock(T1));
  }, "markConnectorRequestMatched refuses when no pending request exists");

  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe in the service name is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const probe = "Grace'); DROP TABLE connector_requests; --";

    const created = await createConnectorRequest(db, { userId, serviceName: probe }, fixedClock(T0));

    assert.equal(
      await tableExists(db, "connector_requests"),
      true,
      "the connector_requests table must still exist (the probe was stored as data, not run as SQL)",
    );

    const [loaded] = await listConnectorRequestsForUser(db, userId);
    assert.equal(loaded!.id, created.id, "the same request is read back");
    assert.equal(loaded!.serviceName, probe, "the probe round-trips verbatim as data");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// [obligation:secrets-from-env] — the repo reads no process.env (db + clock injected);
// a decoy secret in the environment never lands in a stored or returned request.
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in the request", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "env");
    const created = await createConnectorRequest(db, { userId, serviceName: "Dropbox" }, fixedClock(T0));

    assert.ok(
      !JSON.stringify(created).includes(DECOY),
      "no ambient env value is folded into the returned request",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the same
    // value could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM connector_requests");
    assert.ok(all.rows.length >= 1, "the request row was stored");
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

test("the connector_requests migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "connector_requests"),
      true,
      "the connector_requests table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0019_connector_requests"),
      "db/migrations/0019_connector_requests.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0019's CREATE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
