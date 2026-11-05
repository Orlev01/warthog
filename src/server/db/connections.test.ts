// E09-S05 — Connections store (`src/server/db/connections.ts`,
// `db/migrations/0018_connections.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./connections` throws and `freshDb()` has no `connections` table — every test here
// fails until the builder adds them. That absence IS the point of test-first; do NOT
// implement anything to make these pass — the builder writes the module and the
// migration afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: the stored identity and
// status, the list-all read, the DEK-encrypted credentials that round-trip only under the
// owner's key, who may read/mutate what, what a handler rejects, that every value is bound
// as a parameter), never the source text of the module or the SQL file — a later rename
// that preserves behaviour must not redden them.
//
// WHY this exists (task E09-S05; CLAUDE.md vocabulary: a *connection* is a person's
// connected service; a *connector* is a catalogue entry): a connection holds the provider
// CREDENTIALS and the live STATUS for one connected service. Every agent use of a service
// resolves through one connection (design §6.1, §7 — "Agents reach connected services only
// through Warthog"), and management must see ALL of a person's connections regardless of
// status. The credentials are PERSONAL CONTENT (provider OAuth tokens / API keys), so they
// are stored only DEK-ENCRYPTED (`../crypto/envelope`, design §4.1, §7 "Credentials are
// stored DEK-encrypted per connection"): the id is generated up front so the envelope's
// associated data can bind the ciphertext to its exact (table, column, row) — the plaintext
// never lands in a column. The connector id, account label, status and connected date are
// PLAINTEXT METADATA (design §4.1) — needed for the list — so they are NOT encrypted.
//
// The `connectorId` is a catalogue slug (design §7 — `catalogue/connectors/<id>.yaml`:
// "google", "microsoft", "gmail", …), a TEXT value, not a uuid. The connection's own `id`
// and the owning `user_id` are uuids. `connectorId` is bound by value with ownership
// enforced by the session's `user_id`, not a foreign key to the catalogue (which is a data
// file, not a table).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type ConnectionStatus = "connected" | "needs_reconnect" | "error";
//
//   interface NewConnection {        // what createConnection records
//     userId: string;                // the owner (the session's id, NEVER a client value)
//     connectorId: string;           // the catalogue slug of the connected service
//     accountLabel: string;          // the account label shown in the UI (e.g. an address)
//     credentials: Record<string, unknown>;  // provider credentials — stored DEK-encrypted
//     status?: ConnectionStatus;     // defaults to "connected" (a freshly connected service)
//   }
//
//   interface Connection {           // a connection as handed back to a client/management:
//     id: string;                    // the connection id (generated on create)
//     userId: string;                // CREDENTIALS ARE NEVER PART OF THIS SHAPE (AC2) —
//     connectorId: string;           // only id, connector, account label, status and date.
//     accountLabel: string;
//     status: ConnectionStatus;
//     connectedAt: Date | string;    // the connected date (= clock.now() on create)
//   }
//
//   createConnection(db, input: NewConnection, dek, clock): Promise<Connection>
//     • stores the metadata plus the DEK-encrypted credentials (status defaults to
//       "connected", connectedAt = clock.now()), and returns the Connection — WITHOUT
//       credentials. Assembles the returned Connection from its inputs (it does not depend
//       on a RETURNING read), like createAgent / createHeldRequest.
//   listConnectionsForUser(db, userId): Promise<Connection[]>
//     • ALL of `userId`'s connections REGARDLESS OF STATUS (member-scoped: WHERE user_id
//       bound); never another person's; never with credentials. Empty array when none.
//   getConnectionById(db, userId, id): Promise<Connection | null>
//     • the one connection OWNED BY `userId` (member-scoped: id AND user_id both bound),
//       WITHOUT credentials; null when none for this user — so another person's connection
//       id returns null.
//   getConnectionCredentials(db, userId, id, dek): Promise<Record<string, unknown> | null>
//     • the SERVER-SIDE accessor the connector engine resolves an agent's service use
//       through — member-scoped (id AND user_id both bound), the credentials decrypted under
//       the owner's `dek`; null when none for this user (another person cannot read them).
//       This path is never wired to a client response — AC2 governs the Connection shape
//       above, which carries no credentials.
//   updateConnectionStatus(db, { userId, id, status }): Promise<Connection>
//     • member-scoped: sets the owned connection's status (design §7 — a failed refresh
//       marks a connection "needs_reconnect"), leaving the credentials, connector, label
//       and connected date untouched; returns the updated Connection (no credentials).
//       THROWS (never silently) when no connection with that id belongs to this user — so
//       one person can never mutate another's connection.
//
// Acceptance criteria → tests:
//   AC1 "Creating a connection stores credentials DEK-encrypted and listConnectionsForUser
//        returns all of the owner's connections regardless of status." — createConnection
//        returns an id and the recorded metadata; the plaintext credentials never appear in
//        a raw column (encrypted at rest) yet round-trip under the owner's DEK via
//        getConnectionCredentials; listConnectionsForUser returns every one of the owner's
//        connections across all three statuses and none of anyone else's.
//   AC2 "A connection's credentials are never returned to the client; only id, connector,
//        account label, status and date." — create / list / getById / updateStatus each
//        return a Connection with NO credentials field and never fold a credential token
//        into the returned object.
//   AC3 "A user cannot read or mutate another user's connection by id (filtered by session
//        user id)." — B's getConnectionById / getConnectionCredentials on A's id return
//        null, B never sees A's connections in a list, and B's updateConnectionStatus on A's
//        id is refused and leaves A's connection untouched; the user id is bound as a param.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed
//        input with a 4xx before any query runs; a SQL-injection probe routed through the
//        repo travels as a BOUND value (placeholders, never concatenation) and cannot drop
//        the table. The handler below is a test fixture (the intended usage), not an
//        implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — enforced by construction: the repo takes
//        `db` and the `dek` as injected dependencies, holds no key and reads no
//        `process.env` (config flows from `src/server/config.ts` alone). Shown
//        behaviourally: the credentials are encrypted under the INJECTED dek (a different
//        dek cannot read them back — not a baked-in secret), the connection reads/writes
//        purely from the injected db with no app env configured, and a decoy secret planted
//        in the environment never lands in the stored or returned connection.
//   Migration: the `connections` relation exists after the project migrations and a second
//        run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import {
  createConnection,
  listConnectionsForUser,
  getConnectionById,
  getConnectionCredentials,
  updateConnectionStatus,
} from "./connections";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// Connector slugs are catalogue ids (design §7 — text, not uuids).
const GOOGLE = "google";
const MICROSOFT = "microsoft";
const GMAIL = "gmail";

