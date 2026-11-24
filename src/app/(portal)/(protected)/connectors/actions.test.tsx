// E09-S17 — Connectors page loader + connect/disconnect/request actions
// (`src/app/(portal)/(protected)/connectors/actions.ts`, mounted by the thin
// `src/app/(portal)/(protected)/connectors/page.tsx`).
//
// RED-first: the connectors-page loader seam does NOT exist yet — `connectors/`
// holds only `page.tsx` (an operator ComingSoon placeholder). So importing
// `./actions` throws (ERR_MODULE_NOT_FOUND) and every test here fails until the
// builder adds it. That absence IS the point of test-first — do NOT implement
// anything to make these pass. The builder writes `actions.ts` afterwards to
// satisfy exactly this contract, and wires the thin `page.tsx` over it.
//
// These tests pin BEHAVIOUR (what the loader RETURNS and the screen it mounts; what
// disconnect CHANGES in the database and WHOSE provider access it revokes; what the
// handlers REFUSE) against an isolated in-memory PGlite with the REAL migrations
// (src/test/db) and the REAL already-built seams it composes — the connection store
// (createConnection / listConnectionsForUser / getConnectionById), the agent store
// (createAgent / getAgentById), the agent-permissions store (upsertPermissions /
// getConnectionPermissions), the connector-request store, the real catalogue loader,
// and the already-render-tested ConnectorsView (E09-S16). No test asserts on the
// SOURCE TEXT of any module, so a later behaviour-preserving refactor stays green.
//
// Where the task names an entry/route file, the testable seam lives in the plain
// SIBLING module `actions.ts` (the convention's `createXActions(deps)` factory, as
// `agents/actions.ts`, `access-key/actions.ts`, `oauth/authorize/actions.ts` and
// `home/actions.ts` do) — never on the thin `page.tsx`, which may export only its
// framework fields (`next build` rejects any other export, OBS-025). A server PAGE
// that reads the session cookie + the process-wide database cannot be rendered
// without a live request scope, so — exactly like the sibling agents loader test —
// the loader's data assembly is pinned on the factory's `load`, and the SCREEN it
// mounts is pinned by feeding `load`'s output straight into <ConnectorsView/> with
// the page-supplied actions bound.
//
// ─── The contract this task defines (the builder implements exactly this) ────────────
//
//   createConnectorsActions(deps: {
//     db: Db;
//     clock: Clock;                                    // connected-at / requested-at (never SQL now())
//     catalogue: CatalogueIndex;                       // browse + resolve a connector entry by id
//     dekFor: (userId) => Promise<Uint8Array>;         // the acting person's own DEK (credential envelopes)
//     fetch: typeof fetch;                             // SSRF-guarded outbound (api-key verify, oauth, mcp)
//     googleEarlyAccess: readonly string[];            // the gate allowlist (injected from config)
//     oauthClientConfigFor: (connectorId) => OAuthClientConfig;   // provider sign-in client (from config)
//     providerMcpConfig: ProviderMcpConfig;            // CIMD identity (from config)
//     listProviderTools: ListProviderTools;            // provider_mcp tool listing seam
//     revokeProviderAccess: (input: { userId; connectionId; … }) => Promise<void>;  // the provider-side revocation seam
//   }): {
//     // Assemble the Connectors screen's props for the SESSION user (member-scoped by
//     // session.userId — never a client value): the catalogue browse grouped by category
//     // and the person's OWN connections. Returns the <ConnectorsView/> data object
//     // ({ groups, connections, query, canRequest }); the page binds the controls when it
//     // mounts the view. `input` carries the optional search term.
//     load(session: Session, input?: { query?: string; category?: string }): Promise<ConnectorsViewData>;
//     // Start a provider sign-in (oauth2) connection for the session user.
//     connectProviderSignin(session: Session, input: { connectorId: string }): Promise<unknown>;
//     // Save an api-key connection for the session user. Validates the input at the
//     // boundary (a 4xx before any write); the host comes only from the catalogue entry.
//     saveApiKeyConnection(session: Session, input: { connectorId: string; accountLabel: string; apiKey: string }): Promise<unknown>;
//     // Connect a provider_mcp connection for the session user.
//     connectProviderMcp(session: Session, input: { connectorId: string; accountLabel: string }): Promise<unknown>;
//     // Disconnect ONE of the session user's own connected accounts: it REMOVES the account
//     // from EVERY agent that uses it (the person's other accounts of the service stay
//     // granted) AND revokes the stored provider access where the provider allows it. A malformed / oversized / SQL-shaped connection id throws a
//     // 4xx HttpError at the boundary BEFORE any query; another person's connection id is
//     // refused ({ ok:false }) with their service + their agents left wholly untouched.
//     disconnectService(session: Session, connectionId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
//     // Record a "Request a connector" for the session user (member-scoped) and email the
//     // operator. A malformed / oversized / SQL-shaped name is refused at the boundary.
//     requestConnector(session: Session, input: { name: string }): Promise<unknown>;
//   }
//
// ─── Acceptance criteria → tests ──────────────────────────────────────────────────────
//   AC1  the loader reads ONLY the session user's connections + the catalogue and mounts
//        ConnectorsView wired to connectProviderSignin / saveApiKeyConnection /
//        connectProviderMcp / disconnectService / requestConnector (the five controls
//        render LIVE, each carrying its own id — never a dead button).
//   AC2  disconnectService removes EVERY agent's access to that account (its grant goes from
//        every agent; other accounts of the service stay) and revokes the stored provider
//        access where the provider allows it (the revocation seam fires for a provider-sign-in
//        service).
//   AC3  a connector / connection id that is not the expected shape is rejected with a 4xx
//        (not a raw cast); a person cannot disconnect another person's connection, and the
//        removal is member-scoped (another person's agents keep their access).
//   AC4  a handler rejects malformed / oversized input with a 4xx; a SQL-injection probe in
//        an input field cannot alter a query (parameter binding — the table survives and
//        nothing is mutated).                          [obligation:validate-and-parameterize-input]
//   AC5  no ambient env secret leaks into the loaded data or the mounted screen; config is
//        read from the injected seams, not the image/client.   [obligation:secrets-from-env]
//
// Scope note: connectProviderSignin and connectProviderMcp carry a provider OAuth / CIMD
// dance whose full happy path needs a live provider; this file pins that they EXIST (so
// the page can wire them, AC1) and exercises the input-validation / member-scope / secret
// obligations through saveApiKeyConnection, disconnectService and requestConnector, whose
// behaviour is offline-testable. The connect methods validate their connector id the same
// way saveApiKeyConnection does (the pinned 4xx shape guard).
//
// Every db handle is closed in a `finally`. The signed-in person is a REAL user row
// (connections.user_id / agents.user_id are foreign keys to users(id)), so the session's
// id is one `createUser` minted. Each person gets a fresh random 256-bit DEK the injected
// `dekFor` returns. We render ConnectorsView with `react-dom/server` (no DOM/jsdom —
// React component / E2E testing is a per-job ADR), exactly as the sibling view + loader
// tests do.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { createConnectorsActions, type RevokeProviderAccessInput } from "./actions";

