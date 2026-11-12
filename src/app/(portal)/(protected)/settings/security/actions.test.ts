// E04-S15 — Security settings loader + actions (`src/app/(portal)/(protected)/settings/security/`).
//
// RED-first: the security-settings seam does not exist yet, so importing `./actions`
// throws and every test here fails until the builder adds it. That absence IS the point
// of test-first — do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR (what the loader RETURNS, what each action CHANGES in the
// database, and what it REFUSES) against an isolated in-memory PGlite with the REAL
// migrations (src/test/db) and the REAL sibling seams (session, passkey, recovery,
// step-up). The WebAuthn round trips use the software authenticator (src/test/
// authenticator), whose only non-test collaborator is the real @simplewebauthn/server
// verifier. No test asserts on the source text of any module, so a later
// behaviour-preserving refactor (a rename, a moved import) stays green.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry file may
// export ONLY its framework fields (its default page component), so it cannot carry an
// injectable, unit-testable seam without breaking `next build`. The thin protected-page
// loader (`page.tsx`) reads the session + database and renders a view; the testable
// logic — reading this person's factors/sessions and mutating them — lives in the plain
// sibling module `actions.ts` (the convention's `createXHandler({ db })` factory
// pattern, here `createSecurityActions(deps)`). These tests drive that factory directly
// with fakes; the page wires thin server-action wrappers over it.
//
// Why this exists (brief: "People manage their own factors and sessions; sensitive
// changes need step-up"; design §5 — sessions carry `stepped_up_at`, step-up valid 5
// minutes, "every member-scoped query is filtered by the session's user id, never an id
// from the client"; OBS-049 — a mis-shaped id is rejected at the validation boundary,
// never cast at `WHERE id = $1`): the security screen lists a person's OWN passkeys and
// sessions (each session row is also a recent sign-in — its own `created_at`/
// `last_seen_at`), and lets them add/remove a passkey, sign out another session and
// regenerate their recovery code. Every sensitive change requires a fresh step-up, and
// no person can ever touch another person's passkey or session by id.
//
// ─── The contract this task defines (the builder implements exactly this) ─────────────
//
//   createSecurityActions(deps): {
//     load(session):                      Promise<{ passkeys: {id}[]; sessions: {id}[] }>
//     beginAddPasskey(session):           Promise<{ ok: true; options } | { ok: false; reason }>
//     finishAddPasskey(session, response): Promise<{ ok: true } | { ok: false; reason }>
//     removePasskey(session, passkeyId):   Promise<{ ok: true } | { ok: false; reason }>
//     signOutSession(session, sessionId):  Promise<{ ok: true } | { ok: false; reason }>
//     regenerateRecovery(session):         Promise<{ ok: true; code } | { ok: false; reason }>
//   }
//
//   deps: { db: Db; clock: Clock; random: Random; rpId: string }
//
//   • Every method takes the person's VERIFIED Session and derives the acting user id
//     from `session.userId` — never from a client-supplied value (design §5). So the
//     loader lists only that person's rows, and a mutation is scoped to that person: an
//     id belonging to someone else matches nothing and changes nothing.
//   • The three single-step mutations and adding a passkey are SENSITIVE CHANGES: each
//     requires a fresh step-up on the session (requireStepUp). Without one the change is
//     refused ({ ok: false }) and nothing changes.
//   • A MALFORMED id (not a well-formed uuid) is rejected at the validation boundary with
//     a 4xx `HttpError` (OBS-049) — it never reaches `WHERE id = $1` as a cast, and never
//     surfaces as a 500. A WELL-FORMED id that is simply not this person's returns
//     { ok: false } and leaves the other person's row intact (a safe no-op, never a
//     silent success).
//
// ─── Acceptance criteria → tests ──────────────────────────────────────────────────────
//   AC1 lists only this person's passkeys/sessions (and recent sign-ins — the sessions
//       themselves); supports add/remove passkey, sign out another session and regenerate
//       recovery, with step-up required for each sensitive change.
//   AC2 a member can never remove another user's passkey or session by id (the other
//       person's row survives), and a malformed id returns a 4xx.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own freshDb(). Entropy (session ids, recovery codes, credential ids) is drawn
// from the REAL seams so nothing collides across tests.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { RegistrationResponseJSON } from "@simplewebauthn/server";

import { createSecurityActions } from "./actions";

