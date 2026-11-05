// E09-S12 — Token-refresh and connector-health background jobs
// (`src/server/connectors/jobs.ts`; design §7 "Connector engine" — "a refresh job
// renews OAuth tokens before expiry; failures mark the connection 'Reconnect needed'
// and notify" and "Google early access: connections expire 7 days after consent →
// reminder push 24 h before; status 'Reconnect needed' after").
//
// RED-first: `./jobs` does not exist yet, so every import below throws at load and the
// whole suite fails — that absence IS the point of test-first. As the TESTER I MUST NOT
// create or edit the module (or any implementation/source file) to make these pass; the
// builder writes `src/server/connectors/jobs.ts` afterwards to this contract.
//
// These tests pin BEHAVIOUR (what the jobs DO: the stored connection status, the
// notifications emitted, the queue state, the HTTP status a handler returns), never the
// source text of any module. The time source is the injected Clock (never Date.now());
// the refresh of provider tokens and the push channel are injected seams (conventions:
// "external services sit behind interfaces with fakes; tests never touch the network").
// The jobs run off the REAL background-jobs queue (`../db/jobs`: enqueue/claim/run) and
// the REAL connection store (`../db/connections`) over an in-memory PGlite with the real
// migrations (`../../test/db`), so idempotency and member-scoping are exercised end to end.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type RefreshConnection =            // the injected seam that renews one connection's
//     (target: { userId: string;        // provider OAuth tokens (production wires it over
//                connectionId: string } // refreshConnectionTokens with the catalogue entry
//     ) => Promise<void>;               // + operator client); THROWS on a refresh failure.
//
//   interface ConnectorJobDeps {        // injected seams — this module reads no process.env
//     db: Db;                           // the parameterizing data seam
//     clock: Clock;                     // time (due checks / status stamps), never Date.now()
//     push: PushSender;                 // the notification channel (outbox/fake in test)
//     refresh: RefreshConnection;       // renew tokens; throws on failure
//   }
//
//   scheduleConnectionRefresh(
//     db, { userId, connectionId, expiresAt }): Promise<Job>
//     • Enqueues a background refresh job due BEFORE `expiresAt` (near expiry, so the
//       token is renewed before it lapses). Returns the enqueued job (run_at < expiresAt).
//
//   scheduleGoogleLapse(
//     db, { userId, connectionId, connectedAt }): Promise<void>
//     • Enqueues the Google early-access timers: a REMINDER due 24 h before the 7-day
//       lapse (connectedAt + 7d − 24h) and a LAPSE-mark due at the lapse (connectedAt + 7d).
//
//   createConnectorJobHandler(deps): (job: Job) => Promise<void>
//     • The dispatcher handed to the queue runner `run(db, clock, handler)`. For a refresh
//       job it calls `deps.refresh`; on SUCCESS the connection stays connected, on FAILURE
//       it marks the connection `needs_reconnect` and sends ONE notification — and the job
//       is HANDLED (completes, never re-run). For a Google reminder it pushes a reminder;
//       for a Google lapse it marks the connection `needs_reconnect`.
//
// Every member-scoped read/write binds the `userId` carried in the job payload (set from
// the session when the job was scheduled), never a client value, so a job touches only its
// owner's connection. "Absence" assertions are scoped narrowly to the exact surface under
// test (a secret legitimately lives, encrypted, in the connection's credentials column —
// so the leak scan is the NOTIFICATION outputs only, never the whole database).
//
// Every db handle is closed in a `finally`, and each real-db test uses its own `freshDb()`
// (an isolated in-memory PGlite), so the parallel test files share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import {
  scheduleConnectionRefresh,
  scheduleGoogleLapse,
  createConnectorJobHandler,
} from "./jobs";
import { run } from "../db/jobs";
import { createConnection, getConnectionById } from "../db/connections";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import type { Db, QueryResult } from "../db/index";
import type { Clock } from "../seams/clock";
import type { OutgoingMessage } from "../notify/senders";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SEVEN_DAYS_MS = 7 * DAY_MS;

