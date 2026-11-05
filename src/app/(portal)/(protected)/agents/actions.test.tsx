// E10-S11 — Agents list page loader + disconnect wiring
// (`src/app/(portal)/(protected)/agents/actions.ts`, mounted by the thin
// `src/app/(portal)/(protected)/agents/page.tsx`).
//
// RED-first: the agents-list loader seam does NOT exist yet — `agents/` holds only
// `page.tsx` (an operator ComingSoon placeholder), `connect/`, `[id]/` and
// `access-key/`. So importing `./actions` throws (ERR_MODULE_NOT_FOUND) and every
// test here fails until the builder adds it. That absence IS the point of test-first
// — do NOT implement anything to make these pass. The builder writes `actions.ts`
// afterwards to satisfy exactly this contract, and wires the thin `page.tsx` over it.
//
// These tests pin BEHAVIOUR (what the loader RETURNS and the screen it mounts; what
// the disconnect handler CHANGES in the database; what it REFUSES) against an
// isolated in-memory PGlite with the REAL migrations (src/test/db) and the REAL
// already-built seams it composes — the agents store (createAgent / getAgentById /
// listAgentsForUser), the agent-permissions store (upsertPermissions), the one-click
// disconnect operation (src/server/agents/disconnect — E10-S09, its own exhaustive
// test), the in-memory release store, and the already-render-tested AgentListView
// (E10-S10). No test asserts on the SOURCE TEXT of any module, so a later
// behaviour-preserving refactor (a rename, a moved import) stays green.
//
// Where the task names an entry/route file, the testable seam lives in the plain
// SIBLING module `actions.ts` (the convention's `createXActions(deps)` factory, as
// `[id]/actions.ts`, `access-key/actions.ts`, `settings/security/actions.ts` and
// `home/actions.ts` do) — never on the thin `page.tsx`, which may export only its
// framework fields (`next build` rejects any other export, OBS-025). A server PAGE
// that reads the session cookie + the process-wide database cannot be rendered
// without a live request scope, so — exactly like the sibling home + permissions
// loader tests — the loader's data assembly is pinned on the factory's `load`, and
// the SCREEN it mounts is pinned by feeding `load`'s output straight into
// <AgentListView/>. The browser-side "single confirm" that gates a disconnect is a
// client interaction (no jsdom on this job; React component / E2E testing is a
// per-job ADR), so it is pinned separately, framework-free, in the sibling
// `disconnect-confirm.test.ts` controller test — exactly as factor-controls does.
//
// WHY this exists (task E10-S11; brief "Agents screen" + "One-click disconnect";
// design §6.1; CLAUDE.md vocabulary — an *agent* is a connected AI client, one row
// per connection): the Agents screen lists EVERY one of the person's agents and, on
// each, mounts the Disconnect control wired to the disconnect operation and a
// per-agent link. An un-mounted disconnect ships nothing — so the list must actually
// mount a live, per-agent-bound Disconnect and the per-agent links.
//
// ─── The contract this task defines (the builder implements exactly this) ───────────
//
//   createAgentsActions(deps: {
//     db: Db;
//     clock: Clock;                                   // connected/last-active labels (never SQL now())
//     releaseStore: ReleaseStore;                     // disconnect cancels the uncollected release
//     dekFor: (userId: string) => Promise<Uint8Array>;// disconnect's activity write + approval denial
//   }): {
//     // Assemble the Agents screen's props for the SESSION user's own agents
//     // (member-scoped by session.userId — never a client value). Returns the view's
//     // props object (an `agents` array of already-formatted AgentListItem); the page
//     // adds the bound `disconnectAction` when it mounts <AgentListView/>.
//     load(session: Session): Promise<{ agents: ReadonlyArray<{ id: string; name: string; /* …AgentListItem */ }> }>;
//     // The disconnect handler the page's `use server` wrapper drives: disconnect ONE
//     // of the session user's own agents (composing src/server/agents/disconnect's
//     // disconnectAgent). A malformed / oversized / SQL-shaped agent id throws a 4xx
//     // HttpError at the boundary BEFORE any query; another person's agent id is
//     // refused ({ ok: false }) with their agent left wholly working.
//     disconnect(session: Session, agentId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
//   }
//
// ─── Acceptance criteria → tests ────────────────────────────────────────────────────
//   AC1  the loader reads ONLY the session user's agents (list-all) and mounts
//        AgentListView over them, with a per-agent Disconnect control (bound, carrying
//        that agent's id) and a per-agent link.
//   AC2  the disconnect handler disconnects the session user's OWN agent (it genuinely
//        calls through to the one-click disconnect operation). The single browser
//        confirm that must precede it is pinned in `disconnect-confirm.test.ts`.
//   AC3  a person never sees another person's agents, and cannot disconnect another
//        person's agent by id (the other person's agent is left connected).
//   AC4  a malformed / oversized agent id is rejected with a 4xx; a SQL-injection probe
//        in the id cannot alter a query — the table survives and nothing is
//        disconnected (parameter binding).            [obligation:validate-and-parameterize-input]
//   AC5  no ambient env secret leaks into the loaded list or the mounted screen; config
//        is read from the injected seams, not the image/client.   [obligation:secrets-from-env]
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// test uses its own freshDb(). The signed-in person is a REAL user row (agents.user_id
// is a foreign key to users(id)), so the session's id is one `createUser` minted —
// never a bare uuid that would trip the foreign key. Each person gets a fresh random
// 256-bit DEK the injected `dekFor` returns (disconnect's activity write uses it). We
// render AgentListView with `react-dom/server` (no DOM/jsdom — React component / E2E
// testing is a per-job ADR), exactly as the sibling view + loader tests do.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createAgentsActions } from "./actions";