import {
  createSession,
  recordStepUp,
  verifySession,
  type CreatedSession,
  type Session,
} from "../../../../../server/auth/session";
import {
  beginPasskeyRegistration,
  finishPasskeyRegistration,
  beginPasskeyAuthentication,
  finishPasskeyAuthentication,
} from "../../../../../server/auth/passkey";
import { issueRecoveryCode, verifyRecoveryCode } from "../../../../../server/auth/recovery";
import { createUser } from "../../../../../server/db/users";
import { HttpError } from "../../../../../server/http/validate";
import { fixedClock, type Clock } from "../../../../../server/seams/clock";
import { systemRandom } from "../../../../../server/seams/random";
import { freshDb } from "../../../../../test/db";
import { createAuthenticator, type SoftwareAuthenticator } from "../../../../../test/authenticator";
import type { Db } from "../../../../../server/db/index";
import { randomBytes } from "node:crypto";
import { localAesKeyWrapper } from "../../../../../server/crypto/key-wrapper";
import { createTotpSecretStore } from "../../../../../server/auth/totp-store";

// A frozen instant used as "now" for every test: a session stepped up at T0, read by a
// clock also at T0, is comfortably inside the 5-minute step-up window, with no
// wall-clock dependence.
const T0 = new Date("2026-05-01T00:00:00.000Z");

// The configured WebAuthn RP ID — passed through deps (never a module constant), so the
// add-passkey flow exercises the "RP ID from config" discipline end to end.
const RP_ID = "warthog.com.au";

const clock: Clock = fixedClock(T0);

test("security shows only the owner's Authenticator enrollment without reading its secret", async () => {
  const db = await freshDb();
  try {
    const owner = await createPerson(db, "factor-owner@example.test");
    const other = await createPerson(db, "factor-other@example.test");
    await db.query("INSERT INTO totp_secrets (user_id, secret_enc) VALUES ($1, $2)", [other, "opaque-other-secret"]);
    const session = (await freshSession(db, owner)).session;
    const actions = makeActions(db);
    assert.equal((await actions.load(session)).authenticatorEnabled, false);
    await db.query("INSERT INTO totp_secrets (user_id, secret_enc) VALUES ($1, $2)", [owner, "opaque-owner-secret"]);
    const view = await actions.load(session);
    assert.equal(view.authenticatorEnabled, true);
    assert.ok(!JSON.stringify(view).includes("secret"));
  } finally { await db.close(); }
});

// Build the security-settings actions under test with the real seams. Each test uses its
// own db, so nothing leaks across tests.
function makeActions(db: Db) {
  return createSecurityActions({ db, clock, random: systemRandom, rpId: RP_ID });
}

// Create a real person row (the account every member-scoped row hangs off). The wrapped
// DEK is opaque here — we never unwrap it — so any stable reference serves.
async function createPerson(db: Db, email: string): Promise<string> {
  const user = await createUser(db, {
    email,
    wrappedDek: Buffer.from(`wrapped-dek-${email}`).toString("base64"),
  });
  return user.id;
}

// Register a real passkey for `userId` through the REAL passkey seam + the software
// authenticator, so the credential genuinely verifies later. Returns nothing the caller
// needs — the row is addressed by the loader's passkey id.
async function registerPasskeyFor(
  db: Db,
  userId: string,
  auth: SoftwareAuthenticator,
): Promise<void> {
  const options = await beginPasskeyRegistration(db, { userId, userName: `${userId}@t` }, { rpId: RP_ID });
  const response = await auth.register(options);
  const result = await finishPasskeyRegistration(db, { userId, response }, { rpId: RP_ID });
  assert.equal(result.ok, true, "test setup: the passkey must register");
}

// A fresh session for `userId` that has NEVER stepped up (steppedUpAt === null) — the
// "no fresh step-up" case for the sensitive-change gate.
async function freshSession(db: Db, userId: string): Promise<CreatedSession> {
  return createSession(db, userId, { clock, random: systemRandom });
}

// A session for `userId` carrying a FRESH step-up (stamped at T0 by the real
// recordStepUp), read by a clock also at T0 — so requireStepUp passes.
async function steppedUpSession(db: Db, userId: string): Promise<Session> {
  const created = await createSession(db, userId, { clock, random: systemRandom });
  return recordStepUp(db, created.session.id, { clock });
}