// Instants deliberately in the past relative to the wall clock, so anything that wrongly
// read Date.now() instead of the injected clock would diverge here.
const T0 = new Date("2026-04-01T09:00:00.000Z");

// Compare the moment, not the representation: connectedAt may come back as a Date or an ISO
// string — either is a reasonable choice and must not redden a test.
const ms = (value: Date | string | number): number => new Date(value as never).getTime();

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a layer
// up; this repo only ever receives the already-unwrapped bytes.
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

// Provider credentials carrying UNIQUE tokens, so an at-rest scan for them is unambiguous —
// a raw occurrence would be a genuine plaintext leak, not a coincidence.
function credsWith(token: string): Record<string, unknown> {
  return {
    accessToken: `atok_${token}`,
    refreshToken: `rtok_${token}`,
    scope: "https://www.googleapis.com/auth/gmail.readonly",
  };
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

// Assert a returned Connection carries NO credentials (AC2), scoped to the one object: it
// has no `credentials` key and no credential token is folded into it. The same token may
// legitimately live (encrypted) in a raw column — this check is the client-facing shape only.
function assertNoCredentials(connection: unknown, token: string): void {
  assert.ok(connection && typeof connection === "object", "a connection object was returned");
  const obj = connection as Record<string, unknown>;
  assert.ok(!("credentials" in obj), "the connection shape carries no credentials field");
  assert.equal(obj.credentials, undefined, "there is no credentials value on the connection");
  assert.ok(
    !JSON.stringify(connection).includes(`atok_${token}`),
    "no access-token value is folded into the returned connection",
  );
  assert.ok(
    !JSON.stringify(connection).includes(`rtok_${token}`),
    "no refresh-token value is folded into the returned connection",
  );
}

// ===========================================================================
// AC1 — creating records a connection's metadata and stores its credentials
// DEK-encrypted; listConnectionsForUser returns all of the owner's connections
// regardless of status.
// ===========================================================================

test("createConnection returns a connection with an id, the recorded metadata, and the injected connected date", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const dek = freshDek();

    const created = await createConnection(
      db,
      { userId, connectorId: GOOGLE, accountLabel: "oren@gmail.com", credentials: credsWith("A1") },
      dek,
      fixedClock(T0),
    );

    assert.equal(typeof created.id, "string", "createConnection returns an id string");
    assert.ok(created.id.length > 0, "the returned id is non-empty");
    assert.equal(created.userId, userId, "the connection belongs to the creating person");
    assert.equal(created.connectorId, GOOGLE, "the connector slug is recorded");
    assert.equal(created.accountLabel, "oren@gmail.com", "the account label is recorded");
    assert.equal(created.status, "connected", "a freshly connected service defaults to connected");
    assert.equal(ms(created.connectedAt), ms(T0), "connectedAt is the injected clock instant");
  } finally {
    await db.close();
  }
});

