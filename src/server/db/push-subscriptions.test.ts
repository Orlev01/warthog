// E12-S01 — Push-subscriptions store (`src/server/db/push-subscriptions.ts`,
// `db/migrations/0025_push_subscriptions.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./push-subscriptions` throws and `freshDb()` has no `push_subscriptions` table —
// every test here fails until the builder adds them. That absence IS the point of
// test-first; do NOT implement anything to make these pass — the builder writes the
// module and the migration afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: the stored + round-tripped
// device data, which subscriptions a listing returns, who may read/remove what, that the
// endpoint and keys are encrypted at rest, what a handler rejects, that every value is
// bound as a parameter), never the source text of the module or the SQL file — a later
// rename that preserves behaviour must not redden them.
//
// WHY this exists (design §10 Notifications, brief "Notification settings" /
// "Approval notifications"): approval notifications push to EVERY registered device within
// seconds. A person may register ONE OR MORE devices for Web Push; each device's
// subscription carries a push-service `endpoint` and the two Web Push keys
// (`p256dh` + `auth`). The endpoint and keys are PER-PERSON DEVICE DATA — personal content
// — so they are stored only DEK-ENCRYPTED (design §4.1; project rule: personal content is
// encrypted with the per-person DEK, the plaintext never lands in a column). The person can
// list their registered devices and remove one; a removed or expired subscription drops out
// of the active listing.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface PushKeys {           // the two Web Push keys (base64url) — DEK-encrypted at rest
//     p256dh: string;
//     auth: string;
//   }
//
//   interface NewPushSubscription {
//     userId: string;              // the person (the session's id, NEVER a client value)
//     endpoint: string;            // the push-service endpoint URL for this device — DEK-encrypted
//     keys: PushKeys;              // p256dh + auth — DEK-encrypted
//     expiresAt?: Date | string | null;  // the subscription's expirationTime; omitted/null ⇒ never expires
//   }
//
//   interface StoredPushSubscription {
//     id: string;                  // generated on create; identifies the subscription (device)
//     userId: string;
//     endpoint: string;            // DECRYPTED on read, under the injected DEK
//     keys: PushKeys;              // DECRYPTED on read, under the injected DEK
//     createdAt: Date | string;    // the injected clock's instant (moment, not representation)
//     expiresAt: Date | string | null;  // the stored expirationTime (null when it never expires)
//   }
//
//   interface RemoveSubscriptionInput { userId: string; id: string }
//
//   registerSubscription(db, input: NewPushSubscription, dek, clock): Promise<StoredPushSubscription>
//     • stores an ACTIVE subscription for `userId` with its endpoint + keys DEK-encrypted
//       (createdAt = clock.now()), and returns the StoredPushSubscription (carrying the
//       generated id). Assembles the returned value from its inputs (it does not depend on a
//       RETURNING read), like createHeldRequest. A person may register several (one per device).
//   listSubscriptions(db, userId, dek, clock): Promise<StoredPushSubscription[]>
//     • ALL of `userId`'s ACTIVE subscriptions (member-scoped: WHERE user_id bound), endpoint +
//       keys decrypted under `dek`; never another person's. An active subscription is one that
//       is NOT removed and NOT expired (expiresAt is null or strictly after clock.now()). Empty
//       array when the person has none active.
//   removeSubscription(db, { userId, id }, dek?): Promise<boolean>   // (dek NOT required to remove)
//     • removes the one subscription OWNED BY `userId` with this id (member-scoped: id AND
//       user_id both bound), so it is no longer returned by listSubscriptions. Returns true when
//       a subscription was removed, false when none matched for this user (idempotent — removing
//       something that is not there, or another user's id, is not an error and changes nothing).
//
// Acceptance criteria → tests:
//   AC1 "Registering a subscription stores it for the session user with keys DEK-encrypted, and
//        listSubscriptions returns the owner's active subscriptions." — registerSubscription
//        returns an id and the recorded device data; listSubscriptions reads back every active
//        one with the SAME endpoint + keys; the plaintext endpoint/keys never appear in a raw
//        column (encrypted at rest).
//   AC2 "A removed or expired subscription is not returned." — after removeSubscription the row
//        drops out of the listing; a subscription whose expiresAt is in the past (relative to the
//        injected clock) is never listed, while one with a future / null expiry is.
//   AC3 "A user cannot read or remove another user's subscriptions (filtered by session user
//        id)." — B never sees A's subscriptions in a list, and B's removeSubscription on A's id
//        removes nothing and leaves A's subscription listed; the user id is bound as a parameter.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed input
//        with a 4xx before any query runs; a SQL-injection probe routed through the repo travels
//        as a BOUND value (placeholders, never concatenation) and cannot drop the table. The
//        handler below is a test fixture (the intended usage), not an implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — the endpoint + keys are encrypted under the
//        INJECTED DEK, not a baked-in secret: a different DEK cannot read them back. The repo
//        takes `db`/`dek`/`clock` as dependencies, reads no `process.env` and holds no key, so a
//        decoy secret planted in the environment never lands in the stored or returned subscription.
//   Migration: the `push_subscriptions` relation exists after the project migrations and a second
//        run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { registerSubscription, listSubscriptions, removeSubscription } from "./push-subscriptions";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// Compare the moment, not the representation: createdAt / expiresAt may come back as a Date
// or an ISO string — either is a reasonable choice and must not redden a test.
const ms = (value: Date | string | number): number => new Date(value as never).getTime();

