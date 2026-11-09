// E12-S04 — Notification preferences store
// (`src/server/db/notification-prefs.ts`, `db/migrations/0027_notification_prefs.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so
// importing `./notification-prefs` throws and `freshDb()` has no
// `notification_prefs` table — every test here fails until the builder adds them.
// That absence IS the point of test-first; do NOT implement anything to make these
// pass — the builder writes the module and the migration afterwards.
//
// These tests pin BEHAVIOUR (what the functions DO: the defaults a person with
// nothing set reads back, that a save persists and round-trips, that an out-of-range
// delay is rejected and NOT persisted, that email fallback can be switched off, who
// may read/change whose preferences, that every value is bound as a parameter, that
// the repo reads no secret from the environment), never the source text of the module
// or the SQL file — a later rename that preserves behaviour must not redden them.
//
// WHY this exists (design §10 Notifications / "Fallback job"; brief "Notification
// settings" and the approval-fallback SHALL): the approval SMS/email fallback fires at
// `created_at + fallback_delay` if the approval is still unopened. The fallback job
// reads, per person, whether email fallback is on (ON by default) and the fallback
// delay in minutes (default 2, adjustable 1–30). When a person has set nothing, the
// defaults the brief names must apply. Every read/write is scoped to the SESSION's
// user id, never a value from the client, so one person can never read or change
// another's preferences.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface NotificationPrefs {
//     userId: string;                // the person these preferences belong to
//     emailFallback: boolean;        // whether fallback messages also go by email (default true)
//     fallbackDelayMinutes: number;  // minutes to wait before the fallback fires (default 2, 1–30)
//   }
//
//   interface SaveNotificationPrefsInput {
//     userId: string;                // the person (the SESSION's id, NEVER a client value)
//     emailFallback: boolean;        // the chosen email-fallback setting
//     fallbackDelayMinutes: number;  // the chosen delay; a value outside 1–30 is REJECTED
//   }
//
//   type SaveNotificationPrefsResult =
//     | { ok: true; prefs: NotificationPrefs }       // persisted; prefs reflects what was stored
//     | { ok: false; reason: "delay_out_of_range" }; // delay < 1 or > 30; NOTHING is persisted
//
//   getNotificationPrefs(db, userId: string): Promise<NotificationPrefs>
//     • member-scoped (WHERE user_id bound). Returns this person's stored preferences,
//       or — when the person has saved none — the brief's defaults
//       { userId, emailFallback: true, fallbackDelayMinutes: 2 } assembled in code,
//       carrying the queried userId. Never another person's preferences.
//   saveNotificationPrefs(db, input: SaveNotificationPrefsInput): Promise<SaveNotificationPrefsResult>
//     • upserts the ONE row for input.userId (one row per person). A delay outside the
//       inclusive range 1–30 is rejected ({ ok: false, reason: "delay_out_of_range" })
//       and NOTHING is written — a previously stored value (or the default) is left
//       untouched (it is NOT clamped into range). A valid save returns
//       { ok: true, prefs } with prefs assembled from the inputs (it does not depend on
//       a RETURNING read), and a subsequent get reads the same values back.
//
// Acceptance criteria → tests:
//   AC1 "Reading preferences for a user with none set returns email fallback on and a
//        2-minute delay by default." — getNotificationPrefs for a person who has saved
//        nothing returns { emailFallback: true, fallbackDelayMinutes: 2 }.
//   AC2 "Saving a delay outside 1-30 minutes is rejected, and email fallback can be
//        switched off." — saveNotificationPrefs with delay 0 / 31 is rejected and
//        persists nothing (not clamped); delays 1 and 30 are accepted (the boundaries);
//        a save with emailFallback: false round-trips as off.
//   AC3 "A user cannot read or change another user's preferences (filtered by session
//        user id)." — one person's save never changes another's read; a second person
//        reads defaults, not the first person's values; the user id is bound as a
//        parameter. A handler takes the user id from the SESSION, never the body.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed /
//        out-of-range input with a 4xx before any query runs; a SQL-injection probe
//        routed through the repo travels as a BOUND value (placeholders, never
//        concatenation) and cannot drop the table. The handlers below are test fixtures
//        (the intended usage), not implementation files.
//   AC5 [obligation:secrets-from-env] (INV-103) — the repo takes its db as a dependency,
//        reads no `process.env` and holds no secret, so a decoy secret planted in the
//        environment never lands in the stored or returned preferences.
//   Migration: the `notification_prefs` relation exists after the project migrations and
//        a second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  getNotificationPrefs,
  saveNotificationPrefs,
} from "./notification-prefs";
// Documentary type anchors — the exact names/shapes the implementation exports.
// Erased at runtime (and test files are excluded from `tsc`), so a rename cannot break
// these tests; the runtime assertions below are what actually gate behaviour.
import type {
  NotificationPrefs,
  SaveNotificationPrefsInput,
  SaveNotificationPrefsResult,
} from "./notification-prefs";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db, type QueryResult } from "./index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

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
// WHAT reached the query layer and HOW (bound value vs. spliced text). Returns no rows
// and satisfies the `Db` shape structurally (query + close).
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []): Promise<QueryResult> {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the
// relation name when it exists and NULL when it does not — a non-throwing probe scoped
// to the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
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

// ===========================================================================
// AC1 — a person with nothing set reads the brief's defaults: email fallback ON,
// a 2-minute delay.
// ===========================================================================

test("reading preferences for a person who has saved none returns the defaults (email on, 2 minutes)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-default");
    const prefs: NotificationPrefs = await getNotificationPrefs(db, userId);

    assert.equal(prefs.userId, userId, "the preferences are scoped to the queried person");
    assert.equal(prefs.emailFallback, true, "email fallback is ON by default (brief: on by default)");
    assert.equal(prefs.fallbackDelayMinutes, 2, "the fallback delay defaults to 2 minutes (brief)");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — an out-of-range delay is rejected (and NOT persisted / NOT clamped); the
// boundaries 1 and 30 are accepted; email fallback can be switched off.
// ===========================================================================

test("a saved delay and email-fallback choice round-trip for the person", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-roundtrip");

    const result: SaveNotificationPrefsResult = await saveNotificationPrefs(db, {
      userId,
      emailFallback: false,
      fallbackDelayMinutes: 5,
    });
    assert.equal(result.ok, true, "a valid save succeeds");
    if (result.ok) {
      assert.equal(result.prefs.emailFallback, false, "the returned prefs reflect the chosen email setting");
      assert.equal(result.prefs.fallbackDelayMinutes, 5, "the returned prefs reflect the chosen delay");
      assert.equal(result.prefs.userId, userId, "the returned prefs belong to the saving person");
    }

    const read = await getNotificationPrefs(db, userId);
    assert.equal(read.emailFallback, false, "email fallback reads back as switched off");
    assert.equal(read.fallbackDelayMinutes, 5, "the chosen delay reads back");
  } finally {
    await db.close();
  }
});