// A fixed origin instant; time only moves when a test advances/sets it. Deliberately in
// the past relative to the wall clock, so any code that wrongly read Date.now() instead
// of the injected clock would diverge here.
const T0 = new Date("2026-05-01T10:00:00.000Z");

// A clock whose "now" the test controls. `set` jumps it to an instant, `advance` nudges it
// forward — so a due-at-T job fires at exactly T and idempotency can be probed a day later,
// deterministically, with no wall-clock dependence and no backoff flakiness.
function mutableClock(start: Date): { clock: Clock; set(at: Date): void; advance(ms: number): void } {
  let current = start.getTime();
  return {
    clock: {
      now(): Date {
        return new Date(current);
      },
    },
    set(at: Date): void {
      current = at.getTime();
    },
    advance(ms: number): void {
      current += ms;
    },
  };
}

// A fresh random 256-bit DEK (the client only ever receives already-unwrapped bytes).
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque base64; never read by the jobs).
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

// A recording push channel: records every notification so a test can count them and scan
// their contents. Satisfies the PushSender shape the jobs depend on.
function recordingPush(): { sender: { sendPush(m: OutgoingMessage): Promise<void> }; sent: OutgoingMessage[] } {
  const sent: OutgoingMessage[] = [];
  return {
    sender: {
      async sendPush(message: OutgoingMessage): Promise<void> {
        sent.push(message);
      },
    },
    sent,
  };
}

// A refresh seam a test controls: `ok()` records every renewal target and resolves;
// `failing()` records then throws, standing in for a provider that rejects the refresh.
function recordingRefresh(mode: "ok" | "fail"): {
  refresh: (target: { userId: string; connectionId: string }) => Promise<void>;
  calls: { userId: string; connectionId: string }[];
} {
  const calls: { userId: string; connectionId: string }[] = [];
  return {
    async refresh(target) {
      calls.push(target);
      if (mode === "fail") throw new Error("provider rejected the token refresh");
    },
    calls,
  };
}

// Drain every currently-due job through the handler: the queue runner `run` processes one
// due job per call, so loop until none is due. Returns how many jobs were processed.
async function drainAll(db: Db, clock: Clock, handler: Parameters<typeof run>[2]): Promise<number> {
  let processed = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await run(db, clock, handler);
    if (job == null) break;
    processed += 1;
  }
  return processed;
}

// Seed a connected service for `userId` with the given stored provider tokens.
async function seedConnection(
  db: Db,
  clock: Clock,
  dek: Uint8Array,
  userId: string,
  overrides: { connectorId?: string; accountLabel?: string; credentials?: Record<string, unknown> } = {},
): Promise<string> {
  const conn = await createConnection(
    db,
    {
      userId,
      connectorId: overrides.connectorId ?? "google-gmail",
      accountLabel: overrides.accountLabel ?? "oren@gmail.com",
      credentials: overrides.credentials ?? { access_token: "atok", refresh_token: "rtok" },
      status: "connected",
    },
    dek,
    clock,
  );
  return conn.id;
}

// Whether a relation of this exact name exists — a non-throwing probe scoped to the one
// table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// ===========================================================================
// AC1 — a connection near token expiry is refreshed; a refresh FAILURE marks it
// needs_reconnect and sends a notification. Each job is idempotent.
// ===========================================================================

test("scheduleConnectionRefresh schedules the renewal to run BEFORE the token expires", async () => {
  const mc = mutableClock(T0);
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "near-expiry");
    const connectionId = await seedConnection(db, mc.clock, freshDek(), userId);

    const expiresAt = new Date(T0.getTime() + 2 * HOUR_MS);
    const job = await scheduleConnectionRefresh(db, { userId, connectionId, expiresAt });

    assert.ok(job.runAt instanceof Date, "the enqueued refresh job carries a run time");
    assert.ok(
      job.runAt.getTime() < expiresAt.getTime(),
      "the refresh is scheduled to run before the token's expiry (renew before it lapses)",
    );
  } finally {
    await db.close();
  }
});

