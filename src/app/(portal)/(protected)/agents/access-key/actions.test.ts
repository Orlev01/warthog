// E10-S06 — Per-agent access key creation
// (`src/app/(portal)/(protected)/agents/access-key/actions.ts`).
//
// RED-first: the access-key-flow seam does not exist yet, so importing `./actions`
// throws (ERR_MODULE_NOT_FOUND) and every test here fails until the builder adds it.
// That absence IS the point of test-first — do NOT implement anything to make these
// pass. The builder writes `actions.ts` afterwards to satisfy exactly this contract.
//
// These tests pin BEHAVIOUR (what the flow RETURNS, what it CHANGES in the database,
// what VERIFIES afterwards, and what it REFUSES) against an isolated in-memory PGlite
// with the REAL migrations (src/test/db) and the REAL already-built seams it composes
// — the access-key module (verifyAccessKey), the OAuth store (resolveAccessKey), the
// agents store (getAgentById / listAgentsForUser) and the agent-permissions store
// (getConnectionPermissions). No test asserts on the source text of any module, so a
// later behaviour-preserving refactor (a rename, a moved import) must stay green.
//
// Where the task names an entry/route-group file, the testable seam lives in the plain
// SIBLING module `actions.ts` (the convention's `createXActions(deps)` factory, as
// `settings/security/actions.ts` and `oauth/authorize/actions.ts` do) — never on the
// thin `"use server"` wrappers in `page.tsx`, which may export only their framework
// fields (`next build` rejects any other export, OBS-025). These tests drive that
// factory directly with real seams; the page wires thin wrappers over it.
//
// WHY this exists (brief "Connect an agent" / "For a platform that cannot use the
// standard connector sign-in, 'Create an access key' lets the person name the agent
// and set its permissions on the same screen as the consent screen, shows the key once
// with a copy button, and lets them revoke or replace the key later from that agent's
// page"; design §6.1; constitution 16 — each agent has its own revocable credential, a
// per-agent access key where a platform cannot use the connector flow). The access-key
// flow is the consent flow's twin: instead of issuing an OAuth code, it mints a static
// `wh_ak_` bearer. Everything else is the same per-agent, per-connection model.
//
// ─── The contract this task defines (the builder implements exactly this) ─────────────
//
//   createAccessKeyActions(deps): {
//     create(session, input):   Promise<{ ok: true; agentId; key } | { ok: false; reason }>
//     revoke(session, agentId): Promise<{ ok: true }        | { ok: false; reason }>
//     replace(session, agentId):Promise<{ ok: true; key }   | { ok: false; reason }>
//   }
//
//   deps:  { db: Db; clock: Clock; random: Random }   // no config — no OAuth issuer here
//   input: AccessKeyInput = {                          // the same shape the consent screen
//     name: string;                                    //   submits (set permissions "on the
//     platform: string;                                //   same screen as the consent screen")
//     template: string;                                //   "minimal" | "standard" | "custom"
//     tickedServices?: readonly string[];
//     highTier?: boolean;                              // always opt-in (off unless true)
//     card?: boolean;                                  // always opt-in; needs a budget when on
//     cardBudget?: { amount: number; currency: string; period: string } | null;
//     learningSharing?: boolean;                       // always opt-in (off unless true)
//   }
//
//   • create names ONE agent for session.userId linked to a server-minted connection id,
//     upserts that connection's chosen permissions, and issues a per-agent access key —
//     returning the RAW key ONCE (`key`) plus the created `agentId`. The raw key is never
//     stored (only a derived/hashed form); it verifies as a bearer to that one connection.
//   • revoke/replace resolve the agent by (session.userId, agentId) FIRST — so another
//     person's agent id matches nothing and the call is refused ({ ok: false }) with that
//     person's key left working. revoke stops the key verifying; replace stops the old key
//     and hands back a fresh one bound to the same connection.
//   • the acting user id is ALWAYS session.userId, never a value smuggled in the input.
//   • malformed / oversized input throws a 4xx HttpError before anything is written; a
//     SQL-injection probe in an input field is bound as data (the table survives).
//   • no secret is baked into the flow: the key is minted from the injected randomness
//     seam (distinct every issue), and no ambient env value lands in any output (INV-103).
//
// ─── Acceptance criteria → tests ──────────────────────────────────────────────────────
//   AC1 create names the agent, applies its permissions and shows the key EXACTLY ONCE;
//       the key is stored only hashed (the raw key is not the stored key) and verifies.
//   AC2 revoking or replacing the key refuses the old key's next request.
//   AC3 the key belongs to the session user's agent, and cannot be created or revoked for
//       another user's agent.
//   AC4 malformed/oversized input is rejected with a 4xx; a SQLi probe cannot alter a query.
//   AC5 no secret is folded into the output; the key is minted fresh (not a fixed literal).
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// builds its own freshDb(). The signed-in person is a REAL user row (agents.user_id and
// agent_permissions.user_id are foreign keys to users(id)), so the session's id is one
// `createUser` minted — never a bare uuid that would trip the foreign key. Entropy (the
// access keys) is drawn from the REAL randomness seam so two issues never collide.

