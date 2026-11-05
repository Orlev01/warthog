// E10-S09 — One-click disconnect (`src/server/agents/disconnect.ts`).
//
// RED-first: the disconnect seam does not exist yet, so importing `./disconnect`
// throws (ERR_MODULE_NOT_FOUND) and every test here fails until the builder writes
// it. That absence IS the point of test-first — do NOT implement anything to make
// these pass. The builder writes `disconnect.ts` afterwards to satisfy exactly this
// contract.
//
// These tests pin BEHAVIOUR (what the operation RETURNS, what it CHANGES in the
// database and the in-memory release store, what VERIFIES afterwards, and what it
// REFUSES) against an isolated in-memory PGlite with the REAL migrations
// (src/test/db) and the REAL already-built seams it composes — the OAuth store
// (createToken / resolveToken / resolveAccessKey), bearer verification
// (verifyBearer), the access-key module (issueAccessKey / verifyAccessKey), the
// agents store (createAgent / getAgentById / listAgentsForUser), the approvals store
// (createApproval / getApproval / listPendingForUser / decide), the activity writer
// (readActivity) and the in-memory release store (createReleaseStore /
// releaseKeyFor). No test asserts on the SOURCE TEXT of any module, so a later
// behaviour-preserving refactor (a rename, a moved import, a different `kind` label)
// stays green.
//
// WHY this exists (brief NFR: "WHEN a person disconnects an agent, THE SYSTEM SHALL
// refuse every subsequent request carrying that agent's credential, deny its pending
// approvals and cancel its uncollected releases before the disconnect confirmation is
// shown to the person"; brief feature "One-click disconnect — … revokes its
// credential so its very next request is refused, denies all its pending approvals,
// cancels any released-but-not-yet-collected identity detail or card, and records the
// disconnection in the activity feed"; design §6.1 "Disconnect deletes the
// connection's tokens and access keys in the same transaction that marks it
// disconnected → the next request is refused"). The person owns the agent; one switch
// kills it dead — its very next request fails and its pending work is cancelled the
// instant they disconnect it.
//
// ─── The contract this task defines (the builder implements exactly this) ─────────────
//
//   disconnectAgent(deps, session, agentId): Promise<
//       { ok: true;  … }        // the disconnect succeeded (fields beyond `ok` are the
//     | { ok: false; reason }    //   builder's; these tests assert only the outcome)
//   >
//
//   deps: {                        // every seam injected — no process.env, no secret
//     db: Db;                      //   the one db handle every write runs through
//     clock: Clock;                //   decided-at / occurred-at (never SQL now())
//     releaseStore: ReleaseStore;  //   the in-memory release store (cancel uncollected)
//     dekFor: (userId: string) => Promise<Uint8Array>;  // the user's DEK (activity write)
//   }
//   session: Session               // the acting person; the member scope is session.userId
//   agentId: string                // the agent row id (agents.id) from the agent's page
//
//   • disconnectAgent resolves the agent by (session.userId, agentId) FIRST — so another
//     person's agent id matches nothing and the call is refused ({ ok: false }) with that
//     person's agent left wholly working.
//   • In ONE transaction, before it returns, it: deletes the connection's OAuth tokens
//     AND access keys (so the next request carrying either is refused), denies the
//     connection's PENDING approvals, and records the disconnection in the activity feed
//     (source "warthog"). It also cancels the connection's uncollected release in the
//     in-memory store and marks the agent disconnected.
//   • Atomic: if any step fails, NOTHING commits — the agent stays connected, its
//     credential keeps verifying and its pending approvals stay pending.
//   • A malformed / oversized agent id throws a 4xx HttpError at the boundary before any
//     write; a SQL-injection probe in the id is refused there (not a valid uuid), so the
//     tables survive and no query is altered (parameter binding, INV-102).
//   • No ambient env value is folded into the confirmation or the recorded activity
//     (INV-103): the operation is a pure function of its injected seams.
//
// ─── Acceptance criteria → tests ──────────────────────────────────────────────────────
//   AC1/AC2  after disconnect the credential is refused, pending approvals are denied,
//            the uncollected release is cancelled, the disconnection is in the feed, and
//            the agent is marked disconnected — ALL before the confirmation returns.
//   AC2      only THIS agent is affected (another agent's work survives); only PENDING
//            approvals are denied; and the whole thing is atomic (a mid-way failure
//            commits nothing).
//   AC3      a person cannot disconnect another person's agent (filtered by session user
//            id); the other person's agent is wholly untouched.
//   AC4      a malformed / oversized id is rejected with a 4xx; a SQLi probe cannot alter
//            a query (the tables survive and nothing is disconnected).
//   AC5      no secret value is folded into the confirmation or the recorded activity.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// builds its own freshDb(). The signed-in person is a REAL user row (foreign keys point
// at users(id)), so the session's id is one `createUser` minted — never a bare uuid that
// would trip the foreign key. Each person gets a fresh random 256-bit DEK (the injected
// `dekFor` returns it and the tests read activity / approvals back with the same bytes).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { disconnectAgent } from "./disconnect";