import { ConnectorsView } from "@/components/connectors/connectors-view";
import {
  createConnection,
  listConnectionsForUser,
  getConnectionById,
  updateConnectionStatus,
  type Connection,
} from "@/server/db/connections";
import { createAgent } from "@/server/db/agents";
import {
  upsertPermissions,
  getConnectionPermissions,
  type PermissionGrants,
} from "@/server/db/agent-permissions";
import { listConnectorRequestsForUser } from "@/server/db/connector-requests";
import { readActivity } from "@/server/activity/writer";
import { createUser } from "@/server/db/users";
import { loadCatalogue, type CatalogueIndex } from "@/server/connectors/catalogue";
import { HttpError } from "@/server/http/validate";
import { fixedClock } from "@/server/seams/clock";
import type { OAuthClientConfig } from "@/server/connectors/oauth-client";
import type { ProviderMcpConfig, ListProviderTools } from "@/server/connectors/provider-mcp";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

// A frozen instant so seeded connections' connected-at is deterministic (the stores + the
// loader take an injected clock, never SQL now()).
const NOW = new Date("2026-06-01T00:00:00.000Z");

// --- catalogue fixtures -------------------------------------------------------------
//
// A small, self-contained catalogue spanning three categories and three connect kinds,
// none flagged for Google early access (so the per-person gate is always "connect"):
//   • acme-mail   (api_key)      — connected with the person's own key; nothing the
//                                  provider lets Warthog revoke server-side.
//   • widget-sync (oauth2)       — a provider SIGN-IN service: Warthog holds the provider
//                                  tokens, so disconnecting revokes them at the provider.
//   • data-grid   (provider_mcp) — a provider-hosted MCP service.
const FIXTURE_ENTRIES: Array<Record<string, unknown>> = [
  {
    id: "acme-mail",
    name: "Acme Mail",
    aliases: ["acme"],
    category: "email",
    auth_kind: "api_key",
    base_url: "https://api.acme.example",
    auth: { header: "Authorization: Bearer {api_key}" },
    // No `verify` — saving a key makes no outbound call, so the api-key path runs offline.
  },
  {
    id: "widget-sync",
    name: "Widget Sync",
    aliases: ["widget"],
    category: "productivity",
    auth_kind: "oauth2",
    base_url: "https://api.widget.example",
    auth: {
      authorize_url: "https://widget.example/authorize",
      token_url: "https://widget.example/token",
      scopes: ["sync.read"],
    },
  },
  {
    id: "data-grid",
    name: "Data Grid",
    aliases: ["grid"],
    category: "database",
    auth_kind: "provider_mcp",
    base_url: "https://mcp.datagrid.example/mcp",
    auth: {},
    curated_tools: [{ name: "list_rows" }],
  },
];

function makeCatalogueDir(entries: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "warthog-connectors-actions-"));
  for (const entry of entries) {
    writeFileSync(join(dir, `${String(entry.id)}.json`), JSON.stringify(entry));
  }
  return dir;
}