import { AgentListView } from "@/components/agents/agent-list-view";
import { createAgent, getAgentById } from "@/server/db/agents";
import { upsertPermissions, type PermissionGrants } from "@/server/db/agent-permissions";
import { createUser } from "@/server/db/users";
import { createReleaseStore } from "@/server/crypto/release-store";
import { HttpError } from "@/server/http/validate";
import { fixedClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

// A frozen instant so the seeded agents' connected-at is deterministic (the agents
// store + the loader take an injected clock, never SQL now()).
const NOW = new Date("2026-06-01T00:00:00.000Z");

// --- types derived from the factory (so the tests don't hard-code a type NAME) ------
type Actions = ReturnType<typeof createAgentsActions>;
type LoadView = Awaited<ReturnType<Actions["load"]>>;
type ListItem = LoadView["agents"][number];
type DisconnectResult = Awaited<ReturnType<Actions["disconnect"]>>;

// Each person's unwrapped 256-bit DEK, keyed by user id — the injected `dekFor`
// returns it (disconnect's activity write / approval denial consume it). We never read
// it back, so any stable bytes serve.
const deks = new Map<string, Uint8Array>();
async function dekFor(userId: string): Promise<Uint8Array> {
  const dek = deks.get(userId);
  if (dek === undefined) throw new Error(`test setup: no DEK registered for ${userId}`);
  return dek;
}

// Build the agents-list actions under test with the real seams (a fresh release store
// per build — disconnect's release cancel is a harmless no-op on an empty store here).
function makeActions(db: Db): Actions {
  return createAgentsActions({
    db,
    clock: fixedClock(NOW),
    releaseStore: createReleaseStore(fixedClock(NOW)),
    dekFor,
  });
}

// Create a real person, register their DEK, and return their id. Every member-scoped
// row (their agents) hangs off this id, which must exist in `users` for the foreign key.
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  deks.set(user.id, randomBytes(32));
  return user.id;
}

