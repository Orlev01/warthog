// E09-S14 — Connector-request create path and match-notify
// (`src/server/connectors/requests.ts`).
//
// RED-first: the service module does not exist yet (nor does the store it sits on, nor the
// migration), so importing `./requests` throws and every test here fails until the builder
// writes it. That absence IS the point of test-first; do NOT implement anything to make
// these pass — the builder writes the service AFTERWARDS to turn them green.
//
// These tests pin BEHAVIOUR (what the two paths DO: the stored "Requested" row, the single
// email to the configured operator, the Requested → matched transition and the person
// notification on a catalogue match, that a non-matching entry changes nothing, what a
// handler rejects, that the operator email is redacted and the operator address is
// config-driven), never the source text of the module — a later rename that preserves
// behaviour must not redden them.
//
// WHY this exists (task E09-S14; brief "Request a connector"; design §7): a person can
// request a service that is not in the catalogue. The CREATE path records it "Requested"
// for the person and emails the operator so they can consider adding it. When a catalogue
// entry whose name OR aliases match a pending request is later added, the MATCH-NOTIFY path
// marks the request "matched" and tells the person their service has arrived. Matching
// ignores case and punctuation (via the shared `src/domain/catalogue/match` matcher);
// unmatched requests stay Requested.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // The CREATE path: record a "Requested" item for the person and email the operator.
//   requestConnector(
//     input: { userId: string; serviceName: string },   // userId is the SESSION's, never a client value
//     deps: {
//       db: Db;
//       email: EmailSender;        // the operator is told by email
//       operatorEmail: string;     // the operator ADDRESS, read from configuration (INV-103)
//       clock: Clock;
//     },
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
// The operator email body and the person notification both pass through the redaction module
// (project hard rule: everything reaching an email or a notification is redacted first), so a
// card number planted in the free-text service name is masked before it leaves Warthog.
//
// Acceptance criteria → tests:
//   AC "Creating a request records it Requested for the user and emails the operator address
//        from configuration." — requestConnector stores a Requested row for the SESSION user
//        and sends exactly one email, to the injected operatorEmail.
//   AC "Adding a catalogue entry whose name or alias matches a pending request (ignoring case
//        and punctuation) marks it matched and notifies the person; a non-matching entry
//        leaves requests Requested." — notifyMatchingRequests flips the matching person's
//        request to matched (connector recorded) and pushes them a notice; a non-matching
//        entry marks nothing and notifies nobody.
//   AC [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed input
//        with a 4xx before any query or email; a SQL-injection probe in the service name is
//        stored as data (the table survives) and the user id comes from the session, never the
//        body. The handler below is a test fixture (the intended usage), not an impl file.
//   AC [obligation:secrets-from-env] (INV-103) — the operator address is the INJECTED config
//        value (two configs route to two addresses — it is not baked in), and a decoy secret
//        planted in the environment never lands in the email or the stored request.
//   Security (redaction hard rule) — a card number planted in the service name is masked in
//        the operator email.
//
// Every db handle is closed in a `finally`; each real-db test uses its own `freshDb()` (an
// isolated in-memory PGlite with the real migrations), so tests share no state. Each test
// builds its own `createOutbox()` so the recorded messages belong to that test alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { requestConnector, notifyMatchingRequests } from "./requests";
import {
  createConnectorRequest,
  listConnectorRequestsForUser,
} from "../db/connector-requests";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { fixedClock } from "../seams/clock";
import { createOutbox, type Outbox, type SentMessage } from "../notify/outbox";
import { OPERATOR_EMAIL_REASON } from "../notify/email";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

const OPERATOR = "ops@warthog.com.au";

// Instants in the past relative to wall-clock, so a stray Date.now() would diverge.
const T0 = new Date("2026-05-01T09:00:00.000Z");
const T1 = new Date("2026-05-08T14:30:00.000Z");

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

// The emails / pushes an outbox recorded, filtered per channel (the outbox is the real
// dev/test sender that satisfies EmailSender and PushSender both).
const emailsOf = (box: Outbox): SentMessage[] => box.list().filter((m) => m.channel === "email");
const pushesOf = (box: Outbox): SentMessage[] => box.list().filter((m) => m.channel === "push");

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
// The CREATE path — records a Requested item and emails the operator address.
// ===========================================================================

test("requestConnector records a Requested item for the person", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "create");
    const box = createOutbox();

    const created = await requestConnector(
      { userId, serviceName: "Dropbox" },
      { db, email: box, operatorEmail: OPERATOR, clock: fixedClock(T0) },
    );

    assert.equal(created.userId, userId, "the request belongs to the person");
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