import { createToken, resolveToken, resolveAccessKey } from "../oauth/store";
import { issueAccessKey, verifyAccessKey } from "../oauth/access-key";
import { verifyBearer } from "../oauth/verify-bearer";
import { createAgent, getAgentById, listAgentsForUser } from "../db/agents";
import {
  createApproval,
  getApproval,
  listPendingForUser,
  decide,
} from "../db/approvals";
import { createUser } from "../db/users";
import { readActivity } from "../activity/writer";
import { createReleaseStore, type ReleaseStore } from "../crypto/release-store";
import { releaseKeyFor } from "../mcp/tools/collect-release";
import { HttpError } from "../http/validate";
import { loadConfig } from "../config";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import type { Session } from "../auth/session";

// A frozen instant so decided-at / occurred-at are deterministic (the flow takes an
// injected clock, never SQL now()).
const NOW = new Date("2026-06-01T00:00:00.000Z");

// An access token's life (design §6.1: 1 hour) — long enough that the token is live at
// NOW, so a FAILURE to verify after disconnect can only mean the token was revoked.
const TOKEN_TTL_MS = 60 * 60 * 1000;

// Each person's unwrapped 256-bit DEK, keyed by user id. The injected `dekFor` returns
// it, and the tests read the activity feed / approvals back with the same bytes.
const deks = new Map<string, Uint8Array>();
async function dekFor(userId: string): Promise<Uint8Array> {
  const dek = deks.get(userId);
  if (dek === undefined) throw new Error(`test setup: no DEK registered for ${userId}`);
  return dek;
}

// SHA-256 hex — the contract tokens are stored under (never the raw bearer).
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// A plain signed-in session for `userId` — the member scope is session.userId; the rest
// is irrelevant to the disconnect. Stepped-up state is left null (disconnect is a single
// confirm in the app, not a sensitive re-auth).
function sessionFor(userId: string): Session {
  return {
    id: `sess-${userId}`,
    userId,
    createdAt: new Date(NOW.getTime() - 60_000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    steppedUpAt: null,
  };
}

// Create a real person, register their DEK, and return their id. Every member-scoped row
// (the agent, its approvals, its activity) hangs off this id.
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  deks.set(user.id, randomBytes(32));
  return user.id;
}

// Connect an agent for `userId`: a fresh server-minted connection id, status connected.
// Returns the created agent (its row id is distinct from its connection id, so the tests
// exercise the real two-id model — the UI hands the ROW id to disconnect).
async function connectAgent(db: Db, userId: string, name = "My Grok", platform = "grok") {
  return createAgent(
    db,
    { userId, connectionId: randomUUID(), displayName: name, platform, status: "connected" },
    fixedClock(NOW),
  );
}

// Issue an OAuth access token bound to a connection; returns the RAW bearer (stored only
// as its hash, the same contract /oauth/token mints under). Live at NOW.
async function issueToken(db: Db, connectionId: string): Promise<string> {
  const raw = `tok_${randomUUID()}`;
  await createToken(db, {
    tokenHash: sha256Hex(raw),
    connectionId,
    kind: "access",
    expiresAt: new Date(NOW.getTime() + TOKEN_TTL_MS),
  });
  return raw;
}

// Issue a per-agent access key bound to a connection; returns the RAW `wh_ak_` bearer.
async function issueKey(db: Db, connectionId: string): Promise<string> {
  const { key } = await issueAccessKey(db, { connectionId }, { random: systemRandom });
  return key;
}