// A plain signed-in session for `userId` — the page resolves this from the
// `__Host-wh_session` cookie; the seam only needs its user id (identity from the
// session, never a client value). Disconnect is a single confirm in the app, not a
// step-up-gated change, so stepped-up state is left null.
function sessionFor(userId: string): Session {
  return {
    id: `sess-${userId}`,
    userId,
    createdAt: new Date(NOW.getTime() - 60_000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    steppedUpAt: null,
  };
}

// A complete baseline grants record (every field present, as the store requires), so
// an agent the loader may join against its permissions (for its budget) is never
// dropped for want of a grants row. Card off, no budget, nothing shared.
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

// Seed a CONNECTED agent for `userId` (plus its baseline grants). Returns the created
// agent — its ROW id is the handle the Disconnect action and the per-agent link
// consume (one row per connection; the row id differs from the connection id, so the
// tests exercise the real two-id model). Distinct display names/platforms per agent
// are chosen digit- and separator-free so a presence check can only be satisfied by
// the field it targets.
async function seedAgent(
  db: Db,
  userId: string,
  opts: { displayName: string; platform?: string; grants?: Partial<PermissionGrants> },
) {
  const connectionId = randomUUID();
  const agent = await createAgent(
    db,
    {
      userId,
      connectionId,
      displayName: opts.displayName,
      platform: opts.platform ?? "someplatform",
      status: "connected",
    },
    fixedClock(NOW),
  );
  await upsertPermissions(db, baselineGrants(userId, connectionId, opts.grants));
  return agent;
}

// --- tiny markup helpers (no DOM), mirrored from the sibling component/loader tests --

const fakeDisconnectAction = async (_formData: FormData): Promise<void> => {};

// Mount the screen the loader feeds, exactly as the page does: AgentListView over the
// loader's agents, with a bound Disconnect action supplied by the page.
function renderScreen(view: LoadView): string {
  return renderToStaticMarkup(
    <AgentListView agents={view.agents} disconnectAction={fakeDisconnectAction} />,
  );
}

function decode(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

// Visible text with <script>/<style> blocks dropped whole (a bound server-action form
// injects a progressive-enhancement submit script whose JS text is not visible copy)
// then tags stripped and entities decoded — the words a sighted reader sees.
function visibleText(markup: string): string {
  const withoutScripts = markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  return decode(withoutScripts.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

type El = { attrs: string; inner: string };
function findAll(markup: string, tag: string): El[] {
  const out: El[] = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1]!, inner: m[2]! });
  }
  return out;
}
function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1]! : null;
}

// React encodes a FUNCTION form action as a `javascript:` progressive-enhancement
// placeholder in server-rendered markup; a bare form carries no such action. So
// "this form is bound to an action" is observable as its action scheme — behaviour,
// not source text (the same probe the view's own test uses).
function isBoundToAction(form: El): boolean {
  const action = attr(form.attrs, "action");
  return action !== null && /^javascript:/i.test(action);
}

// The value attributes of every <input> inside some markup fragment.
function inputValues(innerMarkup: string): string[] {
  const out: string[] = [];
  for (const m of innerMarkup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const v = attr(m[1]!, "value");
    if (v !== null) out.push(v);
  }
  return out;
}

// Every <form> whose visible text names a Disconnect control (the submit's label).
function disconnectForms(markup: string): El[] {
  return findAll(markup, "form").filter((f) => /disconnect/i.test(visibleText(f.inner)));
}

// Every anchor href in the markup.
function anchorHrefs(markup: string): string[] {
  return findAll(markup, "a")
    .map((a) => attr(a.attrs, "href"))
    .filter((h): h is string => h !== null);
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

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the
// relation name when it exists and NULL when it does not — a non-throwing probe scoped
// to the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// =====================================================================================
// AC1 — the loader reads ONLY the session user's agents (list-all) and mounts
// AgentListView, with a per-agent Disconnect control and a per-agent link.
// =====================================================================================

test("the loader returns every one of the session user's agents and mounts AgentListView over them", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "lister");
    const seeded = [
      await seedAgent(db, userId, { displayName: "QuokkaResearcher", platform: "ChatGPT" }),
      await seedAgent(db, userId, { displayName: "NarwhalPlanner", platform: "Claude" }),
      await seedAgent(db, userId, {
        displayName: "WallabyInbox",
        platform: "Cursor",
        grants: { cardAccess: true, cardBudget: { amount: 150, currency: "A$", period: "month" } },
      }),
    ];

    const view: LoadView = await makeActions(db).load(sessionFor(userId));

    // The loader returns the view's props object carrying an agents array.
    assert.ok(Array.isArray(view.agents), "the loader returns an `agents` array");
    assert.equal(view.agents.length, seeded.length, "the loader lists ALL of the person's agents");

    // Every seeded agent is present — carried by its ROW id (the Disconnect action's
    // handle) and named on the screen it mounts.
    const loadedIds = new Set(view.agents.map((a: ListItem) => a.id));
    for (const agent of seeded) {
      assert.ok(loadedIds.has(agent.id), `the loader must carry agent ${agent.id} (its row id)`);
    }

    // "mounts AgentListView": the loader's output IS the screen's props — feeding it
    // into the already-render-tested view renders every agent's name.
    const text = visibleText(renderScreen(view));
    for (const agent of seeded) {
      assert.ok(
        text.includes(agent.displayName),
        `mounting AgentListView over the loader's props must render agent "${agent.displayName}"; text="${text}"`,
      );
    }
  } finally {
    await db.close();
  }
});