// Instants deliberately in the past relative to the wall clock, so anything that wrongly read
// Date.now() instead of the injected clock would diverge here. T0 is the registration instant;
// NOW is the moment a listing is evaluated at; PAST_EXPIRY < NOW (expired) and
// FUTURE_EXPIRY > NOW (still active).
const T0 = new Date("2026-02-01T09:00:00.000Z");
const NOW = new Date("2026-02-10T09:00:00.000Z");
const PAST_EXPIRY = new Date("2026-02-05T09:00:00.000Z");
const FUTURE_EXPIRY = new Date("2026-03-01T09:00:00.000Z");

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a layer up;
// this repo only ever receives the already-unwrapped bytes.
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

// A device's push-service endpoint and Web Push keys. The token makes each value UNIQUE so an
// at-rest scan for it is unambiguous — a hit would be a real plaintext leak, not a coincidence.
function endpointFor(token: string): string {
  return `https://fcm.googleapis.com/fcm/send/${token}`;
}
function keysFor(token: string): { p256dh: string; auth: string } {
  return { p256dh: `p256dh-public-key-${token}`, auth: `auth-secret-${token}` };
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

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the relation
// name when it exists and NULL when it does not — a non-throwing probe scoped to the one table
// under test (behaviour, not source text).
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
    assert.ok(
      !call.text.includes("DROP TABLE"),
      "no injected statement appears in the SQL text",
    );
  }
}

// ===========================================================================
// AC1 — registering stores a subscription (endpoint + keys DEK-encrypted) for the owner;
// listSubscriptions returns the owner's active subscriptions with the device data decrypted.
// ===========================================================================

test("registerSubscription returns a subscription with an id, the recorded device data, and the injected created-at", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const dek = freshDek();
    const endpoint = endpointFor("A1");
    const keys = keysFor("A1");

    const created = await registerSubscription(
      db,
      { userId, endpoint, keys },
      dek,
      fixedClock(T0),
    );

    assert.equal(typeof created.id, "string", "registerSubscription returns an id string");
    assert.ok(created.id.length > 0, "the returned id is non-empty");
    assert.equal(created.userId, userId, "the subscription belongs to the registering person");
    assert.equal(created.endpoint, endpoint, "the endpoint is recorded");
    assert.deepEqual(created.keys, keys, "the Web Push keys are recorded");
    assert.equal(ms(created.createdAt), ms(T0), "createdAt is the injected clock instant");
    assert.equal(created.expiresAt ?? null, null, "an omitted expiry means the subscription never expires");
  } finally {
    await db.close();
  }
});

test("registerSubscription gives each registered device a distinct id (one or more devices per person)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-ids");
    const dek = freshDek();
    const one = await registerSubscription(
      db,
      { userId, endpoint: endpointFor("dev1"), keys: keysFor("dev1") },
      dek,
      fixedClock(T0),
    );
    const two = await registerSubscription(
      db,
      { userId, endpoint: endpointFor("dev2"), keys: keysFor("dev2") },
      dek,
      fixedClock(T0),
    );
    assert.notEqual(one.id, two.id, "two registered devices have different ids");
  } finally {
    await db.close();
  }
});