test("requestConnector emails exactly the configured operator address", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "op-email");
    const box = createOutbox();

    await requestConnector(
      { userId, serviceName: "Dropbox" },
      { db, email: box, operatorEmail: OPERATOR, clock: fixedClock(T0) },
    );

    const emails = emailsOf(box);
    assert.equal(emails.length, 1, "exactly one operator email is sent");
    assert.equal(emails[0]!.recipient, OPERATOR, "it goes to the configured operator address");
    assert.ok(!emails[0]!.body.includes("Dropbox"), "free-text requests stay out of provider mail");
    assert.match(emails[0]!.body, /Review it in Warthog/);
  } finally {
    await db.close();
  }
});

// ===========================================================================
// The MATCH-NOTIFY path — a matching catalogue entry marks the request and
// notifies the person; a non-matching entry leaves requests Requested.
// ===========================================================================


test("the connector-request operator email is branded and still leaves the free text out", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "op-branded");
    const box = createOutbox();
    await requestConnector(
      { userId, serviceName: "Dropbox" },
      { db, email: box, operatorEmail: OPERATOR, clock: fixedClock(T0) },
    );
    const email = emailsOf(box)[0]!.email!;
    assert.equal(email.subject, "New connector request");
    assert.equal(email.heading, "Someone requested a connector");
    assert.match(email.paragraphs.join(" "), /Review it in Warthog/);
    assert.ok(!JSON.stringify(email).includes("Dropbox"), "free-text requests stay out of provider mail");
    assert.equal(email.reason, OPERATOR_EMAIL_REASON);
  } finally {
    await db.close();
  }
});

test("adding a matching entry marks the person's request matched and notifies them", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "match-alice");
    const bob = await makeUser(db, "match-bob");
    await createConnectorRequest(db, { userId: alice, serviceName: "Dropbox" }, fixedClock(T0));
    await createConnectorRequest(db, { userId: bob, serviceName: "Notion" }, fixedClock(T0));

    const box = createOutbox();
    const matched = await notifyMatchingRequests(
      { id: "dropbox", name: "Dropbox", aliases: [] },
      { db, push: box, clock: fixedClock(T1) },
    );

    // Alice's request is the one that matched.
    assert.equal(matched.length, 1, "exactly the matching request is returned");
    assert.equal(matched[0]!.userId, alice, "it is Alice's request");
    assert.equal(matched[0]!.status, "matched", "it is now matched");
    assert.equal(matched[0]!.matchedConnectorId, "dropbox", "the connector that satisfied it is recorded");
    assert.equal(ms(matched[0]!.matchedAt!), ms(T1), "matchedAt is the injected clock instant");

    // Alice is notified; the push goes to her (recipient is her user id).
    const pushes = pushesOf(box);
    assert.equal(pushes.length, 1, "exactly one person is notified");
    assert.equal(pushes[0]!.recipient, alice, "Alice is the one notified");

    // Alice's stored request shows matched; Bob's is untouched and Bob is NOT notified.
    const aliceReqs = await listConnectorRequestsForUser(db, alice);
    assert.equal(aliceReqs[0]!.status, "matched", "Alice's request is persisted as matched");
    const bobReqs = await listConnectorRequestsForUser(db, bob);
    assert.equal(bobReqs[0]!.status, "requested", "Bob's unrelated request stays Requested");
    assert.ok(!pushes.some((p) => p.recipient === bob), "Bob is not notified");
  } finally {
    await db.close();
  }
});

test("matching ignores case and punctuation (entry NAME)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "match-name");
    // The person typed a messy form; the entry's display name is clean. They must still match.
    await createConnectorRequest(db, { userId, serviceName: "google-drive!" }, fixedClock(T0));

    const box = createOutbox();
    const matched = await notifyMatchingRequests(
      { id: "google-drive", name: "Google Drive", aliases: [] },
      { db, push: box, clock: fixedClock(T1) },
    );

    assert.equal(matched.length, 1, "the messy request matches the clean entry name");
    assert.equal(matched[0]!.matchedConnectorId, "google-drive", "the connector is recorded");
    assert.equal(pushesOf(box).length, 1, "the person is notified");
  } finally {
    await db.close();
  }
});

test("matching scans the entry's ALIASES, not only its name", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "match-alias");
    // "GDrive" is not the display name — only an alias of the Google Drive entry.
    await createConnectorRequest(db, { userId, serviceName: "GDrive" }, fixedClock(T0));

    const box = createOutbox();
    const matched = await notifyMatchingRequests(
      { id: "google-drive", name: "Google Drive", aliases: ["gdrive", "drive"] },
      { db, push: box, clock: fixedClock(T1) },
    );

    assert.equal(matched.length, 1, "a request that matches only an alias is still matched");
    assert.equal(matched[0]!.userId, userId, "it is this person's request");
    assert.equal(pushesOf(box).length, 1, "the person is notified");
  } finally {
    await db.close();
  }
});