// Build a real CatalogueIndex over the fixtures through the project's own loader. Only the
// oauth2 entry needs a configured client to be connectable; the others are always so.
function fixtureIndex(connectableOAuth: Set<string> = new Set(["widget-sync"])): CatalogueIndex {
  const dir = makeCatalogueDir(FIXTURE_ENTRIES);
  try {
    return loadCatalogue({ dir, isOAuthClientConfigured: (id) => connectableOAuth.has(id) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- injected-seam doubles ----------------------------------------------------------

// Each person's unwrapped 256-bit DEK, keyed by user id — the injected `dekFor` returns
// it (the credential envelopes encrypt/decrypt under it). We never read it back, so any
// stable bytes serve.
const deks = new Map<string, Uint8Array>();
async function dekFor(userId: string): Promise<Uint8Array> {
  const dek = deks.get(userId);
  if (dek === undefined) throw new Error(`test setup: no DEK registered for ${userId}`);
  return dek;
}

// The outbound fetch MUST NOT fire in these tests: the api-key fixture declares no verify,
// and provider revocation goes through the `revokeProviderAccess` seam — so a fetch call
// is a mistake the test should surface loudly.
const unusedFetch = (async () => {
  throw new Error("fetch must not be called in these tests");
}) as unknown as typeof fetch;

// Stub provider configs for the connect methods this file only asserts the EXISTENCE of
// (never calls). Deliberately NOT env-derived and not resembling the decoy secret.
const STUB_OAUTH_CONFIG: OAuthClientConfig = {
  clientId: "stub-oauth-client",
  clientSecret: "stub-oauth-client-auth",
  redirectUri: "https://warthog.com.au/connectors/callback",
};
const STUB_MCP_CONFIG: ProviderMcpConfig = {
  clientMetadataUrl: "https://warthog.com.au/oauth/client-metadata.json",
};
const STUB_LIST_TOOLS: ListProviderTools = async () => [];

// Build the connectors actions under test with the real seams plus a recording double for
// the external effect (the provider-side revocation). Returns the actions and the recorder
// so a test can assert what left Warthog.
function makeActions(
  db: Db,
  catalogue: CatalogueIndex = fixtureIndex(),
  opts: { revoke?: (input: RevokeProviderAccessInput) => Promise<void> } = {},
) {
  const revokeCalls: Array<{ userId: string; connectionId: string }> = [];
  const actions = createConnectorsActions({
    db,
    clock: fixedClock(NOW),
    catalogue,
    dekFor,
    fetch: unusedFetch,
    googleEarlyAccess: [],
    oauthClientConfigFor: () => STUB_OAUTH_CONFIG,
    providerMcpConfig: STUB_MCP_CONFIG,
    listProviderTools: STUB_LIST_TOOLS,
    revokeProviderAccess: async (input) => {
      revokeCalls.push({ userId: input.userId, connectionId: input.connectionId });
      await opts.revoke?.(input);
    },
  });
  return { actions, revokeCalls };
}

// --- types derived from the factory (so the tests don't hard-code a type NAME) ------
type Actions = ReturnType<typeof createConnectorsActions>;
type LoadData = Awaited<ReturnType<Actions["load"]>>;
type DisconnectResult = Awaited<ReturnType<Actions["disconnectService"]>>;

// --- fixtures -----------------------------------------------------------------------

// Create a real person, register their DEK, and return their id. Every member-scoped row
// (their connections, agents) hangs off this id, which must exist in `users` for the FK.
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  deks.set(user.id, randomBytes(32));
  return user.id;
}

// A plain signed-in session for `userId` — the page resolves this from the
// `__Host-wh_session` cookie; the seam only needs its user id (identity from the session,
// never a client value).
function sessionFor(userId: string): Session {
  return {
    id: `sess-${userId}`,
    userId,
    createdAt: new Date(NOW.getTime() - 60_000),
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    steppedUpAt: null,
  };
}

// Provider credentials carrying a UNIQUE token, so an appearance of it in a page read is an
// unambiguous plaintext leak (the page read never carries credentials).
function credsWith(token: string): Record<string, unknown> {
  return { access_token: `atok_${token}`, refresh_token: `rtok_${token}` };
}

// Seed ONE connected service for `userId` and return the created Connection (its id is the
// handle Disconnect consumes; its connectorId is the catalogue slug agents are granted).
async function seedConnection(
  db: Db,
  userId: string,
  opts: { connectorId: string; accountLabel: string; token?: string },
): Promise<Connection> {
  return createConnection(
    db,
    {
      userId,
      connectorId: opts.connectorId,
      accountLabel: opts.accountLabel,
      credentials: credsWith(opts.token ?? opts.accountLabel),
      status: "connected",
    },
    await dekFor(userId),
    fixedClock(NOW),
  );
}

// A complete baseline grants record (every field present, as the store requires), giving the
// agent the listed accounts (connection ids) with the agent's own settings.
function baselineGrants(
  userId: string,
  connectionId: string,
  accountIds: string[],
): PermissionGrants {
  return {
    userId,
    connectionId,
    accounts: accountIds.map((accountId) => ({ accountId })),
    readTools: true,
    changeTools: "ask_first",
    identityAccess: true,
    highTierAccess: false,
    cardAccess: false,
    cardBudget: null,
    skillsScope: [],
    memoryRead: false,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
  };
}

// Seed an agent (its row AND its permission grants) for `userId`, granting it the given
// accounts. Returns the agent's connection id — the (userId, connectionId) handle its grants
// are read back by. One row per connection: the grant connection id differs from any service
// connection id, so the tests exercise the real two-id model.
async function seedAgent(
  db: Db,
  userId: string,
  opts: { displayName: string; accounts: string[]; status?: "connected" | "disconnected" },
): Promise<string> {
  const connectionId = randomUUID();
  await createAgent(
    db,
    {
      userId,
      connectionId,
      displayName: opts.displayName,
      platform: "someplatform",
      status: opts.status ?? "connected",
    },
    fixedClock(NOW),
  );
  await upsertPermissions(db, baselineGrants(userId, connectionId, opts.accounts));
  return connectionId;
}

// The ids of the accounts an agent may use, in a stable order.
async function accountsOf(db: Db, userId: string, agentConnectionId: string): Promise<string[]> {
  return (await getConnectionPermissions(db, userId, agentConnectionId))!.accounts.map((a) => a.accountId).sort();
}

// --- tiny markup helpers (no DOM), mirrored from the sibling component/loader tests --

const fakeAction = async (_formData: FormData): Promise<void> => {};

// Mount the screen the loader feeds, exactly as the page does: ConnectorsView over the
// loader's data, with the connect / disconnect / request actions bound by the page.
function renderScreen(data: LoadData): string {
  return renderToStaticMarkup(
    <ConnectorsView
      {...data}
      connectAction={fakeAction}
      disconnectAction={fakeAction}
      requestAction={fakeAction}
    />,
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
// injects a progressive-enhancement submit script), tags stripped and entities decoded —
// the words a sighted reader sees.
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
// placeholder in server-rendered markup; a bare form carries no such action. So "this form
// is bound to an action" is observable as its action scheme — behaviour, not source text
// (the same probe the view's own test uses).
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

// Forms whose visible text names a given control. `\bconnect\b` does not match inside
// "Disconnect" (the 's' before 'connect' is a word char, so there is no boundary), so the
// Connect and Disconnect controls are told apart cleanly.
function formsLabelled(markup: string, label: RegExp): El[] {
  return findAll(markup, "form").filter((f) => label.test(visibleText(f.inner)));
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
// relation name when it exists and NULL when it does not — a non-throwing probe scoped to
// the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// =====================================================================================
// AC1 — the loader reads ONLY the session user's connections + the catalogue and mounts
// ConnectorsView wired to the five controls.
// =====================================================================================

test("the loader exposes every wired action the page mounts (connect sign-in / api-key / provider-mcp / disconnect / request)", async () => {
  const db = await freshDb();
  try {
    const { actions } = makeActions(db);
    // An un-exposed action cannot be wired to the view — so each must be present to mount.
    assert.equal(typeof actions.load, "function", "load must be exposed");
    assert.equal(typeof actions.connectProviderSignin, "function", "connectProviderSignin must be exposed");
    assert.equal(typeof actions.saveApiKeyConnection, "function", "saveApiKeyConnection must be exposed");
    assert.equal(typeof actions.connectProviderMcp, "function", "connectProviderMcp must be exposed");
    assert.equal(typeof actions.disconnectService, "function", "disconnectService must be exposed");
    assert.equal(typeof actions.requestConnector, "function", "requestConnector must be exposed");
  } finally {
    await db.close();
  }
});

test("the loader returns the catalogue (grouped) and the person's own connections, and mounts a live ConnectorsView over them", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "lister");
    const connections = [
      await seedConnection(db, userId, { connectorId: "acme-mail", accountLabel: "QuokkaMailbox" }),
      await seedConnection(db, userId, { connectorId: "widget-sync", accountLabel: "NarwhalWorkspace" }),
    ];

    const data: LoadData = await makeActions(db).actions.load(sessionFor(userId));
    const markup = renderScreen(data);
    const text = visibleText(markup);

    // The catalogue is browsable: every fixture connector is offered on the screen.
    for (const name of ["Acme Mail", "Widget Sync", "Data Grid"]) {
      assert.ok(text.includes(name), `the catalogue must offer "${name}"; text="${text}"`);
    }

    // The person's OWN connected services are listed, each by its account label.
    for (const connection of connections) {
      assert.ok(
        text.includes(connection.accountLabel),
        `the loader must list the person's connection "${connection.accountLabel}"`,
      );
    }

    // Wired, not dead: a Connect control per catalogue entry is bound to the action and
    // carries that connector's id.
    const connectForms = formsLabelled(markup, /\bconnect\b/i);
    assert.ok(connectForms.length >= FIXTURE_ENTRIES.length, "every catalogue entry must offer a Connect control");
    assert.ok(connectForms.every(isBoundToAction), "every Connect control must be bound to a connect action (not a dead button)");
    for (const slug of ["acme-mail", "widget-sync", "data-grid"]) {
      assert.ok(
        connectForms.some((f) => inputValues(f.inner).includes(slug)),
        `a Connect control must carry connector id "${slug}" so the action connects the right service`,
      );
    }

    // Wired, not dead: a Disconnect control per connection is bound and carries THAT
    // connection's id.
    const disconnectForms = formsLabelled(markup, /\bdisconnect\b/i);
    assert.equal(disconnectForms.length, connections.length, "every connection must offer a Disconnect control");
    assert.ok(disconnectForms.every(isBoundToAction), "every Disconnect control must be bound to the disconnect action");
    for (const connection of connections) {
      assert.ok(
        disconnectForms.some((f) => inputValues(f.inner).includes(connection.id)),
        `a Disconnect control must carry connection id "${connection.id}" so the action disconnects the right service`,
      );
    }
  } finally {
    await db.close();
  }
});

test("a search miss surfaces a LIVE Request-a-service control wired to the request action", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "miss");
    // A term that matches no fixture connector → a MISS: no groups, the Request affordance on.
    const data = await makeActions(db).actions.load(sessionFor(userId), { query: "zzqqxx-nothing-matches" });
    assert.equal(data.canRequest, true, "a search that matches nothing offers Request a service");

    const markup = renderScreen(data);
    const requestForms = formsLabelled(markup, /request a service/i);
    assert.ok(requestForms.length >= 1, "a miss must render a Request-a-service control");
    assert.ok(requestForms.some(isBoundToAction), "the Request-a-service control must be bound to the request action");
  } finally {
    await db.close();
  }
});