test("createConnection records an explicitly supplied status", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-status");
    const dek = freshDek();

    const created = await createConnection(
      db,
      {
        userId,
        connectorId: MICROSOFT,
        accountLabel: "oren@outlook.com",
        credentials: credsWith("S1"),
        status: "needs_reconnect",
      },
      dek,
      fixedClock(T0),
    );

    assert.equal(created.status, "needs_reconnect", "an explicit status is recorded verbatim");

    const reloaded = await getConnectionById(db, userId, created.id);
    assert.equal(reloaded!.status, "needs_reconnect", "and it is persisted");
  } finally {
    await db.close();
  }
});

test("createConnection gives each connection a distinct id", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-ids");
    const dek = freshDek();
    const one = await createConnection(
      db,
      { userId, connectorId: GOOGLE, accountLabel: "a@gmail.com", credentials: credsWith("x") },
      dek,
      fixedClock(T0),
    );
    const two = await createConnection(
      db,
      { userId, connectorId: MICROSOFT, accountLabel: "b@outlook.com", credentials: credsWith("y") },
      dek,
      fixedClock(T0),
    );
    assert.notEqual(one.id, two.id, "two created connections have different ids");
  } finally {
    await db.close();
  }
});

test("the credentials are stored DEK-encrypted: the plaintext tokens never appear in a raw column", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-atrest");
    const dek = freshDek();
    const creds = credsWith("LEAKCHECK9x");

    await createConnection(
      db,
      { userId, connectorId: GOOGLE, accountLabel: "oren@gmail.com", credentials: creds },
      dek,
      fixedClock(T0),
    );

    // Scan every cell of the one table under test. The access/refresh tokens are personal
    // content that MUST be encrypted (AC1), and their tokens are unique, so any raw
    // occurrence is a genuine plaintext leak. Scoped to `connections` alone — the same
    // value may legitimately live (encrypted) elsewhere.
    const all = await db.query("SELECT * FROM connections");
    assert.ok(all.rows.length >= 1, "the connection row was stored");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(
            !cell.includes(creds.accessToken as string),
            "the plaintext access token must never be written to a column",
          );
          assert.ok(
            !cell.includes(creds.refreshToken as string),
            "the plaintext refresh token must never be written to a column",
          );
        }
      }
    }
  } finally {
    await db.close();
  }
});

test("getConnectionCredentials round-trips the stored credentials under the owner's DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-roundtrip");
    const dek = freshDek();
    const creds = credsWith("ROUND");

    const created = await createConnection(
      db,
      { userId, connectorId: GMAIL, accountLabel: "oren@gmail.com", credentials: creds },
      dek,
      fixedClock(T0),
    );

    const read = await getConnectionCredentials(db, userId, created.id, dek);
    assert.deepEqual(read, creds, "the credentials decrypt back to exactly what was stored");
  } finally {
    await db.close();
  }
});

