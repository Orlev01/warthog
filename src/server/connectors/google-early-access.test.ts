// E09-S13 — Google early-access gating (`src/server/connectors/google-early-access.ts`;
// brief.yaml:162 "Google early access"; design §7 "Google early access").
//
// RED-first: the module under test does NOT exist yet — importing `./google-early-access`
// throws, so every test here fails until the builder writes it. That absence IS the point
// of test-first; do NOT implement anything to make these pass. The builder writes the
// module AFTERWARDS to turn them green (and leaves these tests untouched).
//
// These tests pin BEHAVIOUR (what the gate DECIDES and what the filing path DOES: the
// connect-vs-ask-to-join decision, the "Early access — ask to join" funnel that records a
// connector request and emails the operator, the unverified-app note
// shown when a connection may start, what a handler rejects, that a probe is bound not
// spliced, that the allowlist and operator address are injected config and no ambient env
// secret leaks). They never assert the source text of the module — a later rename that
// preserves behaviour must not redden them.
//
// WHY this exists (task E09-S13; brief "Google early access"): Google allows only 100
// unverified-mode testers, so Google connectors (the catalogue entries flagged
// `google_early_access: true`: google-gmail, google-calendar, google-drive) are offered
// only to people whose email the founder has placed on the configured early-access
// allowlist (`config.googleEarlyAccess`). Everyone else sees the connector marked
// "Early access — ask to join"; filing that records a connector request (the E09-S14
// store) and emails the operator so they can add the person to the allowlist. The connect
// screen says Google will show its "unverified app" screen. (Reconnecting every 7 days
// ended when the Google app was published: docs/adr/google-published-and-accounts.md.)
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // The GATE (pure): what a person sees for a connector entry.
//   //   - A connector NOT flagged google_early_access is never gated → connect, no warning.
//   //   - A flagged entry whose person's email is on the allowlist → connect, with the
//   //     Google unverified-app note (no 7-day reconnect since the app was published).
//   //   - A flagged entry whose email is NOT on the allowlist → ask_to_join (the funnel).
//   // Allowlist matching is case-insensitive (config stores emails trimmed but verbatim).
//   gateGoogleConnector(
//     entry: { google_early_access?: boolean },
//     email: string,
//     allowlist: readonly string[],                 // from config.googleEarlyAccess (INJECTED)
//   ): { kind: "connect"; warning: { unverifiedApp: string } | null }
//    | { kind: "ask_to_join"; label: string }       // label === "Early access — ask to join"
//
//   // The FILING path: a non-allowlisted person asks to join early access for a Google
//   // connector. It records an early-access request FOR THE SESSION USER (never a client id)
//   // naming the service; the operator reads it on the admin portal's Requests page.
//   askToJoinEarlyAccess(
//     input: { userId: string; connector: { id: string; name: string } },   // userId is the SESSION's
//     deps: { db: Db; clock: Clock },
//   ): Promise<ConnectorRequest>                     // the recorded, Requested request
//
// Acceptance criteria → tests:
//   AC "An allowlisted email can start a Google connection; a non-allowlisted email sees
//       Early access — ask to join and filing it records a connector request." — the gate
//       returns connect for an allowlisted email and ask_to_join for a non-allowlisted one;
//       askToJoinEarlyAccess records a Requested connector request for the session user.
//   AC "The allowlist is read from configuration, never hard-coded." — the SAME email flips
//       between connect and ask_to_join when the injected allowlist changes; an empty
//       allowlist admits nobody.
//   AC [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//       `../http/validate` boundary rejects malformed / oversized / missing / mis-typed input
//       with a 4xx before any query; a probe travels as a bound value (never spliced
//       into the SQL text) and the table survives. The handler below is a TEST FIXTURE (the
//       intended usage of `parseBody` + `askToJoinEarlyAccess`), not an implementation file.
//   AC [obligation:secrets-from-env] (INV-103) — the allowlist is an INJECTED config value, and
//       a decoy secret planted in the environment never lands in the decision or the stored
//       request.
//
// Every db handle is closed in a `finally`; each real-db test uses its own `freshDb()` (an
// isolated in-memory PGlite with the real migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { gateGoogleConnector, askToJoinEarlyAccess } from "./google-early-access";
import { listConnectorRequestsForUser } from "../db/connector-requests";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { fixedClock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------


// An instant in the past relative to wall-clock, so a stray Date.now() would diverge.
const T0 = new Date("2026-05-01T09:00:00.000Z");

// The three Google connectors are flagged `google_early_access: true` (catalogue data);
// a structural ref carrying the id + display name is all the gate and the filing path need.
const GMAIL = { id: "google-gmail", name: "Gmail" };

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return user.id;
}


