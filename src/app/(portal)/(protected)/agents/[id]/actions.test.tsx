// E10-S08 — Per-agent permissions page loader + save action
// (`src/app/(portal)/(protected)/agents/[id]/actions.ts`, mounted by the thin
// `[id]/page.tsx`).
//
// RED-first: the per-agent permissions seam does NOT exist yet, so importing
// `./actions` throws (ERR_MODULE_NOT_FOUND) and every test here fails until the
// builder adds it. That absence IS the point of test-first — do NOT implement
// anything to make these pass. The builder writes `actions.ts` afterwards to
// satisfy exactly this contract, and wires the thin `page.tsx` over it.
//
// These tests pin BEHAVIOUR (what the loader RETURNS and the view it mounts; what
// the save CHANGES in the database; what it REFUSES) against an isolated in-memory
// PGlite with the REAL migrations (src/test/db) and the REAL already-built seams it
// composes — the agents store (createAgent / getAgentById / listAgentsForUser), the
// agent-permissions store (upsertPermissions / getConnectionPermissions) that the
// policy pipeline reads on EVERY call, and the already-render-tested PermissionsView
// (E10-S07). No test asserts on the source text of any module, so a later
// behaviour-preserving refactor (a rename, a moved import) stays green.
//
// Where the task names an entry/route file, the testable seam lives in the plain
// SIBLING module `actions.ts` (the convention's `createXActions(deps)` factory, as
// `settings/security/actions.ts`, `home/actions.ts` and `agents/access-key/actions.ts`
// do) — never on the thin `page.tsx`, which may export only its framework fields
// (`next build` rejects any other export, OBS-025). These tests drive that factory
// directly with real seams; the page mounts a thin loader + server-action wrappers
// over it. A server PAGE that reads the session cookie + database cannot be rendered
// without a live request scope, so — exactly like the sibling home loader test — the
// loader's data assembly is pinned on the factory's `load`, and the SCREEN it mounts
// is pinned by feeding `load`'s output straight into <PermissionsView/>.
//
// WHY this exists (brief "Per-agent permissions page" — "Each agent's reach is shaped
// on one screen … card access cannot be switched on without a budget … changes take
// effect on the agent's next request"; design §7 connector engine / §8 policy step 2;
// CLAUDE.md — the permissions object is saved server-side against the owning
// connection and is read by the pipeline on every call).
//
// ─── The contract this task defines (the builder implements exactly this) ───────────
//
//   createPermissionsActions(deps: { db: Db }): {
//     load(session, agentId): Promise<PermissionsViewProps | null>  // null ⇒ not the
//                                                                    //  session user's
//     save(session, agentId, input): Promise<{ ok: true; … } | { ok: false; reason }>
//   }
//
//   input (a partial edit of the connection's grants; absent fields keep their stored
//   value, so a previously-set budget survives an edit that does not touch it — the
//   OBS-022 shared-state invariant). The opt-in names mirror the sibling access-key
//   create input (the permissions page is the consent screen's twin):
//     card?: boolean;                                           // card access toggle
//     cardBudget?: { amount: number; currency: string; period: "day"|"week"|"month" } | null;
//     learningSharing?: boolean;                                // ⇒ grants.sharing
//     requestLimit?: number;                                    // ⇒ grants.rateLimit
//
//   • load resolves the agent by (session.userId, agentId) FIRST and reads its stored
//     permissions, member-scoped — so another person's agent id reads NOTHING (null).
//     It returns the props PermissionsView is mounted over (the agent named, card
//     access + its budget reflecting what is stored).
//   • save resolves the agent by (session.userId, agentId) FIRST — another person's
//     agent id matches nothing and the call is refused ({ ok: false }) with that
//     person's grants left untouched — then persists the connection's permissions so
//     the change takes effect on the agent's next request.
//   • card access ON without a budget (none in the input AND none already stored) is
//     REFUSED and never persisted; a budget once set survives toggling card off/on.
//   • the acting user id is ALWAYS session.userId, never a value smuggled in the input.
//   • a malformed agent id (not a well-formed uuid) throws a 4xx HttpError at the
//     boundary before any query (OBS-049); malformed / oversized input throws a 4xx
//     before anything is written; a SQL-shaped value in an input field is bound as
//     data (the table survives, the value round-trips).
//   • this module reads no process.env and holds no secret (INV-103) — config flows
//     from src/server/config.ts alone; no ambient env value lands in any output.
//
// ─── NOTE on the acceptance-criterion wording vs. this codebase ──────────────────────
// The criterion says "an agent id that is not a positive INTEGER is rejected with a
// 4xx". That phrasing is generic obligation boilerplate (serial catalogue ids); in
// Warthog `agents.id` is a `uuid` (db/migrations/0020_agents.sql — gen_random_uuid()),
// and the just-built sibling actions (access-key/actions.ts, settings/security/
// actions.ts) validate agent/credential ids with `z.uuid()`. The obligation here is
// OBS-049 / validate-and-parameterize-input: a MALFORMED id is rejected at the
// boundary with a 4xx before it can reach `WHERE id = $1` as a cast. We honour the
// obligation using the ACTUAL id shape — and the malformed probes below include a bare
// integer, a negative, a decimal and the empty string, so "not a positive integer is
// rejected" holds true as a special case of "not a well-formed uuid is rejected".
//
// ─── Acceptance criteria → tests ────────────────────────────────────────────────────
//   AC1  the loader reads only the session user's agent + its permissions and mounts
//        PermissionsView over them.
//   AC2  saving card access on with no budget is refused; across a sequence of edits a
//        previously-set budget survives and card-access-without-budget is never persisted.
//   AC3  a malformed agent id is rejected with a 4xx; a member cannot change another
//        person's agent permissions by id.
//   AC4  a handler rejects malformed / oversized input with a 4xx; a SQL-injection probe
//        in an input field is bound as data (parameter binding).  [validate-and-parameterize-input]
//   AC5  no secret value lands in a saved/loaded result; config is read from env.      [secrets-from-env]
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// test uses its own freshDb(). The signed-in person is a REAL user row (agents.user_id
// and agent_permissions.user_id are foreign keys to users(id)), so the session's id is
// one `createUser` minted — never a bare uuid that would trip the foreign key. We
// render PermissionsView with `react-dom/server` (no DOM/jsdom — React component / E2E
// testing is a per-job ADR), exactly as the sibling view + loader tests do.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createPermissionsActions } from "./actions";

