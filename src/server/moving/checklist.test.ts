// E14-S06 — Moving checklist builder (`src/server/moving/checklist.ts`).
//
// RED-first: the builder module does not exist yet, so importing `./checklist` throws
// (ERR_MODULE_NOT_FOUND) and every test here fails until the builder writes it. That absence IS the
// point of test-first — do NOT implement anything to make these pass. The builder writes
// `checklist.ts` afterwards to satisfy exactly this contract.
//
// These tests pin BEHAVIOUR (what the build DOES: which checklist items it seeds for a move, that it
// leaves the person's own additions alone, that a second build changes nothing, that no move means
// no items, that it reads and seeds only for the session user, what a handler on the validation
// boundary rejects, and that no ambient env value leaks) against an isolated in-memory PGlite with
// the REAL migrations (`../../test/db`) and the REAL already-built seams it composes — the identity
// store (`saveIdentityField`), the connection store (`createConnection`), the life-admin store
// (`createRecord`) and the moving-checklist store (`addOwnItem` / `listForUser` / `toggleDone`). No
// test asserts on the SOURCE TEXT of any module, so a later behaviour-preserving refactor (a rename,
// a moved import, a different internal label derivation) stays green.
//
// WHY this exists (task E14-S06; brief §"Moving-house helper"): when the owner's postal address
// carries a moving-on date, Warthog turns that date into a concrete checklist of places that hold
// the OLD address — one item per connected SERVICE and per SUBSCRIPTION / RENEWAL record already on
// file — so the person and their agents can work through the move. The build reuses the
// moving-address domain (`src/domain/address/moving`) and the identity store to decide there is a
// move, then seeds through the idempotent moving-checklist store, leaving the person's own additions
// intact. It is idempotent: a second build over unchanged connections and records changes nothing.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface BuildMovingChecklistDeps {   // every seam injected — no process.env, no secret (INV-103)
//     db: Db;                               // the one db handle every read/write runs through
//     clock: Clock;                         // supplies `now` for the moving-address resolution (never SQL now())
//     dek: Uint8Array;                      // the session person's already-unwrapped data key
//   }
//
//   buildMovingChecklist(deps, session: Session): Promise<{ ok: true } | ...>
//     • Reads the SESSION person's postal addresses from the identity store (member-scoped by
//       session.userId). If a postal address carries a moving-on date, it resolves the current /
//       upcoming address (reusing the moving-address domain) and SEEDS one checklist item per
//       connected service (sourceKind "connection") and per SUBSCRIPTION ("subscription") and
//       RENEWAL ("renewal") record on file — a receipt/warranty record is NOT a place that holds the
//       address, so it is NOT seeded.
//     • Seeding goes through the idempotent moving-checklist store (ON CONFLICT DO NOTHING on
//       (user, source kind, source reference)), so it NEVER touches the person's own ("own")
//       additions and NEVER resets an item already ticked off. A second build over unchanged
//       connections and records changes nothing.
//     • With NO moving-on date set (or no postal address at all), NO checklist items are created.
//     • Member-scoped: every read and seed is filtered by session.userId — never a client value — so
//       one person's build never reads or seeds under another person.
//     • Reports success as `{ ok: true }` (fields beyond `ok` are the builder's; the tests assert
//       behaviour via the checklist the store hands back, not the result shape).
//
// Acceptance criteria → tests:
//   AC1 "With a postal address that has a moving-on date, building the checklist seeds one item per
//        connected service and per subscription/renewal record on file and leaves the person's own
//        additions intact." — a move + 2 connections + 1 subscription + 1 renewal (+ 1 receipt that
//        must NOT seed) + 1 own addition → after the build the checklist has exactly those 2 + 1 + 1
//        seeded items plus the untouched own addition.
//   AC2 "A second build over unchanged connections and records changes nothing (idempotent), and
//        with no moving-on date set no checklist items are created." — building twice leaves the
//        count and a ticked-off item unchanged; a postal address with no moving-on date (and even a
//        person with no postal address at all) seeds nothing.
//   AC3 "The builder reads and seeds only for the session user (filtered by session user id)." —
//        building under Alice's session seeds only Alice's sources and never Bob's, and leaves Bob's
//        checklist empty until Bob's own build runs.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the `../http/validate`
//        boundary rejects malformed / oversized input with a 4xx before any query runs and takes the
//        owner from the SESSION (never the body); the member-scope reads bind the user id as a
//        parameter (never spliced); a SQL-injection probe carried in a connection's account label is
//        seeded as DATA — the tables survive and the item still seeds. The handler below is a test
//        fixture (the intended usage), not an implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — enforced by construction: the builder takes `db`,
//        `clock` and `dek` as injected dependencies, holds no key and reads no `process.env`. Shown
//        behaviourally: a decoy secret planted in the environment never lands in the result or in a
//        seeded / stored checklist item.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db test
// uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so tests share
// no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import { buildMovingChecklist } from "./checklist";

