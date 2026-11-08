// E16-S08 — Account-deletion service (`src/server/account/delete.ts`).
//
// RED-first: the account-deletion module does not exist yet, so importing
// `./delete` throws and every test here fails until the builder writes it. That
// absence IS the point of test-first; do NOT implement anything to make these pass
// — the builder writes the module afterwards, with the minimum code that turns
// these green.
//
// These tests pin BEHAVIOUR (what the service RETURNS, what is stored, what is
// revoked, what is enqueued and what is sent), never the source text of the module
// — a later rename that preserves behaviour must not redden them. There is no
// browser, no Azure and no network: the cross-aggregate agent/connection revocation
// is observed through an injected spy (exactly as account-reset observes its own
// erase/revoke through a `ResetExecutor` spy — see src/server/auth/account-reset.ts),
// the confirmation email is recorded in the dev/test outbox (notify), the purge
// queue and the crypto-shred are checked against an isolated in-memory PGlite with
// the real migrations (src/test/db), and household ownership is set up through the
// real household store.
//
// WHY this exists (task E16-S08; brief §"Australian Privacy Act and GDPR-style
// rights"; design §4.1 "Account deletion = crypto-shredding: deleting the wrapped
// DEK makes everything unreadable before the confirmation is shown; a job deletes
// the rows within 24 hours"). A person deletes their own account: FIRST any
// household they OWN must be transferred or closed, then — in one unit, before the
// service returns success — their wrapped DEK is crypto-shredded (so DEK-encrypted
// content can no longer be decrypted), every agent and service connection is
// revoked (so an agent's next request is refused), the account is enqueued for the
// 24-hour purge, and a confirmation email is sent.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // The cross-aggregate revocation a deletion performs, injected because the
//   // agent / connection / credential stores live in other aggregates. The account
//   // module owns the deletion unit and calls this seam to cut every agent off; the
//   // app wires the real revoker at the composition root (the dev path is the prod
//   // path with the real stores behind the same seam).
//   interface DeletionExecutor {
//     revokeAgentsAndConnections(userId: string): Promise<void>;
//   }
//
//   // Every seam injected — no process.env, no secret (INV-103). The confirmation
//   // email goes through `senders.email`.
//   deps: { db: Db; revoker: DeletionExecutor; senders: Senders }
//
//   deleteAccount(deps, session: { userId: string }):
//       Promise<{ ok: true } | { ok: false; reason: string }>
//     • acts ONLY on session.userId — the account id is never taken from a caller /
//       body value, so one person can never delete another's account.
//     • if the person still OWNS a household (households.owner_id = session.userId)
//       it refuses with { ok: false, reason } (a plain reason) and changes NOTHING:
//       the wrapped DEK is intact, nothing is enqueued, no email is sent and the
//       revoker is NOT called — until ownership is transferred or the household is
//       closed.
//     • otherwise, before returning { ok: true }, in one unit it:
//       – crypto-shreds the person's wrapped DEK (the original wrapped DEK is gone —
//         the users row itself PERSISTS, to be removed by the purge job within 24h);
//       – calls revoker.revokeAgentsAndConnections(session.userId) once;
//       – enqueues the account for purge (account_purge_queue — the E16-S07 store);
//       – sends a confirmation email to the person (senders.email).
//
// Acceptance criteria → tests:
//   AC1 "the account's wrapped DEK is gone" — after a deletion the stored wrapped
//        DEK is no longer the original (its content can no longer be decrypted) and
//        the users row persists until the purge job runs.
//   AC2 "every agent and service connection is revoked" — a deletion calls the
//        revoker once for exactly that person (the seam the app wires to the real
//        revocation, so an agent's next request is refused).
//   AC3 "enqueued for purge and a confirmation email sent, both before success" —
//        after a successful deletion the account is on the pending purge queue and a
//        confirmation email addressed to the person is in the outbox.
//   AC4 "refused while the person still owns a household" — an owner is refused with
//        a plain reason and nothing changes; closing the household, or transferring
//        ownership (and the target accepting), lets the deletion proceed; a mere
//        MEMBER (non-owner) is never blocked.
//   AC5 "acts only on the session user's own account" — deleting Alice leaves Bob's
//        account wholly intact; a handler takes the account from the session, never
//        a body value.
//   AC6 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing /
//        mis-typed input with a 4xx BEFORE any query runs; the service binds the
//        account id as a parameter (placeholders, never concatenation), so a
//        SQL-injection probe is handled as a value and cannot alter a query. The
//        handler below is a TEST FIXTURE (the intended usage), not an implementation
//        file.
//   AC7 [obligation:secrets-from-env] (INV-103) — shown behaviourally: a decoy
//        secret planted in the environment never lands in the confirmation email,
//        the purge queue, or the users row (the service reads no process.env; db,
//        revoker and senders are all injected).
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` and its own fresh outbox / revoker spy, so
// tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { deleteAccount } from "./delete";
import { createUser, getUserById, type User } from "../db/users";
import {
  createHousehold,
  addMember,
  closeHousehold,
  transferOwnership,
  acceptOwnership,
} from "../db/households";
import { listPendingPurges } from "../db/account-purge";
import { createOutbox, type Outbox } from "../notify/outbox";
import { freshDb } from "../../test/db";
import { type Db } from "../db/index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

// A stand-in wrapped-DEK reference: a long, opaque base64 blob standing for the
// KEK-wrapped data key (opaque ciphertext to the app). Distinct per person so the
// cross-account test can tell one person's DEK from another's, and long enough that
// a crypto-shred (clearing the column) is unmistakably shorter.
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}-${"x".repeat(64)}`).toString("base64");
}

