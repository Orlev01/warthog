// E09-S14 — Connector-request create path and match-notify
// (`src/server/connectors/requests.ts`).
//
// RED-first: the service module does not exist yet (nor does the store it sits on, nor the
// migration), so importing `./requests` throws and every test here fails until the builder
// writes it. That absence IS the point of test-first; do NOT implement anything to make
// these pass — the builder writes the service AFTERWARDS to turn them green.
//
// These tests pin BEHAVIOUR (what the two paths DO: the stored "Requested" row, the
// Requested → matched transition and the person notification on a catalogue match, that a
// non-matching entry changes nothing, and what a handler rejects), never the source text of
// the module — a later rename that preserves behaviour must not redden them.
//
// WHY this exists (task E09-S14; brief "Request a connector"; design §7): a person can
// request a service that is not in the catalogue. The CREATE path records it "Requested"
// for the person; the operator reads it, with who asked, on the admin portal's Requests page
// (docs/adr/admin-portal.md, amendment of 20 November 2026 — it is no longer emailed). When a catalogue
// entry whose name OR aliases match a pending request is later added, the MATCH-NOTIFY path
// marks the request "matched" and tells the person their service has arrived. Matching
// ignores case and punctuation (via the shared `src/domain/catalogue/match` matcher);
// unmatched requests stay Requested.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // The CREATE path: record a "Requested" service request for the person.
//   requestConnector(
//     input: { userId: string; serviceName: string },   // userId is the SESSION's, never a client value
//     deps: { db: Db; clock: Clock },
//   ): Promise<ConnectorRequest>   // the recorded, Requested request
//
//   // The MATCH-NOTIFY path: run when a catalogue entry is added. Scan every pending
//   // request, mark those the entry matches (name or alias, case- & punctuation-insensitive),
//   // and notify each person. Returns the requests newly marked matched.
//   notifyMatchingRequests(
//     entry: { id: string; name: string; aliases: string[] },  // structural — a CatalogueEntry fits
//     deps: { db: Db; push: PushSender; clock: Clock },
//   ): Promise<ConnectorRequest[]>
//
// The person notification passes through the redaction module (project hard rule: everything
// reaching an email or a notification is redacted first). The admin portal redacts the name
// when it shows it (src/server/admin/page-data.test.ts).
//
// Acceptance criteria → tests:
//   AC "Creating a request records it Requested for the user." — requestConnector stores a
//        Requested service request for the SESSION user.
//   AC "Adding a catalogue entry whose name or alias matches a pending request (ignoring case
//        and punctuation) marks it matched and notifies the person; a non-matching entry
//        leaves requests Requested." — notifyMatchingRequests flips the matching person's
//        request to matched (connector recorded) and pushes them a notice; a non-matching
//        entry marks nothing and notifies nobody.
//   AC [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed input
//        with a 4xx before any query; a SQL-injection probe in the service name is
//        stored as data (the table survives) and the user id comes from the session, never the
//        body. The handler below is a test fixture (the intended usage), not an impl file.
//   AC [obligation:secrets-from-env] (INV-103) — a decoy secret planted in the environment
//        never lands in the stored request.
//
// Every db handle is closed in a `finally`; each real-db test uses its own `freshDb()` (an
// isolated in-memory PGlite with the real migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { requestConnector } from "./requests";
import {
  listConnectorRequestsForUser,
} from "../db/connector-requests";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { fixedClock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

// Instants in the past relative to wall-clock, so a stray Date.now() would diverge.
const T0 = new Date("2026-05-01T09:00:00.000Z");

const ms = (value: Date | string | number): number => new Date(value as never).getTime();

function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A recording db that runs nothing and returns no rows, so a test can prove the handler
// never reached a query (the "4xx before any query" half of INV-102).
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

async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// ===========================================================================
// The CREATE path — records a Requested service request.
// ===========================================================================

test("requestConnector records a Requested item for the person", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "create");

    const created = await requestConnector(
      { userId, serviceName: "Dropbox" },
      { db, clock: fixedClock(T0) },
    );

    assert.equal(created.userId, userId, "the request belongs to the person");
    assert.equal(created.kind, "service", "it is a request for a new service");
    assert.equal(created.connectorId, null, "naming no catalogue entry");
    assert.equal(created.handledAt, null, "and the operator hasn't handled it");
    assert.equal(created.serviceName, "Dropbox", "the requested name is recorded");
    assert.equal(created.status, "requested", "it is recorded Requested");
    assert.equal(created.matchedConnectorId, null, "nothing has matched it yet");

    // It is persisted and visible to the person.
    const [stored] = await listConnectorRequestsForUser(db, userId);
    assert.ok(stored, "the request is persisted for the person");
    assert.equal(stored!.serviceName, "Dropbox", "with the requested name");
    assert.equal(stored!.status, "requested", "and Requested status");
  } finally {
    await db.close();
  }
});

