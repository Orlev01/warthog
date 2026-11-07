// E10-S03 — Agent consent decision action wired into authorize
// (`src/app/oauth/authorize/actions.ts`).
//
// RED-first: the consent-decision seam does not exist yet, so importing `./actions`
// throws (ERR_MODULE_NOT_FOUND) and every test here fails until the builder adds it.
// That absence IS the point of test-first — do NOT implement anything to make these
// pass. The builder writes `actions.ts` afterwards to satisfy exactly this contract.
//
// These tests pin BEHAVIOUR (what the decision RETURNS, what it CHANGES in the
// database, and what it REFUSES) against an isolated in-memory PGlite with the REAL
// migrations (src/test/db) and the REAL already-built seams it composes — the agents
// store (createAgent / listAgentsForUser), the agent-permissions store
// (getConnectionPermissions) and the OAuth code store (getAuthCode). No test asserts
// on the source text of any module, so a later behaviour-preserving refactor (a
// rename, a moved import) must stay green. Where the task names an entry/route-group
// file, the testable seam lives in the plain SIBLING module `actions.ts` (the
// convention's `createXActions(deps)` factory, as `settings/security/actions.ts`
// does) — never on the thin `"use server"` wrappers in `page.tsx`, which may export
// only their framework fields (`next build` rejects any other export, OBS-025).
//
// WHY this exists (brief "Agent consent screen"; design §6.1; constitution 15/16 —
// each agent gets its own revocable credential through the connector standard's
// consent flow): when a person APPROVES on the consent screen, Warthog names the
// agent, applies the chosen permission set, and issues that agent's credential
// through the authorize flow bound to the ONE connection it just created. When they
// REFUSE, nothing is created and no credential is issued. The acting person's user id
// is ALWAYS the session's — never a value from the request (CLAUDE.md: every
// member-scoped write takes `userId` from the session). Malformed or oversized input
// is rejected at the validation boundary with a 4xx (INV-102), and every value is
// bound as a query parameter, so a value shaped like SQL is stored as data and cannot
// alter a query. Config/secrets are read from the injected config alone (INV-103).
//
// ─── E10-S12 SUPERSESSION — the decision runs from the mounted consent page ────────────
//
// E10-S12 moves consent to its own screen and carries the authorize request SERVER-SIDE:
// the GET route no longer issues a code, it stores the request in the pending store
// (`beginAuthorization`, returning an opaque handle the route puts in a host-locked
// cookie) and shows `/oauth/consent`. So the decision no longer takes the OAuth query from
// the (untrusted) form — it takes the opaque HANDLE and resolves+CONSUMES the pending
// request from the server-side store. The acting person is still the session's; a tampered
// (unknown) or replayed (already-consumed) handle resolves to nothing and so creates
// nothing. Every assertion about WHAT approve/refuse create or refuse is unchanged — only
// the INPUT the declared change invalidates (raw `params` → a server-side handle) is
// amended, and the `seedPending` helper mints a real handle through `beginAuthorization`.
//
// ─── The contract this task defines (the builder implements exactly this) ─────────────
//
//   createAuthorizeActions(deps): {
//     approve(session, handle, approval): Promise<{ ok: true; redirectTo } | { ok: false; error }>
//     refuse(session, handle):           Promise<{ ok: true; redirectTo } | { ok: false; error }>
//   }
//
//   deps:     { db: Db; config: Config; clock: Clock; random: Random }
//   handle:   string                     // opaque reference to the pending authorize request
//                                        // held server-side (from the host-locked cookie),
//                                        // resolved+consumed through the pending store
//   approval: {
//     name: string;                      // the person's chosen name for the agent
//     platform: string;                  // the connecting platform label
//     template: string;                  // "minimal" | "standard" | "custom" (validated)
//     tickedServices?: readonly string[];
//     highTier?: boolean;                // always opt-in (off unless explicitly true)
//     card?: boolean;                    // always opt-in; needs a budget when on
//     cardBudget?: { amount: number; currency: string; period: string } | null;
//     learningSharing?: boolean;         // always opt-in (off unless explicitly true)
//   }
//
//   • approve creates ONE agent for session.userId linked to a server-minted
//     connection id, upserts that connection's permissions, and issues an
//     authorization code (bound to that same connection, stored only as its hash)
//     through the authorize flow — returning the redirect back to the client.
//   • refuse creates no agent and issues no credential; it returns a redirect carrying
//     no code.
//   • high-tier, card and sharing-what-it-learns are OFF in every starting set and only
//     switch on when explicitly opted in; Minimal grants none of them.
//   • the acting user id is session.userId, never a value smuggled in the input.
//   • malformed / oversized input throws a 4xx HttpError before anything is written; a
//     SQL-injection probe is stored as data (parameter binding), the table survives.
//
// ─── Acceptance criteria → tests ──────────────────────────────────────────────────────
//   AC1 approve creates the agent, upserts its permissions and issues a credential bound
//       to that one connection; refuse issues nothing.
//   AC2 high-tier, card and sharing are off unless explicitly opted in; Minimal grants none.
//   AC3 the signed-in person's user id is taken from the session, never the request.
//   AC4 malformed/oversized input is rejected with a 4xx; a SQLi probe cannot alter a query.
//   AC5 no secret is folded into the output; config (issuer) is read from the injected config.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// builds its own freshDb(). The signed-in person is a REAL user row (agents.user_id and
// agent_permissions.user_id are foreign keys to users(id)), so the session's id is one
// `createUser` minted — never a bare uuid that would trip the foreign key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createAuthorizeActions, type ConsentApproval } from "./actions";