test("listConnectionsForUser returns every one of the owner's connections REGARDLESS OF STATUS", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-list");
    const dek = freshDek();
    await createConnection(
      db,
      { userId, connectorId: GOOGLE, accountLabel: "ok@gmail.com", credentials: credsWith("c1"), status: "connected" },
      dek,
      fixedClock(T0),
    );
    await createConnection(
      db,
      { userId, connectorId: MICROSOFT, accountLabel: "stale@outlook.com", credentials: credsWith("c2"), status: "needs_reconnect" },
      dek,
      fixedClock(T0),
    );
    await createConnection(
      db,
      { userId, connectorId: GMAIL, accountLabel: "broken@gmail.com", credentials: credsWith("c3"), status: "error" },
      dek,
      fixedClock(T0),
    );

    const connections = await listConnectionsForUser(db, userId);
    assert.equal(connections.length, 3, "all three of the owner's connections are listed");

    // Every status is present — management must see connections in any state.
    const statuses = new Set(connections.map((c) => c.status));
    assert.ok(statuses.has("connected"), "a connected connection is listed");
    assert.ok(statuses.has("needs_reconnect"), "a needs_reconnect connection is listed");
    assert.ok(statuses.has("error"), "an errored connection is listed");

    for (const connection of connections) {
      assert.equal(connection.userId, userId, "every listed connection belongs to the owner");
    }
  } finally {
    await db.close();
  }
});

test("listConnectionsForUser returns an empty array for a person with no connections", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-empty");
    const connections = await listConnectionsForUser(db, userId);
    assert.deepEqual(connections, [], "a person with no connections gets an empty list");
  } finally {
    await db.close();
  }
});

test("getConnectionById reads one created connection back by its id for its owner", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-byid");
    const dek = freshDek();
    const created = await createConnection(
      db,
      { userId, connectorId: GOOGLE, accountLabel: "oren@gmail.com", credentials: credsWith("B") },
      dek,
      fixedClock(T0),
    );

    const loaded = await getConnectionById(db, userId, created.id);
    assert.ok(loaded, "the created connection is readable by its owner via its id");
    assert.equal(loaded!.id, created.id, "the same connection id is returned");
    assert.equal(loaded!.connectorId, GOOGLE, "its connector is preserved");
    assert.equal(loaded!.accountLabel, "oren@gmail.com", "its account label is preserved");
    assert.equal(loaded!.status, "connected", "its status is preserved");
    assert.equal(ms(loaded!.connectedAt), ms(T0), "its connected date is preserved");
  } finally {
    await db.close();
  }
});

test("getConnectionById returns null for an id that does not exist", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-missing");
    const loaded = await getConnectionById(db, userId, "99999999-9999-9999-9999-999999999999");
    assert.equal(loaded, null, "an unknown connection id returns null");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a connection's credentials are never returned to the client; only id,
// connector, account label, status and date.
// ===========================================================================

test("createConnection never returns the credentials in the Connection it hands back", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-create");
    const dek = freshDek();
    const created = await createConnection(
      db,
      { userId, connectorId: GOOGLE, accountLabel: "oren@gmail.com", credentials: credsWith("NOCRED1") },
      dek,
      fixedClock(T0),
    );
    assertNoCredentials(created, "NOCRED1");
  } finally {
    await db.close();
  }
});

test("listConnectionsForUser and getConnectionById never carry credentials", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-read");
    const dek = freshDek();
    const created = await createConnection(
      db,
      { userId, connectorId: MICROSOFT, accountLabel: "oren@outlook.com", credentials: credsWith("NOCRED2") },
      dek,
      fixedClock(T0),
    );

    const [listed] = await listConnectionsForUser(db, userId);
    assertNoCredentials(listed, "NOCRED2");

    const byId = await getConnectionById(db, userId, created.id);
    assertNoCredentials(byId, "NOCRED2");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: a second signed-in person can never read, list or mutate
// another's connection. The user id is bound from the session, never the client.
// ===========================================================================

test("listConnectionsForUser never returns another person's connections", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-alice");
    const bob = await makeUser(db, "owner-bob");
    const dek = freshDek();
    await createConnection(db, { userId: alice, connectorId: GOOGLE, accountLabel: "alice@gmail.com", credentials: credsWith("a1") }, dek, fixedClock(T0));
    await createConnection(db, { userId: alice, connectorId: MICROSOFT, accountLabel: "alice@outlook.com", credentials: credsWith("a2") }, dek, fixedClock(T0));
    await createConnection(db, { userId: bob, connectorId: GMAIL, accountLabel: "bob@gmail.com", credentials: credsWith("b1") }, dek, fixedClock(T0));

    const aliceConnections = await listConnectionsForUser(db, alice);
    assert.equal(aliceConnections.length, 2, "Alice sees exactly her own two connections");
    assert.ok(aliceConnections.every((c) => c.userId === alice), "every connection in Alice's list is hers");
    assert.ok(!aliceConnections.some((c) => c.accountLabel === "bob@gmail.com"), "Bob's connection never appears in Alice's list");

    const bobConnections = await listConnectionsForUser(db, bob);
    assert.equal(bobConnections.length, 1, "Bob sees exactly his own connection");
    assert.equal(bobConnections[0]!.accountLabel, "bob@gmail.com", "Bob sees his own connection");
  } finally {
    await db.close();
  }
});