test("a due refresh job renews the token and keeps the connection connected (and does not re-run)", async () => {
  const mc = mutableClock(T0);
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "refresh-ok");
    const connectionId = await seedConnection(db, mc.clock, freshDek(), userId);

    const expiresAt = new Date(T0.getTime() + 2 * HOUR_MS);
    const job = await scheduleConnectionRefresh(db, { userId, connectionId, expiresAt });

    const push = recordingPush();
    const refresh = recordingRefresh("ok");
    const handler = createConnectorJobHandler({ db, clock: mc.clock, push: push.sender, refresh: refresh.refresh });

    // Move to the job's scheduled time (which is before expiry) and run the queue.
    mc.set(job.runAt);
    const processed = await drainAll(db, mc.clock, handler);

    assert.ok(processed >= 1, "the due refresh job is processed");
    assert.equal(refresh.calls.length, 1, "the connection's token is renewed exactly once");
    assert.equal(refresh.calls[0]?.userId, userId, "the renewal targets the owning user");
    assert.equal(refresh.calls[0]?.connectionId, connectionId, "…and the scheduled connection");

    const after = await getConnectionById(db, userId, connectionId);
    assert.equal(after?.status, "connected", "a successful refresh keeps the connection connected");
    assert.equal(push.sent.length, 0, "a successful refresh sends no notification");

    // Idempotent: the job is done, so a later run renews nothing more.
    mc.advance(DAY_MS);
    const again = await drainAll(db, mc.clock, handler);
    assert.equal(again, 0, "a succeeded refresh job is not claimed again");
    assert.equal(refresh.calls.length, 1, "no second renewal on a later run (idempotent)");
  } finally {
    await db.close();
  }
});

test("a refresh FAILURE marks the connection needs_reconnect and sends ONE notification — idempotently", async () => {
  const mc = mutableClock(T0);
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "refresh-fail");
    const connectionId = await seedConnection(db, mc.clock, freshDek(), userId);

    const expiresAt = new Date(T0.getTime() + HOUR_MS);
    await scheduleConnectionRefresh(db, { userId, connectionId, expiresAt });

    const push = recordingPush();
    const refresh = recordingRefresh("fail");
    const handler = createConnectorJobHandler({ db, clock: mc.clock, push: push.sender, refresh: refresh.refresh });

    // Fire the refresh job: the provider rejects it.
    mc.set(expiresAt);
    await drainAll(db, mc.clock, handler);

    const after = await getConnectionById(db, userId, connectionId);
    assert.equal(after?.status, "needs_reconnect", "a failed refresh marks the connection needs_reconnect");
    assert.equal(push.sent.length, 1, "a failed refresh sends exactly one notification");
    assert.equal(push.sent[0]?.recipient, userId, "the notification is addressed to the owning person");
    assert.ok((push.sent[0]?.body ?? "").length > 0, "the notification carries a message");

    // Idempotent: the failure was handled (not left to retry), so a later run changes nothing.
    mc.advance(DAY_MS);
    const again = await drainAll(db, mc.clock, handler);
    assert.equal(again, 0, "the handled failure is not re-claimed on a later run");
    assert.equal(push.sent.length, 1, "no duplicate notification on a second run (idempotent)");
    const after2 = await getConnectionById(db, userId, connectionId);
    assert.equal(after2?.status, "needs_reconnect", "the status stays needs_reconnect across runs");
  } finally {
    await db.close();
  }
});