// Seed a PENDING approval for `userId`'s connection (the pipeline stores approvals keyed
// by the requesting connection). The detail carries a unique token so a leak would be
// unambiguous. Returns the approval id.
async function seedPending(
  db: Db,
  userId: string,
  connectionId: string,
  token: string,
): Promise<string> {
  const approval = await createApproval(
    db,
    {
      userId,
      agentId: connectionId,
      detail: {
        recipient: `recipient-${token}@secret.example`,
        amount: "42.00 AUD",
        field: `passport_number_${token}`,
      },
    },
    await dekFor(userId),
    fixedClock(NOW),
  );
  return approval.id;
}

// The release store key for a connection — through the SAME scheme the collector uses
// (one source of truth), so a value put here is exactly where disconnect must cancel it.
function releaseKey(userId: string, connectionId: string): string {
  return releaseKeyFor({ userId, connectionId, agentId: connectionId, active: true });
}

// A request to the protected resource carrying `cred` as a Bearer — the agent's very
// next request. The host deliberately differs from the configured base URL.
function bearerRequest(cred: string): Request {
  return new Request("https://request-host.invalid/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${cred}` },
  });
}

// A real Config via the one env seam, with a minimal DEVELOPMENT env (pglite is allowed
// in dev), so verifyBearer can run without a fully-populated production environment.
function configForVerify() {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "https://warthog.example",
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
    WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
  } as NodeJS.ProcessEnv);
}

// Whether the agent's next request carrying `cred` is accepted (true) or refused (false)
// — the real request-time check (verifyBearer), so "the next request is refused" is read
// exactly as the protected resource reads it.
async function nextRequestAccepted(db: Db, cred: string): Promise<boolean> {
  const verification = await verifyBearer(bearerRequest(cred), {
    db,
    config: configForVerify(),
    clock: fixedClock(NOW),
  });
  return verification.ok;
}

// The disconnect deps with the real seams: the one db handle, a frozen clock, the given
// release store, and the per-user DEK lookup.
function disconnectDeps(db: Db, releaseStore: ReleaseStore) {
  return { db, clock: fixedClock(NOW), releaseStore, dekFor };
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the
// relation name when it exists and NULL when it does not — a non-throwing probe scoped to
// the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Assert that awaiting `fn()` rejects with a 4xx HttpError (the validation boundary).
async function assertRejects4xx(label: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    assert.ok(
      err instanceof HttpError,
      `${label}: malformed input must be rejected at the validation boundary (HttpError), got ${String(err)}`,
    );
    assert.ok(
      (err as HttpError).status >= 400 && (err as HttpError).status < 500,
      `${label}: the rejection must carry a 4xx status, got ${(err as HttpError).status}`,
    );
  }
  assert.ok(threw, `${label}: malformed input must be rejected (nothing was thrown)`);
}

// Resolve either the thrown error or the returned value of a disconnect — used where a
// mid-way failure may surface as a throw OR a refusal; either way it is NOT a success.
async function outcomeOf<T>(
  fn: () => Promise<T>,
): Promise<{ threw: true } | { threw: false; value: T }> {
  try {
    return { threw: false, value: await fn() };
  } catch {
    return { threw: true };
  }
}

// =====================================================================================
// AC1/AC2 — the whole guarantee, BEFORE the confirmation returns: by the time
// disconnectAgent resolves, the agent's next request (OAuth token AND access key) is
// refused, its pending approvals are denied, its uncollected release is cancelled, the
// disconnection is in the activity feed, and the agent is marked disconnected.
// =====================================================================================