import { createConnection } from "@/server/db/connections";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createAccessKeyActions, type AccessKeyInput } from "./actions";

import { verifyAccessKey } from "../../../../../server/oauth/access-key";
import { resolveAccessKey } from "../../../../../server/oauth/store";
import { getAgentById, listAgentsForUser } from "../../../../../server/db/agents";
import { getConnectionPermissions } from "../../../../../server/db/agent-permissions";
import { createUser } from "../../../../../server/db/users";
import { HttpError } from "../../../../../server/http/validate";
import { fixedClock } from "../../../../../server/seams/clock";
import { systemRandom } from "../../../../../server/seams/random";
import { freshDb } from "../../../../../test/db";
import type { Db } from "../../../../../server/db/index";
import type { Session } from "../../../../../server/auth/session";

// The prefix every access key carries (design §6.1: `wh_ak_` + 32 base62 bytes), kept
// here so the tests read it without re-typing the literal.
const PREFIX = "wh_ak_";

// A frozen instant so the agent's connected-at is deterministic (the flow takes an
// injected clock, never SQL now()).
const NOW = new Date("2026-06-01T00:00:00.000Z");

// Build the access-key actions under test with the real seams: a frozen clock and the
// real randomness source (so two issued keys never collide across tests).
function makeActions(db: Db) {
  return createAccessKeyActions({ db, clock: fixedClock(NOW), random: systemRandom });
}

// A stand-in wrapped DEK for createUser (opaque base64; never read here).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a real person and return their id. Every member-scoped row (the agent, its
// permissions) hangs off this id, which must exist in `users` for the foreign keys.
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek: wrappedDekFor(who) });
  return user.id;
}