import { PermissionsView } from "@/components/agents/permissions-view";
import { createAgent } from "@/server/db/agents";
import {
  upsertPermissions,
  getConnectionPermissions,
  type PermissionGrants,
  type ConnectionPermissions,
} from "@/server/db/agent-permissions";
import { createUser } from "@/server/db/users";
import { HttpError } from "@/server/http/validate";
import { fixedClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

// A frozen instant so the seeded agent's connected-at is deterministic (the agents
// store takes an injected clock, never SQL now()).
const NOW = new Date("2026-06-01T00:00:00.000Z");

// --- types derived from the factory (so the tests don't hard-code a type NAME) ------
type Actions = ReturnType<typeof createPermissionsActions>;
type SaveInput = Parameters<Actions["save"]>[2];
type SaveResult = Awaited<ReturnType<Actions["save"]>>;
type LoadResult = Awaited<ReturnType<Actions["load"]>>;

// Build the permissions actions under test with the real db seam.
function makeActions(db: Db): Actions {
  return createPermissionsActions({ db });
}

// Create a real person and return their id. Every member-scoped row (the agent, its
// permissions) hangs off this id, which must exist in `users` for the foreign keys.
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return user.id;
}

// A plain signed-in session for `userId` — the page resolves this from the
// `__Host-wh_session` cookie; the seam only needs its user id. Editing permissions is
// not a step-up-gated change, so stepped-up state is irrelevant and left null.
function sessionFor(userId: string): Session {
  return {
    id: `sess-${userId}`,
    userId,
    createdAt: new Date(NOW.getTime() - 60_000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    steppedUpAt: null,
  };
}

// A complete baseline grants record (every field present, as the store requires):
// card off, no budget, nothing shared. Overridable per seed.
function baselineGrants(
  userId: string,
  connectionId: string,
  overrides: Partial<PermissionGrants> = {},
): PermissionGrants {
  return {
    userId,
    connectionId,
    grantedConnectors: [],
    readTools: false,
    changeTools: "off",
    identityAccess: true,
    highTierAccess: false,
    cardAccess: false,
    cardBudget: null,
    skillsScope: [],
    memoryRead: false,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
    ...overrides,
  };
}

// Seed an agent for `userId` with a connection whose permissions are the baseline
// (plus any overrides). Returns the agent id (the `[id]` path handle) and the
// connection its grants live under (so a test reads them back by the same key).
async function seedAgent(
  db: Db,
  userId: string,
  opts: { displayName?: string; grants?: Partial<PermissionGrants> } = {},
): Promise<{ agentId: string; connectionId: string }> {
  const connectionId = randomUUID();
  const agent = await createAgent(
    db,
    {
      userId,
      connectionId,
      displayName: opts.displayName ?? "Test Agent",
      platform: "grok",
      status: "connected",
    },
    fixedClock(NOW),
  );
  await upsertPermissions(db, baselineGrants(userId, connectionId, opts.grants));
  return { agentId: agent.id, connectionId };
}

// Read a connection's stored grants (the SAME primitive the policy pipeline reads on
// every call), asserting they exist.
async function readGrants(db: Db, userId: string, connectionId: string): Promise<ConnectionPermissions> {
  const grants = await getConnectionPermissions(db, userId, connectionId);
  assert.ok(grants != null, "the connection's permissions must be readable");
  return grants!;
}

// Build a save input from a loose object (so a test can pass a partial edit, a
// malformed value, or a smuggled rogue key without a type error — exactly what an
// untrusted form body could carry).
function asInput(obj: Record<string, unknown>): SaveInput {
  return obj as unknown as SaveInput;
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields
// the relation name when it exists and NULL when it does not — a non-throwing probe
// scoped to the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Visible text with tags stripped: exactly the words a sighted reader sees.
function strip(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The invariant that must hold after EVERY save (OBS-022): card access is never
// persisted without a budget.
function assertNoCardWithoutBudget(grants: ConnectionPermissions, where: string): void {
  assert.ok(
    !(grants.cardAccess && grants.cardBudget == null),
    `${where}: card access must never be persisted without a budget`,
  );
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
      `${label}: must be rejected at the validation boundary (HttpError), got ${String(err)}`,
    );
    assert.ok(
      (err as HttpError).status >= 400 && (err as HttpError).status < 500,
      `${label}: the rejection must carry a 4xx status, got ${(err as HttpError).status}`,
    );
  }
  assert.ok(threw, `${label}: must be rejected (nothing was thrown)`);
}

// Assert a save is REJECTED — either a thrown 4xx HttpError or a reported
// { ok: false } refusal, never a silent success. (A refusal that depends on stored
// state — card access with no budget available, or an agent that is not this
// person's — may legitimately be reported rather than thrown; this accepts both.)
async function assertSaveRejected(label: string, fn: () => Promise<SaveResult>): Promise<void> {
  let result: SaveResult | undefined;
  try {
    result = await fn();
  } catch (err) {
    assert.ok(
      err instanceof HttpError && err.status >= 400 && err.status < 500,
      `${label}: a thrown rejection must be a 4xx HttpError, got ${String(err)}`,
    );
    return;
  }
  assert.equal(result.ok, false, `${label}: the save must be refused (ok:false), not a silent success`);
}

// =====================================================================================
// AC1 — the loader reads only the session user's agent + its permissions and mounts
// PermissionsView over them.
// =====================================================================================

test("the loader returns the agent's screen data and mounts PermissionsView (named, with card access + budget from storage)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "loader-ok");
    const { agentId } = await seedAgent(db, userId, {
      displayName: "Quokka Agent",
      grants: { cardAccess: true, cardBudget: { amount: 150, currency: "A$", period: "month" } },
    });

    const props: LoadResult = await makeActions(db).load(sessionFor(userId), agentId);
    if (props == null) throw new Error("the loader must return the owned agent's screen data, got null");

    // The loader names the agent being shaped, and reflects the stored card access +
    // its budget — the policy-relevant state the person edits on this screen.
    assert.ok(
      props.agentName.includes("Quokka Agent"),
      `the loader must name the agent being shaped, got agentName="${props.agentName}"`,
    );
    assert.equal(props.cardAccess, true, "the loader reflects the stored card-access state");
    assert.ok(props.budget != null, "the loader reflects the stored budget");
    assert.equal(props.budget!.amount, 150, "the stored budget amount is reflected");
    assert.equal(props.budget!.period, "month", "the stored budget period is reflected");

    // "mounts PermissionsView": the loader's output IS the screen's props — feeding it
    // straight into the already-render-tested view renders the agent's screen.
    const markup = renderToStaticMarkup(<PermissionsView {...props} />);
    assert.ok(
      strip(markup).includes("Quokka Agent"),
      `mounting PermissionsView over the loader's props must render the agent's screen, got: "${strip(markup)}"`,
    );
  } finally {
    await db.close();
  }
});