test("a non-matching entry marks nothing and notifies nobody; requests stay Requested", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "nomatch-alice");
    const bob = await makeUser(db, "nomatch-bob");
    await createConnectorRequest(db, { userId: alice, serviceName: "Dropbox" }, fixedClock(T0));
    await createConnectorRequest(db, { userId: bob, serviceName: "Notion" }, fixedClock(T0));

    const box = createOutbox();
    const matched = await notifyMatchingRequests(
      { id: "slack", name: "Slack", aliases: [] },
      { db, push: box, clock: fixedClock(T1) },
    );

    assert.deepEqual(matched, [], "an unrelated entry matches no pending request");
    assert.equal(pushesOf(box).length, 0, "nobody is notified");

    // Both requests remain Requested.
    assert.equal((await listConnectorRequestsForUser(db, alice))[0]!.status, "requested", "Alice's request stays Requested");
    assert.equal((await listConnectorRequestsForUser(db, bob))[0]!.status, "requested", "Bob's request stays Requested");
  } finally {
    await db.close();
  }
});

test("a word shared with a different multi-word service does not match", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "near-miss");
    await createConnectorRequest(db, { userId, serviceName: "Google Calendar" }, fixedClock(T0));

    const box = createOutbox();
    // "Google Drive" shares the word "Google" but is a different service — no match.
    const matched = await notifyMatchingRequests(
      { id: "google-drive", name: "Google Drive", aliases: ["gdrive"] },
      { db, push: box, clock: fixedClock(T1) },
    );

    assert.deepEqual(matched, [], "sharing one word is not a match");
    assert.equal(pushesOf(box).length, 0, "the person is not notified");
    assert.equal((await listConnectorRequestsForUser(db, userId))[0]!.status, "requested", "the request stays Requested");
  } finally {
    await db.close();
  }
});

test("every person who requested the same service is matched and notified", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "many-alice");
    const carol = await makeUser(db, "many-carol");
    const bob = await makeUser(db, "many-bob");
    await createConnectorRequest(db, { userId: alice, serviceName: "Dropbox" }, fixedClock(T0));
    await createConnectorRequest(db, { userId: carol, serviceName: "dropbox" }, fixedClock(T0));
    await createConnectorRequest(db, { userId: bob, serviceName: "Notion" }, fixedClock(T0));

    const box = createOutbox();
    const matched = await notifyMatchingRequests(
      { id: "dropbox", name: "Dropbox", aliases: [] },
      { db, push: box, clock: fixedClock(T1) },
    );

    assert.equal(matched.length, 2, "both people who wanted Dropbox are matched");
    const matchedOwners = new Set(matched.map((r) => r.userId));
    assert.ok(matchedOwners.has(alice) && matchedOwners.has(carol), "Alice and Carol both matched");

    const pushRecipients = new Set(pushesOf(box).map((p) => p.recipient));
    assert.ok(pushRecipients.has(alice) && pushRecipients.has(carol), "both are notified");
    assert.ok(!pushRecipients.has(bob), "Bob (who wanted Notion) is not notified");
  } finally {
    await db.close();
  }
});

test("running match-notify twice for the same entry notifies the person only once", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "idem");
    await createConnectorRequest(db, { userId: alice, serviceName: "Dropbox" }, fixedClock(T0));

    const box = createOutbox();
    const entry = { id: "dropbox", name: "Dropbox", aliases: [] };

    const first = await notifyMatchingRequests(entry, { db, push: box, clock: fixedClock(T1) });
    assert.equal(first.length, 1, "the first run matches the pending request");

    const second = await notifyMatchingRequests(entry, { db, push: box, clock: fixedClock(T1) });
    assert.deepEqual(second, [], "the second run finds nothing still pending to match");

    assert.equal(pushesOf(box).length, 1, "the person is notified exactly once across both runs");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// [obligation:validate-and-parameterize-input] — a handler on the validation
// boundary rejects bad input before any query/email, binds probes, and takes the
// user id from the session. This handler is a TEST FIXTURE (the intended usage of
// `parseBody` + `requestConnector`), not an implementation file.
// ===========================================================================