test("getConnectionById never returns another person's connection by id", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "byid-alice");
    const bob = await makeUser(db, "byid-bob");
    const dek = freshDek();
    const alices = await createConnection(db, { userId: alice, connectorId: GOOGLE, accountLabel: "alice@gmail.com", credentials: credsWith("a") }, dek, fixedClock(T0));

    assert.ok(await getConnectionById(db, alice, alices.id), "Alice can read her own connection by id");
    assert.equal(
      await getConnectionById(db, bob, alices.id),
      null,
      "Bob cannot read Alice's connection by its id",
    );
  } finally {
    await db.close();
  }
});

test("getConnectionCredentials never returns another person's credentials by id", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "cred-alice");
    const bob = await makeUser(db, "cred-bob");
    const dek = freshDek();
    const alices = await createConnection(db, { userId: alice, connectorId: GOOGLE, accountLabel: "alice@gmail.com", credentials: credsWith("secretA") }, dek, fixedClock(T0));

    assert.ok(await getConnectionCredentials(db, alice, alices.id, dek), "Alice can resolve her own credentials");
    assert.equal(
      await getConnectionCredentials(db, bob, alices.id, dek),
      null,
      "Bob cannot resolve Alice's credentials by her connection id",
    );
  } finally {
    await db.close();
  }
});

test("updateConnectionStatus cannot mutate another person's connection, and leaves it unchanged", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "mut-alice");
    const bob = await makeUser(db, "mut-bob");
    const dek = freshDek();
    const alices = await createConnection(db, { userId: alice, connectorId: GOOGLE, accountLabel: "alice@gmail.com", credentials: credsWith("a") }, dek, fixedClock(T0));

    // Bob tries to change the status of Alice's connection by its id: member-scoped, so
    // there is no such connection FOR BOB — updateConnectionStatus must refuse (never
    // silently touch it).
    await assert.rejects(
      async () => {
        await updateConnectionStatus(db, { userId: bob, id: alices.id, status: "error" });
      },
      "Bob cannot change the status of a connection that is not his",
    );

    const stillAlices = await getConnectionById(db, alice, alices.id);
    assert.equal(stillAlices!.status, "connected", "Alice's status is untouched by Bob's attempt");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 (cont.) — updateConnectionStatus is the owned mutation: it changes the owner's
// connection status, persists, and leaves credentials / metadata intact.
// ===========================================================================

test("updateConnectionStatus changes the owner's status and persists it, leaving credentials intact", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "mut-ok");
    const dek = freshDek();
    const creds = credsWith("KEEP");
    const created = await createConnection(
      db,
      { userId, connectorId: GOOGLE, accountLabel: "oren@gmail.com", credentials: creds },
      dek,
      fixedClock(T0),
    );
    assert.equal(created.status, "connected", "it starts connected");

    const updated = await updateConnectionStatus(db, { userId, id: created.id, status: "needs_reconnect" });
    assert.equal(updated.status, "needs_reconnect", "the status is changed");
    assert.equal(updated.connectorId, GOOGLE, "the connector is untouched");
    assert.equal(updated.accountLabel, "oren@gmail.com", "the account label is untouched");
    assert.equal(ms(updated.connectedAt), ms(T0), "the connected date is untouched by a status change");
    assertNoCredentials(updated, "KEEP");

    const reloaded = await getConnectionById(db, userId, created.id);
    assert.equal(reloaded!.status, "needs_reconnect", "the new status is persisted");

    // The credentials survive a status change (not clobbered) and still decrypt.
    const stillReadable = await getConnectionCredentials(db, userId, created.id, dek);
    assert.deepEqual(stillReadable, creds, "the credentials are intact after a status change");
  } finally {
    await db.close();
  }
});