test("the loader reads ONLY the session user's connections — another person's never appear", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner");
    const bob = await makeUser(db, "stranger");
    const mine = [
      await seedConnection(db, alice, { connectorId: "acme-mail", accountLabel: "QuokkaMailbox", token: "alice-a" }),
      await seedConnection(db, alice, { connectorId: "widget-sync", accountLabel: "NarwhalWorkspace", token: "alice-b" }),
    ];
    const theirs = [
      await seedConnection(db, bob, { connectorId: "acme-mail", accountLabel: "DingoMailbox", token: "bob-a" }),
      await seedConnection(db, bob, { connectorId: "data-grid", accountLabel: "PossumGrid", token: "bob-b" }),
    ];

    const data = await makeActions(db).actions.load(sessionFor(alice));
    const text = visibleText(renderScreen(data));
    const loadedIds = new Set(data.connections.map((c) => c.id));

    assert.equal(data.connections.length, mine.length, "the loader lists only the session user's own connections");
    for (const connection of mine) {
      assert.ok(loadedIds.has(connection.id), `Alice must see her own connection ${connection.id}`);
      assert.ok(text.includes(connection.accountLabel), `Alice's connection "${connection.accountLabel}" must appear`);
    }
    for (const connection of theirs) {
      assert.ok(!loadedIds.has(connection.id), `Alice must never see another person's connection ${connection.id}`);
      assert.ok(
        !text.includes(connection.accountLabel),
        `another person's connection "${connection.accountLabel}" must never appear; text="${text}"`,
      );
    }
    // The unique provider tokens never reach the client-facing data (page reads carry no
    // credentials) — neither Alice's own nor anyone else's.
    const json = JSON.stringify(data);
    for (const token of ["atok_alice-a", "rtok_alice-a", "atok_bob-a", "rtok_bob-b"]) {
      assert.ok(!json.includes(token), `a stored credential (${token}) must never reach the loaded page data`);
    }
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — disconnectService removes EVERY agent's access to that service and revokes the
// stored provider access where the provider allows it.
// =====================================================================================

test("disconnectService removes the account from EVERY one of the person's agents, and nothing else", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "disc-grants");
    // The account being disconnected, and two unrelated accounts that must survive.
    const service = await seedConnection(db, userId, { connectorId: "widget-sync", accountLabel: "NarwhalWorkspace" });
    const grid = await seedConnection(db, userId, { connectorId: "data-grid", accountLabel: "Grid" });
    const mail = await seedConnection(db, userId, { connectorId: "acme-mail", accountLabel: "QuokkaMail" });
    const agentA = await seedAgent(db, userId, { displayName: "QuokkaResearcher", accounts: [service.id, grid.id] });
    const agentB = await seedAgent(db, userId, { displayName: "NarwhalPlanner", accounts: [mail.id, service.id] });
    const agentC = await seedAgent(db, userId, { displayName: "WallabyInbox", accounts: [grid.id] });

    const result: DisconnectResult = await makeActions(db).actions.disconnectService(sessionFor(userId), service.id);
    assert.equal(result.ok, true, "disconnecting one's own connected service succeeds");

    assert.deepEqual(await accountsOf(db, userId, agentA), [grid.id], "agent A loses the disconnected account, keeps its other one");
    assert.deepEqual(await accountsOf(db, userId, agentB), [mail.id], "agent B loses the disconnected account, keeps its other one");
    assert.deepEqual(await accountsOf(db, userId, agentC), [grid.id], "an agent that never had it is left exactly as it was");
    assert.deepEqual((await getConnectionPermissions(db, userId, agentA))!.grantedConnectors, ["data-grid"], "so its service is no longer granted");
  } finally {
    await db.close();
  }
});

// docs/adr/several-accounts-per-agent.md — the founder's three Gmail accounts: disconnecting one
// removes only that one, from every agent that used it. The other two stay granted, and the
// page says who uses each of them.
test("disconnecting one of three accounts of a service keeps the other two granted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "disc-one-of-three");
    const home = await seedConnection(db, userId, { connectorId: "acme-mail", accountLabel: "levyoren1@acme.test" });
    const billing = await seedConnection(db, userId, { connectorId: "acme-mail", accountLabel: "levyorenbilling@acme.test" });
    const booking = await seedConnection(db, userId, { connectorId: "acme-mail", accountLabel: "levyorenbooking@acme.test" });
    const all = await seedAgent(db, userId, { displayName: "Claude", accounts: [home.id, billing.id, booking.id] });
    const homeOnly = await seedAgent(db, userId, { displayName: "Muse", accounts: [home.id] });
    const billingOnly = await seedAgent(db, userId, { displayName: "Grok", accounts: [billing.id] });

    const { actions } = makeActions(db);
    assert.equal((await actions.disconnectService(sessionFor(userId), home.id)).ok, true);

    assert.deepEqual(await accountsOf(db, userId, all), [billing.id, booking.id].sort(), "the other two accounts stay granted");
    assert.deepEqual((await getConnectionPermissions(db, userId, all))!.grantedConnectors, ["acme-mail"], "so the service stays granted");
    assert.deepEqual(await accountsOf(db, userId, homeOnly), [], "an agent that had only that account has none left");
    assert.deepEqual(await accountsOf(db, userId, billingOnly), [billing.id], "an agent using another account keeps it");

    const byId = new Map((await actions.load(sessionFor(userId))).connections.map((c) => [c.id, c]));
    assert.equal(byId.has(home.id), false, "the disconnected account is no longer listed");
    assert.deepEqual([...byId.get(billing.id)!.agents].sort(), ["Claude", "Grok"]);
    assert.deepEqual(byId.get(booking.id)?.agents, ["Claude"]);
  } finally {
    await db.close();
  }
});