// How many passkeys the database holds for `userId` (a direct probe, independent of the
// loader, so a removal is proven at the row level and not merely by a filtered read).
async function passkeyCount(db: Db, userId: string): Promise<number> {
  const result = await db.query("SELECT count(*)::int AS n FROM passkeys WHERE user_id = $1", [userId]);
  return Number(result.rows[0]?.n ?? -1);
}

// Assert that awaiting `fn()` rejects with a 4xx HttpError (the validation boundary) and
// that the id never reached the query as a cast.
async function assertRejects4xx(label: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    assert.ok(
      err instanceof HttpError,
      `${label}: a malformed id must be rejected at the validation boundary (HttpError), got ${String(err)}`,
    );
    assert.ok(
      err.status >= 400 && err.status < 500,
      `${label}: the rejection must carry a 4xx status, got ${err.status}`,
    );
  }
  assert.ok(threw, `${label}: a malformed id must be rejected (nothing was thrown)`);
}

// =====================================================================================
// AC1 — the loader lists ONLY this person's passkeys and sessions (each session being
// also a recent sign-in, with its own created_at/last_seen_at). Another person's rows
// are never visible — the scope is the session's user id, never a client value.
// =====================================================================================

test("the loader lists only this person's passkeys and sessions (never another person's)", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);

    const alice = await createPerson(db, "alice@warthog.com.au");
    const bob = await createPerson(db, "bob@warthog.com.au");

    await registerPasskeyFor(db, alice, createAuthenticator());
    await registerPasskeyFor(db, bob, createAuthenticator());

    const aliceSession = (await freshSession(db, alice)).session;
    const bobSession = (await freshSession(db, bob)).session;

    const aliceView = await actions.load(aliceSession);
    const bobView = await actions.load(bobSession);

    // Each person sees their own factors and sessions…
    assert.ok(aliceView.passkeys.length >= 1, "Alice's own passkey is listed");
    assert.ok(aliceView.sessions.length >= 1, "Alice's own session is listed");
    assert.ok(
      aliceView.sessions.some((s) => s.id === aliceSession.id),
      "Alice's current session appears in her own list",
    );

    // …and NONE of the other person's rows. (Compared by the ids the loader exposes —
    // the same handles the remove/sign-out actions take.)
    const alicePasskeyIds = new Set(aliceView.passkeys.map((p) => p.id));
    const bobPasskeyIds = new Set(bobView.passkeys.map((p) => p.id));
    const aliceSessionIds = new Set(aliceView.sessions.map((s) => s.id));
    const bobSessionIds = new Set(bobView.sessions.map((s) => s.id));

    for (const id of bobPasskeyIds) {
      assert.ok(!alicePasskeyIds.has(id), "Bob's passkey must never appear in Alice's list");
    }
    for (const id of bobSessionIds) {
      assert.ok(!aliceSessionIds.has(id), "Bob's session must never appear in Alice's list");
    }
    assert.ok(
      !bobSessionIds.has(aliceSession.id),
      "Alice's session must never appear in Bob's list",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — add passkey: with a fresh step-up the new passkey is registered, becomes visible
// in the loader, and genuinely authenticates the person (a real second factor).
// =====================================================================================

test("add passkey (with step-up): the new passkey is stored, listed, and authenticates the person", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await createPerson(db, "add-ok@warthog.com.au");
    // One existing passkey, so this exercises adding an ADDITIONAL factor.
    await registerPasskeyFor(db, alice, createAuthenticator());

    const session = await steppedUpSession(db, alice);
    const before = await passkeyCount(db, alice);

    const begun = await actions.beginAddPasskey(session);
    if (!begun.ok) {
      assert.fail(`a stepped-up person may add a passkey, but begin was refused: ${begun.reason}`);
      return;
    }
    assert.equal(begun.options.rp.id, RP_ID, "the registration options carry the configured RP ID");

    const newAuth = createAuthenticator();
    const response: RegistrationResponseJSON = await newAuth.register(begun.options);
    const finished = await actions.finishAddPasskey(session, response);
    assert.equal(finished.ok, true, "a valid attestation registers the new passkey");

    // Stored and listed.
    assert.equal(await passkeyCount(db, alice), before + 1, "exactly one passkey was added");
    assert.equal(
      (await actions.load(session)).passkeys.length,
      before + 1,
      "the new passkey appears in the loader",
    );

    // And it is a REAL working second factor: the just-added credential authenticates.
    const authOptions = await beginPasskeyAuthentication(db, { userId: alice }, { rpId: RP_ID });
    const assertion = await newAuth.authenticate(authOptions);
    const authResult = await finishPasskeyAuthentication(
      db,
      { userId: alice, response: assertion },
      { rpId: RP_ID },
    );
    assert.equal(authResult.ok, true, "the newly added passkey authenticates the person");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 (step-up) — adding a passkey is a sensitive change: without a fresh step-up, no
// passkey is added, wherever the gate sits in the two-step flow.
// =====================================================================================

test("add passkey requires a fresh step-up: without one, no passkey is added", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await createPerson(db, "add-needs-stepup@warthog.com.au");
    await registerPasskeyFor(db, alice, createAuthenticator());

    const session = (await freshSession(db, alice)).session; // never stepped up
    const before = await passkeyCount(db, alice);

    // Drive the whole add flow without a step-up. The gate may sit at begin (no options
    // issued) or at finish (attestation refused) — either way nothing is added.
    const begun = await actions.beginAddPasskey(session);
    if (begun.ok) {
      const response = await createAuthenticator().register(begun.options);
      const finished = await actions.finishAddPasskey(session, response);
      assert.equal(finished.ok, false, "finishing an add without a fresh step-up must be refused");
    }

    assert.equal(
      await passkeyCount(db, alice),
      before,
      "no passkey is added without a fresh step-up",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — remove passkey: with a fresh step-up the chosen passkey is deleted from the
// person's own factors.
// =====================================================================================

test("remove passkey (with step-up): the chosen passkey is deleted", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await createPerson(db, "remove-ok@warthog.com.au");
    // Two passkeys, so removing one is unambiguous and does not depend on any
    // last-factor policy.
    await registerPasskeyFor(db, alice, createAuthenticator());
    await registerPasskeyFor(db, alice, createAuthenticator());

    const session = await steppedUpSession(db, alice);
    const listed = (await actions.load(session)).passkeys;
    assert.equal(listed.length, 2, "two passkeys are listed before removal");
    const target = listed[0]!.id;

    const result = await actions.removePasskey(session, target);
    assert.equal(result.ok, true, "a stepped-up person may remove their own passkey");

    assert.equal(await passkeyCount(db, alice), 1, "exactly one passkey remains in the database");
    const after = (await actions.load(session)).passkeys.map((p) => p.id);
    assert.ok(!after.includes(target), "the removed passkey is gone from the loader");
    assert.equal(after.length, 1, "the other passkey is untouched");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 (step-up) — removing a passkey without a fresh step-up is refused and the passkey
// survives.
// =====================================================================================

test("remove passkey requires a fresh step-up: without one, the passkey survives", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await createPerson(db, "remove-needs-stepup@warthog.com.au");
    await registerPasskeyFor(db, alice, createAuthenticator());

    const readSession = (await freshSession(db, alice)).session; // never stepped up
    const target = (await actions.load(readSession)).passkeys[0]!.id;

    const result = await actions.removePasskey(readSession, target);
    assert.equal(result.ok, false, "removing a passkey without a fresh step-up is refused");
    assert.equal(await passkeyCount(db, alice), 1, "the passkey survives a refused removal");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — a member can never remove ANOTHER person's passkey by id. Even stepped up, an id
// that belongs to someone else matches nothing (scope is the session's user id) and that
// person's passkey survives.
// =====================================================================================

test("a member cannot remove another person's passkey by id — the other person's passkey survives", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await createPerson(db, "attacker@warthog.com.au");
    const bob = await createPerson(db, "victim@warthog.com.au");
    await registerPasskeyFor(db, alice, createAuthenticator());
    await registerPasskeyFor(db, bob, createAuthenticator());

    // Discover Bob's passkey id from his OWN view, then try to delete it as Alice —
    // fully stepped up, so ownership is the only thing standing in the way.
    const bobSession = (await freshSession(db, bob)).session;
    const bobPasskeyId = (await actions.load(bobSession)).passkeys[0]!.id;

    const aliceSession = await steppedUpSession(db, alice);
    const result = await actions.removePasskey(aliceSession, bobPasskeyId);

    assert.equal(result.ok, false, "removing another person's passkey reports failure, not a silent success");
    assert.equal(await passkeyCount(db, bob), 1, "Bob's passkey survives Alice's attempt");
    assert.ok(
      (await actions.load(bobSession)).passkeys.some((p) => p.id === bobPasskeyId),
      "Bob still sees his own passkey",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — sign out another session: with a fresh step-up the chosen session is ended (it
// no longer verifies and drops out of the loader).
// =====================================================================================

test("sign out another session (with step-up): the chosen session is ended", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await createPerson(db, "signout-ok@warthog.com.au");

    const actor = await steppedUpSession(db, alice); // the device doing the signing-out
    const other = await freshSession(db, alice); // another device of the SAME person

    const result = await actions.signOutSession(actor, other.session.id);
    assert.equal(result.ok, true, "a stepped-up person may sign out another of their sessions");

    assert.equal(
      await verifySession(db, other.token, { clock }),
      null,
      "the signed-out session no longer verifies",
    );
    assert.ok(
      !(await actions.load(actor)).sessions.some((s) => s.id === other.session.id),
      "the signed-out session is gone from the loader",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 (step-up) — signing out a session without a fresh step-up is refused and the
// session survives.
// =====================================================================================

test("sign out session requires a fresh step-up: without one, the session survives", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await createPerson(db, "signout-needs-stepup@warthog.com.au");

    const actor = (await freshSession(db, alice)).session; // never stepped up
    const other = await freshSession(db, alice);

    const result = await actions.signOutSession(actor, other.session.id);
    assert.equal(result.ok, false, "signing out a session without a fresh step-up is refused");
    assert.ok(
      (await verifySession(db, other.token, { clock })) !== null,
      "the session survives a refused sign-out",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — a member can never sign out ANOTHER person's session by id. The other person's
// session survives.
// =====================================================================================

test("a member cannot sign out another person's session by id — the other person's session survives", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await createPerson(db, "signout-attacker@warthog.com.au");
    const bob = await createPerson(db, "signout-victim@warthog.com.au");

    const aliceSession = await steppedUpSession(db, alice);
    const bobSession = await freshSession(db, bob);

    const result = await actions.signOutSession(aliceSession, bobSession.session.id);

    assert.equal(result.ok, false, "signing out another person's session reports failure");
    assert.ok(
      (await verifySession(db, bobSession.token, { clock })) !== null,
      "Bob's session survives Alice's attempt",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — a malformed id (not a well-formed uuid) is rejected with a 4xx at the validation
// boundary (OBS-049), for both remove-passkey and sign-out — never cast at WHERE id = $1,
// never a 500. The acting session is fully stepped up, so the id shape is the only thing
// that can reject the call.
// =====================================================================================

test("a malformed id is rejected with a 4xx (remove passkey and sign out), changing nothing", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await createPerson(db, "malformed@warthog.com.au");
    await registerPasskeyFor(db, alice, createAuthenticator());

    const session = await steppedUpSession(db, alice);
    const malformed = "not-a-uuid-at-all";

    await assertRejects4xx("removePasskey", () => actions.removePasskey(session, malformed));
    await assertRejects4xx("signOutSession", () => actions.signOutSession(session, malformed));

    // The rejected calls did nothing: Alice's passkey and her session are both intact.
    assert.equal(await passkeyCount(db, alice), 1, "a malformed id removes no passkey");
    assert.ok(
      (await actions.load(session)).sessions.some((s) => s.id === session.id),
      "a malformed id signs out no session",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 — regenerate recovery: with a fresh step-up a new code is issued (it verifies) and
// the previous code stops working (exactly one current code per person).
// =====================================================================================

test("regenerate recovery (with step-up): a new code verifies and the old one stops working", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await createPerson(db, "recovery-ok@warthog.com.au");

    // An existing recovery code (as issued at sign-up).
    const { code: oldCode } = await issueRecoveryCode(db, alice, { random: systemRandom });
    assert.equal(await verifyRecoveryCode(db, alice, oldCode), true, "the old code works before regeneration");

    const session = await steppedUpSession(db, alice);
    const result = await actions.regenerateRecovery(session);
    if (!result.ok) {
      assert.fail(`a stepped-up person may regenerate recovery, but it was refused: ${result.reason}`);
      return;
    }
    assert.equal(typeof result.code, "string", "a fresh recovery code is handed back");
    assert.ok(result.code.length > 0, "the fresh recovery code is non-empty");
    assert.notEqual(result.code, oldCode, "the fresh code differs from the old one");

    assert.equal(await verifyRecoveryCode(db, alice, result.code), true, "the fresh code verifies");
    assert.equal(
      await verifyRecoveryCode(db, alice, oldCode),
      false,
      "the previous code no longer verifies after regeneration",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 (step-up) — regenerating recovery without a fresh step-up is refused and the
// existing code still works.
// =====================================================================================

test("regenerate recovery requires a fresh step-up: without one, the existing code still works", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await createPerson(db, "recovery-needs-stepup@warthog.com.au");

    const { code: oldCode } = await issueRecoveryCode(db, alice, { random: systemRandom });
    const session = (await freshSession(db, alice)).session; // never stepped up

    const result = await actions.regenerateRecovery(session);
    assert.equal(result.ok, false, "regenerating recovery without a fresh step-up is refused");
    assert.equal(
      await verifyRecoveryCode(db, alice, oldCode),
      true,
      "the existing recovery code still works after a refused regeneration",
    );
  } finally {
    await db.close();
  }
});

// --- Review fix: adding a passkey sends the brief's security alert ---------------------

test("adding a passkey emails the person a new-passkey alert; a send failure never fails the add", async () => {
  const db = await freshDb();
  try {
    const alice = await createPerson(db, "alert-add@warthog.com.au");
    await registerPasskeyFor(db, alice, createAuthenticator());
    const sent: { recipient: string; body: string }[] = [];
    const actions = createSecurityActions({
      db,
      clock,
      random: systemRandom,
      rpId: RP_ID,
      alerts: { emailSender: { sendEmail: async (m) => void sent.push(m) } },
    });

    const session = await steppedUpSession(db, alice);
    const begun = await actions.beginAddPasskey(session);
    assert.ok(begun.ok);
    const finished = await actions.finishAddPasskey(session, await createAuthenticator().register(begun.options));
    assert.equal(finished.ok, true);
    assert.equal(sent.length, 1, "one alert");
    assert.equal(sent[0]!.recipient, "alert-add@warthog.com.au");
    assert.match(sent[0]!.body, /new passkey/i);

    const failing = createSecurityActions({
      db,
      clock,
      random: systemRandom,
      rpId: RP_ID,
      alerts: { emailSender: { sendEmail: async () => { throw new Error("down"); } } },
    });
    const again = await failing.beginAddPasskey(session);
    assert.ok(again.ok);
    const added = await failing.finishAddPasskey(session, await createAuthenticator().register(again.options));
    assert.equal(added.ok, true, "the passkey is still added when the alert cannot be sent");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Follow-up S1 — an authenticator app can be set up from this screen. The rules live in
// src/server/auth/totp-enrolment.ts (its own tests); here: the screen's actions are wired
// to it, gated on a fresh confirmation, and the loader reflects the result.
// =====================================================================================

// The RFC 6238 SHA-1 vector: this secret gives CODE at Unix time 1111111111.
const VECTOR_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const VECTOR_CODE = "050471";
const VECTOR_CLOCK: Clock = fixedClock(new Date(1111111111 * 1000));

test("an authenticator app can be set up here after confirming it's you, and the screen then shows it", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const user = await createUser(db, { email: "settings-totp@warthog.com.au", wrappedDek: await keyWrapper.wrap(randomBytes(32)) });
    const sent: { body: string }[] = [];
    const actions = createSecurityActions({
      db,
      clock: VECTOR_CLOCK,
      random: { randomBytes: (n) => (n === 20 ? Buffer.from("12345678901234567890") : systemRandom.randomBytes(n)) },
      rpId: RP_ID,
      totpSecrets: createTotpSecretStore({ db, keyWrapper }),
      alerts: { emailSender: { sendEmail: async (m) => void sent.push(m) } },
    });
    const plain = (await createSession(db, user.id, { clock: VECTOR_CLOCK, random: systemRandom })).session;
    assert.deepEqual(await actions.beginAddAuthenticator(plain), { ok: false, reason: "step_up_required" });

    const confirmed = await recordStepUp(db, plain.id, { clock: VECTOR_CLOCK });
    const begun = await actions.beginAddAuthenticator(confirmed);
    assert.ok(begun.ok);
    assert.equal(begun.secret, VECTOR_SECRET);
    assert.deepEqual(await actions.verifyAddAuthenticator(confirmed, "000000"), { ok: false, reason: "invalid_code" });
    assert.equal((await actions.load(confirmed)).authenticatorEnabled, false);
    assert.deepEqual(await actions.verifyAddAuthenticator(confirmed, VECTOR_CODE), { ok: true });
    assert.equal((await actions.load(confirmed)).authenticatorEnabled, true);
    assert.equal(sent.length, 1, "the new-sign-in-method alert is sent once");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Follow-up S2 — never remove the last sign-in method. Removing the account's only passkey
// is refused when there is no authenticator app; with one, it is allowed (the dialog still
// warns). The step-up gate still comes first, and the check holds under parallel removals.
// =====================================================================================

test("the only passkey cannot be removed when there is no authenticator app; it survives", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await createPerson(db, "last-method@warthog.com.au");
    await registerPasskeyFor(db, alice, createAuthenticator());
    const session = await steppedUpSession(db, alice);
    const only = (await actions.load(session)).passkeys[0]!.id;
    assert.deepEqual(await actions.removePasskey(session, only), { ok: false, reason: "last_sign_in_method" });
    assert.equal(await passkeyCount(db, alice), 1, "the last passkey survives");

    // The step-up gate still answers first.
    const stale = (await freshSession(db, alice)).session;
    assert.deepEqual(await actions.removePasskey(stale, only), { ok: false, reason: "step_up_required" });
  } finally {
    await db.close();
  }
});

test("the only passkey can be removed when an authenticator app is set up", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await createPerson(db, "last-with-app@warthog.com.au");
    await registerPasskeyFor(db, alice, createAuthenticator());
    await db.query("INSERT INTO totp_secrets (user_id, secret_enc) VALUES ($1, $2)", [alice, "opaque"]);
    const session = await steppedUpSession(db, alice);
    const only = (await actions.load(session)).passkeys[0]!.id;
    assert.deepEqual(await actions.removePasskey(session, only), { ok: true });
    assert.equal(await passkeyCount(db, alice), 0);
  } finally {
    await db.close();
  }
});

test("with two passkeys and no authenticator, one can go but never both — even removed in parallel", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const alice = await createPerson(db, "two-passkeys@warthog.com.au");
    await registerPasskeyFor(db, alice, createAuthenticator());
    await registerPasskeyFor(db, alice, createAuthenticator());
    const session = await steppedUpSession(db, alice);
    const ids = (await actions.load(session)).passkeys.map((p) => p.id);
    const results = await Promise.all(ids.map((id) => actions.removePasskey(session, id)));
    assert.equal(results.filter((r) => r.ok).length, 1, "exactly one removal goes through");
    assert.deepEqual(results.find((r) => !r.ok), { ok: false, reason: "last_sign_in_method" });
    assert.equal(await passkeyCount(db, alice), 1, "one passkey always remains");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Follow-up S3 — the screen counts the session's own waiting sign-in requests (to link to
// Settings › Security › Sign-in requests); another account's never count.
// =====================================================================================

test("the loader counts only this person's waiting sign-in requests", async () => {
  const db = await freshDb();
  try {
    const { requestNewDeviceApproval } = await import("../../../../../server/auth/new-device");
    const { issueEmailCode } = await import("../../../../../server/auth/email-code");
    const { createOutbox } = await import("../../../../../server/notify/outbox");
    const outbox = createOutbox();
    const hmacKey = new Uint8Array(32).fill(7);
    const alice = await createPerson(db, "requests-alice@warthog.com.au");
    const bob = await createPerson(db, "requests-bob@warthog.com.au");
    await issueEmailCode(db, "requests-bob@warthog.com.au", { purpose: "device", clock, random: systemRandom, hmacKey, emailSender: outbox });
    const code = outbox.list().at(-1)!.body.match(/(?<!\d)\d{6}(?!\d)/)![0];
    const started = await requestNewDeviceApproval(db, { email: "requests-bob@warthog.com.au", code, deviceLabel: "Chrome on Mac" },
      { clock, random: systemRandom, hmacKey, emailSender: outbox, pushSender: outbox });
    assert.ok(started.ok);
    const actions = makeActions(db);
    assert.equal((await actions.load((await freshSession(db, alice)).session)).pendingSignInRequests, 0);
    assert.equal((await actions.load((await freshSession(db, bob)).session)).pendingSignInRequests, 1);
  } finally {
    await db.close();
  }
});