test("listSubscriptions returns every active subscription for the owner with its decrypted device data", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-list");
    const dek = freshDek();
    await registerSubscription(db, { userId, endpoint: endpointFor("d1"), keys: keysFor("d1") }, dek, fixedClock(T0));
    await registerSubscription(db, { userId, endpoint: endpointFor("d2"), keys: keysFor("d2") }, dek, fixedClock(T0));
    await registerSubscription(db, { userId, endpoint: endpointFor("d3"), keys: keysFor("d3") }, dek, fixedClock(T0));

    const subs = await listSubscriptions(db, userId, dek, fixedClock(NOW));
    assert.equal(subs.length, 3, "all three of the owner's active subscriptions are listed");

    // Order is not pinned (over-constraining); compare as a map keyed by the decrypted endpoint.
    const byEndpoint = new Map(subs.map((s) => [s.endpoint, s]));
    assert.deepEqual(byEndpoint.get(endpointFor("d1"))!.keys, keysFor("d1"), "the first device's keys round-trip");
    assert.deepEqual(byEndpoint.get(endpointFor("d2"))!.keys, keysFor("d2"), "the second device's keys round-trip");
    assert.deepEqual(byEndpoint.get(endpointFor("d3"))!.keys, keysFor("d3"), "the third device's keys round-trip");
    for (const sub of subs) {
      assert.equal(sub.userId, userId, "every listed subscription belongs to the owner");
    }
  } finally {
    await db.close();
  }
});

test("listSubscriptions returns an empty array for a person with no subscriptions", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-empty");
    const subs = await listSubscriptions(db, userId, freshDek(), fixedClock(NOW));
    assert.deepEqual(subs, [], "a person with no subscriptions gets an empty list");
  } finally {
    await db.close();
  }
});

test("the endpoint and keys are stored DEK-encrypted: the plaintext never appears in a raw column", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-atrest");
    const dek = freshDek();
    const endpoint = endpointFor("LEAKCHECK9x");
    const keys = keysFor("LEAKCHECK9x");

    await registerSubscription(db, { userId, endpoint, keys }, dek, fixedClock(T0));

    // Scan every cell of the one table under test. The endpoint and both keys are personal
    // device data that MUST be encrypted (AC1), and their tokens are unique, so any raw
    // occurrence is a genuine plaintext leak. Scoped to `push_subscriptions` alone — the same
    // value may legitimately live (encrypted) elsewhere.
    const all = await db.query("SELECT * FROM push_subscriptions");
    assert.ok(all.rows.length >= 1, "the subscription row was stored");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(endpoint), "the plaintext endpoint must never be written to a column");
          assert.ok(!cell.includes(keys.p256dh), "the plaintext p256dh key must never be written to a column");
          assert.ok(!cell.includes(keys.auth), "the plaintext auth key must never be written to a column");
        }
      }
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the device data is encrypted under the INJECTED dek, not a baked-in secret:
// a different dek cannot read it back.
// ===========================================================================

test("listSubscriptions cannot decrypt the device data with a different DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5");
    const dek = freshDek();
    await registerSubscription(db, { userId, endpoint: endpointFor("K"), keys: keysFor("K") }, dek, fixedClock(T0));

    // A different DEK is the wrong key; the GCM tag must fail rather than return other bytes —
    // so reading the subscriptions under it rejects.
    const wrongDek = freshDek();
    await assert.rejects(
      async () => {
        await listSubscriptions(db, userId, wrongDek, fixedClock(NOW));
      },
      "the device data is bound to the person's own DEK, not any ambient/hardcoded key",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a removed or expired subscription is not returned by listSubscriptions.
// ===========================================================================

test("a removed subscription is not returned by listSubscriptions", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-remove");
    const dek = freshDek();
    const kept = await registerSubscription(db, { userId, endpoint: endpointFor("keep"), keys: keysFor("keep") }, dek, fixedClock(T0));
    const gone = await registerSubscription(db, { userId, endpoint: endpointFor("gone"), keys: keysFor("gone") }, dek, fixedClock(T0));

    const removed = await removeSubscription(db, { userId, id: gone.id });
    assert.equal(removed, true, "removing an owned subscription reports that one was removed");

    const subs = await listSubscriptions(db, userId, dek, fixedClock(NOW));
    assert.equal(subs.length, 1, "only the surviving subscription remains in the active listing");
    assert.equal(subs[0]!.id, kept.id, "the surviving subscription is the one that was not removed");
    assert.ok(!subs.some((s) => s.id === gone.id), "the removed subscription is never listed");
  } finally {
    await db.close();
  }
});

