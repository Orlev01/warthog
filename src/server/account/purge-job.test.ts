// E16-S09 — Account-purge job (`src/server/account/purge-job.ts`).
//
// RED-first: the purge-job module does not exist yet, so importing `./purge-job`
// throws and every test here fails until the builder writes it. That absence IS the
// point of test-first; do NOT implement anything to make these pass — the builder
// writes the module afterwards, with the minimum code that turns these green.
//
// These tests pin BEHAVIOUR (what the job DOES to stored state: which rows it removes,
// which it leaves, what it reports, and that it is safe to re-run), never the source
// text of the module — a later rename that preserves behaviour must not redden them.
// There is no Postgres server, no Azure and no network: the deletion is checked
// against an isolated in-memory PGlite with the real migrations (src/test/db), rows
// are seeded through the real stores / parameterized inserts, and the parameterize
// half of INV-102 is observed through a recording db stand-in.
//
// WHY this exists (task E16-S09; brief §"Australian Privacy Act and GDPR-style
// rights"; design §4.1 "Account deletion = crypto-shredding: deleting the wrapped DEK
// makes everything unreadable before the confirmation is shown; a job deletes the
// rows within 24 hours"; design §9 "a separate `warthog_purge` role is used only by
// the account-deletion job"). Crypto-shredding (E16-S08) makes a deleted account's
// data unreadable immediately, but the ROWS must still be removed within 24 hours by a
// dedicated job. The job is the single, auditable code path permitted to delete the
// append-only activity rows (activity_entries / activity_disputes — their application
// role is INSERT+SELECT only; the `warthog_purge` role, E16-S07, holds the DELETE), and
// it must be safe to re-run after a partial failure.
//
// Note on the 24-hour clock: "within 24 hours" is the SLA the job meets by running at
// least that often — it is NOT a per-account wait. Every account ON the queue is purged
// when the job runs (the requested_at the store records is the deadline for monitoring,
// not a gate), so the job needs no clock and this contract takes none.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface PurgeRunResult { purged: string[] }   // the account ids purged on this run
//
//   runAccountPurge(db: Db): Promise<PurgeRunResult>
//     • reads the WHOLE pending purge queue (E16-S07) and, for each enqueued account,
//       in one idempotent unit:
//         – deletes ALL of that account's personal rows across every table, INCLUDING
//           its append-only activity entries and disputes;
//         – clears the account's queue entry.
//     • only touches accounts PRESENT on the queue — an account that was never enqueued
//       is left wholly intact.
//     • IDEMPOTENT / re-runnable: a run that finds some of an account's rows already
//       gone (a prior run failed partway) completes the purge without throwing; a run
//       over an empty / already-purged queue changes nothing and reports nothing.
//     • takes `db` as its only dependency — it holds no secret, reads no `process.env`
//       (INV-103), and every statement binds the account id as a parameter, never
//       concatenated into the SQL text (INV-102).
//
// Acceptance criteria → tests:
//   AC1 "running the job purges all of an enqueued account's personal rows across every
//        table, including activity entries and disputes." — seed a spread of the
//        account's personal tables (incl. activity_entries + activity_disputes), enqueue
//        it, run the job; every seeded table (and every user-scoped table in the schema)
//        then holds zero rows for that account, the users row is gone, and the queue
//        entry is cleared.
//   AC2 "the job only purges accounts present in the purge queue; one not enqueued is
//        untouched." — with two seeded accounts and only one enqueued, the run removes
//        the enqueued account entirely and leaves the other's rows and users row intact.
//   AC3 "a second run after a completed purge changes nothing." — re-running over an
//        empty queue removes nothing, reports nothing, leaves the already-purged account
//        gone and the bystander intact. And re-run SAFETY after a partial failure: a run
//        that finds some of the account's rows already deleted still completes the purge
//        and clears the queue, without throwing.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized input with a 4xx
//        BEFORE the job runs (no query), and never lets the client direct the purge
//        (the queue decides, not the body); the job binds every account id as a bound
//        parameter (placeholders, never concatenation), so an injection probe arriving
//        as a queued id is handled as a value and cannot drop a table. The handler below
//        is a TEST FIXTURE (the intended usage), not an implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — shown behaviourally: with a decoy
//        secret planted in the environment, the job still purges purely from the injected
//        db and the decoy appears nowhere in its result (the job reads no process.env).
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state even though files run in parallel.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { runAccountPurge } from "./purge-job";
import { createUser } from "../db/users";
import { enqueueAccountPurge, listPendingPurges } from "../db/account-purge";
import { freshDb } from "../../test/db";
import { type Db } from "../db/index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