test("email fallback can be switched off (and back on)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-toggle");

    await saveNotificationPrefs(db, { userId, emailFallback: false, fallbackDelayMinutes: 2 });
    assert.equal((await getNotificationPrefs(db, userId)).emailFallback, false, "it reads back off after switching off");

    await saveNotificationPrefs(db, { userId, emailFallback: true, fallbackDelayMinutes: 2 });
    assert.equal((await getNotificationPrefs(db, userId)).emailFallback, true, "it reads back on after switching on");
  } finally {
    await db.close();
  }
});

test("the boundary delays 1 and 30 minutes are accepted and persist", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-bounds");

    const low = await saveNotificationPrefs(db, { userId, emailFallback: true, fallbackDelayMinutes: 1 });
    assert.equal(low.ok, true, "1 minute (the lower bound) is accepted");
    assert.equal((await getNotificationPrefs(db, userId)).fallbackDelayMinutes, 1, "1 minute persists");

    const high = await saveNotificationPrefs(db, { userId, emailFallback: true, fallbackDelayMinutes: 30 });
    assert.equal(high.ok, true, "30 minutes (the upper bound) is accepted");
    assert.equal((await getNotificationPrefs(db, userId)).fallbackDelayMinutes, 30, "30 minutes persists");
  } finally {
    await db.close();
  }
});