test("the loader reads ONLY the session user's agent — another person's agent id loads nothing", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "loader-victim");
    const bob = await makeUser(db, "loader-attacker");
    const { agentId } = await seedAgent(db, alice, { displayName: "Alice Agent" });

    // Alice loads her own agent — a screen.
    const mine = await makeActions(db).load(sessionFor(alice), agentId);
    assert.ok(mine != null, "the owner can load her own agent's permissions screen");

    // Bob, holding Alice's real agent id, loads NOTHING (member-scoped by the session's
    // user id, never the path value) — so he never sees another person's permissions.
    const theirs = await makeActions(db).load(sessionFor(bob), agentId);
    assert.equal(theirs, null, "another person's agent id must load nothing (null), never their permissions");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — saving card access on with no budget is REFUSED, and across a sequence of edits
// a previously-set budget survives while card-access-without-budget is never persisted.
// =====================================================================================

test("saving card access on with no budget is refused and card-access-without-budget is never persisted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "card-no-budget");
    const { agentId, connectionId } = await seedAgent(db, userId); // card off, no budget
    const actions = makeActions(db);

    // Card on with NO budget in the input and NONE already stored: refused.
    await assertSaveRejected("save(card on, no budget)", () =>
      actions.save(sessionFor(userId), agentId, asInput({ card: true })),
    );
    assertNoCardWithoutBudget(
      await readGrants(db, userId, connectionId),
      "after a refused card-on-no-budget save",
    );

    // Card on with a ZERO budget (a budget that does not allow card) is likewise refused
    // — the brief: "card access cannot be switched on without a budget".
    await assertSaveRejected("save(card on, zero budget)", () =>
      actions.save(
        sessionFor(userId),
        agentId,
        asInput({ card: true, cardBudget: { amount: 0, currency: "A$", period: "month" } }),
      ),
    );
    const grants = await readGrants(db, userId, connectionId);
    assertNoCardWithoutBudget(grants, "after a refused card-on-zero-budget save");
    assert.equal(grants.cardAccess, false, "a refused save leaves card access off");
  } finally {
    await db.close();
  }
});