import { beginAuthorization } from "../../../server/oauth/authorize";
import { getAuthCode } from "../../../server/oauth/store";
import { listAgentsForUser } from "../../../server/db/agents";
import { getConnectionPermissions } from "../../../server/db/agent-permissions";
import { createUser } from "../../../server/db/users";
import { HttpError } from "../../../server/http/validate";
import { loadConfig, type Config } from "../../../server/config";
import { fixedClock } from "../../../server/seams/clock";
import { systemRandom } from "../../../server/seams/random";
import { freshDb } from "../../../test/db";
import type { Db } from "../../../server/db/index";
import type { Session } from "../../../server/auth/session";

// A realistic consent: a platform consenting at the founder's public host. The resource
// is that host's MCP endpoint (design §6.1), so the carried-through authorize request is
// valid and the only variable is the decision under test.
const BASE_URL = "https://warthog.com.au";
const MCP_RESOURCE = "https://warthog.com.au/mcp";
const CLIENT_ID = "https://claude.ai/.well-known/oauth-client";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
// A real RFC 7636 S256 code_challenge (base64url of a SHA-256 digest); the authorize
// flow binds it verbatim to the issued code.
const CODE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const STATE = "state-7f3a91c0";
// A frozen instant so "the credential expires in the future" is deterministic (the flow
// takes an injected clock, never SQL now()).
const NOW = new Date("2026-06-01T00:00:00.000Z");

// The SHA-256 hex digest of a value — how an authorization code is addressed in storage
// (constitution: codes are stored only as hashes). Computed here so a test can read the
// issued credential back by the same hash the flow persists, proving the raw code is
// never a stored key.
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// A real Config built through the one env seam, with a chosen public base URL (so the
// MCP resource and the issuer both flow from it). A minimal DEVELOPMENT env (pglite is
// allowed in dev) keeps config construction off the real environment.
function configWithBaseUrl(publicBaseUrl: string): Config {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: publicBaseUrl,
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
    WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
  } as NodeJS.ProcessEnv);
}

// Build the consent-decision actions under test with the real seams, a frozen clock and
// the real randomness source (so credentials/connection ids never collide across tests).
function makeActions(db: Db, base: string = BASE_URL) {
  return createAuthorizeActions({
    db,
    config: configWithBaseUrl(base),
    clock: fixedClock(NOW),
    random: systemRandom,
  });
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

// A plain signed-in session for `userId` — the route resolves this from the
// `__Host-wh_session` cookie; the seam only needs its user id. Stepped-up state is
// irrelevant to consent, so it is left null.
function sessionFor(userId: string): Session {
  return {
    id: `sess-${userId}`,
    userId,
    createdAt: new Date(NOW.getTime() - 60_000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    steppedUpAt: null,
  };
}

// The OAuth authorize query the consent screen carries through to the decision: a valid
// signed-in S256 request for this server's MCP resource. `resource` must match the deps'
// configured base so the carried-through authorize succeeds and the only variable is the
// consent decision under test.
function authorizeParams(resource: string = MCP_RESOURCE): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    resource,
    state: STATE,
    scope: "warthog",
  });
}