test("a delay below 1 or above 30 is rejected and NOTHING is persisted (not clamped)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-reject");

    const tooLow: SaveNotificationPrefsResult = await saveNotificationPrefs(db, {
      userId,
      emailFallback: true,
      fallbackDelayMinutes: 0,
    });
    assert.deepEqual(tooLow, { ok: false, reason: "delay_out_of_range" }, "0 minutes is rejected");

    const tooHigh: SaveNotificationPrefsResult = await saveNotificationPrefs(db, {
      userId,
      emailFallback: true,
      fallbackDelayMinutes: 31,
    });
    assert.deepEqual(tooHigh, { ok: false, reason: "delay_out_of_range" }, "31 minutes is rejected");

    // Nothing was written: the person still reads the untouched defaults — the
    // out-of-range value was NOT clamped into 1 or 30 and stored.
    const read = await getNotificationPrefs(db, userId);
    assert.equal(read.fallbackDelayMinutes, 2, "the delay is still the default — the rejected value was not clamped and stored");
    assert.equal(read.emailFallback, true, "and the rest of the preferences are untouched");
  } finally {
    await db.close();
  }
});

test("rejecting an out-of-range delay leaves a previously saved valid value untouched", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-reject-keeps");

    await saveNotificationPrefs(db, { userId, emailFallback: false, fallbackDelayMinutes: 7 });
    const rejected = await saveNotificationPrefs(db, { userId, emailFallback: true, fallbackDelayMinutes: 99 });
    assert.deepEqual(rejected, { ok: false, reason: "delay_out_of_range" }, "99 minutes is rejected");

    const read = await getNotificationPrefs(db, userId);
    assert.equal(read.fallbackDelayMinutes, 7, "the earlier valid delay survives the rejected save");
    assert.equal(read.emailFallback, false, "and the earlier email-fallback choice survives too");
  } finally {
    await db.close();
  }
});

test("saving again overwrites the existing preferences — one row per person", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-upsert");

    await saveNotificationPrefs(db, { userId, emailFallback: true, fallbackDelayMinutes: 5 });
    await saveNotificationPrefs(db, { userId, emailFallback: false, fallbackDelayMinutes: 10 });

    const read = await getNotificationPrefs(db, userId);
    assert.equal(read.fallbackDelayMinutes, 10, "the second save wins (upsert, not a new row)");
    assert.equal(read.emailFallback, false, "the second save's email choice wins");

    const count = await db.query(
      "SELECT count(*)::int AS n FROM notification_prefs WHERE user_id = $1",
      [userId],
    );
    assert.equal(count.rows[0]!.n, 1, "there is exactly one preferences row for the person");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: one person's preferences never leak to or overwrite another's.
// The user id is bound from the session, never the client.
// ===========================================================================

test("one person's saved preferences never change another person's read", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "own-alice");
    const bob = await makeUser(db, "own-bob");

    await saveNotificationPrefs(db, { userId: alice, emailFallback: false, fallbackDelayMinutes: 17 });

    // Bob has saved nothing: he reads the defaults, never Alice's values.
    const bobPrefs = await getNotificationPrefs(db, bob);
    assert.equal(bobPrefs.emailFallback, true, "Bob reads the default (on), not Alice's off");
    assert.equal(bobPrefs.fallbackDelayMinutes, 2, "Bob reads the default delay, not Alice's 17");
    assert.equal(bobPrefs.userId, bob, "and the prefs are scoped to Bob");

    // Bob saves his own; Alice's are untouched.
    await saveNotificationPrefs(db, { userId: bob, emailFallback: true, fallbackDelayMinutes: 9 });
    const alicePrefs = await getNotificationPrefs(db, alice);
    assert.equal(alicePrefs.emailFallback, false, "Alice's email choice is untouched by Bob's save");
    assert.equal(alicePrefs.fallbackDelayMinutes, 17, "Alice's delay is untouched by Bob's save");
    assert.equal(alicePrefs.userId, alice, "Alice reads her own preferences");

    const bobAgain = await getNotificationPrefs(db, bob);
    assert.equal(bobAgain.fallbackDelayMinutes, 9, "Bob reads his own saved delay");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL); a probe
// routed through the repo is bound and the table survives.
// ===========================================================================

test("getNotificationPrefs binds the member-scope user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "p'); DROP TABLE notification_prefs; --";

  // The recording db returns no rows, so a read yields the defaults carrying the
  // queried id — but whatever statement it issued must have BOUND the id.
  const prefs = await getNotificationPrefs(db, probe);
  assert.equal(prefs.emailFallback, true, "no row → the default (email on) is assembled");
  assert.equal(prefs.fallbackDelayMinutes, 2, "no row → the default delay is assembled");
  assert.equal(prefs.userId, probe, "the defaults carry the queried user id");
  assertBoundNotSpliced(db, probe);
});