test("disconnect refuses the next request, denies pending approvals, cancels the release, records the disconnection and marks the agent disconnected — all before it returns", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "owner");
    const agent = await connectAgent(db, userId);
    const connectionId = agent.connectionId;

    // The connection's two credential kinds, both live before disconnect.
    const token = await issueToken(db, connectionId);
    const key = await issueKey(db, connectionId);
    assert.equal(await nextRequestAccepted(db, token), true, "the OAuth token is accepted before disconnect");
    assert.equal(await nextRequestAccepted(db, key), true, "the access key is accepted before disconnect");

    // Two pending approvals for this connection, waiting in the inbox.
    const approvalA = await seedPending(db, userId, connectionId, "a");
    const approvalB = await seedPending(db, userId, connectionId, "b");
    assert.equal(
      (await listPendingForUser(db, userId, await dekFor(userId))).length,
      2,
      "both approvals are pending before disconnect",
    );

    // An uncollected release sitting in the in-memory store for this connection.
    const releaseStore = createReleaseStore(fixedClock(NOW));
    releaseStore.put(releaseKey(userId, connectionId), "secret-passport-value");

    // Disconnect. Everything below is asserted with NO further awaits on background work
    // — the guarantee is that it is all done by the time this resolves.
    const result = await disconnectAgent(disconnectDeps(db, releaseStore), sessionFor(userId), agent.id);
    assert.ok(result.ok, "disconnecting one's own connected agent succeeds");
    if (!result.ok) throw new Error("unreachable: disconnect was not ok");

    // The agent's very next request — on EITHER credential — is refused.
    assert.equal(await nextRequestAccepted(db, token), false, "the next request carrying the OAuth token is refused");
    assert.equal(await nextRequestAccepted(db, key), false, "the next request carrying the access key is refused");
    assert.equal(await resolveToken(db, sha256Hex(token)), null, "the connection's OAuth tokens are gone");
    assert.equal(await verifyAccessKey(db, key), null, "the connection's access key no longer verifies");

    // Its pending approvals are denied — gone from the inbox, each recorded denied.
    assert.deepEqual(
      await listPendingForUser(db, userId, await dekFor(userId)),
      [],
      "no approvals remain pending after disconnect",
    );
    for (const id of [approvalA, approvalB]) {
      const decided = await getApproval(db, userId, id, await dekFor(userId));
      assert.ok(decided != null, "the approval is still readable (denied, not deleted)");
      assert.equal(decided!.status, "denied", "the pending approval is denied");
      assert.ok(decided!.decidedAt != null, "a denied approval carries a decided-at time");
    }

    // Its uncollected release is cancelled — the agent can never collect it.
    assert.equal(
      releaseStore.collect(releaseKey(userId, connectionId)),
      undefined,
      "the uncollected release is cancelled (collecting it afterwards finds nothing)",
    );

    // The disconnection is in the activity feed: a Warthog-written entry naming the agent.
    const feed = await readActivity(db, userId, await dekFor(userId));
    const disconnectEntries = feed.filter(
      (e) =>
        e.source === "warthog" &&
        `${e.kind} ${e.outcome ?? ""}`.toLowerCase().includes("disconnect"),
    );
    assert.equal(disconnectEntries.length, 1, "exactly one disconnection entry is recorded in the feed");
    const entry = disconnectEntries[0]!;
    assert.ok(
      entry.agentId === agent.id || entry.agentId === connectionId,
      "the disconnection entry names the agent that was disconnected",
    );

    // And the agent itself is marked disconnected (so the policy engine denies it).
    const after = await getAgentById(db, userId, agent.id);
    assert.ok(after != null, "the agent row still exists after disconnect");
    assert.equal(after!.status, "disconnected", "the agent is marked disconnected");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — the blast radius is exactly one connection: disconnecting agent A leaves agent
// B's credential, pending approval and uncollected release wholly untouched.
// =====================================================================================