// A stand-in wrapped DEK for createUser (opaque base64; this task never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (the account every personal row hangs off).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// The personal tables this test seeds and then asserts are emptied — a representative
// spread that INCLUDES the two append-only tables the AC names (activity_entries,
// activity_disputes) alongside ordinary cascade-on-delete member tables.
const SEEDED_TABLES = [
  "activity_entries",
  "activity_disputes",
  "sessions",
  "memories",
  "cards",
  "approvals",
] as const;

// Seed one row for `userId` into each table in SEEDED_TABLES. `tag` disambiguates the
// values that must be unique across accounts (e.g. a session token hash). The activity
// entry is inserted BEFORE its dispute (the dispute's composite FK references it).
// Parameterized throughout; the dummy ciphertext/hash values only satisfy NOT NULL.
async function seedPersonalRows(db: Db, userId: string, tag: string): Promise<void> {
  await db.query(
    `INSERT INTO activity_entries
       (user_id, seq, occurred_at, kind, source, payload_ct, prev_hash, entry_hash)
     VALUES ($1, 1, now(), 'tool_call', 'warthog', 'v1:seed', 'genesis', 'hash-' || $2)`,
    [userId, tag],
  );
  await db.query(
    `INSERT INTO activity_disputes (user_id, entry_seq, dispute_seq, note_ct, created_at)
     VALUES ($1, 1, 1, 'v1:dispute', now())`,
    [userId],
  );
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at)
     VALUES ($1, $2, now(), now())`,
    [userId, `tok-${tag}`],
  );
  await db.query(
    `INSERT INTO memories (user_id, content, scope, created_at)
     VALUES ($1, 'remember', 'kept', now())`,
    [userId],
  );
  await db.query(
    `INSERT INTO cards
       (user_id, brand, last_four, expiry_month, expiry_year, nickname,
        billing_address_id, number_ciphertext)
     VALUES ($1, 'visa', '4242', 12, 2030, 'card', 'addr-1', 'v1:card')`,
    [userId],
  );
  await db.query(
    `INSERT INTO approvals (user_id, agent_id, status, detail, created_at, expires_at)
     VALUES ($1, gen_random_uuid(), 'pending', 'please', now(), now() + interval '1 day')`,
    [userId],
  );
}

// How many rows a given table holds for `userId`. The table name comes from a fixed
// whitelist or the catalog (never external input) and is checked to be a plain
// identifier before it is quoted into the statement; the id is always bound.
async function countFor(db: Db, table: string, userId: string): Promise<number> {
  assert.match(table, /^[a-z_][a-z0-9_]*$/, "table name is a plain identifier");
  const result = await db.query(
    `SELECT count(*)::int AS n FROM "${table}" WHERE user_id = $1`,
    [userId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

// Whether the users row for this id still exists.
async function usersRowExists(db: Db, userId: string): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM users WHERE id = $1", [userId]);
  return result.rows.length > 0;
}

// Every table in the public schema that has a `user_id` column — i.e. every
// member-scoped table a purge must clear. Read from the catalog so the sweep covers
// tables this test never names explicitly (a purge that forgets one is caught).
async function userScopedTables(db: Db): Promise<string[]> {
  const result = await db.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'user_id'
      ORDER BY table_name`,
  );
  return result.rows.map((row) => String(row.table_name));
}

// Whether a relation of this exact name exists (a non-throwing probe: to_regclass
// yields the name when present, NULL when not) — used to show a table SURVIVED a run.
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// A db seam stand-in that records every call instead of running it, and optionally
// answers reads with scripted rows (so a test can feed the job a queue it never had a
// real table for, and prove WHAT reached the query layer and HOW — bound vs. spliced).
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(
  respond?: (text: string, values: unknown[]) => Record<string, unknown>[],
): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows: respond ? respond(text, values) : [] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// Assert a probe reached the query layer as a BOUND value and never as spliced SQL
// text, scoped to each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(
    db.calls.some((c) => c.values.includes(probe)),
    "the probe travels as a bound value",
  );
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the id is bound, never concatenated into the SQL");
    assert.ok(!/DROP\s+TABLE/i.test(call.text), "no injected statement appears in the SQL text");
  }
}

// ===========================================================================
// AC1 — running the job purges every personal row of an enqueued account across every
// table, including its activity entries and disputes, and clears the queue entry.
// ===========================================================================