// Begin an authorize request the way the GET route does — storing it SERVER-SIDE through
// the real `beginAuthorization` seam — and return the opaque handle the consent decision
// then resolves. This is how a real pending request reaches the decision: never from a
// form field. `base` picks the issuer/MCP-resource so the carried request is valid for the
// matching deps' config (the iss-A/iss-B tests run two different issuers).
async function seedPending(db: Db, base: string = BASE_URL): Promise<string> {
  const begun = await beginAuthorization(
    { params: authorizeParams(`${base}/mcp`), session: sessionFor("pending-seed") },
    { db, config: configWithBaseUrl(base), clock: fixedClock(NOW), random: systemRandom },
  );
  assert.ok(begun.ok, "seeding the pending authorize request must succeed");
  if (!begun.ok) throw new Error("unreachable: beginAuthorization failed to seed a pending request");
  return begun.handle;
}

// A valid consent approval, overridable per test. The extra-key escape hatch lets a test
// smuggle a rogue `userId` into the input (AC3) without a type error — exactly what an
// untrusted form body could carry.
function approval(
  overrides: Partial<ConsentApproval> & Record<string, unknown> = {},
): ConsentApproval {
  return { name: "My Claude", platform: "claude", template: "standard", ...overrides } as ConsentApproval;
}

// Pull the authorization code out of a redirect-back URL (the credential the client will
// exchange at the token endpoint). Returns null when no code is carried (a refusal).
function codeIn(redirectTo: string): string | null {
  return new URL(redirectTo).searchParams.get("code");
}

// Resolve the connection the issued credential is bound to, by reading the code back
// through the already-built OAuth store addressed by its hash (never by grepping SQL).
async function connectionOfIssuedCode(db: Db, redirectTo: string): Promise<string> {
  const code = codeIn(redirectTo);
  assert.ok(code != null, "the approval redirect must carry an issued authorization code");
  const stored = await getAuthCode(db, sha256Hex(code!));
  assert.ok(stored != null, "the issued credential is persisted, addressed by its SHA-256 hash");
  return stored!.connectionId;
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

// =====================================================================================
// AC1 — approve creates the agent, upserts its permissions and issues a credential bound
// to that ONE connection; refuse issues nothing.
// =====================================================================================

test("approving creates the agent, upserts its permissions and issues a credential bound to that one connection", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "approve");
    const actions = makeActions(db);

    const result = await actions.approve(
      sessionFor(userId),
      await seedPending(db),
      approval({ name: "My Claude", platform: "claude", template: "standard" }),
    );

    assert.ok(result.ok, "approving a valid consent succeeds");
    if (!result.ok) throw new Error("unreachable: approve was not ok");

    // The redirect carries the issued credential back to the consenting client, with the
    // echoed state and the issuer (RFC 9207).
    const url = new URL(result.redirectTo);
    assert.equal(`${url.origin}${url.pathname}`, REDIRECT_URI, "the redirect goes back to the client");
    assert.equal(url.searchParams.get("state"), STATE, "the redirect echoes the request state");
    assert.equal(url.searchParams.get("iss"), BASE_URL, "the redirect carries the issuer (RFC 9207)");

    const code = codeIn(result.redirectTo);
    assert.ok(code != null && code.length >= 32, "an opaque, high-entropy credential is issued");

    // The credential is stored addressed ONLY by its hash, bound to one connection.
    const stored = await getAuthCode(db, sha256Hex(code!));
    assert.ok(stored != null, "the credential is persisted by its SHA-256 hash");
    assert.equal(await getAuthCode(db, code!), null, "the raw credential is never a stored key");
    const connectionId = stored!.connectionId;
    assert.equal(stored!.codeChallenge, CODE_CHALLENGE, "the PKCE challenge is bound to the credential");
    assert.equal(stored!.redirectUri, REDIRECT_URI, "the redirect URI is bound to the credential");
    assert.equal(stored!.resource, MCP_RESOURCE, "the MCP resource is bound to the credential");
    assert.ok(stored!.expiresAt.getTime() > NOW.getTime(), "the credential expires in the future");

    // Exactly one agent was created for this person, linked to that SAME connection.
    const agents = await listAgentsForUser(db, userId);
    assert.equal(agents.length, 1, "approving creates exactly one agent");
    const agent = agents[0]!;
    assert.equal(agent.userId, userId, "the agent belongs to the signed-in person");
    assert.equal(agent.displayName, "My Claude", "the agent is named as the person chose");
    assert.equal(agent.platform, "claude", "the connecting platform is recorded");
    assert.equal(agent.status, "connected", "a freshly consented agent is connected");
    assert.equal(
      agent.connectionId,
      connectionId,
      "the agent is bound to the SAME connection the credential is bound to",
    );

    // That connection's chosen permissions were upserted (one source of truth for the grants).
    const grants = await getConnectionPermissions(db, userId, connectionId);
    assert.ok(grants != null, "the chosen permissions are upserted for the connection");
  } finally {
    await db.close();
  }
});