test("disconnect affects only the named agent — another of the person's agents keeps working", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "two-agents");
    const agentA = await connectAgent(db, userId, "Agent A");
    const agentB = await connectAgent(db, userId, "Agent B");

    const keyA = await issueKey(db, agentA.connectionId);
    const keyB = await issueKey(db, agentB.connectionId);
    const pendingB = await seedPending(db, userId, agentB.connectionId, "b-survives");

    const releaseStore = createReleaseStore(fixedClock(NOW));
    releaseStore.put(releaseKey(userId, agentA.connectionId), "A-value");
    releaseStore.put(releaseKey(userId, agentB.connectionId), "B-value");

    const result = await disconnectAgent(disconnectDeps(db, releaseStore), sessionFor(userId), agentA.id);
    assert.ok(result.ok, "disconnecting agent A succeeds");

    // Agent A is cut off…
    assert.equal(await nextRequestAccepted(db, keyA), false, "agent A's next request is refused");
    // …while agent B is wholly untouched: credential, approval and release all intact.
    assert.equal(await nextRequestAccepted(db, keyB), true, "agent B's credential keeps working");
    const stillPending = await listPendingForUser(db, userId, await dekFor(userId));
    assert.equal(stillPending.length, 1, "agent B's approval is still pending");
    assert.equal(stillPending[0]!.id, pendingB, "the surviving pending approval is agent B's");
    assert.equal(
      releaseStore.collect(releaseKey(userId, agentB.connectionId)),
      "B-value",
      "agent B's uncollected release is not cancelled",
    );
    assert.equal(
      (await getAgentById(db, userId, agentB.id))!.status,
      "connected",
      "agent B stays connected",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — disconnect denies only the connection's PENDING approvals; an already-decided
// approval is left exactly as the person left it (it is not re-stamped denied).
// =====================================================================================

test("disconnect denies only pending approvals — an already-approved one is left untouched", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "mixed-approvals");
    const agent = await connectAgent(db, userId);
    const connectionId = agent.connectionId;

    const pending = await seedPending(db, userId, connectionId, "pending");
    const alreadyApproved = await seedPending(db, userId, connectionId, "approved");
    await decide(
      db,
      { userId, id: alreadyApproved, decision: { status: "approved" } },
      await dekFor(userId),
      fixedClock(NOW),
    );

    const releaseStore = createReleaseStore(fixedClock(NOW));
    const result = await disconnectAgent(disconnectDeps(db, releaseStore), sessionFor(userId), agent.id);
    assert.ok(result.ok, "disconnect succeeds");

    assert.equal(
      (await getApproval(db, userId, pending, await dekFor(userId)))!.status,
      "denied",
      "the pending approval is denied",
    );
    assert.equal(
      (await getApproval(db, userId, alreadyApproved, await dekFor(userId)))!.status,
      "approved",
      "the already-approved approval is left as it was (not clobbered to denied)",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — all in ONE transaction: if recording the disconnection fails part-way, NOTHING
// commits. A db whose activity INSERT throws stands in for any mid-transaction failure;
// afterwards the agent is still connected, its credential still verifies and its pending
// approval is still pending — no half-disconnected state, and no success confirmation.
// =====================================================================================

test("a failure while recording the disconnection commits nothing — the agent stays fully connected", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "atomic");
    const agent = await connectAgent(db, userId);
    const connectionId = agent.connectionId;

    const key = await issueKey(db, connectionId);
    const pending = await seedPending(db, userId, connectionId, "atomic");

    // A db that forwards every statement to the real PGlite EXCEPT the activity insert,
    // which it fails — simulating a mid-transaction error. BEGIN / the writes / ROLLBACK
    // all forward to the SAME underlying connection, so a correct transaction rolls the
    // earlier writes back; a non-transactional sequence leaves them committed (caught
    // here, because the activity write is the last step per the brief's ordering).
    const failing: Db = {
      query(text: string, values?: unknown[]) {
        if (/insert\s+into\s+activity_entries/i.test(text)) {
          return Promise.reject(new Error("injected failure: activity write failed"));
        }
        return db.query(text, values);
      },
      close() {
        return Promise.resolve();
      },
    };

    const releaseStore = createReleaseStore(fixedClock(NOW));
    const outcome = await outcomeOf(() =>
      disconnectAgent(disconnectDeps(failing, releaseStore), sessionFor(userId), agent.id),
    );

    // It is NOT a success — either it threw or it refused, never { ok: true }.
    let succeeded = false;
    if (!outcome.threw) succeeded = outcome.value.ok === true;
    assert.ok(!succeeded, "a failed disconnect never returns a success confirmation");

    // Read the post-state through the REAL handle: nothing was committed.
    assert.equal(await nextRequestAccepted(db, key), true, "the credential still verifies — its revocation rolled back");
    assert.equal(
      (await getApproval(db, userId, pending, await dekFor(userId)))!.status,
      "pending",
      "the approval is still pending — its denial rolled back",
    );
    assert.equal(
      (await getAgentById(db, userId, agent.id))!.status,
      "connected",
      "the agent is still connected — the disconnect did not half-commit",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a person cannot disconnect ANOTHER person's agent. Bob, holding Alice's real
// agent id, disconnects nothing: Alice's credential, approval, release and agent status
// are all untouched, and nothing is recorded under either person.
// =====================================================================================

test("a person cannot disconnect another person's agent — the other person's agent keeps working", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "victim");
    const bob = await makeUser(db, "attacker");
    const aliceAgent = await connectAgent(db, alice, "Alice's Claude");

    const aliceKey = await issueKey(db, aliceAgent.connectionId);
    const alicePending = await seedPending(db, alice, aliceAgent.connectionId, "alice");

    const releaseStore = createReleaseStore(fixedClock(NOW));
    releaseStore.put(releaseKey(alice, aliceAgent.connectionId), "alice-value");

    // Bob, signed in as himself, tries to disconnect Alice's agent by its real id.
    const attempt = await disconnectAgent(
      disconnectDeps(db, releaseStore),
      sessionFor(bob),
      aliceAgent.id,
    );
    assert.equal(attempt.ok, false, "disconnecting another person's agent reports failure, not a silent success");

    // Alice's agent is wholly untouched.
    assert.equal(await nextRequestAccepted(db, aliceKey), true, "Alice's credential keeps working");
    assert.equal(
      (await getApproval(db, alice, alicePending, await dekFor(alice)))!.status,
      "pending",
      "Alice's approval is still pending",
    );
    assert.equal(
      releaseStore.collect(releaseKey(alice, aliceAgent.connectionId)),
      "alice-value",
      "Alice's uncollected release is not cancelled",
    );
    assert.equal(
      (await getAgentById(db, alice, aliceAgent.id))!.status,
      "connected",
      "Alice's agent stays connected",
    );

    // And nothing was recorded under either person.
    assert.deepEqual(await readActivity(db, alice, await dekFor(alice)), [], "nothing recorded under Alice");
    assert.deepEqual(await readActivity(db, bob, await dekFor(bob)), [], "nothing recorded under Bob");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — a malformed / oversized agent id is rejected with a 4xx at the validation
// boundary, before anything is disconnected (the real agent stays fully connected).
// =====================================================================================

test("a malformed or oversized agent id is rejected with a 4xx and nothing is disconnected", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "malformed");
    const agent = await connectAgent(db, userId);
    const key = await issueKey(db, agent.connectionId);
    const releaseStore = createReleaseStore(fixedClock(NOW));

    await assertRejects4xx("disconnect(not-a-uuid)", () =>
      disconnectAgent(disconnectDeps(db, releaseStore), sessionFor(userId), "not-a-uuid"),
    );
    await assertRejects4xx("disconnect(oversized)", () =>
      disconnectAgent(disconnectDeps(db, releaseStore), sessionFor(userId), "x".repeat(100_000)),
    );

    // The real agent is untouched — its credential still verifies and it stays connected.
    assert.equal(await nextRequestAccepted(db, key), true, "a rejected disconnect leaves the credential working");
    assert.equal(
      (await getAgentById(db, userId, agent.id))!.status,
      "connected",
      "a rejected disconnect leaves the agent connected",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — a SQL-injection probe in the agent id is refused at the boundary (not a valid
// uuid), so it never reaches a query as a cast and the tables it names survive.
// =====================================================================================

test("a SQL-injection probe in the agent id is refused and the tables survive (parameter binding)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "sqli");
    const agent = await connectAgent(db, userId);
    const key = await issueKey(db, agent.connectionId);
    const releaseStore = createReleaseStore(fixedClock(NOW));

    await assertRejects4xx("disconnect(sqli id)", () =>
      disconnectAgent(
        disconnectDeps(db, releaseStore),
        sessionFor(userId),
        "x'; DROP TABLE agents; --",
      ),
    );

    // The probe altered no query — the tables it tried to drop are all still there.
    assert.equal(await tableExists(db, "agents"), true, "the agents table survives the SQLi probe");
    assert.equal(await tableExists(db, "approvals"), true, "the approvals table survives the SQLi probe");
    assert.equal(await tableExists(db, "oauth_tokens"), true, "the oauth_tokens table survives the SQLi probe");

    // And the real agent is still connected and reachable.
    assert.equal(await nextRequestAccepted(db, key), true, "the real agent's credential still verifies");
    assert.equal((await listAgentsForUser(db, userId)).length, 1, "the real agent is still there");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC5 — no ambient env value is folded into the confirmation or the recorded activity:
// the operation is a pure function of its injected seams (INV-103). A decoy secret in
// the environment must not surface in the result or in the disconnection entry.
// =====================================================================================

test("no ambient env secret lands in the confirmation or the recorded disconnection", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "decoy");
    const agent = await connectAgent(db, userId);
    await issueKey(db, agent.connectionId);
    const releaseStore = createReleaseStore(fixedClock(NOW));

    const result = await disconnectAgent(disconnectDeps(db, releaseStore), sessionFor(userId), agent.id);
    assert.ok(result.ok, "the disconnect succeeds with the decoy env var present");

    assert.ok(
      !JSON.stringify(result).includes(DECOY),
      "no ambient env value is folded into the confirmation",
    );

    const feed = await readActivity(db, userId, await dekFor(userId));
    assert.ok(
      !JSON.stringify(feed).includes(DECOY),
      "no ambient env value is folded into the recorded disconnection",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