// "Used by" is per account: an agent is listed under each account it may use, and only under
// those, so two accounts of one service can have different agents. Disconnected agents and
// another person's agents are never named.
test("Used by names, for each account, the connected agents that may use that account", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "used-by");
    const otherId = await makeUser(db, "used-by-other");
    const home = await seedConnection(db, userId, { connectorId: "acme-mail", accountLabel: "home@acme.test" });
    const work = await seedConnection(db, userId, { connectorId: "acme-mail", accountLabel: "work@acme.test" });
    const grid = await seedConnection(db, userId, { connectorId: "data-grid", accountLabel: "Grid" });
    await seedAgent(db, userId, { displayName: "QuokkaResearcher", accounts: [home.id] });
    await seedAgent(db, userId, { displayName: "NarwhalPlanner", accounts: [home.id, work.id] });
    await seedAgent(db, userId, { displayName: "WallabyInbox", accounts: [work.id], status: "disconnected" });
    const theirs = await seedConnection(db, otherId, { connectorId: "acme-mail", accountLabel: "them@acme.test" });
    await seedAgent(db, otherId, { displayName: "DingoScheduler", accounts: [theirs.id] });

    const byId = new Map((await makeActions(db).actions.load(sessionFor(userId))).connections.map((c) => [c.id, c]));
    assert.deepEqual([...byId.get(home.id)!.agents].sort(), ["NarwhalPlanner", "QuokkaResearcher"]);
    assert.deepEqual(byId.get(work.id)!.agents, ["NarwhalPlanner"], "a disconnected agent isn't named");
    assert.deepEqual(byId.get(grid.id)!.agents, [], "no agent uses the account");

    const words = visibleText(renderScreen(await makeActions(db).actions.load(sessionFor(userId))));
    assert.match(words, /Used by NarwhalPlanner(?!,)/, "the second account names only its own agent");
    assert.ok(!words.includes("DingoScheduler"), "another person's agent is never named");
    assert.ok(!words.includes("WallabyInbox"));
  } finally {
    await db.close();
  }
});

test("disconnectService revokes the stored provider access for a provider-sign-in service", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "disc-revoke");
    // "widget-sync" is an oauth2 (provider sign-in) service — Warthog holds the provider
    // tokens, so the provider allows revoking them.
    const service = await seedConnection(db, userId, { connectorId: "widget-sync", accountLabel: "NarwhalWorkspace" });

    const { actions, revokeCalls } = makeActions(db);
    const result = await actions.disconnectService(sessionFor(userId), service.id);
    assert.equal(result.ok, true, "disconnecting one's own provider-sign-in service succeeds");

    // The provider-side revocation fired exactly for THIS person's THIS connection — never
    // on a caller-supplied identity.
    assert.equal(revokeCalls.length, 1, "the provider access is revoked exactly once");
    assert.equal(revokeCalls[0]!.connectionId, service.id, "revocation names the disconnected connection");
    assert.equal(revokeCalls[0]!.userId, userId, "revocation is scoped to the session user");
  } finally {
    await db.close();
  }
});

// Review fix F4 — disconnecting really disconnects: the connection and its stored provider
// credentials are gone, the provider is asked to revoke (best effort, while the tokens still
// exist), and the disconnection is recorded in the person's activity.

test("disconnectService deletes the connection and its stored credentials, so the page no longer lists it", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "disc-delete");
    const service = await seedConnection(db, userId, { connectorId: "acme-mail", accountLabel: "QuokkaMail", token: "SECRET" });
    const kept = await seedConnection(db, userId, { connectorId: "data-grid", accountLabel: "Grid" });
    const agent = await seedAgent(db, userId, { displayName: "QuokkaResearcher", accounts: [service.id] });

    const { actions } = makeActions(db);
    const result = await actions.disconnectService(sessionFor(userId), service.id);
    assert.equal(result.ok, true);

    assert.equal(await getConnectionById(db, userId, service.id), null, "the connection is gone");
    const stored = await db.query("SELECT count(*)::int AS n FROM connections WHERE id = $1", [service.id]);
    assert.equal(stored.rows[0]?.n, 0, "no row (and so no ciphertext of the credentials) remains");
    assert.deepEqual(
      (await listConnectionsForUser(db, userId)).map((c) => c.id),
      [kept.id],
      "only the other service remains",
    );
    const data = await actions.load(sessionFor(userId));
    assert.deepEqual(data.connections.map((c) => c.id), [kept.id], "the page lists only the remaining service");

    // The agent's grant went with the account: nothing can reactivate the old credential.
    assert.deepEqual((await getConnectionPermissions(db, userId, agent))!.accounts, []);
    assert.deepEqual((await getConnectionPermissions(db, userId, agent))!.grantedConnectors, []);
  } finally {
    await db.close();
  }
});

test("disconnectService records the disconnection in the person's activity, with no credential in it", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "disc-activity");
    const service = await seedConnection(db, userId, { connectorId: "widget-sync", accountLabel: "NarwhalWorkspace", token: "SECRET" });

    await makeActions(db).actions.disconnectService(sessionFor(userId), service.id);

    const entries = await readActivity(db, userId, await dekFor(userId));
    assert.equal(entries.length, 1, "exactly one activity entry is written");
    const entry = entries[0]!;
    assert.equal(entry.kind, "connection_change");
    assert.equal(entry.source, "warthog");
    assert.equal(entry.connectorId, "widget-sync");
    assert.equal(entry.outcome, "disconnected");
    const json = JSON.stringify(entry);
    assert.ok(json.includes("NarwhalWorkspace"), "the entry names the disconnected account");
    assert.ok(!json.includes("SECRET"), "no stored credential reaches the activity record");
  } finally {
    await db.close();
  }
});

