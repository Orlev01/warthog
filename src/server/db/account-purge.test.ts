// E16-S07 — Account-purge store and purge role (`src/server/db/account-purge.ts`,
// `db/migrations/0043_account_purge.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./account-purge` throws and `freshDb()` has no `account_purge_queue` table and no
// `warthog_purge` role — every test here fails until the builder adds them. That absence IS
// the point of test-first; do NOT implement anything to make these pass — the builder writes
// the module and the migration afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: an account enqueued for purge
// and read back off the pending queue, the de-duplication of a repeat enqueue, that every
// value is BOUND as a parameter, what a handler on the validation boundary rejects, and the
// `warthog_purge` role's deletion capability that the append-only app role lacks), never the
// source text of the module or the SQL file — a later rename that preserves behaviour must not
// redden them.
//
// WHY this exists (task E16-S07; brief §"Australian Privacy Act and GDPR-style rights"
// / design §4.1 "Account deletion = crypto-shredding: deleting the wrapped DEK makes
// everything unreadable before the confirmation is shown; a job deletes the rows within 24
// hours"; design §9 "a separate `warthog_purge` role is used only by the account-deletion
// job"). Crypto-shredding makes a deleted account's data unreadable immediately, but the ROWS
// must still be removed within 24 hours by a dedicated job. A queue records which accounts
// await that purge; the separate `warthog_purge` role scopes the only code path allowed to
// delete append-only activity rows (the application role, `warthog_app`, is INSERT+SELECT only
// on `activity_entries` and can never remove an entry — migration 0016).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface PurgeRequest {            // an account awaiting purge
//     userId: string;                   // the account to purge (the session's id, NEVER a client value)
//     requestedAt: string | Date;       // when the purge was first requested (plaintext metadata,
//                                        //   the 24-hour clock starts here — NOT bumped by a re-enqueue)
//   }
//
//   enqueueAccountPurge(db, userId: string): Promise<PurgeRequest>
//     • enqueues `userId` for purge and returns the pending request. IDEMPOTENT: a second call
//       for the same account does NOT add a second pending entry and does NOT move the original
//       requestedAt (so the 24-hour deadline cannot be pushed out by re-requesting).
//   listPendingPurges(db): Promise<PurgeRequest[]>
//     • the WHOLE pending queue — every account awaiting purge (the job reads the queue across
//       all accounts, so this read is deliberately NOT member-scoped). Empty array when nothing
//       is queued.
//
// Acceptance criteria → tests:
//   AC1 "An account can be enqueued for purge and the pending queue read back." — enqueue
//        returns the request; listPendingPurges reads it back; several distinct accounts all
//        appear; an empty queue reads back as [].
//   AC2 "Enqueuing the same account twice does not create a duplicate pending entry." — after
//        two enqueues of one account the queue holds exactly one entry for it, and its original
//        requestedAt is preserved (the repeat is a no-op, not a replace).
//   AC3 "The migration creates the warthog_purge role used only by the purge job." — the role
//        exists after the migrations, is a no-LOGIN role (credentials bound out of band, never a
//        secret in a migration — INV-103), is separate from the app role, and HOLDS the DELETE
//        privilege on the append-only `activity_entries` that the app role is denied (the role
//        "scopes the only code path allowed to delete append-only activity rows"), enforced when
//        acting AS each role.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed input
//        with a 4xx BEFORE any query runs and takes the account from the SESSION (never a body
//        value); the repo binds its account id as a parameter (placeholders, never
//        concatenation), so a SQL-injection probe is stored/handled as a value and cannot drop
//        the table. The handler below is a TEST FIXTURE (the intended usage), not an
//        implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — enforced by construction: the repo takes `db`
//        as its only dependency, holds no secret and reads no `process.env`. Shown
//        behaviourally: a decoy secret planted in the environment never lands in a stored or
//        returned request.
//   Migration: the `account_purge_queue` relation exists after the project migrations and a
//        second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { enqueueAccountPurge, listPendingPurges } from "./account-purge";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

// A stand-in wrapped DEK for createUser (opaque base64; this task never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (the account the purge queue hangs off).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A structural view of a returned purge request, so the helpers below do not depend on the
// (absent) module's exported types at the point they run.
interface PurgeRequestLike {
  readonly userId: string;
  readonly requestedAt: Date | string;
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

// Whether a database role of this exact name exists.
async function roleExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT 1 AS present FROM pg_roles WHERE rolname = $1", [name]);
  return result.rows.length > 0;
}