test("asking again for a service the person is already waiting on records nothing new", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "again");
    const first = await requestConnector({ userId, serviceName: "Dropbox" }, { db, clock: fixedClock(T0) });
    const again = await requestConnector({ userId, serviceName: " dropbox! " }, { db, clock: fixedClock(T0) });
    assert.equal(again.id, first.id, "the waiting request is handed back");
    await db.query("UPDATE connector_requests SET handled_at = $2::timestamptz WHERE id = $1", [first.id, T0.toISOString()]);
    const afterDone = await requestConnector({ userId, serviceName: "Dropbox" }, { db, clock: fixedClock(T0) });
    assert.notEqual(afterDone.id, first.id, "once the operator has closed it, asking again is a new request");
    const other = await makeUser(db, "other");
    const theirs = await requestConnector({ userId: other, serviceName: "Dropbox" }, { db, clock: fixedClock(T0) });
    assert.notEqual(theirs.id, first.id, "another person's request is their own");
    assert.equal((await listConnectorRequestsForUser(db, userId)).length, 2);
  } finally {
    await db.close();
  }
});

// The match-notify path is now the hourly arrivals sweep, tested in request-arrivals.test.ts.


// ===========================================================================
// [obligation:validate-and-parameterize-input] — a handler on the validation
// boundary rejects bad input before any query, binds probes, and takes the
// user id from the session. This handler is a TEST FIXTURE (the intended usage of
// `parseBody` + `requestConnector`), not an implementation file.
// ===========================================================================

function requestConnectorHandler(
  deps: { db: Db; clock: ReturnType<typeof fixedClock> },
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries ONLY the service name; the user id comes from the session, never the
  // body. The length cap rejects an absurd value but is generous enough that a probe can
  // still REACH the query to prove it is bound.
  const schema = z.object({ serviceName: z.string().min(1).max(200) });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 8 * 1024 });
      const created = await requestConnector(
        { userId: sessionUserId, serviceName: body.serviceName },
        deps,
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
  return new Request("https://warthog.com.au/api/connector-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = requestConnectorHandler(
    { db, clock: fixedClock(T0) },
    "session-user",
  );

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = requestConnectorHandler(
    { db, clock: fixedClock(T0) },
    "session-user",
  );

  // ~20 KiB service name, well over the handler's 8 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ serviceName: "a".repeat(20 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing the service name with a 4xx", async () => {
  const db = recordingDb();
  const handler = requestConnectorHandler(
    { db, clock: fixedClock(T0) },
    "session-user",
  );

  const res = await handler(jsonRequest(JSON.stringify({})));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects an empty service name with a 4xx", async () => {
  const db = recordingDb();
  const handler = requestConnectorHandler(
    { db, clock: fixedClock(T0) },
    "session-user",
  );

  const res = await handler(jsonRequest(JSON.stringify({ serviceName: "" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an empty service name must never reach a query");
});

test("the handler rejects a mis-typed service name with a 4xx", async () => {
  const db = recordingDb();
  const handler = requestConnectorHandler(
    { db, clock: fixedClock(T0) },
    "session-user",
  );

  // serviceName must be a string — a number is a schema violation, rejected before any query.
  const res = await handler(jsonRequest(JSON.stringify({ serviceName: 123 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler accepts a well-formed body: records the request for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
      const handler = requestConnectorHandler(
      { db, clock: fixedClock(T0) },
      userId,
    );

    const res = await handler(jsonRequest(JSON.stringify({ serviceName: "Dropbox" })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };

    const [stored] = await listConnectorRequestsForUser(db, userId);
    assert.ok(stored, "a valid body is persisted for the session user");
    assert.equal(stored!.id, id, "the stored request matches the returned id");
    assert.equal(stored!.serviceName, "Dropbox", "with the submitted service name");
    assert.equal(stored!.status, "requested", "and Requested status");
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
      const handler = requestConnectorHandler(
      { db, clock: fixedClock(T0) },
      sessionUser,
    );

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(jsonRequest(JSON.stringify({ userId: attacker, serviceName: "Dropbox" })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal((await listConnectorRequestsForUser(db, sessionUser)).length, 1, "the request is recorded under the SESSION user");
    assert.deepEqual(
      await listConnectorRequestsForUser(db, attacker),
      [],
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe service name is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
      const handler = requestConnectorHandler(
      { db, clock: fixedClock(T0) },
      userId,
    );
    const probe = "Dropbox'); DROP TABLE connector_requests; --";

    const res = await handler(jsonRequest(JSON.stringify({ serviceName: probe })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "connector_requests"), true, "the connector_requests table must still exist");

    const [stored] = await listConnectorRequestsForUser(db, userId);
    assert.equal(stored!.serviceName, probe, "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// [obligation:secrets-from-env] — no ambient env value leaks into the stored request.
// ===========================================================================

test("a decoy secret in the environment never lands in the stored request", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "op-env");

    const created = await requestConnector(
      { userId, serviceName: "Dropbox" },
      { db, clock: fixedClock(T0) },
    );

    assert.ok(!JSON.stringify(created).includes(DECOY), "no ambient env value is folded into the returned request");
    assert.ok(!JSON.stringify(await listConnectorRequestsForUser(db, userId)).includes(DECOY), "nor into the stored one");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