test("refusing creates no agent and issues no credential", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "refuse");
    const actions = makeActions(db);

    const result = await actions.refuse(sessionFor(userId), await seedPending(db));

    assert.ok(result.ok, "refusing is a handled outcome, not an error");
    if (!result.ok) throw new Error("unreachable: refuse was not ok");

    // Nothing was created and no credential was issued.
    assert.deepEqual(await listAgentsForUser(db, userId), [], "refusing creates no agent");
    assert.equal(codeIn(result.redirectTo), null, "the refusal redirect carries no credential");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — high-tier, card and sharing-what-it-learns are OFF unless explicitly opted in;
// Minimal grants none of them.
// =====================================================================================

test("Minimal grants none of high-tier, card access or sharing", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "minimal");
    const actions = makeActions(db);

    const result = await actions.approve(
      sessionFor(userId),
      await seedPending(db),
      approval({ template: "minimal" }),
    );
    assert.ok(result.ok, "a Minimal approval succeeds");
    if (!result.ok) throw new Error("unreachable");

    const connectionId = await connectionOfIssuedCode(db, result.redirectTo);
    const grants = await getConnectionPermissions(db, userId, connectionId);
    assert.ok(grants != null, "permissions were written");
    assert.equal(grants!.highTierAccess, false, "Minimal does not grant high-tier access");
    assert.equal(grants!.cardAccess, false, "Minimal does not grant card access");
    assert.equal(grants!.sharing, false, "Minimal does not grant sharing-what-it-learns");
    assert.equal(grants!.cardBudget, null, "Minimal sets no card budget");
  } finally {
    await db.close();
  }
});

test("Standard leaves high-tier, card and sharing off unless they are opted in", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "standard-default");
    const actions = makeActions(db);

    const result = await actions.approve(
      sessionFor(userId),
      await seedPending(db),
      approval({ template: "standard" }), // no opt-ins
    );
    assert.ok(result.ok, "a Standard approval succeeds");
    if (!result.ok) throw new Error("unreachable");

    const connectionId = await connectionOfIssuedCode(db, result.redirectTo);
    const grants = await getConnectionPermissions(db, userId, connectionId);
    assert.ok(grants != null, "permissions were written");
    assert.equal(grants!.highTierAccess, false, "Standard leaves high-tier off by default");
    assert.equal(grants!.cardAccess, false, "Standard leaves card access off by default");
    assert.equal(grants!.sharing, false, "Standard leaves sharing off by default");
  } finally {
    await db.close();
  }
});

test("explicitly opting in to high-tier and sharing turns exactly those on", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "optin-ht-share");
    const actions = makeActions(db);

    const result = await actions.approve(
      sessionFor(userId),
      await seedPending(db),
      approval({ template: "standard", highTier: true, learningSharing: true }),
    );
    assert.ok(result.ok, "an approval with opt-ins succeeds");
    if (!result.ok) throw new Error("unreachable");

    const connectionId = await connectionOfIssuedCode(db, result.redirectTo);
    const grants = await getConnectionPermissions(db, userId, connectionId);
    assert.ok(grants != null, "permissions were written");
    assert.equal(grants!.highTierAccess, true, "opting in turns high-tier access on");
    assert.equal(grants!.sharing, true, "opting in turns sharing-what-it-learns on");
    assert.equal(grants!.cardAccess, false, "card access stays off when not opted in");
  } finally {
    await db.close();
  }
});