import { saveIdentityField } from "../db/identity-fields";
import { createConnection } from "../db/connections";
import { createRecord } from "../db/life-admin-records";
import { addOwnItem, listForUser, toggleDone } from "../db/moving-checklist";
import { createUser } from "../db/users";
import { parseBody, HttpError } from "../http/validate";
import { fixedClock, type Clock } from "../seams/clock";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import type { Session } from "../auth/session";

// --- fixtures ---------------------------------------------------------------------

// A frozen "now" for the moving-address resolution. The move date below is AFTER this instant, so
// the move is unambiguously still ahead (now < movingDate) in every positive case.
const NOW = new Date("2026-11-07T00:00:00.000Z");

// The owner's moving-on date, a bare calendar date stored on the postal address — comfortably after
// NOW, so the resolution sees an upcoming move rather than one already completed.
const MOVE_DATE = "2027-03-01";

const DEK_BYTES = 32; // a 256-bit per-person data key

// A fresh random 256-bit DEK (the real one is unwrapped from the KeyWrapper seam a layer up).
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A plain signed-in session for `userId` — the member scope is session.userId; the rest is
// irrelevant to the build. Stepped-up state is left null.
function sessionFor(userId: string): Session {
  return {
    id: `sess-${userId}`,
    userId,
    createdAt: new Date(NOW.getTime() - 60_000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    steppedUpAt: null,
  };
}

// The injected deps for a single session person: the db, a frozen clock, and that person's DEK.
function buildDeps(db: Db, dek: Uint8Array) {
  return { db, clock: fixedClock(NOW), dek };
}

// Create a real person (every member-scoped row — and the moving_checklist FK to users(id) — hangs
// off this id) and return their id. Distinct email per call so two users never collide.
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return user.id;
}

// Save a postal address (the value is personal content, stored DEK-encrypted; the moving-on date is
// plaintext metadata). A JSON value is used so the builder may treat it as a structured address or a
// verbatim string — either way the resolution never inspects it.
async function savePostalAddress(
  db: Db,
  userId: string,
  dek: Uint8Array,
  address: Record<string, unknown>,
  movingOn: string | null,
): Promise<void> {
  await saveIdentityField(
    db,
    { userId, kind: "postal_address", value: JSON.stringify(address), movingOn },
    dek,
  );
}

// Set up a move for `userId`: the CURRENT postal address (no moving-on date) and an UPCOMING one that
// carries the moving-on date — the exact "a new address with a moving date" the brief describes.
async function setUpMove(db: Db, userId: string, dek: Uint8Array): Promise<void> {
  await savePostalAddress(db, userId, dek, { line1: "12 Old St", suburb: "Oldtown" }, null);
  await savePostalAddress(db, userId, dek, { line1: "99 New Rd", suburb: "Newville" }, MOVE_DATE);
}

// Connect a service for `userId` (a place that holds the address).
async function connect(
  db: Db,
  userId: string,
  dek: Uint8Array,
  connectorId: string,
  accountLabel: string,
) {
  return createConnection(
    db,
    { userId, connectorId, accountLabel, credentials: { token: "t" } },
    dek,
    fixedClock(NOW),
  );
}