function requestConnectorHandler(
  deps: { db: Db; email: Outbox; operatorEmail: string; clock: ReturnType<typeof fixedClock> },
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

test("the handler rejects malformed JSON with a 4xx and never reaches a query or an email", async () => {
  const db = recordingDb();
  const box = createOutbox();
  const handler = requestConnectorHandler(
    { db, email: box, operatorEmail: OPERATOR, clock: fixedClock(T0) },
    "session-user",
  );

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
  assert.equal(box.list().length, 0, "and must never send an operator email");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const box = createOutbox();
  const handler = requestConnectorHandler(
    { db, email: box, operatorEmail: OPERATOR, clock: fixedClock(T0) },
    "session-user",
  );

  // ~20 KiB service name, well over the handler's 8 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ serviceName: "a".repeat(20 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
  assert.equal(box.list().length, 0, "and must never send an operator email");
});

test("the handler rejects a body missing the service name with a 4xx", async () => {
  const db = recordingDb();
  const box = createOutbox();
  const handler = requestConnectorHandler(
    { db, email: box, operatorEmail: OPERATOR, clock: fixedClock(T0) },
    "session-user",
  );

  const res = await handler(jsonRequest(JSON.stringify({})));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects an empty service name with a 4xx", async () => {
  const db = recordingDb();
  const box = createOutbox();
  const handler = requestConnectorHandler(
    { db, email: box, operatorEmail: OPERATOR, clock: fixedClock(T0) },
    "session-user",
  );

  const res = await handler(jsonRequest(JSON.stringify({ serviceName: "" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an empty service name must never reach a query");
});

test("the handler rejects a mis-typed service name with a 4xx", async () => {
  const db = recordingDb();
  const box = createOutbox();
  const handler = requestConnectorHandler(
    { db, email: box, operatorEmail: OPERATOR, clock: fixedClock(T0) },
    "session-user",
  );

  // serviceName must be a string — a number is a schema violation, rejected before any query.
  const res = await handler(jsonRequest(JSON.stringify({ serviceName: 123 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler accepts a well-formed body: records the request for the SESSION user and emails the operator", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const box = createOutbox();
    const handler = requestConnectorHandler(
      { db, email: box, operatorEmail: OPERATOR, clock: fixedClock(T0) },
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

    const emails = emailsOf(box);
    assert.equal(emails.length, 1, "the operator is emailed once");
    assert.equal(emails[0]!.recipient, OPERATOR, "at the configured operator address");
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const box = createOutbox();
    const handler = requestConnectorHandler(
      { db, email: box, operatorEmail: OPERATOR, clock: fixedClock(T0) },
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
    const box = createOutbox();
    const handler = requestConnectorHandler(
      { db, email: box, operatorEmail: OPERATOR, clock: fixedClock(T0) },
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
// [obligation:secrets-from-env] — the operator address is config-driven (not baked in),
// and no ambient env value leaks into the email or the stored request.
// ===========================================================================

test("the operator address is the injected config value: two configs route to two addresses", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "op-config");

    const boxA = createOutbox();
    await requestConnector(
      { userId, serviceName: "Dropbox" },
      { db, email: boxA, operatorEmail: "ops-a@warthog.com.au", clock: fixedClock(T0) },
    );

    const boxB = createOutbox();
    await requestConnector(
      { userId, serviceName: "Notion" },
      { db, email: boxB, operatorEmail: "ops-b@warthog.com.au", clock: fixedClock(T0) },
    );

    assert.equal(emailsOf(boxA)[0]!.recipient, "ops-a@warthog.com.au", "the first config's operator is used");
    assert.equal(emailsOf(boxB)[0]!.recipient, "ops-b@warthog.com.au", "the second config's operator is used");
  } finally {
    await db.close();
  }
});

test("a decoy secret in the environment never lands in the operator email or the stored request", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "op-env");
    const box = createOutbox();

    const created = await requestConnector(
      { userId, serviceName: "Dropbox" },
      { db, email: box, operatorEmail: OPERATOR, clock: fixedClock(T0) },
    );

    assert.ok(!JSON.stringify(created).includes(DECOY), "no ambient env value is folded into the returned request");
    for (const message of box.list()) {
      assert.ok(!message.body.includes(DECOY), "no ambient env value is folded into an outgoing message");
      assert.ok(!message.recipient.includes(DECOY), "no ambient env value is used as a recipient");
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===========================================================================
// Security (redaction hard rule) — a card number planted in the free-text service
// name is MASKED in the operator email (everything reaching an email is redacted).
// ===========================================================================

test("the operator email is redacted: a card number in the service name is masked", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "redact");
    const box = createOutbox();

    // 4111 1111 1111 1111 is a Luhn-valid test PAN. The redaction module masks it to
    // `[card ••••1111]`, revealing only the last four — so the full number must not appear
    // in the operator email.
    await requestConnector(
      { userId, serviceName: "Acme 4111 1111 1111 1111 Bank" },
      { db, email: box, operatorEmail: OPERATOR, clock: fixedClock(T0) },
    );

    const body = emailsOf(box)[0]!.body;
    assert.ok(!body.includes("Acme"), "the free-text name is not sent overseas");
    assert.ok(!body.includes("1111"), "even the card suffix stays out of email");
    assert.ok(!body.includes("4111 1111 1111 1111"), "the full grouped card number must not appear");
    assert.ok(!body.includes("4111111111111111"), "nor the full card number with its separators stripped");
  } finally {
    await db.close();
  }
});