test("opting in to card access with a budget turns card access on and records the budget", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "optin-card");
    const actions = makeActions(db);

    const result = await actions.approve(
      sessionFor(userId),
      await seedPending(db),
      approval({
        template: "custom",
        card: true,
        cardBudget: { amount: 200, currency: "AUD", period: "month" },
      }),
    );
    assert.ok(result.ok, "a card opt-in with a budget succeeds");
    if (!result.ok) throw new Error("unreachable");

    const connectionId = await connectionOfIssuedCode(db, result.redirectTo);
    const grants = await getConnectionPermissions(db, userId, connectionId);
    assert.ok(grants != null, "permissions were written");
    assert.equal(grants!.cardAccess, true, "opting in turns card access on");
    assert.deepEqual(
      grants!.cardBudget,
      { amount: 200, currency: "AUD", period: "month" },
      "the chosen card budget is recorded with its amount, currency and period",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — the signed-in person's user id is taken from the session, never the request. A
// rogue `userId` smuggled into the input is ignored: the agent is created under the
// session's user, and never under the smuggled id.
// =====================================================================================

test("the agent is created under the session user, never a user id smuggled in the input", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "owner");
    const attacker = await makeUser(db, "attacker");
    const actions = makeActions(db);

    const result = await actions.approve(
      sessionFor(sessionUser),
      await seedPending(db),
      // The untrusted input smuggles the attacker's user id; the decision must ignore it.
      approval({ userId: attacker, name: "Theirs", platform: "claude", template: "standard" }),
    );
    assert.ok(result.ok, "the approval succeeds");
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
// AC4 — malformed / oversized input is rejected with a 4xx at the validation boundary,
// before anything is written; a SQL-injection probe in an input field is bound as data
// and cannot alter a query (the table survives, the value round-trips verbatim).
// =====================================================================================

test("an oversized agent name is rejected with a 4xx and nothing is written", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "oversized");
    const actions = makeActions(db);
    const handle = await seedPending(db);

    await assertRejects4xx("approve(oversized name)", () =>
      actions.approve(
        sessionFor(userId),
        handle,
        approval({ name: "x".repeat(100_000) }),
      ),
    );

    assert.deepEqual(
      await listAgentsForUser(db, userId),
      [],
      "a rejected approval writes no agent",
    );
  } finally {
    await db.close();
  }
});

test("an empty agent name is rejected with a 4xx and nothing is written", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "emptyname");
    const actions = makeActions(db);
    const handle = await seedPending(db);

    await assertRejects4xx("approve(empty name)", () =>
      actions.approve(sessionFor(userId), handle, approval({ name: "" })),
    );

    assert.deepEqual(await listAgentsForUser(db, userId), [], "a rejected approval writes no agent");
  } finally {
    await db.close();
  }
});

test("an unknown starting set (template) is rejected with a 4xx and nothing is written", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "badtemplate");
    const actions = makeActions(db);
    const handle = await seedPending(db);

    await assertRejects4xx("approve(bad template)", () =>
      actions.approve(sessionFor(userId), handle, approval({ template: "bogus" })),
    );

    assert.deepEqual(await listAgentsForUser(db, userId), [], "a rejected approval writes no agent");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in the agent name is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const actions = makeActions(db);
    const probe = "Grace'); DROP TABLE agents; --";

    const result = await actions.approve(
      sessionFor(userId),
      await seedPending(db),
      approval({ name: probe, platform: "claude", template: "standard" }),
    );
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
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC5 — no secret is baked into the decision: the issuer is read from the injected
// config (change the config and the issued credential's `iss` changes with it), and a
// decoy secret sitting in the environment never lands in the issued credential, the
// agent or its permissions (INV-103).
// =====================================================================================