// A recording db that runs nothing and returns no rows, so a test can prove the handler
// never reached a query (the "4xx before any query" half of INV-102) and that a probe that
// DOES reach a query travels bound, never spliced.
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

// The probe reaches a query as a BOUND value and never appears in the SQL text (OBS /
// INV-102). Substring match on values tolerates a service name the filing path may prefix.
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(
    db.calls.some((c) => c.values.some((v) => typeof v === "string" && v.includes(probe))),
    "the probe travels as a bound value",
  );
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL text");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// ===========================================================================
// The GATE (pure) — connect for an allowlisted email, ask-to-join otherwise;
// the allowlist is injected config (AC1 + AC2 + the connect-screen warning).
// ===========================================================================

test("[gate] an allowlisted email may start a Google connection", () => {
  const decision = gateGoogleConnector(
    { google_early_access: true },
    "founder@warthog.com.au",
    ["founder@warthog.com.au", "tester@warthog.com.au"],
  );
  assert.equal(decision.kind, "connect", "an allowlisted person is offered the connection");
});

test('[gate] a non-allowlisted email is funnelled to "Early access — ask to join"', () => {
  const decision = gateGoogleConnector(
    { google_early_access: true },
    "stranger@example.com",
    ["founder@warthog.com.au"],
  );
  assert.equal(decision.kind, "ask_to_join", "a non-allowlisted person cannot connect");
  if (decision.kind === "ask_to_join") {
    assert.equal(decision.label, "Early access — ask to join", "they see the exact funnel label");
  }
});

test("[gate] the allowlist match is case-insensitive", () => {
  // The founder listed a mixed-case address; the person's email differs only in case.
  const a = gateGoogleConnector({ google_early_access: true }, "founder@warthog.com.au", [
    "Founder@Warthog.com.au",
  ]);
  assert.equal(a.kind, "connect", "a lower-case email matches a mixed-case allowlist entry");

  const b = gateGoogleConnector({ google_early_access: true }, "FOUNDER@WARTHOG.COM.AU", [
    "founder@warthog.com.au",
  ]);
  assert.equal(b.kind, "connect", "an upper-case email matches a lower-case allowlist entry");
});

test("[gate] an empty allowlist admits nobody (no address is hard-coded)", () => {
  const decision = gateGoogleConnector({ google_early_access: true }, "founder@warthog.com.au", []);
  assert.equal(decision.kind, "ask_to_join", "with an empty allowlist even a plausible founder email is gated");
});

test("[secrets-from-env] the allowlist drives the decision: the same email flips with the config", () => {
  const email = "person@example.com";
  const entry = { google_early_access: true };

  // Config A lists the email → connect. Config B omits it → ask_to_join. Same email, two
  // configs, two outcomes: the allowlist is read from configuration, never baked in.
  const withList = gateGoogleConnector(entry, email, [email]);
  const withoutList = gateGoogleConnector(entry, email, ["someone-else@example.com"]);

  assert.equal(withList.kind, "connect", "the email is admitted when the config lists it");
  assert.equal(withoutList.kind, "ask_to_join", "and gated when a different config omits it");
});

test("[gate] a connector NOT flagged for early access is never gated", () => {
  // A non-Google (or unflagged) entry is connectable regardless of the allowlist — only
  // Google early-access entries are gated.
  for (const entry of [{ google_early_access: false }, {}]) {
    const decision = gateGoogleConnector(entry, "stranger@example.com", []);
    assert.equal(decision.kind, "connect", "an unflagged connector is offered to anyone");
    if (decision.kind === "connect") {
      assert.equal(decision.warning, null, "and carries no Google early-access warning");
    }
  }
});

test("[gate] the allowed Google connect says what Google's unverified-app screen will show, with no 7-day reconnect", () => {
  const decision = gateGoogleConnector(
    { google_early_access: true },
    "founder@warthog.com.au",
    ["founder@warthog.com.au"],
  );
  assert.equal(decision.kind, "connect");
  if (decision.kind === "connect") {
    assert.notEqual(decision.warning, null, "an allowed Google connect carries a note");
    assert.match(decision.warning!.unverifiedApp, /hasn't verified Warthog/, "it names Google's unverified-app screen");
    assert.match(decision.warning!.unverifiedApp, /Advanced/, "and how to get past it");
    assert.doesNotMatch(decision.warning!.unverifiedApp, /7 days|reconnect/i, "the published app needs no weekly reconnect");
    assert.deepEqual(Object.keys(decision.warning!), ["unverifiedApp"]);
  }
});

// ===========================================================================
// The FILING path — "ask to join" records an early-access request for the SESSION
// user (AC1 "filing it records a connector request").
// ===========================================================================

test("askToJoinEarlyAccess records a Requested connector request for the person", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ask");
  
    const created = await askToJoinEarlyAccess(
      { userId, connector: GMAIL },
      { db, clock: fixedClock(T0) },
    );

    assert.equal(created.userId, userId, "the request belongs to the person");
    assert.equal(created.status, "requested", "it is recorded Requested");
    assert.equal(created.matchedConnectorId, null, "nothing has matched it yet");
    assert.ok(created.serviceName.includes(GMAIL.name), "it names the Google service they asked to join");
    assert.equal(created.kind, "google_early_access", "it is an early-access request");
    assert.equal(created.connectorId, GMAIL.id, "for that catalogue entry");

    // It is persisted and visible to the person.
    const [stored] = await listConnectorRequestsForUser(db, userId);
    assert.ok(stored, "the request is persisted for the person");
    assert.ok(stored!.serviceName.includes(GMAIL.name), "with the service named");
    assert.equal(stored!.status, "requested", "and Requested status");
  } finally {
    await db.close();
  }
});