test("saveNotificationPrefs binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE notification_prefs; --";

  const result = await saveNotificationPrefs(db, {
    userId: probe,
    emailFallback: true,
    fallbackDelayMinutes: 2,
  });
  assert.equal(result.ok, true, "a valid delay is accepted; the result is assembled from inputs");
  assertBoundNotSpliced(db, probe);
});

test("saveNotificationPrefs binds the email-fallback choice and the delay as parameters", async () => {
  const db = recordingDb();

  await saveNotificationPrefs(db, {
    userId: "session-user",
    emailFallback: false,
    fallbackDelayMinutes: 7,
  });

  assert.ok(
    db.calls.some((c) => c.values.includes("session-user") && c.values.includes(7) && c.values.includes(false)),
    "the user id, the delay and the email-fallback choice all travel as bound values",
  );
});

test("a SQL-injection probe in the user id is bound, never run: the notification_prefs table survives", async () => {
  const db = await freshDb();
  try {
    const probe = "u'); DROP TABLE notification_prefs; --";

    // Reading with a probe user id binds it as a parameter; it never executes as SQL.
    // (A non-uuid value may error on the cast or simply match nothing — either way the
    // statement is a bound read, so the table must still be there afterwards.)
    try {
      await getNotificationPrefs(db, probe);
    } catch {
      /* tolerate a type/cast error — the point is that no injected statement ran */
    }

    assert.equal(
      await tableExists(db, "notification_prefs"),
      true,
      "the notification_prefs table must still exist (the probe was bound, never executed as SQL)",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the repo reads no process.env: a decoy secret in the environment never lands
// in the stored or returned preferences.
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in the preferences", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-env");
    const saved = await saveNotificationPrefs(db, { userId, emailFallback: false, fallbackDelayMinutes: 5 });
    assert.equal(saved.ok, true, "the save reads and writes purely from the injected db + inputs — no app env needed");

    const prefs = await getNotificationPrefs(db, userId);
    assert.ok(
      !JSON.stringify(prefs).includes(DECOY) && !JSON.stringify(saved).includes(DECOY),
      "no ambient env value is folded into the stored or returned preferences",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly).
    const all = await db.query("SELECT * FROM notification_prefs");
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
// AC3 / AC4 — handlers on the validation boundary. A route handler validates external
// input HERE (`parseBody`), then calls this task's parameterized data-access with the
// SESSION's user id (NEVER a body value). A rejected input maps to a 4xx Response and
// never reaches a query. These handlers are test fixtures that EXERCISE the modules —
// they are not implementation files.
// ===========================================================================

function saveNotificationPrefsHandler(
  db: Db,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries only the two settings; the user id comes from the session, never
  // the body. The delay is constrained to an integer within 1–30 at the boundary; the
  // repo rejects an out-of-range delay again as the one source of truth.
  const schema = z.object({
    emailFallback: z.boolean(),
    fallbackDelayMinutes: z.number().int().min(1).max(30),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const result = await saveNotificationPrefs(db, {
        userId: sessionUserId,
        emailFallback: body.emailFallback,
        fallbackDelayMinutes: body.fallbackDelayMinutes,
      });
      if (!result.ok) {
        return new Response(JSON.stringify({ error: result.reason }), { status: 400 });
      }
      return new Response(JSON.stringify({ prefs: result.prefs }), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

function getNotificationPrefsHandler(
  db: Db,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // No body: the person reads their OWN preferences, scoped to the session user id.
  return async (): Promise<Response> => {
    const prefs = await getNotificationPrefs(db, sessionUserId);
    return new Response(JSON.stringify(prefs), { status: 200 });
  };
}

function jsonRequest(path: string, body: string): Request {
  return new Request(`https://warthog.com.au${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the save handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveNotificationPrefsHandler(db, "session-user");

  const res = await handler(jsonRequest("/api/notification-prefs", "{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the save handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveNotificationPrefsHandler(db, "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest(
      "/api/notification-prefs",
      JSON.stringify({ emailFallback: true, fallbackDelayMinutes: 2, junk: "x".repeat(10 * 1024) }),
    ),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the save handler rejects a body missing a field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveNotificationPrefsHandler(db, "session-user");

  const res = await handler(jsonRequest("/api/notification-prefs", JSON.stringify({ emailFallback: true })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the save handler rejects a mis-typed field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveNotificationPrefsHandler(db, "session-user");

  // emailFallback must be a boolean and the delay a number — strings are schema violations.
  const res = await handler(
    jsonRequest("/api/notification-prefs", JSON.stringify({ emailFallback: "yes", fallbackDelayMinutes: "soon" })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the save handler rejects an out-of-range delay with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = saveNotificationPrefsHandler(db, "session-user");

  const tooLow = await handler(
    jsonRequest("/api/notification-prefs", JSON.stringify({ emailFallback: true, fallbackDelayMinutes: 0 })),
  );
  assert.ok(tooLow.status >= 400 && tooLow.status < 500, `expected a 4xx for 0 minutes, got ${tooLow.status}`);

  const tooHigh = await handler(
    jsonRequest("/api/notification-prefs", JSON.stringify({ emailFallback: true, fallbackDelayMinutes: 31 })),
  );
  assert.ok(tooHigh.status >= 400 && tooHigh.status < 500, `expected a 4xx for 31 minutes, got ${tooHigh.status}`);

  assert.equal(db.calls.length, 0, "an out-of-range delay must never reach a query");
});

test("the save handler accepts a well-formed body and persists it for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-save-ok");
    const handler = saveNotificationPrefsHandler(db, userId);

    const res = await handler(
      jsonRequest("/api/notification-prefs", JSON.stringify({ emailFallback: false, fallbackDelayMinutes: 12 })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    const prefs = await getNotificationPrefs(db, userId);
    assert.equal(prefs.emailFallback, false, "the submitted email choice is persisted for the session user");
    assert.equal(prefs.fallbackDelayMinutes, 12, "the submitted delay is persisted for the session user");
  } finally {
    await db.close();
  }
});

test("the save handler takes the user id from the session, not the body", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const handler = saveNotificationPrefsHandler(db, sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(
      jsonRequest(
        "/api/notification-prefs",
        JSON.stringify({ userId: attacker, emailFallback: false, fallbackDelayMinutes: 20 }),
      ),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    // The preferences are recorded under the SESSION user...
    const sessionPrefs = await getNotificationPrefs(db, sessionUser);
    assert.equal(sessionPrefs.fallbackDelayMinutes, 20, "the save landed on the session user");
    assert.equal(sessionPrefs.emailFallback, false, "the session user's email choice was written");

    // ...and never under the user id smuggled in the body (the attacker still reads defaults).
    const attackerPrefs = await getNotificationPrefs(db, attacker);
    assert.equal(attackerPrefs.fallbackDelayMinutes, 2, "the smuggled user id's preferences are untouched (default delay)");
    assert.equal(attackerPrefs.emailFallback, true, "the smuggled user id's preferences are untouched (default email on)");
  } finally {
    await db.close();
  }
});

test("the get handler returns the SESSION user's preferences (defaults when none set)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-get");
    const handler = getNotificationPrefsHandler(db, userId);

    const res = await handler(jsonRequest("/api/notification-prefs", ""));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const prefs = (await res.json()) as NotificationPrefs;

    assert.equal(prefs.userId, userId, "the handler reads for the session user");
    assert.equal(prefs.emailFallback, true, "a person with none set reads email fallback on");
    assert.equal(prefs.fallbackDelayMinutes, 2, "a person with none set reads a 2-minute delay");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Migration — the table applies and a second run changes nothing.
// ===========================================================================

test("the notification_prefs migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "notification_prefs"),
      true,
      "the notification_prefs table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0027_notification_prefs"),
      "db/migrations/0027_notification_prefs.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0027's CREATE would throw "already exists", so an empty result AND
    // no throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});


test("SMS fallback requires explicit opt-in and can be withdrawn without disabling email", async () => {
  const db = await freshDb();
  try {
    const result = await db.query("INSERT INTO users (email, wrapped_dek) VALUES ('global-consent@example.test', 'synthetic') RETURNING id");
    const userId = result.rows[0].id as string;
    assert.equal((await getNotificationPrefs(db, userId)).smsFallback, false);
    await saveNotificationPrefs(db, { userId, emailFallback: true, fallbackDelayMinutes: 2, smsFallback: true });
    assert.equal((await getNotificationPrefs(db, userId)).smsFallback, true);
    await saveNotificationPrefs(db, { userId, emailFallback: true, fallbackDelayMinutes: 2, smsFallback: false });
    const prefs = await getNotificationPrefs(db, userId);
    assert.equal(prefs.smsFallback, false); assert.equal(prefs.emailFallback, true);
  } finally { await db.close(); }
});