// A plain signed-in session for `userId` — the page resolves this from the
// `__Host-wh_session` cookie; the seam only needs its user id. Stepped-up state is
// irrelevant to the access-key flow (it is the consent screen's twin, not a sensitive
// re-auth), so it is left null.
function sessionFor(userId: string): Session {
  return {
    id: `sess-${userId}`,
    userId,
    createdAt: new Date(NOW.getTime() - 60_000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    steppedUpAt: null,
  };
}

// A valid access-key create input, overridable per test. The extra-key escape hatch
// lets a test smuggle a rogue `userId` into the input (AC3) without a type error —
// exactly what an untrusted form body could carry.
function input(
  overrides: Partial<AccessKeyInput> & Record<string, unknown> = {},
): AccessKeyInput {
  return { name: "My Grok", platform: "grok", template: "standard", ...overrides } as AccessKeyInput;
}

// Resolve the connection a created agent is bound to, through the REAL agents store
// (member-scoped), so a test reads the stored key / permissions by the same connection
// the flow bound them to — never by grepping SQL.
async function connectionIdOfAgent(db: Db, userId: string, agentId: string): Promise<string> {
  const agent = await getAgentById(db, userId, agentId);
  assert.ok(agent != null, "the created agent is readable for its owner");
  return agent!.connectionId;
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the
// relation name when it exists and NULL when it does not — a non-throwing probe scoped
// to the one table under test (behaviour, not source text).
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

// =====================================================================================
// AC1 — create names the agent, applies its permissions, and shows the key EXACTLY ONCE:
// the returned key is a `wh_ak_` bearer that VERIFIES to the agent's connection, yet the
// RAW key is never the stored key (only a derived/hashed form was persisted).
// =====================================================================================

test("create names the agent, applies its chosen permissions, and issues a working access key shown once", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "create-ok");
    const actions = makeActions(db);

    await createConnection(db, { userId, connectorId: "gmail", accountLabel: "My account", credentials: { api_key: "test" } }, randomBytes(32), fixedClock(NOW));

    const result = await actions.create(
      sessionFor(userId),
      input({
        name: "My Grok",
        platform: "grok",
        template: "standard",
        tickedServices: ["gmail"],
        highTier: true,
        learningSharing: true,
      }),
    );

    assert.ok(result.ok, "creating an access key for a valid request succeeds");
    if (!result.ok) throw new Error("unreachable: create was not ok");

    // The key is handed back ONCE, as a `wh_ak_` bearer with a high-entropy suffix.
    assert.equal(typeof result.key, "string", "a raw access key is handed back");
    assert.ok(result.key.startsWith(PREFIX), `the key carries the access-key prefix, got: ${result.key}`);
    assert.ok(
      result.key.length > PREFIX.length + 16,
      `the key carries a high-entropy suffix, got length ${result.key.length}`,
    );

    // Exactly one agent was created for this person, named and platform as chosen.
    const agents = await listAgentsForUser(db, userId);
    assert.equal(agents.length, 1, "create names exactly one agent");
    const agent = agents[0]!;
    assert.equal(agent.id, result.agentId, "the returned agentId is the agent that was created");
    assert.equal(agent.userId, userId, "the agent belongs to the signed-in person");
    assert.equal(agent.displayName, "My Grok", "the agent is named as the person chose");
    assert.equal(agent.platform, "grok", "the chosen platform is recorded");
    assert.equal(agent.status, "connected", "a freshly created access-key agent is connected");

    // The chosen permissions were applied for that connection (the opt-ins reflect the
    // input exactly, and a ticked service's read tools were granted).
    const connectionId = agent.connectionId;
    const grants = await getConnectionPermissions(db, userId, connectionId);
    assert.ok(grants != null, "the chosen permissions are upserted for the connection");
    assert.equal(grants!.highTierAccess, true, "opting in turns high-tier access on");
    assert.equal(grants!.sharing, true, "opting in turns sharing-what-it-learns on");
    assert.equal(grants!.cardAccess, false, "card access stays off when not opted in");
    assert.equal(grants!.cardBudget, null, "no card budget is recorded when card access is off");
    assert.ok(
      grants!.grantedConnectors.includes("gmail"),
      "a ticked service's grant is applied to the connection",
    );

    // The key VERIFIES as a bearer, resolving to the SAME connection the agent is bound to.
    const verified = await verifyAccessKey(db, result.key);
    assert.ok(verified != null, "the issued key verifies as a bearer");
    assert.equal(verified!.connectionId, connectionId, "the key verifies to the agent's own connection");

    // "Stored only hashed": the RAW key is not the stored natural key (resolving the raw
    // value finds nothing) — what was persisted is a derived/hashed form. Proven WITHOUT
    // pinning the hash algorithm.
    assert.equal(
      await resolveAccessKey(db, result.key),
      null,
      "the raw access key is never a stored key — only a derived/hashed form is persisted",
    );
  } finally {
    await db.close();
  }
});