test("a failed refresh notification carries no provider secret (redaction before notify)", async () => {
  const mc = mutableClock(T0);
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "notify-redaction");
    const ACCESS = "atok-SECRET-abc";
    const REFRESH = "rtok-SECRET-xyz";
    const connectionId = await seedConnection(db, mc.clock, freshDek(), userId, {
      credentials: { access_token: ACCESS, refresh_token: REFRESH, expires_at: new Date(T0.getTime() + HOUR_MS).toISOString() },
    });

    await scheduleConnectionRefresh(db, { userId, connectionId, expiresAt: new Date(T0.getTime() + HOUR_MS) });

    const push = recordingPush();
    const handler = createConnectorJobHandler({
      db,
      clock: mc.clock,
      push: push.sender,
      refresh: recordingRefresh("fail").refresh,
    });

    mc.set(new Date(T0.getTime() + HOUR_MS));
    await drainAll(db, mc.clock, handler);

    const notified = push.sent.map((m) => `${m.recipient}\n${m.body}\n${m.link ?? ""}`).join("\n");
    assert.ok(push.sent.length >= 1, "a reconnect notification was sent (so the scan is meaningful)");
    assert.ok(!notified.includes(ACCESS), "no stored access token appears in the notification");
    assert.ok(!notified.includes(REFRESH), "no stored refresh token appears in the notification");
  } finally {
    await db.close();
  }
});