test("the job removes all of an enqueued account's personal rows across every table", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-purge");
    await seedPersonalRows(db, userId, "ac1-purge");
    await enqueueAccountPurge(db, userId);

    // Guard: every seeded table really holds a row before the purge (so the zeros
    // below mean "removed", not "never there").
    for (const table of SEEDED_TABLES) {
      assert.equal(await countFor(db, table, userId), 1, `${table} seeded for the account`);
    }

    const result = await runAccountPurge(db);

    // The two append-only tables the AC names are emptied for the account…
    assert.equal(await countFor(db, "activity_entries", userId), 0, "activity entries removed");
    assert.equal(await countFor(db, "activity_disputes", userId), 0, "disputes removed");
    // …and so is every other seeded table, and the users row itself.
    for (const table of SEEDED_TABLES) {
      assert.equal(await countFor(db, table, userId), 0, `${table} purged for the account`);
    }
    assert.equal(await usersRowExists(db, userId), false, "the users row is removed by the purge");

    // No member-scoped table anywhere in the schema still holds a row for the account.
    for (const table of await userScopedTables(db)) {
      assert.equal(await countFor(db, table, userId), 0, `no row survives in ${table}`);
    }

    // The queue entry is cleared and the job reports the account it purged.
    assert.equal(
      (await listPendingPurges(db)).filter((e) => e.userId === userId).length,
      0,
      "the account's purge-queue entry is cleared",
    );
    assert.ok(result.purged.includes(userId), "the run reports the purged account");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — the job only purges accounts on the queue; an account not enqueued is untouched.
// ===========================================================================

test("an account that was never enqueued is left wholly intact", async () => {
  const db = await freshDb();
  try {
    const enqueued = await makeUser(db, "ac2-enqueued");
    const bystander = await makeUser(db, "ac2-bystander");
    await seedPersonalRows(db, enqueued, "ac2-enqueued");
    await seedPersonalRows(db, bystander, "ac2-bystander");

    // Only ONE of the two accounts is enqueued for purge.
    await enqueueAccountPurge(db, enqueued);

    const result = await runAccountPurge(db);

    // The enqueued account is gone across every seeded table and as a users row…
    for (const table of SEEDED_TABLES) {
      assert.equal(await countFor(db, table, enqueued), 0, `${table} purged for the enqueued account`);
    }
    assert.equal(await usersRowExists(db, enqueued), false, "the enqueued users row is removed");

    // …while the bystander's rows and users row are entirely untouched.
    for (const table of SEEDED_TABLES) {
      assert.equal(await countFor(db, table, bystander), 1, `${table} untouched for the bystander`);
    }
    assert.equal(await usersRowExists(db, bystander), true, "the bystander's users row survives");

    assert.ok(result.purged.includes(enqueued), "the run reports the enqueued account");
    assert.ok(!result.purged.includes(bystander), "the run never reports a non-enqueued account");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — idempotency: a second run after a completed purge changes nothing, and a run
// after a PARTIAL failure (some rows already gone) completes the purge safely.
// ===========================================================================

test("a second run after a completed purge changes nothing", async () => {
  const db = await freshDb();
  try {
    const purged = await makeUser(db, "ac3-purged");
    const bystander = await makeUser(db, "ac3-bystander");
    await seedPersonalRows(db, purged, "ac3-purged");
    await seedPersonalRows(db, bystander, "ac3-bystander");
    await enqueueAccountPurge(db, purged);

    await runAccountPurge(db); // completes the purge of `purged`
    const second = await runAccountPurge(db); // the re-run must be a no-op

    assert.equal(second.purged.length, 0, "a completed purge leaves the second run nothing to do");
    assert.equal(await usersRowExists(db, purged), false, "the purged account stays removed");
    for (const table of SEEDED_TABLES) {
      assert.equal(await countFor(db, table, purged), 0, `${table} stays empty for the purged account`);
      assert.equal(await countFor(db, table, bystander), 1, `${table} stays intact for the bystander`);
    }
    assert.deepEqual(await listPendingPurges(db), [], "the queue stays empty after the no-op run");
  } finally {
    await db.close();
  }
});

test("a run after a partial failure (some rows already deleted) completes the purge without throwing", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac3-partial");
    await seedPersonalRows(db, userId, "ac3-partial");
    await enqueueAccountPurge(db, userId);

    // Simulate a crash PART-WAY through a prior run: its activity rows were already
    // deleted, but the users row and the queue entry remain — so the account is still
    // enqueued and must be re-purgeable to completion.
    await db.query("DELETE FROM activity_disputes WHERE user_id = $1", [userId]);
    await db.query("DELETE FROM activity_entries WHERE user_id = $1", [userId]);
    assert.equal(await countFor(db, "activity_entries", userId), 0, "activity already gone before the re-run");
    assert.equal(await usersRowExists(db, userId), true, "the users row still remains before the re-run");

    const result = await runAccountPurge(db); // must not throw on the already-deleted rows

    for (const table of SEEDED_TABLES) {
      assert.equal(await countFor(db, table, userId), 0, `${table} fully purged after the re-run`);
    }
    assert.equal(await usersRowExists(db, userId), false, "the re-run removes the remaining users row");
    assert.equal(
      (await listPendingPurges(db)).filter((e) => e.userId === userId).length,
      0,
      "the re-run clears the queue entry",
    );
    assert.ok(result.purged.includes(userId), "the re-run reports the account it finished purging");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — the job binds every account id as a parameter (no spliced SQL): an injection
// probe arriving as a queued id is handled as a value and cannot alter a query.
// ===========================================================================

test("the job binds a queued account id as a parameter, never woven into the SQL text", async () => {
  const probe = "u'); DROP TABLE activity_entries; --";
  const requestedAt = new Date().toISOString();

  // A recording db that answers the queue read with a single probe-shaped account id
  // and returns no rows for everything else — so the job iterates the probe and we can
  // inspect how it reached the DELETE statements.
  const db = recordingDb((text) =>
    /select/i.test(text) && text.includes("account_purge_queue")
      ? [{ user_id: probe, requested_at: requestedAt }]
      : [],
  );

  try {
    await runAccountPurge(db);
  } catch {
    /* a no-row stand-in may make the job throw; the binding is asserted regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("a probe-shaped id cannot drop a table: the schema survives a real run", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac4-real");
    await seedPersonalRows(db, userId, "ac4-real");
    await enqueueAccountPurge(db, userId);

    await runAccountPurge(db);

    // The purge removed rows, never relations: the append-only table and the queue
    // table both still exist (a spliced id would have run a DROP).
    assert.equal(await tableExists(db, "activity_entries"), true, "activity_entries still exists");
    assert.equal(await tableExists(db, "account_purge_queue"), true, "account_purge_queue still exists");
    assert.equal(await usersRowExists(db, userId), false, "the enqueued account was still purged");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input with a 4xx BEFORE the
// job runs, and the client body never directs the purge (the queue decides). This
// handler is a TEST FIXTURE that exercises the modules — it is not an implementation
// file. A trigger (operator/cron) carries no account input; the job reads the queue.
// ===========================================================================

function purgeTriggerHandler(db: Db): (req: Request) => Promise<Response> {
  // The trigger body carries no account id — any extra field is ignored, never used to
  // choose an account (the queue decides). Capped so an absurd body is rejected by size.
  const schema = z.object({});
  return async (req: Request): Promise<Response> => {
    try {
      await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const result = await runAccountPurge(db);
      return new Response(JSON.stringify({ purged: result.purged.length }), { status: 200 });
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
  return new Request("https://warthog.com.au/api/account/purge-job", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the trigger handler rejects malformed JSON with a 4xx and never runs the job", async () => {
  const db = recordingDb();
  const handler = purgeTriggerHandler(db);

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the trigger handler rejects an oversized body with a 4xx and never runs the job", async () => {
  const db = recordingDb();
  const handler = purgeTriggerHandler(db);

  // ~8 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ pad: "a".repeat(8 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the trigger runs the queued purge and the client body cannot redirect it to another account", async () => {
  const db = await freshDb();
  try {
    const enqueued = await makeUser(db, "ac4-enqueued");
    const smuggled = await makeUser(db, "ac4-smuggled");
    await seedPersonalRows(db, enqueued, "ac4-enqueued");
    await seedPersonalRows(db, smuggled, "ac4-smuggled");
    await enqueueAccountPurge(db, enqueued);

    const handler = purgeTriggerHandler(db);
    // The body smuggles a non-enqueued account id; the handler must ignore it — the
    // queue, not the body, decides what is purged.
    const res = await handler(jsonRequest(JSON.stringify({ userId: smuggled })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    assert.equal(await usersRowExists(db, enqueued), false, "the enqueued account is purged");
    assert.equal(await usersRowExists(db, smuggled), true, "the account smuggled in the body is untouched");
    for (const table of SEEDED_TABLES) {
      assert.equal(await countFor(db, table, smuggled), 1, `${table} intact for the non-enqueued account`);
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the job reads no process.env and holds no secret (INV-103), shown behaviourally
// with a decoy secret planted in the environment.
// ===========================================================================

test("the job reads no process.env: a decoy secret in the environment never lands in its result", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5");
    await seedPersonalRows(db, userId, "ac5");
    await enqueueAccountPurge(db, userId);

    const result = await runAccountPurge(db);

    // The job purged the enqueued account purely from the injected db…
    assert.ok(result.purged.includes(userId), "the job purges from the injected db alone");
    assert.equal(await usersRowExists(db, userId), false, "the account was purged");
    // …and no ambient env value was folded into what it returned.
    assert.ok(
      !JSON.stringify(result).includes(DECOY),
      "no ambient env value is folded into the job's result",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