// Create a genuine person row and hand it back (id, email, the wrapped DEK). Every
// member-scoped row (and the deletion) hangs off this id — the session's userId.
async function makeUser(db: Db, who: string): Promise<User> {
  return createUser(db, { email: `${who}@warthog.com.au`, wrappedDek: wrappedDekFor(who) });
}

// The cross-aggregate revocation seam, observed through a spy that records the
// userId handed to it — so a test asserts the revocation was REQUESTED (and for
// whom) without a real agent/connection/credential store. Mirrors the account-reset
// executor spy.
interface RevokerLike {
  revokeAgentsAndConnections(userId: string): Promise<void>;
}
function makeRevokerSpy(): { revoker: RevokerLike; revoked: string[] } {
  const revoked: string[] = [];
  const revoker: RevokerLike = {
    async revokeAgentsAndConnections(userId: string): Promise<void> {
      revoked.push(userId);
    },
  };
  return { revoker, revoked };
}

// One outbox stands in for all three channels; the service uses only `.email`.
function sendersFor(outbox: Outbox) {
  return { push: outbox, email: outbox, sms: outbox };
}

// The superset deps bundle the service reads from. db + revoker + senders — every
// seam injected, so the module holds no secret and reads no process.env (INV-103).
function makeDeps(db: Db, revoker: RevokerLike, outbox: Outbox) {
  return { db, revoker, senders: sendersFor(outbox) };
}

// The confirmation emails the outbox recorded for this recipient (channel scoped,
// so a push/sms to the same person is not miscounted as the email confirmation).
function emailsTo(outbox: Outbox, recipient: string) {
  return outbox.list().filter((m) => m.channel === "email" && m.recipient === recipient);
}

// Pending purge entries for one account (the queue read is global; filter here).
function purgeEntriesFor(queue: { userId: string }[], userId: string) {
  return queue.filter((e) => e.userId === userId);
}

// A db seam stand-in that records every call instead of running it, so a test can
// prove WHAT reached the query layer and HOW (bound value vs. spliced text). It
// returns no rows and satisfies the `Db` shape structurally (query + close).
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

// Whether a relation of this exact name exists on this handle. `to_regclass` yields
// the relation name when it exists and NULL otherwise — a non-throwing probe scoped
// to the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Assert a probe reached the query layer as a BOUND value and never as spliced SQL
// text, scoped to each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// ===========================================================================
// AC1 — the account's wrapped DEK is crypto-shredded (its content undecryptable).
// ===========================================================================