test("a Minimal set leaves high-tier, card access and sharing off", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "create-minimal");
    const actions = makeActions(db);

    const result = await actions.create(sessionFor(userId), input({ template: "minimal" }));
    assert.ok(result.ok, "a Minimal create succeeds");
    if (!result.ok) throw new Error("unreachable");

    const connectionId = await connectionIdOfAgent(db, userId, result.agentId);
    const grants = await getConnectionPermissions(db, userId, connectionId);
    assert.ok(grants != null, "permissions were written");
    assert.equal(grants!.highTierAccess, false, "Minimal does not grant high-tier access");
    assert.equal(grants!.cardAccess, false, "Minimal does not grant card access");
    assert.equal(grants!.sharing, false, "Minimal does not grant sharing-what-it-learns");
    assert.equal(grants!.cardBudget, null, "Minimal sets no card budget");

    // The key still works regardless of how narrow the permission set is.
    assert.ok(await verifyAccessKey(db, result.key), "a Minimal agent's key still verifies as a bearer");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — revoking the key refuses the old key's next request: after revoke, the key that
// was verifying no longer verifies.
// =====================================================================================

test("revoking the key stops it verifying (its next request is refused)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "revoke-ok");
    const actions = makeActions(db);

    const created = await actions.create(sessionFor(userId), input());
    assert.ok(created.ok, "create succeeds");
    if (!created.ok) throw new Error("unreachable");

    // The key verifies before revocation.
    assert.ok(await verifyAccessKey(db, created.key), "the issued key verifies before revocation");

    const revoked = await actions.revoke(sessionFor(userId), created.agentId);
    assert.equal(revoked.ok, true, "the owner may revoke their own agent's key");

    // …and no longer verifies after it (the next request is refused).
    assert.equal(
      await verifyAccessKey(db, created.key),
      null,
      "the revoked key no longer verifies — the next request is refused",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — replacing the key refuses the OLD key's next request and the NEW key verifies to
// the same connection (so the agent keeps working under a fresh credential).
// =====================================================================================

test("replacing the key refuses the old key and the new key verifies to the same connection", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "replace-ok");
    const actions = makeActions(db);

    const created = await actions.create(sessionFor(userId), input());
    assert.ok(created.ok, "create succeeds");
    if (!created.ok) throw new Error("unreachable");
    const oldKey = created.key;
    const connectionId = await connectionIdOfAgent(db, userId, created.agentId);

    const replaced = await actions.replace(sessionFor(userId), created.agentId);
    assert.equal(replaced.ok, true, "the owner may replace their own agent's key");
    if (!replaced.ok) throw new Error("unreachable");

    const newKey = replaced.key;
    assert.equal(typeof newKey, "string", "replace hands back a fresh raw key");
    assert.ok(newKey.startsWith(PREFIX), "the fresh key carries the access-key prefix");
    assert.notEqual(newKey, oldKey, "the fresh key differs from the old one");

    // The OLD key's next request is refused…
    assert.equal(
      await verifyAccessKey(db, oldKey),
      null,
      "after replacement the old key no longer verifies",
    );
    // …and the NEW key verifies to the SAME connection (the agent keeps working).
    const verified = await verifyAccessKey(db, newKey);
    assert.ok(verified != null, "the fresh key verifies as a bearer");
    assert.equal(
      verified!.connectionId,
      connectionId,
      "the fresh key verifies to the same connection the agent is bound to",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — the agent (and its key) is created under the SESSION user, never a user id
// smuggled into the untrusted input.
// =====================================================================================

test("the agent is created under the session user, never a user id smuggled in the input", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "owner");
    const attacker = await makeUser(db, "attacker");
    const actions = makeActions(db);

    const result = await actions.create(
      sessionFor(sessionUser),
      // The untrusted input smuggles the attacker's user id; the flow must ignore it.
      input({ userId: attacker, name: "Theirs", platform: "grok", template: "standard" }),
    );
    assert.ok(result.ok, "the create succeeds");
    if (!result.ok) throw new Error("unreachable");

    assert.equal(
      (await listAgentsForUser(db, sessionUser)).length,
      1,
      "the agent is recorded under the SESSION user",
    );
    assert.deepEqual(
      await listAgentsForUser(db, attacker),
      [],
      "and never under a user id smuggled in the input",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a member can never revoke ANOTHER person's agent's key by id. Bob, holding
// Alice's real agent id, revokes nothing: Alice's key keeps working.
// =====================================================================================

test("a member cannot revoke another person's agent key — the other person's key keeps working", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "revoke-victim");
    const bob = await makeUser(db, "revoke-attacker");
    const actions = makeActions(db);

    const aliceKey = await actions.create(sessionFor(alice), input({ name: "Alice Grok" }));
    assert.ok(aliceKey.ok, "Alice creates her access key");
    if (!aliceKey.ok) throw new Error("unreachable");

    // Bob tries to revoke Alice's agent by its real id.
    const attempt = await actions.revoke(sessionFor(bob), aliceKey.agentId);
    assert.equal(attempt.ok, false, "revoking another person's agent reports failure, not a silent success");

    // Alice's key is untouched — it still verifies.
    assert.ok(
      await verifyAccessKey(db, aliceKey.key),
      "Alice's key keeps working after Bob's revoke attempt",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a member can never replace ANOTHER person's agent's key by id. Bob's replace of
// Alice's agent issues nothing and leaves Alice's original key working.
// =====================================================================================

test("a member cannot replace another person's agent key — the other person's key keeps working", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "replace-victim");
    const bob = await makeUser(db, "replace-attacker");
    const actions = makeActions(db);

    const aliceKey = await actions.create(sessionFor(alice), input({ name: "Alice Grok" }));
    assert.ok(aliceKey.ok, "Alice creates her access key");
    if (!aliceKey.ok) throw new Error("unreachable");

    const attempt = await actions.replace(sessionFor(bob), aliceKey.agentId);
    assert.equal(attempt.ok, false, "replacing another person's agent reports failure, not a silent success");

    // Alice's ORIGINAL key is untouched — it still verifies (nothing was revoked or reissued).
    assert.ok(
      await verifyAccessKey(db, aliceKey.key),
      "Alice's original key keeps working after Bob's replace attempt",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — malformed / oversized input is rejected with a 4xx at the validation boundary,
// before anything is written (no agent, no key).
// =====================================================================================

test("an oversized agent name is rejected with a 4xx and nothing is written", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "oversized");
    const actions = makeActions(db);

    await assertRejects4xx("create(oversized name)", () =>
      actions.create(sessionFor(userId), input({ name: "x".repeat(100_000) })),
    );

    assert.deepEqual(await listAgentsForUser(db, userId), [], "a rejected create writes no agent");
  } finally {
    await db.close();
  }
});

test("an empty agent name is rejected with a 4xx and nothing is written", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "emptyname");
    const actions = makeActions(db);

    await assertRejects4xx("create(empty name)", () =>
      actions.create(sessionFor(userId), input({ name: "" })),
    );

    assert.deepEqual(await listAgentsForUser(db, userId), [], "a rejected create writes no agent");
  } finally {
    await db.close();
  }
});