test("across a sequence of edits a previously set budget survives and the invariant holds after every save [OBS-022]", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "budget-survives");
    const { agentId, connectionId } = await seedAgent(db, userId); // card off, no budget
    const actions = makeActions(db);
    const session = sessionFor(userId);

    // Edit 1 — toggle card access ON and set a budget.
    const r1 = await actions.save(
      session,
      agentId,
      asInput({ card: true, cardBudget: { amount: 200, currency: "A$", period: "month" } }),
    );
    assert.equal(r1.ok, true, "setting card access + a budget succeeds");
    let grants = await readGrants(db, userId, connectionId);
    assertNoCardWithoutBudget(grants, "after edit 1");
    assert.equal(grants.cardAccess, true, "edit 1: card access is on");
    assert.equal(grants.cardBudget?.amount, 200, "edit 1: the budget is stored");

    // Edit 2 — toggle an UNRELATED setting (sharing what it learns). The budget must
    // survive an edit that does not touch it (the OBS-022 "chosen value survives" bug).
    const r2 = await actions.save(session, agentId, asInput({ learningSharing: true }));
    assert.equal(r2.ok, true, "toggling an unrelated setting succeeds");
    grants = await readGrants(db, userId, connectionId);
    assertNoCardWithoutBudget(grants, "after edit 2");
    assert.equal(grants.sharing, true, "edit 2: the unrelated setting took effect");
    assert.equal(grants.cardAccess, true, "edit 2: card access is untouched");
    assert.equal(grants.cardBudget?.amount, 200, "edit 2: the budget survives an unrelated edit");

    // Edit 3 — toggle card access OFF. The budget is retained (not erased), so it can
    // survive a subsequent re-enable.
    const r3 = await actions.save(session, agentId, asInput({ card: false }));
    assert.equal(r3.ok, true, "turning card access off succeeds");
    grants = await readGrants(db, userId, connectionId);
    assertNoCardWithoutBudget(grants, "after edit 3");
    assert.equal(grants.cardAccess, false, "edit 3: card access is off");
    assert.equal(grants.cardBudget?.amount, 200, "edit 3: the previously set budget survives card access going off");

    // Edit 4 — toggle card access back ON without re-entering a budget. The previously
    // set budget survives, so card access is allowed (no budget re-entry required).
    const r4 = await actions.save(session, agentId, asInput({ card: true }));
    assert.equal(r4.ok, true, "re-enabling card access with a surviving budget succeeds");
    grants = await readGrants(db, userId, connectionId);
    assertNoCardWithoutBudget(grants, "after edit 4");
    assert.equal(grants.cardAccess, true, "edit 4: card access is on again");
    assert.equal(
      grants.cardBudget?.amount,
      200,
      "edit 4: the budget set in edit 1 survived toggling card access off then on",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a malformed agent id is rejected with a 4xx (OBS-049), and a member cannot
// change another person's agent permissions by id.
// =====================================================================================

test("a malformed agent id is rejected with a 4xx before any query (OBS-049)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "bad-id");
    const actions = makeActions(db);
    const session = sessionFor(userId);
    const goodInput = asInput({ learningSharing: true });

    // Not a well-formed uuid — including a bare integer, a negative, a decimal, the
    // empty string and a SQL-shaped id. Each is rejected at the boundary BEFORE it can
    // reach `WHERE id = $1` as a cast (so it never surfaces as a 500, and a SQL-shaped
    // id never reaches a query). "A bare integer is rejected" subsumes the criterion's
    // "not a positive integer".
    for (const badId of ["not-a-uuid", "5", "-1", "1.5", "", "   ", "x'; DROP TABLE agents; --"]) {
      await assertRejects4xx(`save(id=${JSON.stringify(badId)})`, () =>
        actions.save(session, badId, goodInput),
      );
    }
  } finally {
    await db.close();
  }
});