test("deleting an account crypto-shreds the wrapped DEK — the original is gone", async () => {
  const db = await freshDb();
  const outbox = createOutbox();
  const { revoker } = makeRevokerSpy();
  try {
    const person = await makeUser(db, "shred");
    const original = person.wrappedDek;

    const result = await deleteAccount(makeDeps(db, revoker, outbox), { userId: person.id });
    assert.ok(result.ok, `a deletion with no owned household must succeed: ${JSON.stringify(result)}`);

    // The users row PERSISTS (the purge job removes it within 24h), but the wrapped
    // DEK it holds is gone: the KEK can only unwrap the ORIGINAL wrapped form, so a
    // stored value that is no longer the original can no longer be decrypted.
    const after = await getUserById(db, person.id);
    assert.ok(after, "the users row persists until the purge job removes it");
    assert.notEqual(
      after.wrappedDek,
      original,
      "the original wrapped DEK is no longer stored (it has been crypto-shredded)",
    );
    assert.ok(
      !after.wrappedDek.includes(original),
      "no fragment of the original wrapped DEK survives in the column",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — every agent and service connection is revoked (once, for that person).
// ===========================================================================

test("deleting an account revokes every agent and service connection for that person", async () => {
  const db = await freshDb();
  const outbox = createOutbox();
  const { revoker, revoked } = makeRevokerSpy();
  try {
    const person = await makeUser(db, "revoke");

    const result = await deleteAccount(makeDeps(db, revoker, outbox), { userId: person.id });
    assert.ok(result.ok, `a deletion must succeed: ${JSON.stringify(result)}`);

    // The revocation is requested exactly once, for exactly this person — the seam
    // the app wires to the real agent/connection/credential revocation, so an
    // agent's next request is refused.
    assert.deepEqual(
      revoked,
      [person.id],
      "a deletion revokes the person's agents and connections exactly once",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — enqueued for purge AND a confirmation email sent, both before success.
// ===========================================================================

test("a successful deletion enqueues the account for purge and sends a confirmation email", async () => {
  const db = await freshDb();
  const outbox = createOutbox();
  const { revoker } = makeRevokerSpy();
  try {
    const person = await makeUser(db, "confirm");

    const result = await deleteAccount(makeDeps(db, revoker, outbox), { userId: person.id });
    assert.ok(result.ok, `a deletion must succeed: ${JSON.stringify(result)}`);

    // Both effects are awaited INSIDE the service, so their presence once the call
    // has resolved proves they happened before it returned success.
    const queue = await listPendingPurges(db);
    assert.equal(
      purgeEntriesFor(queue, person.id).length,
      1,
      "the deleted account is enqueued for purge before success",
    );

    const confirmations = emailsTo(outbox, person.email);
    assert.equal(confirmations.length, 1, "exactly one confirmation email is sent to the person");
    assert.ok(confirmations[0]!.body.length > 0, "the confirmation email carries a body");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — refused while the person still owns a household; allowed once it is
// transferred or closed; a non-owner member is never blocked.
// ===========================================================================

test("deletion is refused with a plain reason while the person still owns a household, and nothing changes", async () => {
  const db = await freshDb();
  const outbox = createOutbox();
  const { revoker, revoked } = makeRevokerSpy();
  try {
    const owner = await makeUser(db, "owner-blocked");
    const original = owner.wrappedDek;
    await createHousehold(db, { ownerId: owner.id }); // owner now OWNS a household

    const result = await deleteAccount(makeDeps(db, revoker, outbox), { userId: owner.id });

    assert.equal(result.ok, false, "a person who still owns a household cannot delete their account");
    assert.ok(
      !result.ok && typeof result.reason === "string" && result.reason.length > 0,
      "the refusal carries a plain reason (shown to the person until they transfer or close the household)",
    );

    // Nothing was done: the DEK is intact, nothing enqueued, no email, no revoke.
    const after = await getUserById(db, owner.id);
    assert.equal(after?.wrappedDek, original, "a refused deletion leaves the wrapped DEK intact");
    assert.equal(
      purgeEntriesFor(await listPendingPurges(db), owner.id).length,
      0,
      "a refused deletion enqueues nothing for purge",
    );
    assert.equal(emailsTo(outbox, owner.email).length, 0, "a refused deletion sends no confirmation email");
    assert.deepEqual(revoked, [], "a refused deletion revokes nothing");
  } finally {
    await db.close();
  }
});

test("once the owned household is closed, the deletion proceeds", async () => {
  const db = await freshDb();
  const outbox = createOutbox();
  const { revoker, revoked } = makeRevokerSpy();
  try {
    const owner = await makeUser(db, "owner-closes");
    const original = owner.wrappedDek;
    const household = await createHousehold(db, { ownerId: owner.id });

    // Blocked while they own it...
    const blocked = await deleteAccount(makeDeps(db, revoker, outbox), { userId: owner.id });
    assert.equal(blocked.ok, false, "blocked while the person still owns the household");

    // ...then they close it, and the deletion goes through.
    const closed = await closeHousehold(db, { householdId: household.id, actorId: owner.id });
    assert.ok(closed.ok, `closing the household must succeed: ${JSON.stringify(closed)}`);

    const result = await deleteAccount(makeDeps(db, revoker, outbox), { userId: owner.id });
    assert.ok(result.ok, `with no owned household the deletion must proceed: ${JSON.stringify(result)}`);

    const after = await getUserById(db, owner.id);
    assert.notEqual(after?.wrappedDek, original, "the wrapped DEK is crypto-shredded once the deletion proceeds");
    assert.deepEqual(revoked, [owner.id], "the deletion revokes the person's agents and connections");
    assert.equal(
      purgeEntriesFor(await listPendingPurges(db), owner.id).length,
      1,
      "the account is enqueued for purge once the deletion proceeds",
    );
  } finally {
    await db.close();
  }
});

test("once ownership is transferred and accepted, the former owner can delete", async () => {
  const db = await freshDb();
  const outbox = createOutbox();
  const { revoker, revoked } = makeRevokerSpy();
  try {
    const owner = await makeUser(db, "owner-transfers");
    const heir = await makeUser(db, "heir");
    const household = await createHousehold(db, { ownerId: owner.id });
    const added = await addMember(db, { householdId: household.id, userId: heir.id });
    assert.ok(added.ok, `adding the heir must succeed: ${JSON.stringify(added)}`);

    // Pending transfer alone does not move ownership — the owner is still blocked.
    const transferred = await transferOwnership(db, {
      householdId: household.id,
      actorId: owner.id,
      toUserId: heir.id,
    });
    assert.ok(transferred.ok, `the transfer must be recorded: ${JSON.stringify(transferred)}`);
    const stillBlocked = await deleteAccount(makeDeps(db, revoker, outbox), { userId: owner.id });
    assert.equal(stillBlocked.ok, false, "a merely PENDING transfer does not yet let the owner delete");

    // The heir accepts: ownership moves, so the former owner no longer owns anything.
    const accepted = await acceptOwnership(db, { householdId: household.id, userId: heir.id });
    assert.ok(accepted.ok, `the heir must accept ownership: ${JSON.stringify(accepted)}`);

    const result = await deleteAccount(makeDeps(db, revoker, outbox), { userId: owner.id });
    assert.ok(result.ok, `the former owner can delete once ownership has moved: ${JSON.stringify(result)}`);
    assert.deepEqual(revoked, [owner.id], "only the former owner's agents and connections are revoked");
  } finally {
    await db.close();
  }
});

test("a household member who is not the owner is not blocked from deleting", async () => {
  const db = await freshDb();
  const outbox = createOutbox();
  const { revoker, revoked } = makeRevokerSpy();
  try {
    const owner = await makeUser(db, "the-owner");
    const member = await makeUser(db, "the-member");
    const household = await createHousehold(db, { ownerId: owner.id });
    const added = await addMember(db, { householdId: household.id, userId: member.id });
    assert.ok(added.ok, `adding the member must succeed: ${JSON.stringify(added)}`);

    // The member owns no household (they only belong to the owner's), so they delete
    // freely — ownership, not membership, is what blocks.
    const result = await deleteAccount(makeDeps(db, revoker, outbox), { userId: member.id });
    assert.ok(result.ok, `a non-owner member must be able to delete: ${JSON.stringify(result)}`);
    assert.deepEqual(revoked, [member.id], "the member's own agents and connections are revoked");
    assert.equal(
      purgeEntriesFor(await listPendingPurges(db), member.id).length,
      1,
      "the member's account is enqueued for purge",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the service acts only on the session user's own account.
// ===========================================================================

test("the service acts only on the session account — another person's account is untouched", async () => {
  const db = await freshDb();
  const outbox = createOutbox();
  const { revoker, revoked } = makeRevokerSpy();
  try {
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    const bobDek = bob.wrappedDek;

    // Alice deletes her OWN account.
    const result = await deleteAccount(makeDeps(db, revoker, outbox), { userId: alice.id });
    assert.ok(result.ok, `Alice's deletion must succeed: ${JSON.stringify(result)}`);

    // Bob is wholly untouched: his DEK is intact, he is not on the purge queue, his
    // agents are not revoked and no email went to him.
    const bobAfter = await getUserById(db, bob.id);
    assert.equal(bobAfter?.wrappedDek, bobDek, "Bob's wrapped DEK is untouched by Alice's deletion");
    assert.equal(
      purgeEntriesFor(await listPendingPurges(db), bob.id).length,
      0,
      "Bob's account is never enqueued for purge by Alice's deletion",
    );
    assert.deepEqual(revoked, [alice.id], "only Alice's agents and connections are revoked");
    assert.equal(emailsTo(outbox, bob.email).length, 0, "no confirmation email is sent to Bob");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC6 — a handler on the validation boundary rejects bad input and takes the account
// from the SESSION. A person asks to delete THEIR OWN account; the handler validates
// the typed confirmation, then calls the service with the SESSION user id (NEVER a
// body value). A rejected input maps to a 4xx Response and never reaches a query.
// This handler is a TEST FIXTURE that exercises the modules — not an implementation
// file.
// ===========================================================================

const CONFIRM_PHRASE = "DELETE MY ACCOUNT";

function deleteAccountHandler(
  deps: ReturnType<typeof makeDeps>,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries only the typed confirmation; the account comes from the
  // SESSION, never the body. The confirmation length is capped so an absurd value is
  // rejected by size.
  const schema = z.object({ confirm: z.string().min(1).max(64) });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      if (body.confirm !== CONFIRM_PHRASE) {
        return new Response(JSON.stringify({ error: "confirmation required" }), { status: 400 });
      }
      const result = await deleteAccount(deps, { userId: sessionUserId });
      if (!result.ok) {
        return new Response(JSON.stringify({ error: result.reason }), { status: 409 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
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
  return new Request("https://warthog.com.au/api/account/delete", {
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
  const { revoker, revoked } = makeRevokerSpy();
  const handler = deleteAccountHandler(makeDeps(db, revoker, createOutbox()), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
  assert.deepEqual(revoked, [], "malformed input must never trigger a revocation");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const { revoker } = makeRevokerSpy();
  const handler = deleteAccountHandler(makeDeps(db, revoker, createOutbox()), "session-user");

  // ~8 KiB confirmation, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(validBody({ confirm: "a".repeat(8 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing the confirmation with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const { revoker } = makeRevokerSpy();
  const handler = deleteAccountHandler(makeDeps(db, revoker, createOutbox()), "session-user");

  const res = await handler(jsonRequest(JSON.stringify({})));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed confirmation with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const { revoker } = makeRevokerSpy();
  const handler = deleteAccountHandler(makeDeps(db, revoker, createOutbox()), "session-user");

  // confirm must be a string — a number is a schema violation.
  const res = await handler(jsonRequest(JSON.stringify({ confirm: 123 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed confirmation must never reach a query");
});

test("the handler rejects the wrong confirmation phrase with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const { revoker } = makeRevokerSpy();
  const handler = deleteAccountHandler(makeDeps(db, revoker, createOutbox()), "session-user");

  const res = await handler(jsonRequest(validBody({ confirm: "delete" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an unconfirmed request must never reach a query");
});

test("the handler accepts a confirmed request and deletes the SESSION account", async () => {
  const db = await freshDb();
  const outbox = createOutbox();
  const { revoker, revoked } = makeRevokerSpy();
  try {
    const person = await makeUser(db, "handler-ok");
    const original = person.wrappedDek;
    const handler = deleteAccountHandler(makeDeps(db, revoker, outbox), person.id);

    const res = await handler(jsonRequest(validBody()));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const after = await getUserById(db, person.id);
    assert.notEqual(after?.wrappedDek, original, "a confirmed request crypto-shreds the session account's DEK");
    assert.deepEqual(revoked, [person.id], "a confirmed request revokes the session account's agents");
    assert.equal(
      purgeEntriesFor(await listPendingPurges(db), person.id).length,
      1,
      "a confirmed request enqueues the session account for purge",
    );
  } finally {
    await db.close();
  }
});

test("the handler takes the account from the session, not the body (no cross-account deletion)", async () => {
  const db = await freshDb();
  const outbox = createOutbox();
  const { revoker, revoked } = makeRevokerSpy();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const victim = await makeUser(db, "handler-victim");
    const victimDek = victim.wrappedDek;
    const handler = deleteAccountHandler(makeDeps(db, revoker, outbox), sessionUser.id);

    // The body smuggles another person's userId; the handler must ignore it and act
    // on the session's account alone.
    const res = await handler(jsonRequest(validBody({ userId: victim.id })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    const victimAfter = await getUserById(db, victim.id);
    assert.equal(victimAfter?.wrappedDek, victimDek, "the account id smuggled in the body is never deleted");
    assert.equal(
      purgeEntriesFor(await listPendingPurges(db), victim.id).length,
      0,
      "the smuggled account is never enqueued for purge",
    );
    assert.deepEqual(revoked, [sessionUser.id], "only the SESSION account's agents are revoked");
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected through the body: the tables survive and the session account is deleted", async () => {
  const db = await freshDb();
  const outbox = createOutbox();
  const { revoker } = makeRevokerSpy();
  try {
    const person = await makeUser(db, "handler-probe");
    const handler = deleteAccountHandler(makeDeps(db, revoker, outbox), person.id);

    // A probe smuggled as a body userId never reaches a query (the session id is
    // used), and the confirmation is just validated — so the tables stand and only
    // the session account is deleted.
    const res = await handler(
      jsonRequest(validBody({ userId: "x'); DROP TABLE account_purge_queue; --" })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal(await tableExists(db, "account_purge_queue"), true, "the purge queue table still exists");
    assert.equal(await tableExists(db, "users"), true, "the users table still exists");
    assert.equal(
      purgeEntriesFor(await listPendingPurges(db), person.id).length,
      1,
      "only the session account is enqueued for purge",
    );
  } finally {
    await db.close();
  }
});

test("the service binds the account id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const { revoker } = makeRevokerSpy();
  const probe = "u'); DROP TABLE users; --";

  // The recording db returns no rows; tolerate whatever the service does with the
  // (absent) reads — the binding is asserted regardless.
  try {
    await deleteAccount(makeDeps(db, revoker, createOutbox()), { userId: probe });
  } catch {
    /* a no-row read / absent user is tolerated; the binding is what we assert */
  }

  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe passed as the account id cannot alter a query (it is bound, not run)", async () => {
  const db = await freshDb();
  const { revoker } = makeRevokerSpy();
  try {
    const probe = "'); DROP TABLE users; --";

    // Bound as a value, the probe is a malformed account id (Postgres rejects it on
    // type), so the call may throw — but the embedded DROP must never execute.
    try {
      await deleteAccount(makeDeps(db, revoker, createOutbox()), { userId: probe });
    } catch {
      /* a rejected value is fine; the tables surviving is what we assert */
    }

    assert.equal(await tableExists(db, "users"), true, "the users table must still exist");
    assert.equal(
      await tableExists(db, "account_purge_queue"),
      true,
      "the purge queue table must still exist (the probe was bound as a value, not run as SQL)",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC7 — the service reads no process.env and holds no secret (INV-103), shown
// behaviourally with a decoy secret planted in the environment.
// ===========================================================================

test("the service reads no process.env: a decoy secret never lands in the email, the purge queue, or the users row", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  const outbox = createOutbox();
  const { revoker } = makeRevokerSpy();
  try {
    const person = await makeUser(db, "ac7");

    const result = await deleteAccount(makeDeps(db, revoker, outbox), { userId: person.id });
    assert.ok(result.ok, `a deletion must succeed: ${JSON.stringify(result)}`);

    // No ambient env value is folded into anything the deletion produces.
    assert.ok(
      !JSON.stringify(outbox.list()).includes(DECOY),
      "no ambient env value is folded into the confirmation email",
    );
    assert.ok(
      !JSON.stringify(await listPendingPurges(db)).includes(DECOY),
      "no ambient env value is folded into the purge queue",
    );

    // Scan the users row under test for the decoy (scoped narrowly — a real datum
    // could legitimately live elsewhere; this value is not one).
    const rows = await db.query("SELECT * FROM users WHERE id = $1", [person.id]);
    for (const row of rows.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(DECOY), "no ambient env value is written to the users row");
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
// Review fix G2 — deletion is wired live on the Data & privacy screen, so a finished
// deletion must also END the person's sessions (every device is signed out: a shredded
// DEK can no longer back any page), and a confirmation email that fails to send must
// not turn a completed, irreversible deletion into an error.
// ===========================================================================

test("a successful deletion ends every session of the person — their old cookies no longer verify", async () => {
  const { createSession, verifySession } = await import("../auth/session");
  const { fixedClock } = await import("../seams/clock");
  const { systemRandom } = await import("../seams/random");
  const clock = fixedClock(new Date("2026-06-01T00:00:00.000Z"));
  const db = await freshDb();
  const outbox = createOutbox();
  const { revoker } = makeRevokerSpy();
  try {
    const person = await makeUser(db, "sessions-end");
    const bystander = await makeUser(db, "sessions-keep");
    const phone = await createSession(db, person.id, { clock, random: systemRandom });
    const laptop = await createSession(db, person.id, { clock, random: systemRandom });
    const other = await createSession(db, bystander.id, { clock, random: systemRandom });

    const result = await deleteAccount(makeDeps(db, revoker, outbox), { userId: person.id });
    assert.ok(result.ok);

    assert.equal(await verifySession(db, phone.token, { clock }), null, "the phone session is gone");
    assert.equal(await verifySession(db, laptop.token, { clock }), null, "the laptop session is gone");
    assert.ok(await verifySession(db, other.token, { clock }), "another person's session is untouched");
  } finally {
    await db.close();
  }
});

test("a confirmation email that fails to send does not fail a completed deletion", async () => {
  const db = await freshDb();
  const { revoker, revoked } = makeRevokerSpy();
  const failing = async (): Promise<void> => {
    throw new Error("email channel down");
  };
  try {
    const person = await makeUser(db, "email-down");
    const result = await deleteAccount(
      {
        db,
        revoker,
        senders: { push: { sendPush: failing }, email: { sendEmail: failing }, sms: { sendSms: failing } },
      },
      { userId: person.id },
    );
    assert.deepEqual(result, { ok: true }, "the deletion is reported as done");
    assert.equal((await getUserById(db, person.id))?.wrappedDek, "", "the DEK is shredded");
    assert.deepEqual(revoked, [person.id], "agents and connections were revoked");
    assert.equal(purgeEntriesFor(await listPendingPurges(db), person.id).length, 1, "the purge is enqueued");
  } finally {
    await db.close();
  }
});