test("the mounted screen offers a per-agent Disconnect control, bound and carrying THAT agent's id", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "disc-wiring");
    const seeded = [
      await seedAgent(db, userId, { displayName: "QuokkaResearcher" }),
      await seedAgent(db, userId, { displayName: "NarwhalPlanner" }),
    ];

    const view = await makeActions(db).load(sessionFor(userId));
    const markup = renderScreen(view);

    // One Disconnect control per agent — the page mounts a LIVE disconnect (an
    // un-mounted disconnect ships nothing), so each is bound to the action.
    const forms = disconnectForms(markup);
    assert.equal(forms.length, seeded.length, "every agent must offer a Disconnect control");
    assert.ok(forms.every(isBoundToAction), "every mounted Disconnect must be bound to the disconnect action (not a dead button)");

    // Each agent's Disconnect form carries THAT agent's row id, so submitting it
    // disconnects the right one.
    for (const agent of seeded) {
      assert.ok(
        forms.some((f) => inputValues(f.inner).includes(agent.id)),
        `a Disconnect control must carry agent id "${agent.id}" so the action disconnects the right agent`,
      );
    }
  } finally {
    await db.close();
  }
});

test("the mounted screen gives each agent its own per-agent link (distinct, carrying the agent's id)", async () => {
  // The Agents list links each agent to its own per-agent destination. The merged
  // E10-S10 AgentListView (out of this task's scope) exposes exactly one per-agent link
  // slot — the loader supplies a ready-made per-agent href for it. This pins that every
  // agent gets its OWN link, carrying that agent's id, distinct from every other
  // agent's — without betting on the exact target path (activity vs permissions), which
  // the view owns.
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "links");
    const seeded = [
      await seedAgent(db, userId, { displayName: "QuokkaResearcher" }),
      await seedAgent(db, userId, { displayName: "NarwhalPlanner" }),
      await seedAgent(db, userId, { displayName: "WallabyInbox" }),
    ];

    const view = await makeActions(db).load(sessionFor(userId));
    const hrefs = anchorHrefs(renderScreen(view));

    const perAgent: string[] = [];
    for (const agent of seeded) {
      const link = hrefs.find((h) => h.includes(agent.id));
      assert.ok(
        link !== undefined,
        `each agent must get its own link carrying its id "${agent.id}"; hrefs=${JSON.stringify(hrefs)}`,
      );
      perAgent.push(link!);
    }
    assert.equal(
      new Set(perAgent).size,
      seeded.length,
      "each agent's per-agent link must be distinct (one per agent, not one shared link)",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a person never sees another person's agents (the loader is member-scoped by
// the session's user id, never a client value).
// =====================================================================================

test("the loader reads ONLY the session user's agents — another person's agents never appear", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const bob = await makeUser(db, "stranger");
    const mine = [
      await seedAgent(db, alice, { displayName: "QuokkaResearcher" }),
      await seedAgent(db, alice, { displayName: "NarwhalPlanner" }),
    ];
    const theirs = [
      await seedAgent(db, bob, { displayName: "DingoScheduler" }),
      await seedAgent(db, bob, { displayName: "PossumShopper" }),
    ];

    const view = await makeActions(db).load(sessionFor(alice));
    const loadedIds = new Set(view.agents.map((a: ListItem) => a.id));
    const text = visibleText(renderScreen(view));

    // Exactly Alice's agents — count and ids.
    assert.equal(view.agents.length, mine.length, "the loader lists only the session user's own agents");
    for (const agent of mine) {
      assert.ok(loadedIds.has(agent.id), `Alice must see her own agent ${agent.id}`);
      assert.ok(text.includes(agent.displayName), `Alice's agent "${agent.displayName}" must appear`);
    }
    // None of Bob's — not by id, not by name.
    for (const agent of theirs) {
      assert.ok(!loadedIds.has(agent.id), `Alice must never see another person's agent ${agent.id}`);
      assert.ok(
        !text.includes(agent.displayName),
        `another person's agent "${agent.displayName}" must never appear on Alice's screen; text="${text}"`,
      );
    }
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — the disconnect handler disconnects the session user's OWN agent (it genuinely
// composes the one-click disconnect operation). The single browser confirm that must
// precede it is pinned in `disconnect-confirm.test.ts`.
// =====================================================================================

test("disconnect disconnects the session user's own agent (wired through to the disconnect operation)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "self-disc");
    const agent = await seedAgent(db, userId, { displayName: "QuokkaResearcher" });
    assert.equal(
      (await getAgentById(db, userId, agent.id))?.status,
      "connected",
      "the agent is connected before the disconnect",
    );

    const result: DisconnectResult = await makeActions(db).disconnect(sessionFor(userId), agent.id);
    assert.equal(result.ok, true, "disconnecting one's own connected agent succeeds");

    // It genuinely disconnected the agent (the row is marked disconnected) — proving
    // the handler composes the real disconnect operation, not a stub.
    assert.equal(
      (await getAgentById(db, userId, agent.id))?.status,
      "disconnected",
      "after disconnect the agent is marked disconnected",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a person cannot disconnect another person's agent by id (member-scoped); the
// other person's agent is left wholly connected.
// =====================================================================================

test("a person cannot disconnect another person's agent by id — it stays connected", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "disc-victim");
    const bob = await makeUser(db, "disc-attacker");
    const aliceAgent = await seedAgent(db, alice, { displayName: "QuokkaResearcher" });

    // Bob, holding Alice's real agent id, tries to disconnect it.
    const result = await makeActions(db).disconnect(sessionFor(bob), aliceAgent.id);
    assert.equal(result.ok, false, "disconnecting another person's agent must be refused (ok:false)");

    // Alice's agent is wholly untouched — still connected.
    assert.equal(
      (await getAgentById(db, alice, aliceAgent.id))?.status,
      "connected",
      "another person's refused disconnect leaves the owner's agent connected",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — a malformed / oversized agent id is rejected with a 4xx, and a SQL-injection
// probe in the id cannot alter a query (parameter binding).
// [obligation:validate-and-parameterize-input]
// =====================================================================================

test("a malformed or oversized agent id is rejected with a 4xx before any query (OBS-049)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "bad-id");
    const actions = makeActions(db);
    const session = sessionFor(userId);

    // Not a well-formed uuid — a bare integer, a negative, a decimal, the empty string,
    // whitespace, a non-uuid word, and a grossly oversized blob. Each is rejected at the
    // boundary BEFORE it can reach `WHERE id = $1` as a cast (so a SQL-shaped id never
    // reaches a query, and nothing surfaces as a 500). "A bare integer is rejected"
    // subsumes any generic "not a positive integer" phrasing.
    for (const badId of ["not-a-uuid", "5", "-1", "1.5", "", "   ", "x".repeat(100_000)]) {
      await assertRejects4xx(`disconnect(id=${JSON.stringify(badId.slice(0, 16))}…)`, () =>
        actions.disconnect(session, badId),
      );
    }
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in the agent id cannot alter a query: the table survives and nothing is disconnected", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "sqli-probe");
    const agent = await seedAgent(db, userId, { displayName: "QuokkaResearcher" });
    const actions = makeActions(db);

    // A canonical SQL-breaking id. If it were concatenated into the statement text it
    // would attempt to drop the table / alter the query; shape-guarded at the boundary
    // it is refused with a 4xx before any query runs.
    const probe = "x'; DROP TABLE agents; --";
    await assertRejects4xx("disconnect(SQLi id)", () => actions.disconnect(sessionFor(userId), probe));

    // The agents table survives (the probe never reached a query)…
    assert.equal(await tableExists(db, "agents"), true, "the agents table survives the SQL-injection probe");
    // …and the owner's real agent is untouched — still connected (no query was altered).
    assert.equal(
      (await getAgentById(db, userId, agent.id))?.status,
      "connected",
      "the SQL-injection probe disconnected nothing — the real agent is still connected",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC5 — no ambient env secret leaks into the loaded list or the mounted screen; config
// is read from the injected seams, not the image/client. [obligation:secrets-from-env]
// =====================================================================================

test("no ambient env secret leaks into the loaded agent list or the mounted screen", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "decoy");
    await seedAgent(db, userId, { displayName: "QuokkaResearcher" });
    await seedAgent(db, userId, { displayName: "NarwhalPlanner" });

    const view = await makeActions(db).load(sessionFor(userId));

    // The decoy appears in neither the loader's returned props…
    assert.ok(
      !JSON.stringify(view).includes(DECOY),
      "no ambient env value is folded into the loaded agent list",
    );
    // …nor the client-bound markup the person's browser receives.
    assert.ok(
      !renderScreen(view).includes(DECOY),
      "no ambient env value is folded into the mounted Agents screen",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