test("the issued credential's issuer is read from config — it changes with config, not a fixed value", async () => {
  const dbA = await freshDb();
  const dbB = await freshDb();
  try {
    const userA = await makeUser(dbA, "iss-a");
    const userB = await makeUser(dbB, "iss-b");

    const resultA = await makeActions(dbA, "https://a.example").approve(
      sessionFor(userA),
      await seedPending(dbA, "https://a.example"),
      approval(),
    );
    const resultB = await makeActions(dbB, "https://b.example").approve(
      sessionFor(userB),
      await seedPending(dbB, "https://b.example"),
      approval(),
    );

    assert.ok(resultA.ok && resultB.ok, "both approvals succeed");
    if (!resultA.ok || !resultB.ok) throw new Error("unreachable");

    assert.equal(
      new URL(resultA.redirectTo).searchParams.get("iss"),
      "https://a.example",
      "the issuer follows config A",
    );
    assert.equal(
      new URL(resultB.redirectTo).searchParams.get("iss"),
      "https://b.example",
      "the issuer follows config B (so it is not a fixed or hard-coded value)",
    );
  } finally {
    await dbA.close();
    await dbB.close();
  }
});

test("a decoy secret in the environment never lands in the issued credential, agent or permissions", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "decoy");
    const actions = makeActions(db);

    const result = await actions.approve(sessionFor(userId), await seedPending(db), approval());
    assert.ok(result.ok, "the approval succeeds with the decoy env var present");
    if (!result.ok) throw new Error("unreachable");

    // The decoy must not appear in the redirect (which carries the issued credential)…
    assert.ok(!result.redirectTo.includes(DECOY), "no ambient env value is folded into the redirect");

    // …nor in the one agent created for this person…
    const agents = await listAgentsForUser(db, userId);
    assert.ok(
      !JSON.stringify(agents).includes(DECOY),
      "no ambient env value is folded into the created agent",
    );

    // …nor in that connection's permissions.
    const connectionId = await connectionOfIssuedCode(db, result.redirectTo);
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

// =====================================================================================
// E10-S12 — the decision takes the pending request from SERVER-SIDE state, never the form:
// a tampered (unknown) or replayed (already-consumed) handle resolves to nothing, so the
// decision creates no agent, connection or code. (AC: "a tampered or replayed decision
// creates nothing.")
// =====================================================================================

test("approving with an unknown (tampered) handle creates nothing and issues no credential", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "tamper-approve");
    const actions = makeActions(db);

    // A handle the server never minted — a value forged in the form/cookie. It resolves to
    // no pending request, so there is nothing to approve.
    const result = await actions.approve(sessionFor(userId), "forged-handle-not-in-store", approval());

    assert.equal(result.ok, false, "an unknown pending handle is refused");
    assert.deepEqual(await listAgentsForUser(db, userId), [], "a tampered approval creates no agent");
  } finally {
    await db.close();
  }
});

test("refusing with an unknown (tampered) handle creates nothing", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "tamper-refuse");
    const actions = makeActions(db);

    const result = await actions.refuse(sessionFor(userId), "forged-handle-not-in-store");

    assert.equal(result.ok, false, "an unknown pending handle cannot be refused into a client redirect");
    assert.deepEqual(await listAgentsForUser(db, userId), [], "a tampered refusal creates no agent");
  } finally {
    await db.close();
  }
});

test("replaying a decision (the same handle twice) creates nothing the second time", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "replay");
    const actions = makeActions(db);
    const handle = await seedPending(db);

    // The first approval consumes the one-time pending request.
    const first = await actions.approve(sessionFor(userId), handle, approval({ name: "Once" }));
    assert.ok(first.ok, "the first approval of a fresh handle succeeds");

    // Replaying the SAME handle must create no second agent and must not succeed — the
    // pending request was consumed, so there is nothing left to act on.
    const replay = await actions.approve(sessionFor(userId), handle, approval({ name: "Twice" }));
    assert.equal(replay.ok, false, "replaying a consumed handle is refused");
    assert.equal(
      (await listAgentsForUser(db, userId)).length,
      1,
      "the replay creates no second agent (the handle is single-use)",
    );
  } finally {
    await db.close();
  }
});