test("provider revocation runs while the stored tokens still exist, and is handed them", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "disc-revoke-first");
    const service = await seedConnection(db, userId, { connectorId: "widget-sync", accountLabel: "NarwhalWorkspace", token: "T1" });

    let sawRow = false;
    let sawCredentials: Record<string, unknown> | undefined;
    const { actions, revokeCalls } = makeActions(db, fixtureIndex(), {
      revoke: async (input) => {
        sawRow = (await getConnectionById(db, userId, input.connectionId)) !== null;
        sawCredentials = input.credentials;
      },
    });
    await actions.disconnectService(sessionFor(userId), service.id);

    assert.equal(revokeCalls.length, 1);
    assert.equal(sawRow, true, "the provider is asked to revoke before Warthog forgets the tokens");
    assert.deepEqual(sawCredentials, credsWith("T1"), "the revoker is handed the stored token set");
    assert.equal(await getConnectionById(db, userId, service.id), null, "and then the connection is deleted");
  } finally {
    await db.close();
  }
});

test("a failed provider revocation never blocks the disconnect, and the record says it was not revoked", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "disc-revoke-fails");
    const service = await seedConnection(db, userId, { connectorId: "widget-sync", accountLabel: "NarwhalWorkspace" });
    const agent = await seedAgent(db, userId, { displayName: "QuokkaResearcher", accounts: [service.id] });

    const { actions } = makeActions(db, fixtureIndex(), {
      revoke: async () => {
        throw new Error("provider unavailable");
      },
    });
    const result = await actions.disconnectService(sessionFor(userId), service.id);

    assert.equal(result.ok, true, "the person's disconnect still succeeds");
    assert.equal(await getConnectionById(db, userId, service.id), null, "the credentials are still deleted");
    assert.deepEqual((await getConnectionPermissions(db, userId, agent))!.grantedConnectors, []);
    const [entry] = await readActivity(db, userId, await dekFor(userId));
    assert.deepEqual(
      (entry!.payload as { providerRevoked?: unknown }).providerRevoked,
      false,
      "the activity record states the provider access was not revoked",
    );
  } finally {
    await db.close();
  }
});

test("an api-key service is not sent to the provider revoker, but is still deleted and recorded", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "disc-apikey");
    const service = await seedConnection(db, userId, { connectorId: "acme-mail", accountLabel: "QuokkaMail" });

    const { actions, revokeCalls } = makeActions(db);
    await actions.disconnectService(sessionFor(userId), service.id);

    assert.equal(revokeCalls.length, 0, "an api key has no provider-side revocation");
    assert.equal(await getConnectionById(db, userId, service.id), null);
    const [entry] = await readActivity(db, userId, await dekFor(userId));
    assert.equal(entry!.connectorId, "acme-mail");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — ownership: a person cannot disconnect another person's connection, and the strip
// is member-scoped (another person's agents keep their access).
// =====================================================================================

test("a person cannot disconnect another person's connection — it and its agents are untouched", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "disc-victim");
    const bob = await makeUser(db, "disc-attacker");
    const aliceService = await seedConnection(db, alice, { connectorId: "widget-sync", accountLabel: "NarwhalWorkspace" });
    const aliceAgent = await seedAgent(db, alice, { displayName: "QuokkaResearcher", accounts: [aliceService.id] });

    const { actions, revokeCalls } = makeActions(db);
    // Bob, holding Alice's real connection id, tries to disconnect it.
    const result = await actions.disconnectService(sessionFor(bob), aliceService.id);
    assert.equal(result.ok, false, "disconnecting another person's connection must be refused (ok:false)");

    // Alice's service still exists, and her agent still has access — nothing was stripped
    // or revoked on another person's say-so.
    assert.ok(
      (await getConnectionById(db, alice, aliceService.id)) !== null,
      "another person's refused disconnect leaves the owner's connection in place",
    );
    assert.deepEqual(
      await accountsOf(db, alice, aliceAgent),
      [aliceService.id],
      "the owner's agent keeps its access after a stranger's refused disconnect",
    );
    assert.equal(revokeCalls.length, 0, "no provider access is revoked on a refused disconnect");
  } finally {
    await db.close();
  }
});

test("the removal is member-scoped — another person's agent on the same service keeps its account", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "strip-self");
    const bob = await makeUser(db, "strip-other");
    // Both people have their OWN "widget-sync" account and an agent granted it.
    const aliceService = await seedConnection(db, alice, { connectorId: "widget-sync", accountLabel: "NarwhalWorkspace" });
    const bobService = await seedConnection(db, bob, { connectorId: "widget-sync", accountLabel: "NarwhalWorkspace" });
    const aliceAgent = await seedAgent(db, alice, { displayName: "QuokkaResearcher", accounts: [aliceService.id] });
    const bobAgent = await seedAgent(db, bob, { displayName: "DingoScheduler", accounts: [bobService.id] });

    await makeActions(db).actions.disconnectService(sessionFor(alice), aliceService.id);

    assert.deepEqual(
      await accountsOf(db, alice, aliceAgent),
      [],
      "Alice's agent loses access to the account she disconnected",
    );
    assert.deepEqual(
      await accountsOf(db, bob, bobAgent),
      [bobService.id],
      "Bob's agent — same service, different person — keeps its account",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 / AC4 — a connection id that is not the expected shape is rejected with a 4xx (not a
// raw cast), and a SQL-injection probe in the id cannot alter a query (parameter binding).
// =====================================================================================

test("disconnectService rejects a malformed or oversized connection id with a 4xx before any query (OBS-049)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "disc-bad-id");
    const { actions } = makeActions(db);
    const session = sessionFor(userId);

    // Not a well-formed uuid — a bare integer, a negative, a decimal, the empty string,
    // whitespace, a non-uuid word, and a grossly oversized blob. Each is rejected at the
    // boundary BEFORE it can reach `WHERE id = $1` as a failing cast.
    for (const badId of ["not-a-uuid", "5", "-1", "1.5", "", "   ", "x".repeat(100_000)]) {
      await assertRejects4xx(`disconnectService(id=${JSON.stringify(badId.slice(0, 16))}…)`, () =>
        actions.disconnectService(session, badId),
      );
    }
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in the connection id cannot alter a query: the tables survive and nothing is stripped", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "disc-sqli");
    const service = await seedConnection(db, userId, { connectorId: "widget-sync", accountLabel: "NarwhalWorkspace" });
    const agent = await seedAgent(db, userId, { displayName: "QuokkaResearcher", accounts: [service.id] });
    const { actions, revokeCalls } = makeActions(db);

    // A canonical SQL-breaking id. Concatenated into a statement it would drop a table;
    // shape-guarded at the boundary it is refused with a 4xx before any query runs.
    const probe = "x'; DROP TABLE connections; --";
    await assertRejects4xx("disconnectService(SQLi id)", () => actions.disconnectService(sessionFor(userId), probe));

    // The tables survive (the probe never reached a query)…
    assert.equal(await tableExists(db, "connections"), true, "the connections table survives the SQL-injection probe");
    assert.equal(await tableExists(db, "agent_permissions"), true, "the agent_permissions table survives the probe");
    // …nothing was stripped or revoked (no query was altered).
    assert.deepEqual(
      await accountsOf(db, userId, agent),
      [service.id],
      "the SQL-injection probe removed nothing — the agent still has access",
    );
    assert.equal(revokeCalls.length, 0, "the SQL-injection probe revoked nothing");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — saveApiKeyConnection: happy path, and malformed / oversized / SQL-shaped input.
// =====================================================================================

test("saveApiKeyConnection creates the key connection for the SESSION user only", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "save-self");
    const bob = await makeUser(db, "save-other");

    await makeActions(db).actions.saveApiKeyConnection(sessionFor(alice), {
      connectorId: "acme-mail",
      accountLabel: "QuokkaMailbox",
      apiKey: "sk_test_abc123",
    });

    // The connection is Alice's — the owner is the session's id, never a client value.
    const aliceConns = await listConnectionsForUser(db, alice);
    assert.equal(aliceConns.length, 1, "exactly one connection is created for the acting person");
    assert.equal(aliceConns[0]!.connectorId, "acme-mail", "the connection is for the chosen connector");
    assert.equal(aliceConns[0]!.accountLabel, "QuokkaMailbox", "the connection carries the chosen account label");
    // …and never lands under anyone else.
    assert.equal((await listConnectionsForUser(db, bob)).length, 0, "no connection leaks to another person");
  } finally {
    await db.close();
  }
});