// Whether a role may LOGIN (a role the purge job uses out of band must NOT — its credentials
// are bound by the deployment, never baked into a migration).
async function roleCanLogin(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT rolcanlogin FROM pg_roles WHERE rolname = $1", [name]);
  return result.rows[0]?.rolcanlogin === true;
}

// Whether `role` holds `privilege` on `table` (a catalog lookup, no row required).
async function hasTablePrivilege(
  db: Db,
  role: string,
  table: string,
  privilege: string,
): Promise<boolean> {
  const result = await db.query("SELECT has_table_privilege($1, $2, $3) AS p", [
    role,
    table,
    privilege,
  ]);
  return result.rows[0]?.p === true;
}

// Normalise an instant (Date or string) to a canonical ISO string, so a `timestamptz` that
// comes back as a Date, an ISO string, or a "YYYY-MM-DD HH:MM:SS+00" string all compare equal.
function toInstant(value: Date | string | number): string {
  return new Date(value).toISOString();
}

// Pending entries for one account (the queue read is global; callers filter here).
function entriesFor(queue: PurgeRequestLike[], userId: string): PurgeRequestLike[] {
  return queue.filter((e) => e.userId === userId);
}

// Assert a probe reached the query layer as a BOUND value and never as spliced SQL text,
// scoped to each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// Insert one minimal, valid append-only activity row directly (test setup only — this exercises
// the ROLE grants on `activity_entries`, not the activity writer). Parameterized; the dummy
// chain/ciphertext values only need to satisfy the NOT NULL columns.
async function seedActivityRow(db: Db, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO activity_entries
       (user_id, seq, occurred_at, kind, source, payload_ct, prev_hash, entry_hash)
     VALUES ($1, 1, now(), 'tool_call', 'warthog', 'v1:seed', 'genesis', 'hash-seed')`,
    [userId],
  );
}

// ===========================================================================
// AC1 — an account is enqueued for purge and the pending queue reads it back.
// ===========================================================================

test("enqueueAccountPurge returns a pending request with the account id and a requestedAt", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-enqueue");

    const queued = (await enqueueAccountPurge(db, userId)) as PurgeRequestLike;

    assert.equal(queued.userId, userId, "the request names the enqueued account");
    assert.ok(queued.requestedAt != null, "the request carries a requestedAt");
    assert.ok(!Number.isNaN(new Date(queued.requestedAt).getTime()), "requestedAt is a valid instant");
  } finally {
    await db.close();
  }
});

test("an enqueued account is read back from the pending queue", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-readback");
    await enqueueAccountPurge(db, userId);

    const queue = (await listPendingPurges(db)) as PurgeRequestLike[];
    const mine = entriesFor(queue, userId);
    assert.equal(mine.length, 1, "the enqueued account appears once on the pending queue");
    assert.equal(mine[0]!.userId, userId, "the queued entry names the account");
    assert.ok(mine[0]!.requestedAt != null, "the queued entry records when purge was requested");
  } finally {
    await db.close();
  }
});

test("listPendingPurges returns an empty array when nothing is queued", async () => {
  const db = await freshDb();
  try {
    // A person exists but has not asked to be purged.
    await makeUser(db, "ac1-empty");
    const queue = await listPendingPurges(db);
    assert.deepEqual(queue, [], "an empty queue reads back as an empty array");
  } finally {
    await db.close();
  }
});

test("the pending queue holds several distinct accounts awaiting purge", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac1-alice");
    const bob = await makeUser(db, "ac1-bob");
    const carol = await makeUser(db, "ac1-carol");

    await enqueueAccountPurge(db, alice);
    await enqueueAccountPurge(db, bob);
    await enqueueAccountPurge(db, carol);

    const queue = (await listPendingPurges(db)) as PurgeRequestLike[];
    const ids = new Set(queue.map((e) => e.userId));
    assert.ok(ids.has(alice) && ids.has(bob) && ids.has(carol), "all three accounts are on the queue");
    assert.equal(entriesFor(queue, alice).length, 1, "each account appears exactly once");
    assert.equal(entriesFor(queue, bob).length, 1, "each account appears exactly once");
    assert.equal(entriesFor(queue, carol).length, 1, "each account appears exactly once");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — enqueuing the same account twice does not create a duplicate pending entry.
// ===========================================================================

test("enqueuing the same account twice keeps a single pending entry", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-dedup");

    await enqueueAccountPurge(db, userId);
    await enqueueAccountPurge(db, userId);

    const queue = (await listPendingPurges(db)) as PurgeRequestLike[];
    assert.equal(
      entriesFor(queue, userId).length,
      1,
      "a repeat enqueue must not create a duplicate pending entry",
    );
  } finally {
    await db.close();
  }
});

test("re-enqueuing an account preserves its original requestedAt (the deadline is not pushed out)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-stable");

    await enqueueAccountPurge(db, userId);
    const first = entriesFor((await listPendingPurges(db)) as PurgeRequestLike[], userId)[0]!;

    // A real delay so `now()` advances between the two enqueues: were the repeat to REPLACE the
    // row (bump requestedAt), the second read would differ — proving it is a no-op, not a reset.
    await new Promise((resolve) => setTimeout(resolve, 10));

    await enqueueAccountPurge(db, userId);
    const second = entriesFor((await listPendingPurges(db)) as PurgeRequestLike[], userId);

    assert.equal(second.length, 1, "still exactly one pending entry after re-enqueue");
    assert.equal(
      toInstant(second[0]!.requestedAt),
      toInstant(first.requestedAt),
      "the original requestedAt is preserved — the 24-hour purge clock is not restarted",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("enqueueAccountPurge binds the account id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE account_purge_queue; --";

  // The recording db returns no rows; tolerate a no-row read — the binding is asserted below
  // regardless of what enqueueAccountPurge does with the (absent) returned row.
  try {
    await enqueueAccountPurge(db, probe);
  } catch {
    /* no-row read tolerated */
  }

  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe passed as the account id cannot drop the table (it is bound, not run)", async () => {
  const db = await freshDb();
  try {
    const probe = "'); DROP TABLE account_purge_queue; --";

    // Bound as a value, the probe is a malformed account id (Postgres rejects it on type), so the
    // call may throw — but the embedded DROP must never execute. If the id were spliced into the
    // SQL text instead, the DROP would run and the table would vanish.
    try {
      await enqueueAccountPurge(db, probe);
    } catch {
      /* a rejected value is fine; the table surviving is what we assert */
    }

    assert.equal(
      await tableExists(db, "account_purge_queue"),
      true,
      "the account_purge_queue table must still exist (the probe was bound as a value, not run as SQL)",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input and takes the account
// from the SESSION. A person asks to delete THEIR OWN account; the handler validates the
// typed confirmation, then enqueues the SESSION user id (NEVER a body value). A rejected input
// maps to a 4xx Response and never reaches a query. This handler is a TEST FIXTURE that
// exercises the modules — it is not an implementation file.
// ===========================================================================

const CONFIRM_PHRASE = "DELETE MY ACCOUNT";

function purgeAccountHandler(
  db: Db,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries only the typed confirmation; the account comes from the SESSION, never the
  // body. The confirmation length is capped so an absurd value is rejected by size.
  const schema = z.object({
    confirm: z.string().min(1).max(64),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      if (body.confirm !== CONFIRM_PHRASE) {
        return new Response(JSON.stringify({ error: "confirmation required" }), { status: 400 });
      }
      const queued = await enqueueAccountPurge(db, sessionUserId);
      return new Response(JSON.stringify({ userId: queued.userId }), { status: 202 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test sees
      // the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/account/purge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function validBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ confirm: CONFIRM_PHRASE, ...over });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = purgeAccountHandler(db, "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = purgeAccountHandler(db, "session-user");

  // ~8 KiB confirmation, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(validBody({ confirm: "a".repeat(8 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing the confirmation with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = purgeAccountHandler(db, "session-user");

  const res = await handler(jsonRequest(JSON.stringify({})));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed confirmation with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = purgeAccountHandler(db, "session-user");

  // confirm must be a string — a number is a schema violation.
  const res = await handler(jsonRequest(JSON.stringify({ confirm: 123 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed confirmation must never reach a query");
});

test("the handler rejects the wrong confirmation phrase with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = purgeAccountHandler(db, "session-user");

  const res = await handler(jsonRequest(validBody({ confirm: "delete" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an unconfirmed request must never reach a query");
});

test("the handler accepts a confirmed request and enqueues the SESSION account", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const handler = purgeAccountHandler(db, userId);

    const res = await handler(jsonRequest(validBody()));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    const queue = (await listPendingPurges(db)) as PurgeRequestLike[];
    assert.equal(entriesFor(queue, userId).length, 1, "a confirmed request enqueues the session account");
  } finally {
    await db.close();
  }
});

test("the handler takes the account from the session, not the body (no cross-account enqueue)", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const handler = purgeAccountHandler(db, sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(jsonRequest(validBody({ userId: attacker })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    const queue = (await listPendingPurges(db)) as PurgeRequestLike[];
    assert.equal(entriesFor(queue, sessionUser).length, 1, "the SESSION account is enqueued");
    assert.equal(
      entriesFor(queue, attacker).length,
      0,
      "the account id smuggled in the body is never enqueued",
    );
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected through the body: the table survives and the session account is enqueued", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const handler = purgeAccountHandler(db, userId);

    // A probe smuggled as a body userId never reaches a query (the session id is used), and the
    // confirmation is just validated — so the table stands and only the session account queues.
    const res = await handler(
      jsonRequest(validBody({ userId: "x'); DROP TABLE account_purge_queue; --" })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal(
      await tableExists(db, "account_purge_queue"),
      true,
      "the account_purge_queue table must still exist",
    );
    const queue = (await listPendingPurges(db)) as PurgeRequestLike[];
    assert.equal(entriesFor(queue, userId).length, 1, "only the session account is enqueued");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the repo reads no process.env and holds no secret (INV-103), shown behaviourally
// with a decoy secret planted in the environment.
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in a purge request", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5");
    await enqueueAccountPurge(db, userId);

    const queue = (await listPendingPurges(db)) as PurgeRequestLike[];
    assert.equal(entriesFor(queue, userId).length, 1, "the request reads and writes purely from the injected db");
    assert.ok(
      !JSON.stringify(queue).includes(DECOY),
      "no ambient env value is folded into the returned queue",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — a real datum
    // could legitimately live elsewhere; this value is not one).
    const all = await db.query("SELECT * FROM account_purge_queue");
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
// AC3 — the migration creates the `warthog_purge` role used only by the purge job: it exists,
// is a no-LOGIN role separate from the app role, and holds the DELETE privilege on the
// append-only activity record that the app role is denied.
// ===========================================================================

test("the migration creates a no-LOGIN warthog_purge role, separate from the app role", async () => {
  const db = await freshDb();
  try {
    assert.equal(await roleExists(db, "warthog_purge"), true, "the warthog_purge role must exist after the migrations");
    assert.equal(
      await roleCanLogin(db, "warthog_purge"),
      false,
      "warthog_purge must not be able to LOGIN — its credentials are bound out of band, never baked into a migration (INV-103)",
    );
    // A separate role from the application role (migration 0016 creates `warthog_app`).
    assert.equal(await roleExists(db, "warthog_app"), true, "the application role still exists");
  } finally {
    await db.close();
  }
});

test("warthog_purge may DELETE append-only activity rows; the app role may not", async () => {
  const db = await freshDb();
  try {
    // The whole point of the separate role: it CAN delete append-only activity rows, while the
    // application role (INSERT+SELECT only — migration 0016) cannot.
    assert.equal(
      await hasTablePrivilege(db, "warthog_purge", "activity_entries", "DELETE"),
      true,
      "warthog_purge must hold DELETE on activity_entries (the only code path allowed to remove append-only rows)",
    );
    assert.equal(
      await hasTablePrivilege(db, "warthog_app", "activity_entries", "DELETE"),
      false,
      "the application role must NOT hold DELETE on activity_entries (append-only)",
    );
  } finally {
    await db.close();
  }
});

test("acting AS warthog_purge a DELETE on activity_entries succeeds; acting AS the app role it is denied", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "role-enforce");
    await seedActivityRow(db, userId);

    // The append-only application role is denied — it cannot remove the row.
    await db.query(`SET ROLE "warthog_app"`);
    try {
      await assert.rejects(
        () => db.query("DELETE FROM activity_entries"),
        /permission denied/i,
        "a DELETE by the app role must be rejected (append-only)",
      );
    } finally {
      await db.query("RESET ROLE");
    }

    // The row survived the denied delete.
    const stillThere = await db.query("SELECT count(*)::int AS n FROM activity_entries");
    assert.equal(Number(stillThere.rows[0]?.n), 1, "the app role's denied DELETE left the row in place");

    // The purge role is allowed — it removes the append-only row.
    await db.query(`SET ROLE "warthog_purge"`);
    try {
      await db.query("DELETE FROM activity_entries");
    } finally {
      await db.query("RESET ROLE");
    }

    const after = await db.query("SELECT count(*)::int AS n FROM activity_entries");
    assert.equal(Number(after.rows[0]?.n), 0, "acting as warthog_purge the append-only row is removed");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Migration — the table applies and a second run changes nothing.
// ===========================================================================

test("the account_purge migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "account_purge_queue"),
      true,
      "the account_purge_queue table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0043_account_purge"),
      "db/migrations/0043_account_purge.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw — re-executing
    // 0043's CREATE TABLE / CREATE ROLE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