// A subscription record on file (a place that holds the address — seeded as "subscription").
async function subscriptionRecord(db: Db, userId: string, dek: Uint8Array, name: string) {
  return createRecord(
    db,
    { userId, kind: "subscription", fields: { name }, status: "active", source: { kind: "person" } },
    dek,
  );
}

// A renewal/appointment record on file (a place that holds the address — seeded as "renewal").
async function renewalRecord(db: Db, userId: string, dek: Uint8Array, name: string) {
  return createRecord(
    db,
    {
      userId,
      kind: "renewal_appointment",
      fields: { name },
      status: "scheduled",
      source: { kind: "person" },
    },
    dek,
  );
}

// A receipt/warranty record on file — NOT a place that holds the address, so the build must NOT seed it.
async function receiptRecord(db: Db, userId: string, dek: Uint8Array, name: string) {
  return createRecord(
    db,
    {
      userId,
      kind: "receipt_warranty",
      fields: { name },
      status: "kept",
      source: { kind: "person" },
    },
    dek,
  );
}

// A structural view of a returned checklist item, so the helpers below do not depend on the (absent)
// store module's exported types at the point they run.
interface ItemLike {
  readonly id: string;
  readonly userId: string;
  readonly label: string;
  readonly sourceKind: string;
  readonly sourceReference: string;
  readonly done: boolean;
  readonly linkedTaskId: string | null;
}

// Count the listed items by their source kind.
function countByKind(items: ItemLike[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const i of items) counts[i.sourceKind] = (counts[i.sourceKind] ?? 0) + 1;
  return counts;
}

// Find the one listed item carrying this exact decrypted label (list order is not pinned).
function itemByLabel(items: ItemLike[], label: string): ItemLike | undefined {
  return items.find((i) => i.label === label);
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the relation name
// when it exists and NULL when it does not — a non-throwing probe scoped to the one table under test
// (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// A db seam stand-in that records every call instead of running it, so a test can prove WHAT reached
// the query layer and HOW (bound value vs. spliced text). It returns no rows and satisfies the `Db`
// shape structurally (query + close).
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

// Assert a value reached the query layer as a BOUND value and never as spliced SQL text, scoped to
// each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the value travels as a bound parameter");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the value is bound, never concatenated into the SQL");
  }
}

// ===========================================================================
// AC1 — a move seeds one item per connection and per subscription/renewal record; a receipt/warranty
// is not seeded; the person's own addition is left intact.
// ===========================================================================