test("an unknown starting set (template) is rejected with a 4xx and nothing is written", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "badtemplate");
    const actions = makeActions(db);

    await assertRejects4xx("create(bad template)", () =>
      actions.create(sessionFor(userId), input({ template: "bogus" })),
    );

    assert.deepEqual(await listAgentsForUser(db, userId), [], "a rejected create writes no agent");
  } finally {
    await db.close();
  }
});

test("a malformed agent id is rejected with a 4xx on revoke and replace, changing nothing", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "malformed-id");
    const actions = makeActions(db);

    // A real agent + key to prove the malformed-id rejection touched nothing.
    const created = await actions.create(sessionFor(userId), input());
    assert.ok(created.ok, "create succeeds");
    if (!created.ok) throw new Error("unreachable");

    // A non-uuid id must be rejected at the boundary (OBS-049) — it never reaches
    // `WHERE id = $1` as a cast and never surfaces as a 500. A SQL-shaped id is likewise
    // not a well-formed uuid, so it is refused here before any query runs.
    await assertRejects4xx("revoke(malformed id)", () => actions.revoke(sessionFor(userId), "not-a-uuid"));
    await assertRejects4xx("replace(malformed id)", () => actions.replace(sessionFor(userId), "not-a-uuid"));
    await assertRejects4xx("revoke(sqli id)", () =>
      actions.revoke(sessionFor(userId), "x'; DROP TABLE oauth_access_keys; --"),
    );

    // The rejected calls did nothing: the existing key still verifies.
    assert.ok(
      await verifyAccessKey(db, created.key),
      "a malformed id revokes/replaces nothing — the real key still verifies",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — a SQL-injection probe in an input field is bound as data (parameter binding), so
// it cannot alter a query: the table survives and the value round-trips verbatim.
// =====================================================================================

test("a SQL-injection probe in the agent name is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const actions = makeActions(db);
    const probe = "Grace'); DROP TABLE agents; --";

    const result = await actions.create(sessionFor(userId), input({ name: probe, platform: "grok", template: "standard" }));
    assert.ok(result.ok, "a valid-shaped (if nasty) name is accepted");
    if (!result.ok) throw new Error("unreachable");

    assert.equal(
      await tableExists(db, "agents"),
      true,
      "the agents table survives (the probe was stored as data, not run as SQL)",
    );

    const agents = await listAgentsForUser(db, userId);
    assert.equal(agents.length, 1, "exactly one agent was created");
    assert.equal(agents[0]!.displayName, probe, "the probe round-trips verbatim as data");

    // The key is unaffected by the nasty (but inert) name.
    assert.ok(await verifyAccessKey(db, result.key), "the issued key still verifies");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC5 — no secret is baked into the flow: the key is minted from the injected randomness
// seam (so two issues are distinct — not a fixed literal in source), and no ambient env
// value lands in the key, the agent or its permissions (INV-103).
// =====================================================================================

test("each created key is minted fresh (two issues are distinct — never a hard-coded literal)", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "fresh-a");
    const bob = await makeUser(db, "fresh-b");
    const actions = makeActions(db);

    const a = await actions.create(sessionFor(alice), input());
    const b = await actions.create(sessionFor(bob), input());
    assert.ok(a.ok && b.ok, "both creates succeed");
    if (!a.ok || !b.ok) throw new Error("unreachable");

    assert.notEqual(a.key, b.key, "two issued keys are distinct (minted from entropy, not a fixed value)");
    // And each verifies only to its own agent's connection (no cross-talk).
    const aConn = await connectionIdOfAgent(db, alice, a.agentId);
    const bConn = await connectionIdOfAgent(db, bob, b.agentId);
    assert.notEqual(aConn, bConn, "the two agents are bound to different connections");
    assert.equal((await verifyAccessKey(db, a.key))!.connectionId, aConn, "Alice's key verifies to her connection");
    assert.equal((await verifyAccessKey(db, b.key))!.connectionId, bConn, "Bob's key verifies to his connection");
  } finally {
    await db.close();
  }
});

test("a decoy secret in the environment never lands in the issued key, agent or permissions", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "decoy");
    const actions = makeActions(db);

    const result = await actions.create(sessionFor(userId), input());
    assert.ok(result.ok, "the create succeeds with the decoy env var present");
    if (!result.ok) throw new Error("unreachable");

    // The decoy must not appear in the handed-back key…
    assert.ok(!result.key.includes(DECOY), "no ambient env value is folded into the issued key");

    // …nor in the one agent created for this person…
    const agents = await listAgentsForUser(db, userId);
    assert.ok(
      !JSON.stringify(agents).includes(DECOY),
      "no ambient env value is folded into the created agent",
    );

    // …nor in that connection's permissions.
    const connectionId = await connectionIdOfAgent(db, userId, result.agentId);
    const grants = await getConnectionPermissions(db, userId, connectionId);
    assert.ok(
      !JSON.stringify(grants).includes(DECOY),
      "no ambient env value is folded into the connection's permissions",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