test("removeSubscription returns false (changes nothing) when no owned subscription matches the id", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-idempotent");
    const dek = freshDek();
    await registerSubscription(db, { userId, endpoint: endpointFor("live"), keys: keysFor("live") }, dek, fixedClock(T0));

    const removed = await removeSubscription(db, { userId, id: "99999999-9999-9999-9999-999999999999" });
    assert.equal(removed, false, "removing an unknown subscription id removes nothing");

    const subs = await listSubscriptions(db, userId, dek, fixedClock(NOW));
    assert.equal(subs.length, 1, "the person's real subscription is untouched");
  } finally {
    await db.close();
  }
});

test("an expired subscription is not returned, while a future-expiry or never-expiring one is", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-expiry");
    const dek = freshDek();

    // Registered at T0; its expirationTime is already in the past relative to NOW.
    await registerSubscription(
      db,
      { userId, endpoint: endpointFor("expired"), keys: keysFor("expired"), expiresAt: PAST_EXPIRY },
      dek,
      fixedClock(T0),
    );
    // Expires in the future relative to NOW — still active.
    const future = await registerSubscription(
      db,
      { userId, endpoint: endpointFor("future"), keys: keysFor("future"), expiresAt: FUTURE_EXPIRY },
      dek,
      fixedClock(T0),
    );
    // No expiry — active until removed.
    const forever = await registerSubscription(
      db,
      { userId, endpoint: endpointFor("forever"), keys: keysFor("forever") },
      dek,
      fixedClock(T0),
    );

    const subs = await listSubscriptions(db, userId, dek, fixedClock(NOW));
    const ids = new Set(subs.map((s) => s.id));
    assert.equal(subs.length, 2, "the expired subscription drops out; the two active ones remain");
    assert.ok(ids.has(future.id), "a subscription that expires in the future is still active");
    assert.ok(ids.has(forever.id), "a subscription with no expiry is active");
    assert.ok(!subs.some((s) => s.endpoint === endpointFor("expired")), "the expired subscription is never listed");

    // The future expirationTime is persisted and handed back on the active one.
    const futureListed = subs.find((s) => s.id === future.id)!;
    assert.equal(ms(futureListed.expiresAt as Date | string), ms(FUTURE_EXPIRY), "the stored expiry round-trips");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: a second signed-in person can never read or remove another's subscription.
// The user id is bound from the session, never the client.
// ===========================================================================

test("listSubscriptions never returns another person's subscriptions", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-alice");
    const bob = await makeUser(db, "owner-bob");
    const dek = freshDek();
    await registerSubscription(db, { userId: alice, endpoint: endpointFor("alice1"), keys: keysFor("alice1") }, dek, fixedClock(T0));
    await registerSubscription(db, { userId: alice, endpoint: endpointFor("alice2"), keys: keysFor("alice2") }, dek, fixedClock(T0));
    await registerSubscription(db, { userId: bob, endpoint: endpointFor("bob1"), keys: keysFor("bob1") }, dek, fixedClock(T0));

    const aliceSubs = await listSubscriptions(db, alice, dek, fixedClock(NOW));
    assert.equal(aliceSubs.length, 2, "Alice sees exactly her own two subscriptions");
    assert.ok(aliceSubs.every((s) => s.userId === alice), "every subscription in Alice's list is hers");
    assert.ok(!aliceSubs.some((s) => s.endpoint === endpointFor("bob1")), "Bob's device never appears in Alice's list");

    const bobSubs = await listSubscriptions(db, bob, dek, fixedClock(NOW));
    assert.equal(bobSubs.length, 1, "Bob sees exactly his own subscription");
    assert.equal(bobSubs[0]!.endpoint, endpointFor("bob1"), "Bob sees his own device");
  } finally {
    await db.close();
  }
});