test("a connection job acts only on its OWNER's connection (member-scoped by the payload user id)", async () => {
  const mc = mutableClock(T0);
  const db = await freshDb();
  try {
    const dek = freshDek();
    const userA = await makeUser(db, "owner-a");
    const userB = await makeUser(db, "owner-b");
    const connA = await seedConnection(db, mc.clock, dek, userA, { accountLabel: "a@gmail.com" });
    const connB = await seedConnection(db, mc.clock, dek, userB, { accountLabel: "b@gmail.com" });

    // Schedule a (failing) refresh for A's connection only.
    const expiresAt = new Date(T0.getTime() + HOUR_MS);
    await scheduleConnectionRefresh(db, { userId: userA, connectionId: connA, expiresAt });

    const handler = createConnectorJobHandler({
      db,
      clock: mc.clock,
      push: recordingPush().sender,
      refresh: recordingRefresh("fail").refresh,
    });
    mc.set(expiresAt);
    await drainAll(db, mc.clock, handler);

    assert.equal((await getConnectionById(db, userA, connA))?.status, "needs_reconnect", "A's connection is marked");
    assert.equal((await getConnectionById(db, userB, connB))?.status, "connected", "B's connection is untouched");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a Google early-access connection is reminded 24 h before its 7-day lapse and is
// marked needs_reconnect after it. Idempotent across runs.
// ===========================================================================

test("a Google early-access connection is reminded 24h before the 7-day lapse, then marked needs_reconnect after it", async () => {
  const mc = mutableClock(T0);
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "google-ea");
    const connectionId = await seedConnection(db, mc.clock, freshDek(), userId);

    // Consent happened at T0; the testing-mode connection lapses 7 days later.
    await scheduleGoogleLapse(db, { userId, connectionId, connectedAt: T0 });

    const push = recordingPush();
    const handler = createConnectorJobHandler({
      db,
      clock: mc.clock,
      push: push.sender,
      refresh: recordingRefresh("ok").refresh,
    });

    // Just before the 24h-before mark: nothing fires yet.
    mc.set(new Date(T0.getTime() + SEVEN_DAYS_MS - DAY_MS - MINUTE_MS));
    await drainAll(db, mc.clock, handler);
    assert.equal(push.sent.length, 0, "no reminder before the 24h-before mark");
    assert.equal((await getConnectionById(db, userId, connectionId))?.status, "connected");

    // At exactly 24 h before the lapse: the reminder is pushed; the connection is still connected.
    mc.set(new Date(T0.getTime() + SEVEN_DAYS_MS - DAY_MS));
    await drainAll(db, mc.clock, handler);
    assert.equal(push.sent.length, 1, "a reminder is pushed 24h before the 7-day lapse");
    assert.equal(push.sent[0]?.recipient, userId, "the reminder is addressed to the owning person");
    assert.equal(
      (await getConnectionById(db, userId, connectionId))?.status,
      "connected",
      "the connection is still connected at the reminder",
    );

    // Between the reminder and the lapse: no further action.
    mc.set(new Date(T0.getTime() + SEVEN_DAYS_MS - MINUTE_MS));
    await drainAll(db, mc.clock, handler);
    assert.equal(push.sent.length, 1, "no further action between the reminder and the lapse");
    assert.equal((await getConnectionById(db, userId, connectionId))?.status, "connected");

    // At the 7-day lapse: the connection is marked needs_reconnect.
    mc.set(new Date(T0.getTime() + SEVEN_DAYS_MS));
    await drainAll(db, mc.clock, handler);
    assert.equal(
      (await getConnectionById(db, userId, connectionId))?.status,
      "needs_reconnect",
      "the connection is marked needs_reconnect after the 7-day lapse",
    );

    // Idempotent: a later run changes nothing — no extra notification, status unchanged.
    const afterLapse = push.sent.length;
    mc.set(new Date(T0.getTime() + SEVEN_DAYS_MS + DAY_MS));
    const again = await drainAll(db, mc.clock, handler);
    assert.equal(again, 0, "no connector jobs remain due after the lapse");
    assert.equal(push.sent.length, afterLapse, "a second run after the lapse sends nothing more");
    assert.equal(
      (await getConnectionById(db, userId, connectionId))?.status,
      "needs_reconnect",
      "the status stays needs_reconnect across runs",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
// `../http/validate` boundary rejects malformed / oversized / mis-shaped input with a 4xx
// BEFORE any query runs, takes the user id from the SESSION (never the body), and a
// SQL-injection probe in an input field is BOUND as a parameter (it cannot alter a query).
//
// The handler below is a TEST FIXTURE that exercises the real validation boundary and this
// task's `scheduleConnectionRefresh` — the intended usage of a "refresh this connection
// now" trigger, not an implementation file.
// ===========================================================================

// A recording db seam: proves what reached the query layer. Returns a canned `jobs`
// RETURNING row so the enqueue inside the fixture completes without a real database.
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []): Promise<QueryResult> {
      calls.push({ text, values });
      return Promise.resolve({
        rows: [
          { id: "job-fixture", type: "connection.refresh", payload: null, run_at: T0.toISOString(), attempts: 0 },
        ],
      });
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

// Assert a probe reached the query layer INSIDE a bound value and never as spliced SQL text
// (the parameterize half of INV-102). The connection id travels in the job payload, which
// enqueue binds as one parameter, so the probe is a substring of a bound value.
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(
    db.calls.some((c) => c.values.some((v) => typeof v === "string" && v.includes(probe))),
    "the probe travels inside a bound value",
  );
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// The trigger handler fixture: validate the body at the real boundary, then schedule a
// refresh for the SESSION user and the posted connection id. The user id is NEVER read
// from the body.
function connectorRefreshTriggerHandler(opts: {
  db: Db;
  sessionUserId: string;
  expiresAt: Date;
}): (req: Request) => Promise<Response> {
  const schema = z.object({ connectionId: z.string().min(1).max(200) });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 8 * 1024 });
      const job = await scheduleConnectionRefresh(opts.db, {
        userId: opts.sessionUserId,
        connectionId: body.connectionId,
        expiresAt: opts.expiresAt,
      });
      return new Response(JSON.stringify({ jobId: job.id }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
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
  return new Request("https://warthog.com.au/api/connectors/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

const FIXTURE_EXPIRES_AT = new Date(T0.getTime() + HOUR_MS);

test("the handler rejects malformed JSON with a 4xx and reaches no query", async () => {
  const db = recordingDb();
  const handler = connectorRefreshTriggerHandler({ db, sessionUserId: "session-user", expiresAt: FIXTURE_EXPIRES_AT });

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and reaches no query", async () => {
  const db = recordingDb();
  const handler = connectorRefreshTriggerHandler({ db, sessionUserId: "session-user", expiresAt: FIXTURE_EXPIRES_AT });

  // ~20 KiB connection-id blob, well over the handler's 8 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ connectionId: "a".repeat(20 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing the required field with a 4xx", async () => {
  const db = recordingDb();
  const handler = connectorRefreshTriggerHandler({ db, sessionUserId: "session-user", expiresAt: FIXTURE_EXPIRES_AT });

  const res = await handler(jsonRequest(JSON.stringify({})));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed field with a 4xx", async () => {
  const db = recordingDb();
  const handler = connectorRefreshTriggerHandler({ db, sessionUserId: "session-user", expiresAt: FIXTURE_EXPIRES_AT });

  const res = await handler(jsonRequest(JSON.stringify({ connectionId: 12345 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed value must never reach a query");
});

test("a SQL-injection probe in the connection id is BOUND as a parameter, never spliced into the SQL", async () => {
  const db = recordingDb();
  const probe = "x'); DROP TABLE jobs; --";
  const handler = connectorRefreshTriggerHandler({ db, sessionUserId: "session-user", expiresAt: FIXTURE_EXPIRES_AT });

  await handler(jsonRequest(JSON.stringify({ connectionId: probe })));

  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe is stored as data: the jobs table survives and the value round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const probe = "x'); DROP TABLE jobs; --";
    const handler = connectorRefreshTriggerHandler({ db, sessionUserId: userId, expiresAt: FIXTURE_EXPIRES_AT });

    const res = await handler(jsonRequest(JSON.stringify({ connectionId: probe })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "jobs"), true, "the jobs table must still exist");

    const rows = await db.query("SELECT payload FROM jobs");
    const payload = rows.rows[0]?.payload as { connectionId?: string } | undefined;
    assert.equal(payload?.connectionId, probe, "the probe is stored verbatim as data, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

test("the trigger takes the user id from the session, never a client-supplied body value", async () => {
  const db = await freshDb();
  try {
    const sessionUserId = await makeUser(db, "session-owner");
    const handler = connectorRefreshTriggerHandler({ db, sessionUserId, expiresAt: FIXTURE_EXPIRES_AT });

    const res = await handler(
      jsonRequest(JSON.stringify({ connectionId: "conn-1", userId: "attacker-supplied-id" })),
    );
    assert.ok(res.status >= 200 && res.status < 300, "a well-formed body is accepted");

    const rows = await db.query("SELECT payload FROM jobs");
    const payload = rows.rows[0]?.payload as { userId?: string } | undefined;
    assert.equal(payload?.userId, sessionUserId, "the job is scoped to the SESSION user");
    assert.notEqual(payload?.userId, "attacker-supplied-id", "a client-supplied user id is ignored");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 [obligation:secrets-from-env] (INV-103) — the jobs run entirely from INJECTED deps;
// this module folds no ambient environment secret into any notification it emits. Shown
// behaviourally: a decoy secret planted in the environment appears in no notification the
// jobs produce (config flows only through src/server/config.ts, never read here).
// ===========================================================================

test("no ambient env secret reaches a notification — the jobs run from injected deps only", async () => {
  const DECOY = "env-decoy-SECRET-must-never-be-used";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const mc = mutableClock(T0);
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "secrets-from-env");
    const connectionId = await seedConnection(db, mc.clock, freshDek(), userId);

    const expiresAt = new Date(T0.getTime() + HOUR_MS);
    await scheduleConnectionRefresh(db, { userId, connectionId, expiresAt });

    const push = recordingPush();
    const handler = createConnectorJobHandler({
      db,
      clock: mc.clock,
      push: push.sender,
      refresh: recordingRefresh("fail").refresh,
    });

    mc.set(expiresAt);
    await drainAll(db, mc.clock, handler);

    const notified = push.sent.map((m) => `${m.recipient}\n${m.body}\n${m.link ?? ""}`).join("\n");
    assert.ok(push.sent.length >= 1, "a reconnect notification was sent (so the scan is meaningful)");
    assert.ok(!notified.includes(DECOY), "no ambient env secret appears in any notification");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