test("saveApiKeyConnection rejects malformed or oversized input with a 4xx before any write", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "save-bad");
    const { actions } = makeActions(db);
    const session = sessionFor(userId);

    // An oversized / empty connector id is not the expected shape → 4xx (AC3). An unknown
    // key shape is likewise refused: oversized / empty api key, empty / oversized label.
    await assertRejects4xx("oversized connectorId", () =>
      actions.saveApiKeyConnection(session, { connectorId: "x".repeat(100_000), accountLabel: "QuokkaMailbox", apiKey: "sk_test_abc" }),
    );
    await assertRejects4xx("empty connectorId", () =>
      actions.saveApiKeyConnection(session, { connectorId: "", accountLabel: "QuokkaMailbox", apiKey: "sk_test_abc" }),
    );
    await assertRejects4xx("oversized apiKey", () =>
      actions.saveApiKeyConnection(session, { connectorId: "acme-mail", accountLabel: "QuokkaMailbox", apiKey: "x".repeat(100_000) }),
    );
    await assertRejects4xx("empty apiKey", () =>
      actions.saveApiKeyConnection(session, { connectorId: "acme-mail", accountLabel: "QuokkaMailbox", apiKey: "" }),
    );
    await assertRejects4xx("empty accountLabel", () =>
      actions.saveApiKeyConnection(session, { connectorId: "acme-mail", accountLabel: "", apiKey: "sk_test_abc" }),
    );
    await assertRejects4xx("oversized accountLabel", () =>
      actions.saveApiKeyConnection(session, { connectorId: "acme-mail", accountLabel: "x".repeat(100_000), apiKey: "sk_test_abc" }),
    );

    // None of the refused calls wrote a connection (the 4xx came before any write).
    assert.equal((await listConnectionsForUser(db, userId)).length, 0, "a refused save writes no connection");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in the api key is stored as data, not executed (parameter binding)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "save-sqli");
    const { actions } = makeActions(db);

    // A SQL-breaking key value within length bounds: bound as a parameter (and encrypted),
    // it is inert data — the connection saves and the table survives.
    const probeKey = "x'; DROP TABLE connections; --";
    await actions.saveApiKeyConnection(sessionFor(userId), {
      connectorId: "acme-mail",
      accountLabel: "QuokkaMailbox",
      apiKey: probeKey,
    });

    assert.equal(await tableExists(db, "connections"), true, "the connections table survives a SQL-shaped api key");
    const conns = await listConnectionsForUser(db, userId);
    assert.equal(conns.length, 1, "the connection was created (the key was stored as data, not run)");
    assert.equal(conns[0]!.connectorId, "acme-mail", "the saved connection is intact");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC1 / AC4 — requestConnector records the request for the session user (the operator reads
// it on the admin portal's Requests page), and refuses a malformed / oversized / SQL-shaped name.
// =====================================================================================

test("requestConnector records a service request for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "req-self");
    const bob = await makeUser(db, "req-other");
    const { actions } = makeActions(db);

    await actions.requestConnector(sessionFor(alice), { name: "Fancy Spreadsheets" });

    // Recorded for Alice (member-scoped — the owner is the session's id, never a client
    // value), naming exactly what she typed; never recorded for anyone else.
    const aliceReqs = await listConnectorRequestsForUser(db, alice);
    assert.equal(aliceReqs.length, 1, "the request is recorded for the acting person");
    assert.equal(aliceReqs[0]!.serviceName, "Fancy Spreadsheets", "the request names the service the person asked for");
    assert.equal(aliceReqs[0]!.kind, "service", "as a request for a new service");
    assert.equal((await listConnectorRequestsForUser(db, bob)).length, 0, "no request leaks to another person");
  } finally {
    await db.close();
  }
});

test("askToJoin files an early-access request for a gated Google service, naming the catalogue's service", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "early");
    const dir = makeCatalogueDir([
      ...FIXTURE_ENTRIES,
      {
        id: "google-gmail",
        name: "Gmail",
        aliases: [],
        category: "email",
        auth_kind: "oauth2",
        base_url: "https://gmail.googleapis.com",
        auth: { authorize_url: "https://accounts.google.com/a", token_url: "https://oauth2.googleapis.com/t", scopes: ["s"] },
        google_early_access: true,
      },
    ]);
    let catalogue: CatalogueIndex;
    try {
      catalogue = loadCatalogue({ dir, isOAuthClientConfigured: () => true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const { actions } = makeActions(db, catalogue);
    const session = sessionFor(userId);

    await actions.askToJoin(session, { connectorId: "google-gmail" });
    const requests = await listConnectorRequestsForUser(db, userId);
    assert.deepEqual(requests.map((r) => [r.kind, r.connectorId, r.serviceName]), [["google_early_access", "google-gmail", "Gmail"]]);

    // Only a service gated for this person can be asked for; nothing else is written.
    await assertRejects4xx("a service that isn't in early access", () => actions.askToJoin(session, { connectorId: "acme-mail" }));
    await assertRejects4xx("an unknown service", () => actions.askToJoin(session, { connectorId: "no-such-thing" }));
    await assertRejects4xx("an empty id", () => actions.askToJoin(session, { connectorId: "" }));
    assert.equal((await listConnectorRequestsForUser(db, userId)).length, 1);
  } finally {
    await db.close();
  }
});