test("building a move's checklist seeds one item per connection and per subscription/renewal, leaving own additions intact", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const dek = freshDek();

    await setUpMove(db, userId, dek);
    await connect(db, userId, dek, "gmail", "oren@gmail.com");
    await connect(db, userId, dek, "dropbox", "oren-dropbox");
    await subscriptionRecord(db, userId, dek, "Netflix");
    await renewalRecord(db, userId, dek, "Car registration");
    // A receipt/warranty is NOT a place that holds the address — the build must leave it out.
    await receiptRecord(db, userId, dek, "TV warranty");
    // The person's own addition, made before the build; it must survive untouched.
    const own = await addOwnItem(db, { userId, label: "Tell my book club" }, dek);

    await buildMovingChecklist(buildDeps(db, dek), sessionFor(userId));

    const items = (await listForUser(db, userId, dek)) as ItemLike[];
    const counts = countByKind(items);
    assert.equal(counts.connection, 2, "one checklist item per connected service");
    assert.equal(counts.subscription, 1, "one checklist item per subscription record");
    assert.equal(counts.renewal, 1, "one checklist item per renewal record");
    assert.equal(counts.own, 1, "the person's own addition is still there");
    assert.equal(items.length, 5, "exactly the two connections + one subscription + one renewal + one own item");

    // The receipt/warranty produced no item (no 'receipt'-flavoured source kind appears).
    assert.ok(
      !items.some((i) => i.sourceKind === "receipt_warranty" || i.sourceKind === "receipt"),
      "a receipt/warranty record is not seeded onto the checklist",
    );

    // Every item is the owner's, starts not done, and carries a non-empty label.
    for (const i of items) {
      assert.equal(i.userId, userId, "every item belongs to the session owner");
      assert.equal(i.done, false, "a freshly built item starts not done");
      assert.ok(typeof i.label === "string" && i.label.length > 0, "each item has a non-empty label");
    }

    // The own addition is the SAME row — not duplicated, not replaced by the build.
    const ownAfter = itemByLabel(items, "Tell my book club");
    assert.ok(ownAfter, "the own addition is still on the checklist");
    assert.equal(ownAfter!.id, own.id, "it is the same own item, untouched by the build");
    assert.equal(ownAfter!.sourceKind, "own", "and still an 'own' item");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a second build over unchanged connections and records changes nothing (idempotent); no
// moving-on date means no items are created.
// ===========================================================================

test("a second build over unchanged connections and records changes nothing (idempotent)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-idempotent");
    const dek = freshDek();

    await setUpMove(db, userId, dek);
    await connect(db, userId, dek, "gmail", "oren@gmail.com");
    await connect(db, userId, dek, "dropbox", "oren-dropbox");
    await subscriptionRecord(db, userId, dek, "Netflix");
    await renewalRecord(db, userId, dek, "Car registration");

    await buildMovingChecklist(buildDeps(db, dek), sessionFor(userId));
    const first = (await listForUser(db, userId, dek)) as ItemLike[];
    assert.equal(first.length, 4, "the first build seeds four items");

    // The person ticks one seeded item off — a re-build must NOT reset it.
    const target = first.find((i) => i.sourceKind === "connection")!;
    assert.equal(await toggleDone(db, { userId, id: target.id }), true, "the owner ticks an item off");

    await buildMovingChecklist(buildDeps(db, dek), sessionFor(userId));
    const second = (await listForUser(db, userId, dek)) as ItemLike[];

    assert.equal(second.length, 4, "a second build over the same sources adds nothing");
    assert.deepEqual(countByKind(second), countByKind(first), "the per-kind counts are unchanged");
    assert.equal(
      second.find((i) => i.id === target.id)!.done,
      true,
      "the ticked-off item keeps its done flag through the re-build",
    );
  } finally {
    await db.close();
  }
});

test("with no moving-on date set, building creates no checklist items", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-nomove");
    const dek = freshDek();

    // A postal address but NO moving-on date — plus connections and records that WOULD be seeded if a
    // move were in progress.
    await savePostalAddress(db, userId, dek, { line1: "7 Settled Ave" }, null);
    await connect(db, userId, dek, "gmail", "oren@gmail.com");
    await subscriptionRecord(db, userId, dek, "Netflix");
    await renewalRecord(db, userId, dek, "Car registration");

    await buildMovingChecklist(buildDeps(db, dek), sessionFor(userId));

    assert.deepEqual(
      await listForUser(db, userId, dek),
      [],
      "no moving-on date means the build seeds nothing",
    );
  } finally {
    await db.close();
  }
});

test("with no postal address at all, building creates no checklist items", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-noaddress");
    const dek = freshDek();

    await connect(db, userId, dek, "gmail", "oren@gmail.com");
    await subscriptionRecord(db, userId, dek, "Netflix");

    await buildMovingChecklist(buildDeps(db, dek), sessionFor(userId));

    assert.deepEqual(
      await listForUser(db, userId, dek),
      [],
      "no postal address means there is no move, so nothing is seeded",
    );
  } finally {
    await db.close();
  }
});