test("removeSubscription cannot remove another user's subscription, and leaves it listed", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "rm-alice");
    const bob = await makeUser(db, "rm-bob");
    const dek = freshDek();
    const alices = await registerSubscription(db, { userId: alice, endpoint: endpointFor("alice-dev"), keys: keysFor("alice-dev") }, dek, fixedClock(T0));

    // Bob tries to remove Alice's subscription by its id: member-scoped, so there is no such
    // subscription FOR BOB — removeSubscription must remove nothing and report false.
    const removed = await removeSubscription(db, { userId: bob, id: alices.id });
    assert.equal(removed, false, "Bob cannot remove a subscription that is not his");

    const stillAlices = await listSubscriptions(db, alice, dek, fixedClock(NOW));
    assert.equal(stillAlices.length, 1, "Alice's subscription is untouched by Bob's attempt");
    assert.equal(stillAlices[0]!.id, alices.id, "and it is still her same subscription");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("registerSubscription binds the member-scope user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE push_subscriptions; --";

  // The recording db returns no rows; registerSubscription assembles its result from the inputs
  // (like createHeldRequest), so it does not throw on a no-row read — the binding is asserted
  // below regardless. The endpoint + keys are encrypted before binding, so the member-scope
  // user id is the plaintext-bound value this test proves travels as a parameter.
  try {
    await registerSubscription(
      db,
      { userId: probe, endpoint: endpointFor("bind"), keys: keysFor("bind") },
      freshDek(),
      fixedClock(T0),
    );
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }

  assertBoundNotSpliced(db, probe);
});

test("listSubscriptions binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "p'); DROP TABLE push_subscriptions; --";

  const result = await listSubscriptions(db, probe, freshDek(), fixedClock(NOW));
  assert.deepEqual(result, [], "the recording db returns no rows, so the list is empty");

  assertBoundNotSpliced(db, probe);
});