test("a member cannot change another person's agent permissions by id — the other person's grants are untouched", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "perm-victim");
    const bob = await makeUser(db, "perm-attacker");
    const { agentId, connectionId } = await seedAgent(db, alice, {
      grants: { sharing: false, cardAccess: false, cardBudget: null },
    });
    const actions = makeActions(db);

    const before = await readGrants(db, alice, connectionId);

    // Bob, holding Alice's real agent id, tries to flip her agent's settings.
    await assertSaveRejected("save(bob → alice's agent)", () =>
      actions.save(
        sessionFor(bob),
        agentId,
        asInput({ learningSharing: true, card: true, cardBudget: { amount: 999, currency: "A$", period: "month" } }),
      ),
    );

    // Alice's grants are byte-for-byte unchanged (nothing was written under her id).
    const after = await readGrants(db, alice, connectionId);
    assert.deepEqual(after, before, "a member's save against another person's agent changes nothing");

    // And the attacker created no grants of his own under the borrowed connection id.
    assert.equal(
      await getConnectionPermissions(db, bob, connectionId),
      null,
      "the attacker's refused save wrote no permissions under his own user id either",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — a handler rejects malformed / oversized input with a 4xx, and a SQL-injection
// probe in an input field is bound as data (parameter binding).
// [obligation:validate-and-parameterize-input]
// =====================================================================================

test("malformed input is rejected with a 4xx and nothing is persisted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "malformed-input");
    const { agentId, connectionId } = await seedAgent(db, userId);
    const actions = makeActions(db);
    const session = sessionFor(userId);
    const before = await readGrants(db, userId, connectionId);

    // A boolean toggle carrying a non-boolean.
    await assertRejects4xx("save(card not a boolean)", () =>
      actions.save(session, agentId, asInput({ card: "yes" })),
    );
    // The request limit carrying a non-number.
    await assertRejects4xx("save(requestLimit not a number)", () =>
      actions.save(session, agentId, asInput({ requestLimit: "soon" })),
    );
    // A budget amount that is not a number.
    await assertRejects4xx("save(budget amount not a number)", () =>
      actions.save(
        session,
        agentId,
        asInput({ card: true, cardBudget: { amount: "lots", currency: "A$", period: "month" } }),
      ),
    );
    // A budget period outside the brief's three (day | week | month).
    await assertRejects4xx("save(unknown budget period)", () =>
      actions.save(
        session,
        agentId,
        asInput({ card: true, cardBudget: { amount: 50, currency: "A$", period: "fortnight" } }),
      ),
    );

    // Nothing was written by any rejected save.
    assert.deepEqual(
      await readGrants(db, userId, connectionId),
      before,
      "a rejected (malformed) save leaves the stored permissions unchanged",
    );
  } finally {
    await db.close();
  }
});