test("building a move's checklist reports success", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-ok");
    const dek = freshDek();
    await setUpMove(db, userId, dek);
    await connect(db, userId, dek, "gmail", "oren@gmail.com");

    const result = await buildMovingChecklist(buildDeps(db, dek), sessionFor(userId));
    assert.equal(result.ok, true, "the build reports success");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — the builder reads and seeds only for the session user (member-scoped by session.userId).
// ===========================================================================

test("building reads and seeds only for the session user — another person's sources are never touched", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-alice");
    const bob = await makeUser(db, "owner-bob");
    const dekA = freshDek();
    const dekB = freshDek();

    // Both have a move and sources on file.
    await setUpMove(db, alice, dekA);
    await connect(db, alice, dekA, "gmail", "alice@gmail.com");
    await subscriptionRecord(db, alice, dekA, "Alice's Netflix");

    await setUpMove(db, bob, dekB);
    await connect(db, bob, dekB, "dropbox", "bob-dropbox");
    await subscriptionRecord(db, bob, dekB, "Bob's Spotify");

    // Build ONLY Alice's checklist.
    await buildMovingChecklist(buildDeps(db, dekA), sessionFor(alice));

    const aliceItems = (await listForUser(db, alice, dekA)) as ItemLike[];
    assert.equal(aliceItems.length, 2, "Alice gets exactly her own connection + subscription");
    assert.ok(aliceItems.every((i) => i.userId === alice), "every seeded item belongs to Alice");
    assert.ok(!itemByLabel(aliceItems, "Bob's Spotify"), "Bob's source never lands on Alice's checklist");

    // Bob's checklist is still empty — his build has not run.
    assert.deepEqual(
      await listForUser(db, bob, dekB),
      [],
      "building Alice's checklist seeds nothing for Bob",
    );

    // And when Bob builds, he gets only his own sources.
    await buildMovingChecklist(buildDeps(db, dekB), sessionFor(bob));
    const bobItems = (await listForUser(db, bob, dekB)) as ItemLike[];
    assert.equal(bobItems.length, 2, "Bob gets exactly his own connection + subscription");
    assert.ok(bobItems.every((i) => i.userId === bob), "every seeded item belongs to Bob");
    assert.ok(!itemByLabel(bobItems, "Alice's Netflix"), "Alice's source never lands on Bob's checklist");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input, takes the owner from the SESSION, and
// every value reaches the query layer bound as a parameter (no spliced SQL).
//
// A route handler validates external input HERE (`parseBody`), then calls the builder with the
// SESSION (never a body value). A rejected input maps to a 4xx Response and never reaches a query.
// The build needs no body data — the owner and the move both come from the session person's stored
// state — so the schema accepts (and ignores) an object body. This handler is a test fixture that
// EXERCISES the modules; it is not an implementation file.
// ===========================================================================

function buildChecklistHandler(
  deps: { db: Db; clock: Clock; dek: Uint8Array },
  session: Session,
): (req: Request) => Promise<Response> {
  // No body fields are consumed; the owner is the session, never the body. The size cap is generous
  // enough for a normal request yet rejects an absurd body before it is parsed.
  const schema = z.object({});
  return async (req: Request): Promise<Response> => {
    try {
      await parseBody(schema, req, { maxBytes: 8 * 1024 });
      const result = await buildMovingChecklist(deps, session);
      return new Response(JSON.stringify(result), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test sees the
      // raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/moving-checklist/build", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = buildChecklistHandler(buildDeps(db, freshDek()), sessionFor("session-user"));

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = buildChecklistHandler(buildDeps(db, freshDek()), sessionFor("session-user"));

  // ~20 KiB body, well over the handler's 8 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ pad: "a".repeat(20 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler takes the owner from the session, not the body (no cross-user build)", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const dek = freshDek();
    await setUpMove(db, sessionUser, dek);
    await connect(db, sessionUser, dek, "gmail", "oren@gmail.com");

    const handler = buildChecklistHandler(buildDeps(db, dek), sessionFor(sessionUser));

    // The body smuggles another person's userId; the handler must ignore it and use the session's.
    const res = await handler(jsonRequest(JSON.stringify({ userId: attacker })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal(
      ((await listForUser(db, sessionUser, dek)) as ItemLike[]).length,
      1,
      "the checklist is built for the SESSION user",
    );
    assert.deepEqual(
      await listForUser(db, attacker, dek),
      [],
      "and never for the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("the build binds the session user id as a parameter, never woven into the SQL text", async () => {
  // A recording db returns no rows, so the build finds no move and seeds nothing — but its
  // member-scope read(s) still issue `WHERE user_id = $1`, binding the session user id. A uuid-shaped
  // id (what a real session carries) so no boundary shape-guard could reject it before the query.
  const db = recordingDb();
  const sessionUserId = randomUUID();

  try {
    await buildMovingChecklist(buildDeps(db, freshDek()), sessionFor(sessionUserId));
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }

  assertBoundNotSpliced(db, sessionUserId);
});

test("a SQL-injection probe in a connection's account label is seeded as data: the tables survive", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "sqli");
    const dek = freshDek();
    const probe = "Gmail'); DROP TABLE moving_checklist; --";

    await setUpMove(db, userId, dek);
    // The account label is user-influenced input that the build reads and seeds as a checklist label.
    await connect(db, userId, dek, "gmail", probe);
    await subscriptionRecord(db, userId, dek, "Netflix");

    await buildMovingChecklist(buildDeps(db, dek), sessionFor(userId));

    // The probe altered no query — every table it named is still here.
    assert.equal(await tableExists(db, "moving_checklist"), true, "the moving_checklist table survives the probe");
    assert.equal(await tableExists(db, "connections"), true, "the connections table survives the probe");
    assert.equal(await tableExists(db, "identity_fields"), true, "the identity_fields table survives the probe");
    assert.equal(await tableExists(db, "life_admin_records"), true, "the life_admin_records table survives the probe");

    // ...and the probe connection seeded exactly one item as DATA, alongside the subscription.
    const counts = countByKind((await listForUser(db, userId, dek)) as ItemLike[]);
    assert.equal(counts.connection, 1, "the SQLi-labelled connection was seeded (stored as data, not run)");
    assert.equal(counts.subscription, 1, "the subscription was seeded too");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the build is a pure function of its injected seams (INV-103): a decoy secret in the
// environment never lands in the result or in a seeded / stored checklist item.
// ===========================================================================

test("the build reads no process.env: a decoy secret in the environment never lands in a result or item", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "decoy");
    const dek = freshDek();
    await setUpMove(db, userId, dek);
    await connect(db, userId, dek, "gmail", "oren@gmail.com");
    await subscriptionRecord(db, userId, dek, "Netflix");

    const result = await buildMovingChecklist(buildDeps(db, dek), sessionFor(userId));
    assert.ok(
      !JSON.stringify(result).includes(DECOY),
      "no ambient env value is folded into the build result",
    );

    const items = (await listForUser(db, userId, dek)) as ItemLike[];
    assert.equal(items.length, 2, "the build runs purely from the injected db / clock / dek — no app env needed");
    assert.ok(
      !JSON.stringify(items).includes(DECOY),
      "no ambient env value is folded into a seeded item",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the same value
    // could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM moving_checklist");
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

test("typed records whose provider keeps the address join the checklist; the things themselves don't", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "typed-move");
    const dek = freshDek();
    await setUpMove(db, userId, dek);
    const typed = (type: string, fields: Record<string, unknown>) =>
      createRecord(db, { userId, kind: "item", type, fields, status: "active", source: { kind: "person" } }, dek);
    await typed("vehicle.vehicle", { name: "Honda CB500X", plate: "BX12AB" });
    await typed("vehicle.registration", { plate: "BX12AB" });
    await typed("health.insurance", { provider: "Bupa" });
    await typed("money.super", { provider: "AustralianSuper" });
    await typed("id.passport", { country: "Australia" });

    await buildMovingChecklist(buildDeps(db, dek), sessionFor(userId));

    const labels = ((await listForUser(db, userId, dek)) as ItemLike[]).map((item) => item.label).sort();
    assert.equal(labels.length, 3, "rego, health insurance and super; not the bike itself or the passport");
    assert.ok(labels.some((label) => label.includes("Registration · BX12AB")));
    assert.ok(labels.some((label) => label.includes("Bupa")));
    assert.ok(labels.some((label) => label.includes("AustralianSuper")));
  } finally {
    await db.close();
  }
});