test("removeSubscription binds the id and user id as parameters, never splicing SQL", async () => {
  const db = recordingDb();
  const probe = "x'); DROP TABLE push_subscriptions; --";

  // No row comes back, so removeSubscription matches nothing and reports false — but the
  // statement it issued must have BOUND the probe, not spliced it.
  const removed = await removeSubscription(db, { userId: probe, id: probe });
  assert.equal(removed, false, "nothing is removed when the recording db matches no row");

  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe in the endpoint is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const dek = freshDek();
    const probe = "https://fcm.example/send/grace'); DROP TABLE push_subscriptions; --";

    const created = await registerSubscription(
      db,
      { userId, endpoint: probe, keys: keysFor("inject") },
      dek,
      fixedClock(T0),
    );

    assert.equal(
      await tableExists(db, "push_subscriptions"),
      true,
      "the push_subscriptions table must still exist (the probe was stored as data, not run as SQL)",
    );

    const subs = await listSubscriptions(db, userId, dek, fixedClock(NOW));
    assert.equal(subs.length, 1, "the subscription is read back");
    assert.equal(subs[0]!.id, created.id, "the same subscription is returned");
    assert.equal(subs[0]!.endpoint, probe, "the probe round-trips verbatim as data");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input and binds probes.
//
// A route handler validates external input HERE (`parseBody`), then calls this task's
// parameterized data-access with the SESSION's user id (NEVER a body value). A rejected input
// maps to a 4xx Response and never reaches a query. This handler is a test fixture that
// EXERCISES the modules — it is not an implementation file.
// ===========================================================================

function registerSubscriptionHandler(
  db: Db,
  dek: Uint8Array,
  clock: Clock,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries the device's endpoint and Web Push keys; the user id comes from the
  // session, never the body. Lengths are capped so an absurd value is rejected, but generous
  // enough that a probe can still REACH the query to prove it is bound.
  const schema = z.object({
    endpoint: z.string().min(1).max(2048),
    keys: z.object({
      p256dh: z.string().min(1).max(512),
      auth: z.string().min(1).max(512),
    }),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const created = await registerSubscription(
        db,
        { userId: sessionUserId, endpoint: body.endpoint, keys: body.keys },
        dek,
        clock,
      );
      return new Response(JSON.stringify({ id: created.id }), { status: 201 });
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
  return new Request("https://warthog.com.au/api/push-subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = registerSubscriptionHandler(db, freshDek(), fixedClock(T0), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = registerSubscriptionHandler(db, freshDek(), fixedClock(T0), "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest(JSON.stringify({ endpoint: endpointFor("big"), keys: { p256dh: "a".repeat(10 * 1024), auth: "b" } })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = registerSubscriptionHandler(db, freshDek(), fixedClock(T0), "session-user");

  // No keys — a subscription must carry its Web Push keys.
  const res = await handler(jsonRequest(JSON.stringify({ endpoint: endpointFor("nokeys") })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = registerSubscriptionHandler(db, freshDek(), fixedClock(T0), "session-user");

  // keys must be an object of strings — a string there is a schema violation, rejected before any query.
  const res = await handler(jsonRequest(JSON.stringify({ endpoint: endpointFor("bad"), keys: "not-an-object" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler accepts a well-formed body and registers the subscription for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const handler = registerSubscriptionHandler(db, dek, fixedClock(T0), userId);

    const res = await handler(
      jsonRequest(JSON.stringify({ endpoint: endpointFor("ok"), keys: keysFor("ok") })),
    );

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };

    const subs = await listSubscriptions(db, userId, dek, fixedClock(NOW));
    assert.equal(subs.length, 1, "a valid body is persisted for the session user");
    assert.equal(subs[0]!.id, id, "the stored subscription matches the returned id");
    assert.equal(subs[0]!.endpoint, endpointFor("ok"), "with the submitted endpoint");
    assert.deepEqual(subs[0]!.keys, keysFor("ok"), "and the submitted keys");
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
    const handler = registerSubscriptionHandler(db, dek, fixedClock(T0), sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(
      jsonRequest(JSON.stringify({ userId: attacker, endpoint: endpointFor("smuggle"), keys: keysFor("smuggle") })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal(
      (await listSubscriptions(db, sessionUser, dek, fixedClock(NOW))).length,
      1,
      "the subscription is recorded under the SESSION user",
    );
    assert.deepEqual(
      await listSubscriptions(db, attacker, dek, fixedClock(NOW)),
      [],
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe endpoint is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const dek = freshDek();
    const handler = registerSubscriptionHandler(db, dek, fixedClock(T0), userId);
    const probe = "https://fcm.example/send/grace'); DROP TABLE push_subscriptions; --";

    const res = await handler(jsonRequest(JSON.stringify({ endpoint: probe, keys: keysFor("probe") })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "push_subscriptions"), true, "the push_subscriptions table must still exist");

    const subs = await listSubscriptions(db, userId, dek, fixedClock(NOW));
    assert.equal(subs.length, 1, "the subscription was stored");
    assert.equal(subs[0]!.endpoint, probe, "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the repo reads no process.env and holds no secret (INV-103). Enforced by
// construction; shown behaviourally: a decoy secret in the environment never lands in the
// stored or returned subscription, and the repo reads/writes from the injected db + DEK alone.
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in the subscription", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-env");
    const dek = freshDek();
    const created = await registerSubscription(
      db,
      { userId, endpoint: endpointFor("env"), keys: keysFor("env") },
      dek,
      fixedClock(T0),
    );

    const subs = await listSubscriptions(db, userId, dek, fixedClock(NOW));
    assert.equal(subs.length, 1, "the subscription reads and writes purely from the injected db + DEK — no app env needed");
    assert.ok(
      !JSON.stringify(created).includes(DECOY) && !JSON.stringify(subs).includes(DECOY),
      "no ambient env value is folded into the stored or returned subscription",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the same
    // value could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM push_subscriptions");
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

test("the push_subscriptions migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "push_subscriptions"),
      true,
      "the push_subscriptions table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0025_push_subscriptions"),
      "db/migrations/0025_push_subscriptions.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw — re-executing
    // 0025's CREATE would throw "already exists", so an empty result AND no throw together prove
    // the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