test("oversized input is rejected with a 4xx and nothing is persisted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "oversized-input");
    const { agentId, connectionId } = await seedAgent(db, userId);
    const actions = makeActions(db);
    const before = await readGrants(db, userId, connectionId);

    // A grossly oversized currency label is rejected at the boundary before any write.
    await assertRejects4xx("save(oversized currency)", () =>
      actions.save(
        sessionFor(userId),
        agentId,
        asInput({ card: true, cardBudget: { amount: 50, currency: "x".repeat(100_000), period: "month" } }),
      ),
    );

    assert.deepEqual(
      await readGrants(db, userId, connectionId),
      before,
      "a rejected (oversized) save leaves the stored permissions unchanged",
    );
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in an input field is bound as data: the table survives and the value round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "sqli-probe");
    const { agentId, connectionId } = await seedAgent(db, userId);
    const actions = makeActions(db);

    // A budget whose currency carries the canonical SQL-breaking metacharacters. If the
    // value were concatenated into the statement text it would corrupt the query (or
    // run the trailing statement); bound as a parameter it is inert — stored as data.
    const probe = "A$';--";
    const result = await actions.save(
      sessionFor(userId),
      agentId,
      asInput({ card: true, cardBudget: { amount: 75, currency: probe, period: "month" } }),
    );
    assert.equal(result.ok, true, "a valid-shaped budget with a SQL-shaped currency is accepted");

    // The agent_permissions table survives (the probe was stored as data, not run).
    assert.equal(
      await tableExists(db, "agent_permissions"),
      true,
      "the agent_permissions table survives — the probe was bound as a parameter, not concatenated",
    );

    // …and the value round-trips verbatim through the store (proving it was bound).
    const grants = await readGrants(db, userId, connectionId);
    assert.equal(grants.cardAccess, true, "card access was persisted");
    assert.equal(grants.cardBudget?.amount, 75, "the budget amount round-trips");
    assert.equal(grants.cardBudget?.currency, probe, "the SQL-shaped currency round-trips verbatim as data");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC5 — no secret value lands in a saved/loaded result; config is read from env.