test("requestConnector refuses a name of only spaces, like an empty one", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "req-blank");
    const { actions } = makeActions(db);
    await assertRejects4xx("spaces only", () => actions.requestConnector(sessionFor(userId), { name: "   " }));
    assert.equal((await listConnectorRequestsForUser(db, userId)).length, 0);
  } finally {
    await db.close();
  }
});

test("requestConnector rejects a malformed or oversized name with a 4xx before any write", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "req-bad");
    const { actions } = makeActions(db);
    const session = sessionFor(userId);

    await assertRejects4xx("empty name", () => actions.requestConnector(session, { name: "" }));
    await assertRejects4xx("oversized name", () => actions.requestConnector(session, { name: "x".repeat(100_000) }));

    assert.equal((await listConnectorRequestsForUser(db, userId)).length, 0, "a refused request writes nothing");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in a requested name is stored verbatim as data (parameter binding)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "req-sqli");
    const { actions } = makeActions(db);

    // A SQL-breaking service name within bounds: bound as a parameter it is stored
    // VERBATIM (free text the person typed) and cannot alter a query.
    const probe = "Robert'); DROP TABLE connector_requests; --";
    await actions.requestConnector(sessionFor(userId), { name: probe });

    assert.equal(await tableExists(db, "connector_requests"), true, "the connector_requests table survives the probe");
    const reqs = await listConnectorRequestsForUser(db, userId);
    assert.equal(reqs.length, 1, "the request was recorded (the name was stored as data, not run)");
    assert.equal(reqs[0]!.serviceName, probe, "the SQL-shaped name is stored verbatim, unchanged");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC5 — no ambient env secret leaks into the loaded data or the mounted screen; config is
// read from the injected seams, not the image/client. [obligation:secrets-from-env]
// =====================================================================================

test("no ambient env secret leaks into the loaded connectors data or the mounted screen", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "decoy");
    await seedConnection(db, userId, { connectorId: "acme-mail", accountLabel: "QuokkaMailbox" });
    await seedConnection(db, userId, { connectorId: "widget-sync", accountLabel: "NarwhalWorkspace" });

    const data = await makeActions(db).actions.load(sessionFor(userId));

    // The decoy appears in neither the loader's returned data…
    assert.ok(!JSON.stringify(data).includes(DECOY), "no ambient env value is folded into the loaded connectors data");
    // …nor the client-bound markup the person's browser receives.
    assert.ok(!renderScreen(data).includes(DECOY), "no ambient env value is folded into the mounted Connectors screen");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===========================================================================
// Several accounts of one service (docs/adr/google-published-and-accounts.md): a person can
// name a Notion or key-based account, never a Google or Microsoft one (named by its address,
// which is how a reconnect is recognised); a Google or Microsoft account that needs it offers
// Reconnect in place.
// ===========================================================================

test("renameService names the person's own Notion or key-based account, cleaned and short", async () => {
  const db = await freshDb();
  try {
    const { actions } = makeActions(db);
    const userId = await makeUser(db, "renamer");
    const grid = await seedConnection(db, userId, { connectorId: "data-grid", accountLabel: "Data Grid" });
    const key = await seedConnection(db, userId, { connectorId: "acme-mail", accountLabel: "Acme Mail" });

    assert.deepEqual(await actions.renameService(sessionFor(userId), { connectionId: grid.id, name: "  Family\u202E   workspace  " }), { ok: true });
    assert.equal((await getConnectionById(db, userId, grid.id))?.accountLabel, "Family workspace", "invisible characters and extra spaces go");
    assert.deepEqual(await actions.renameService(sessionFor(userId), { connectionId: key.id, name: "x".repeat(200) }), { ok: true });
    assert.equal((await getConnectionById(db, userId, key.id))?.accountLabel.length, 60, "a long name is shortened");
    await assertRejects4xx("an empty name", () => actions.renameService(sessionFor(userId), { connectionId: grid.id, name: "   " }));
  } finally {
    await db.close();
  }
});

test("renameService never renames a Google or Microsoft account, or another person's", async () => {
  const db = await freshDb();
  try {
    const { actions } = makeActions(db);
    const userId = await makeUser(db, "owner");
    const otherId = await makeUser(db, "other");
    const oauth = await seedConnection(db, userId, { connectorId: "widget-sync", accountLabel: "sam@widget.test" });
    const theirs = await seedConnection(db, otherId, { connectorId: "data-grid", accountLabel: "Data Grid" });

    assert.deepEqual(await actions.renameService(sessionFor(userId), { connectionId: oauth.id, name: "Work" }), { ok: false });
    assert.equal((await getConnectionById(db, userId, oauth.id))?.accountLabel, "sam@widget.test");
    assert.deepEqual(await actions.renameService(sessionFor(userId), { connectionId: theirs.id, name: "Mine now" }), { ok: false });
    assert.equal((await getConnectionById(db, otherId, theirs.id))?.accountLabel, "Data Grid");
  } finally {
    await db.close();
  }
});

test("each account says whether it can be reconnected or renamed", async () => {
  const db = await freshDb();
  try {
    const { actions } = makeActions(db);
    const userId = await makeUser(db, "rows");
    const oauthOk = await seedConnection(db, userId, { connectorId: "widget-sync", accountLabel: "ok@widget.test" });
    const oauthLapsed = await seedConnection(db, userId, { connectorId: "widget-sync", accountLabel: "lapsed@widget.test" });
    await updateConnectionStatus(db, { userId, id: oauthLapsed.id, status: "needs_reconnect" });
    const key = await seedConnection(db, userId, { connectorId: "acme-mail", accountLabel: "Acme Mail" });

    const rows = new Map((await actions.load(sessionFor(userId))).connections.map((c) => [c.id, c]));
    assert.equal(rows.get(oauthOk.id)?.reconnectable, false, "a working sign-in account has nothing to reconnect");
    assert.equal(rows.get(oauthOk.id)?.renameable, false, "a sign-in account keeps its address");
    assert.equal(rows.get(oauthLapsed.id)?.reconnectable, true, "a lapsed sign-in account reconnects in place");
    assert.equal(rows.get(oauthLapsed.id)?.reconnectLabel, "Reconnect");
    assert.equal(rows.get(key.id)?.reconnectable, false);
    assert.equal(rows.get(key.id)?.renameable, true);
  } finally {
    await db.close();
  }
});