test("askToJoinEarlyAccess records under the SESSION user; another person sees nothing", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "owner");
    const other = await makeUser(db, "other");
  
    await askToJoinEarlyAccess(
      { userId: sessionUser, connector: GMAIL },
      { db, clock: fixedClock(T0) },
    );

    assert.equal(
      (await listConnectorRequestsForUser(db, sessionUser)).length,
      1,
      "the request is recorded for the session user",
    );
    assert.deepEqual(
      await listConnectorRequestsForUser(db, other),
      [],
      "and is never visible to another person",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// [validate-and-parameterize-input] — a handler on the validation boundary
// rejects bad input before any query/email, binds probes, and takes the user id
// from the session. This handler is a TEST FIXTURE (the intended usage of
// `parseBody` + `askToJoinEarlyAccess`), not an implementation file.
// ===========================================================================

// Resolve a connector id to its catalogue ref (an in-memory lookup — never SQL), so an
// unknown/probe id is rejected at the boundary and cannot reach a query.
function catalogueOf(entries: { id: string; name: string }[]): (id: string) => { id: string; name: string } | undefined {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return (id: string) => byId.get(id);
}

function askToJoinHandler(
  deps: { db: Db; clock: ReturnType<typeof fixedClock> },
  sessionUserId: string,
  lookup: (id: string) => { id: string; name: string } | undefined,
): (req: Request) => Promise<Response> {
  // The body carries ONLY the connector id; the user id comes from the session, never the
  // body. The length cap rejects an absurd value but is generous enough that a probe can
  // still be submitted to prove the boundary resolves it in memory, not via SQL.
  const schema = z.object({ connectorId: z.string().min(1).max(200) });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 8 * 1024 });
      const entry = lookup(body.connectorId);
      if (!entry) {
        return new Response(JSON.stringify({ error: "unknown connector" }), { status: 404 });
      }
      const created = await askToJoinEarlyAccess(
        { userId: sessionUserId, connector: { id: entry.id, name: entry.name } },
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
  return new Request("https://warthog.com.au/api/connectors/google/ask-to-join", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("[validate-and-parameterize-input] the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = askToJoinHandler(
    { db, clock: fixedClock(T0) },
    "session-user",
    catalogueOf([GMAIL]),
  );

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("[validate-and-parameterize-input] the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = askToJoinHandler(
    { db, clock: fixedClock(T0) },
    "session-user",
    catalogueOf([GMAIL]),
  );

  // ~20 KiB connector id, well over the handler's 8 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ connectorId: "a".repeat(20 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("[validate-and-parameterize-input] the handler rejects a body missing the connector id with a 4xx", async () => {
  const db = recordingDb();
  const handler = askToJoinHandler(
    { db, clock: fixedClock(T0) },
    "session-user",
    catalogueOf([GMAIL]),
  );

  const res = await handler(jsonRequest(JSON.stringify({})));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("[validate-and-parameterize-input] the handler rejects an empty connector id with a 4xx", async () => {
  const db = recordingDb();
  const handler = askToJoinHandler(
    { db, clock: fixedClock(T0) },
    "session-user",
    catalogueOf([GMAIL]),
  );

  const res = await handler(jsonRequest(JSON.stringify({ connectorId: "" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an empty connector id must never reach a query");
});

test("[validate-and-parameterize-input] the handler rejects a mis-typed connector id with a 4xx", async () => {
  const db = recordingDb();
  const handler = askToJoinHandler(
    { db, clock: fixedClock(T0) },
    "session-user",
    catalogueOf([GMAIL]),
  );

  // connectorId must be a string — a number is a schema violation, rejected before any query.
  const res = await handler(jsonRequest(JSON.stringify({ connectorId: 123 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("[validate-and-parameterize-input] a SQL-probe connector id in the input field cannot alter a query", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "probe-id");
      const handler = askToJoinHandler(
      { db, clock: fixedClock(T0) },
      userId,
      catalogueOf([GMAIL]),
    );
    // A probe in the connector-id field is an unknown connector (the lookup is in-memory, not
    // SQL): the boundary rejects it, so it can never reach — let alone alter — a query.
    const probe = "google-gmail'); DROP TABLE connector_requests; --";

    const res = await handler(jsonRequest(JSON.stringify({ connectorId: probe })));

    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.equal(await tableExists(db, "connector_requests"), true, "the connector_requests table must still exist");
    assert.deepEqual(await listConnectorRequestsForUser(db, userId), [], "nothing is recorded for a probe id");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] the service name reaches the query bound, never spliced", async () => {
  const db = recordingDb();
  // A probe planted in the connector name is the value that DOES flow into the INSERT; it
  // must travel as a bound parameter, not be concatenated into the SQL text.
  const probe = "Gmail'); DROP TABLE connector_requests; --";

  await askToJoinEarlyAccess(
    { userId: "owner-1", connector: { id: "google-gmail", name: probe } },
    { db, clock: fixedClock(T0) },
  );

  assertBoundNotSpliced(db, probe);
});

test("[validate-and-parameterize-input] a SQL probe in the connector name is stored as data; the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "probe-name");
      const probe = "Gmail'); DROP TABLE connector_requests; --";

    await askToJoinEarlyAccess(
      { userId, connector: { id: "google-gmail", name: probe } },
      { db, clock: fixedClock(T0) },
    );

    assert.equal(await tableExists(db, "connector_requests"), true, "the connector_requests table must still exist");
    const [stored] = await listConnectorRequestsForUser(db, userId);
    assert.ok(stored, "the request is persisted");
    assert.ok(stored!.serviceName.includes(probe), "the probe is stored verbatim as data, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

test("the handler accepts a well-formed body: files the ask-to-join for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
      const handler = askToJoinHandler(
      { db, clock: fixedClock(T0) },
      userId,
      catalogueOf([GMAIL]),
    );

    const res = await handler(jsonRequest(JSON.stringify({ connectorId: "google-gmail" })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };

    const [stored] = await listConnectorRequestsForUser(db, userId);
    assert.ok(stored, "a valid body is persisted for the session user");
    assert.equal(stored!.id, id, "the stored request matches the returned id");
    assert.ok(stored!.serviceName.includes(GMAIL.name), "with the Google service named");
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
      const handler = askToJoinHandler(
      { db, clock: fixedClock(T0) },
      sessionUser,
      catalogueOf([GMAIL]),
    );

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(jsonRequest(JSON.stringify({ userId: attacker, connectorId: "google-gmail" })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal(
      (await listConnectorRequestsForUser(db, sessionUser)).length,
      1,
      "the request is recorded under the SESSION user",
    );
    assert.deepEqual(
      await listConnectorRequestsForUser(db, attacker),
      [],
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// [secrets-from-env] — no ambient env value leaks into the decision or the stored request.
// ===========================================================================

test("[secrets-from-env] a decoy env secret never appears in the gate decision", () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  try {
    const connect = gateGoogleConnector({ google_early_access: true }, "founder@warthog.com.au", [
      "founder@warthog.com.au",
    ]);
    const ask = gateGoogleConnector({ google_early_access: true }, "stranger@example.com", [
      "founder@warthog.com.au",
    ]);
    assert.ok(!JSON.stringify(connect).includes(DECOY), "no ambient env value is folded into a connect decision");
    assert.ok(!JSON.stringify(ask).includes(DECOY), "nor into an ask-to-join decision");
  } finally {
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

test("[secrets-from-env] a decoy env secret never lands in the filed request or its stored cells", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "op-env");
  
    const created = await askToJoinEarlyAccess(
      { userId, connector: GMAIL },
      { db, clock: fixedClock(T0) },
    );

    assert.ok(!JSON.stringify(created).includes(DECOY), "no ambient env value is folded into the returned request");

    // Scan every stored cell — nothing from the environment leaked into the row.
    const all = await db.query("SELECT * FROM connector_requests");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(DECOY), "no ambient env value is stored in the request row");
        }
      }
    }

  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});


test("asking again to join early access for the same service records nothing new while the first ask waits", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "asks-twice");
    const first = await askToJoinEarlyAccess({ userId, connector: GMAIL }, { db, clock: fixedClock(T0) });
    const again = await askToJoinEarlyAccess({ userId, connector: GMAIL }, { db, clock: fixedClock(T0) });
    assert.equal(again.id, first.id);
    const drive = await askToJoinEarlyAccess({ userId, connector: { id: "google-drive", name: "Google Drive" } }, { db, clock: fixedClock(T0) });
    assert.notEqual(drive.id, first.id, "another service is its own ask");
    assert.equal((await listConnectorRequestsForUser(db, userId)).length, 2);
  } finally {
    await db.close();
  }
});