// [obligation:secrets-from-env] — the module reads no process.env and holds no secret,
// so no ambient env value can leak into the permissions it persists or the screen it
// loads.
// =====================================================================================

test("no ambient env secret leaks into the saved permissions or the loaded screen", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "decoy");
    const { agentId, connectionId } = await seedAgent(db, userId, { displayName: "Decoy Agent" });
    const actions = makeActions(db);

    const result = await actions.save(
      sessionFor(userId),
      agentId,
      asInput({ card: true, cardBudget: { amount: 100, currency: "A$", period: "month" }, learningSharing: true }),
    );
    assert.equal(result.ok, true, "the save succeeds with the decoy env var present");

    // The decoy appears in neither the persisted permissions…
    const grants = await readGrants(db, userId, connectionId);
    assert.ok(
      !JSON.stringify(grants).includes(DECOY),
      "no ambient env value is folded into the persisted permissions",
    );

    // …nor the loaded screen the person sees.
    const props = await actions.load(sessionFor(userId), agentId);
    assert.ok(props != null, "the loader returns the saved screen");
    assert.ok(
      !JSON.stringify(props).includes(DECOY),
      "no ambient env value is folded into the loaded permissions screen",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// Operator fix (E10-S08 review veto 2): the identity, high-tier and shared-memory toggles were
// rendered and "saved" but never persisted. The save now carries them as partial edits.
test("saving the identity, high-tier and shared-memory toggles persists them; other grants keep their values", async () => {
  const db = await freshDb();
  try {
    const actions = makeActions(db);
    const userId = await makeUser(db, "toggles");
    const { agentId, connectionId } = await seedAgent(db, userId, {
      grants: { identityAccess: true, highTierAccess: false, memoryRead: false, sharing: false, rateLimit: 120 },
    });
    const first = await actions.save(sessionFor(userId), agentId, asInput({ identity: false, highTier: true, memoryRead: true }));
    assert.deepEqual(first, { ok: true });
    let g = await readGrants(db, userId, connectionId);
    assert.equal(g.identityAccess, false, "low-tier identity read switched off");
    assert.equal(g.highTierAccess, true, "high-tier ask switched on");
    assert.equal(g.memoryRead, true, "shared-memory read switched on");
    assert.equal(g.sharing, false, "untouched: learning sharing");
    assert.equal(g.rateLimit, 120, "untouched: request limit");

    await actions.save(sessionFor(userId), agentId, asInput({ requestLimit: 60 }));
    g = await readGrants(db, userId, connectionId);
    assert.equal(g.rateLimit, 60);
    assert.equal(g.identityAccess, false, "a later partial edit keeps the identity toggle");
    assert.equal(g.highTierAccess, true, "a later partial edit keeps the high-tier toggle");
    assert.equal(g.memoryRead, true, "a later partial edit keeps the shared-memory toggle");
  } finally {
    await db.close();
  }
});