test("updateConnectionStatus throws when no connection with that id exists for the user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "mut-missing");
    await assert.rejects(
      async () => {
        await updateConnectionStatus(db, { userId, id: "99999999-9999-9999-9999-999999999999", status: "error" });
      },
      "updating a non-existent connection is refused, never silent",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("createConnection binds its inputs as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "a'); DROP TABLE connections; --";

  // The recording db returns no rows; createConnection may throw if it reads back a row —
  // either way the INSERT it issued must have BOUND the probe, which is what this test checks.
  try {
    await createConnection(
      db,
      { userId: probe, connectorId: probe, accountLabel: probe, credentials: credsWith("p") },
      freshDek(),
      fixedClock(T0),
    );
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("listConnectionsForUser binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE connections; --";

  const result = await listConnectionsForUser(db, probe);
  assert.deepEqual(result, [], "the recording db returns no rows, so the list is empty");

  assertBoundNotSpliced(db, probe);
});

test("getConnectionById binds the id and user id as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "p'); DROP TABLE connections; --";

  const result = await getConnectionById(db, probe, probe);
  assert.equal(result, null, "the recording db returns no rows, so the lookup is empty");

  assertBoundNotSpliced(db, probe);
});

test("getConnectionCredentials binds the id and user id as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "c'); DROP TABLE connections; --";

  const result = await getConnectionCredentials(db, probe, probe, freshDek());
  assert.equal(result, null, "the recording db returns no rows, so there is nothing to decrypt");

  assertBoundNotSpliced(db, probe);
});

test("updateConnectionStatus binds the id and user id as parameters, never splicing SQL", async () => {
  const db = recordingDb();
  const probe = "x'); DROP TABLE connections; --";

  // No row comes back, so updateConnectionStatus cannot find an owned connection and must
  // refuse — but the statement it issued must have BOUND the probe, not spliced it.
  await assert.rejects(async () => {
    await updateConnectionStatus(db, { userId: probe, id: probe, status: "needs_reconnect" });
  }, "updateConnectionStatus refuses when no owned connection exists");

  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe in the account label is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const dek = freshDek();
    const probe = "Grace'); DROP TABLE connections; --";

    const created = await createConnection(
      db,
      { userId, connectorId: GOOGLE, accountLabel: probe, credentials: credsWith("i") },
      dek,
      fixedClock(T0),
    );

    assert.equal(
      await tableExists(db, "connections"),
      true,
      "the connections table must still exist (the probe was stored as data, not run as SQL)",
    );

    const loaded = await getConnectionById(db, userId, created.id);
    assert.equal(loaded!.id, created.id, "the same connection is read back");
    assert.equal(loaded!.accountLabel, probe, "the probe round-trips verbatim as data");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input and binds probes.
//
// A route handler validates external input HERE (`parseBody`), then calls this task's
// parameterized data-access with the SESSION's user id (NEVER a body value) and the
// injected dek. A rejected input maps to a 4xx Response and never reaches a query. This
// handler is a test fixture that EXERCISES the modules — it is not an implementation file.
// ===========================================================================

function addConnectionHandler(
  db: Db,
  dek: Uint8Array,
  clock: Clock,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries the connector, the account label and the provider credentials; the
  // user id comes from the session, never the body. Lengths are capped so an absurd value
  // is rejected, but generous enough that a probe can still REACH the query to prove it is
  // bound.
  const schema = z.object({
    connectorId: z.string().min(1).max(64),
    accountLabel: z.string().min(1).max(200),
    credentials: z.record(z.string(), z.unknown()),
    status: z.enum(["connected", "needs_reconnect", "error"]).optional(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 8 * 1024 });
      const created = await createConnection(
        db,
        {
          userId: sessionUserId,
          connectorId: body.connectorId,
          accountLabel: body.accountLabel,
          credentials: body.credentials,
          status: body.status,
        },
        dek,
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
  return new Request("https://warthog.com.au/api/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = addConnectionHandler(db, freshDek(), fixedClock(T0), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = addConnectionHandler(db, freshDek(), fixedClock(T0), "session-user");

  // ~20 KiB credential blob, well over the handler's 8 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest(
      JSON.stringify({
        connectorId: GOOGLE,
        accountLabel: "oren@gmail.com",
        credentials: { accessToken: "a".repeat(20 * 1024) },
      }),
    ),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = addConnectionHandler(db, freshDek(), fixedClock(T0), "session-user");

  // No credentials — a connection must carry the provider credentials it stores.
  const res = await handler(jsonRequest(JSON.stringify({ connectorId: GOOGLE, accountLabel: "oren@gmail.com" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = addConnectionHandler(db, freshDek(), fixedClock(T0), "session-user");

  // credentials must be an object — a string is a schema violation, rejected before any query.
  const res = await handler(
    jsonRequest(JSON.stringify({ connectorId: GOOGLE, accountLabel: "oren@gmail.com", credentials: "not-an-object" })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler accepts a well-formed body and records the connection for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const handler = addConnectionHandler(db, dek, fixedClock(T0), userId);

    const res = await handler(
      jsonRequest(JSON.stringify({ connectorId: GOOGLE, accountLabel: "oren@gmail.com", credentials: credsWith("HOK") })),
    );

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };

    const stored = await getConnectionById(db, userId, id);
    assert.ok(stored, "a valid body is persisted for the session user");
    assert.equal(stored!.id, id, "the stored connection matches the returned id");
    assert.equal(stored!.connectorId, GOOGLE, "with the submitted connector");
    assert.equal(stored!.accountLabel, "oren@gmail.com", "and the submitted account label");
    assert.equal(stored!.status, "connected", "and the default status");

    // The credentials were stored (encrypted) and resolve under the owner's DEK.
    const creds = await getConnectionCredentials(db, userId, id, dek);
    assert.deepEqual(creds, credsWith("HOK"), "the submitted credentials round-trip under the DEK");
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const dek = freshDek();
    const handler = addConnectionHandler(db, dek, fixedClock(T0), sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(
      jsonRequest(JSON.stringify({ userId: attacker, connectorId: GOOGLE, accountLabel: "oren@gmail.com", credentials: credsWith("S") })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal((await listConnectionsForUser(db, sessionUser)).length, 1, "the connection is recorded under the SESSION user");
    assert.deepEqual(
      await listConnectionsForUser(db, attacker),
      [],
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe account label is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const dek = freshDek();
    const handler = addConnectionHandler(db, dek, fixedClock(T0), userId);
    const probe = "oren'); DROP TABLE connections; --";

    const res = await handler(
      jsonRequest(JSON.stringify({ connectorId: GOOGLE, accountLabel: probe, credentials: credsWith("P") })),
    );

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "connections"), true, "the connections table must still exist");

    const { id } = (await res.json()) as { id: string };
    const stored = await getConnectionById(db, userId, id);
    assert.equal(stored!.accountLabel, probe, "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the credentials are encrypted under the INJECTED dek, not a baked-in secret
// (a different dek cannot read them back); the repo reads no process.env and holds no
// key (INV-103), shown behaviourally with a decoy secret in the environment.
// ===========================================================================

test("getConnectionCredentials cannot decrypt the credentials with a different DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-wrongdek");
    const dek = freshDek();
    const created = await createConnection(
      db,
      { userId, connectorId: GOOGLE, accountLabel: "oren@gmail.com", credentials: credsWith("K") },
      dek,
      fixedClock(T0),
    );

    // A different DEK is the wrong key; the GCM tag must fail rather than return other
    // bytes — so reading the credentials under it rejects.
    const wrongDek = freshDek();
    await assert.rejects(
      async () => {
        await getConnectionCredentials(db, userId, created.id, wrongDek);
      },
      "the credentials are bound to the person's own DEK, not any ambient/hardcoded key",
    );
  } finally {
    await db.close();
  }
});

test("the repo reads no process.env: a decoy secret in the environment never lands in the connection", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5");
    const dek = freshDek();
    const created = await createConnection(
      db,
      { userId, connectorId: GOOGLE, accountLabel: "oren@gmail.com", credentials: credsWith("E") },
      dek,
      fixedClock(T0),
    );

    const loaded = await getConnectionById(db, userId, created.id);
    assert.ok(loaded, "the connection reads and writes purely from the injected db — no app env needed");
    assert.ok(
      !JSON.stringify(loaded).includes(DECOY),
      "no ambient env value is folded into the returned connection",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the same
    // value could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM connections");
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

test("the connections migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "connections"),
      true,
      "the connections table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0018_connections"),
      "db/migrations/0018_connections.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0018's CREATE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
