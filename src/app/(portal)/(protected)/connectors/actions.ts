import { formatAccountTime } from "@/server/display-time";
import { timeZoneFor } from "@/server/spending/time-zone";
// E09-S17 — Connectors page loader + connect/disconnect/request actions (the
// injectable, unit-testable seam the thin `page.tsx` composes — the convention's
// `createXActions(deps)` factory, as `agents/actions.ts`, `access-key/actions.ts`,
// `oauth/authorize/actions.ts` and `home/actions.ts` do). A Next entry file may export
// only its framework fields, so the flow logic lives here and the entry stays thin
// (OBS-025).
//
// The Connectors screen (brief "Connector hub"; design §7; CLAUDE.md vocabulary — a
// *connector* is a catalogue entry, a *connection* is a person's connected service, an
// *agent* is a connected AI client, ONE ROW PER CONNECTION). `load` assembles the
// already-render-tested <ConnectorsView/>'s props for the SESSION user from the catalogue
// browse (grouped by category, each entry carrying the per-person Google gate decision)
// and the person's OWN connections (never credentials). The connect / disconnect / request
// controls are bound to these actions by the page when it mounts the view.
//
// disconnectService is the one that CHANGES data (brief: "disconnect in one click, which
// immediately removes every agent's access to that service and revokes Warthog's stored
// access to the provider"): it asks the provider to revoke the stored access where the
// provider allows it (the oauth2 provider-sign-in kind, whose tokens Warthog holds — best
// effort, while the tokens still exist), then in ONE transaction strips the connector slug
// from every one of the person's agents' grants, DELETES the connection with its encrypted
// credentials, and records the disconnection in the person's activity.
//
// Security (each a reviewer veto):
//   • Every read/write is member-scoped by `session.userId` — never a client value
//     (CLAUDE.md). `load` reads only the session user's connections / agents / catalogue;
//     disconnectService resolves the connection by (session.userId, id) FIRST, so another
//     person's connection id is refused with their service + their agents left untouched,
//     and the strip only ever walks the session user's own agents.
//   • Input is validated at the boundary (INV-102): a malformed / oversized / SQL-shaped
//     connection id, connector id, account label, api key or requested name is refused with
//     a 4xx `HttpError` BEFORE any query — so a mis-shaped uuid never reaches `WHERE id = $1`
//     as a failing cast (OBS-049) and a SQL-shaped value is bound as a parameter (data),
//     never statement text.
//   • This module reads no `process.env` and holds no secret (INV-103): the db, clock,
//     catalogue, per-user DEK lookup, outbound fetch, the Google allowlist, the provider client configs and the provider-revocation seam are
//     all INJECTED, so no ambient env value can leak into the loaded screen.

import { z } from "zod";

import { parseParams, HttpError } from "@/server/http/validate";
import { withTransaction, type Db } from "@/server/db/index";
import type { Clock } from "@/server/seams/clock";
import type { Session } from "@/server/auth/session";
import { getUserById } from "@/server/db/users";
import { defaultAccountsForAgents, getConnectionById, getConnectionCredentials, renameConnection, setDefaultForAgents as setConnectionDefault } from "@/server/db/connections";
import { cleanShortText } from "@/domain/content/untrusted";
import { createRedactingRecorder } from "@/server/mcp/recorder";
import { listAgentsForUser } from "@/server/db/agents";
import { getConnectionPermissions, upsertPermissions } from "@/server/db/agent-permissions";
import {
  browseCatalogue,
  listConnectionsForPage,
  type ConnectionForPage,
} from "@/server/connectors/page-data";
import { askToJoinEarlyAccess, gateGoogleConnector } from "@/server/connectors/google-early-access";
import { saveApiKeyConnection as saveApiKeyConnectionService } from "@/server/connectors/api-key";
import { requestConnector as requestConnectorService } from "@/server/connectors/requests";
import { connectableMatchFor } from "@/server/connectors/request-match";
import { listConnectorRequestsForUser, type ConnectorRequest } from "@/server/db/connector-requests";
import { redact } from "@/domain/redaction/redact";
import {
  buildAuthorizeUrl,
  type OAuthClientConfig,
} from "@/server/connectors/oauth-client";
import {
  connectProviderMcp as connectProviderMcpService,
  type ProviderMcpConfig,
  type ListProviderTools,
} from "@/server/connectors/provider-mcp";
import type { CatalogueIndex } from "@/server/connectors/catalogue";
import type { ConnectionStatus } from "@/server/db/connections";
import type { StatusKey } from "@/components/ui/status";
import type {
  ConnectorsViewProps,
  CatalogueGroup,
  CatalogueItem,
  CategoryCount,
  ConnectionItem,
  ToolItem,
  YourRequest,
} from "@/components/connectors/connectors-view";
import {
  POPULAR_SERVICES,
  catalogueGroupOf,
  compareCatalogueGroups,
  resolveCatalogueGroup,
} from "@/components/connectors/catalogue-groups";

// What the provider-revocation seam is told: the acting person, the connection whose
// stored provider access to revoke, its connector slug (for the provider adapter) and the
// stored token set (decrypted in memory only, so the adapter can present the tokens to the
// provider's revocation endpoint; never logged or recorded). Identity is the session's,
// never a caller value.
export interface RevokeProviderAccessInput {
  readonly userId: string;
  readonly connectionId: string;
  readonly connectorId: string;
  readonly credentials: Record<string, unknown>;
}

// Every seam injected — no process.env, no secret (INV-103).
export interface ConnectorsActionsDeps {
  readonly providerMcpAvailable?: boolean;
  readonly startProviderMcp?: (session:Session,connectorId:string)=>Promise<{url:string}>;
  readonly providerToolsets?: (userId:string,connections:readonly ConnectionForPage[])=>Promise<Record<string,readonly {name:string; makesChange?:boolean}[]>>;
  readonly startProviderSignin?: (session: Session, connectorId: string) => Promise<{ url: string }>;
  readonly db: Db;
  // Supplies connected-at / requested-at instants, passed through to the stores (never SQL now()).
  readonly clock: Clock;
  // The in-memory catalogue index (browse + resolve a connector entry by id).
  readonly catalogue: CatalogueIndex;
  // The acting person's already-unwrapped DEK (the credential envelopes encrypt under it);
  // injected, so this module holds no key.
  readonly dekFor: (userId: string) => Promise<Uint8Array>;
  // The SSRF-guarded outbound fetch (api-key verify, oauth, provider mcp).
  readonly fetch: typeof fetch;
  // The Google early-access allowlist, injected from config.
  readonly googleEarlyAccess: readonly string[];
  // The operator-registered provider sign-in (oauth2) client, from config.
  readonly oauthClientConfigFor: (connectorId: string) => OAuthClientConfig;
  // The CIMD identity Warthog presents to a provider_mcp provider, from config.
  readonly providerMcpConfig: ProviderMcpConfig;
  // The provider_mcp tool-listing transport seam.
  readonly listProviderTools: ListProviderTools;
  // The provider-side revocation seam (called on disconnect where the provider allows it).
  readonly revokeProviderAccess: (input: RevokeProviderAccessInput) => Promise<void>;
}

// The <ConnectorsView/> data object the loader returns — the view's props minus the
// controls the page binds when it mounts the view.
export type ConnectorsViewData = Omit<
  ConnectorsViewProps,
  "connectAction" | "disconnectAction" | "requestAction" | "renameAction" | "defaultForAgentsAction"
>;

// The outcome of a disconnect: success, or a refusal naming its reason (the connection is
// not this person's / does not exist). Never a silent success.
export type DisconnectServiceResult =
  | { readonly ok: true; readonly providerRevoked?: boolean | null }
  | { readonly ok: false; readonly reason: string };

export interface ConnectorsActions {
  load(session: Session, input?: { query?: string; category?: string }): Promise<ConnectorsViewData>;
  connectProviderSignin(session: Session, input: { connectorId: string }): Promise<unknown>;
  saveApiKeyConnection(
    session: Session,
    input: { connectorId: string; accountLabel: string; apiKey: string },
  ): Promise<unknown>;
  connectProviderMcp(
    session: Session,
    input: { connectorId: string; accountLabel: string },
  ): Promise<unknown>;
  disconnectService(session: Session, connectionId: string): Promise<DisconnectServiceResult>;
  renameService(session: Session, input: { connectionId: string; name: string }): Promise<{ readonly ok: boolean }>;
  setDefaultForAgents(session: Session, input: { connectionId: string; on: boolean }): Promise<{ readonly ok: boolean }>;
  requestConnector(session: Session, input: { name: string }): Promise<unknown>;
  askToJoin(session: Session, input: { connectorId: string }): Promise<unknown>;
}

// ---- boundary validation shapes (INV-102) -----------------------------------------
//
// A catalogue slug / account label / requested name is short free text; a grossly oversized
// value is refused on length before it reaches any store, and an empty one is refused too.
// The api key can be longer (a provider JWT), so it carries a larger ceiling. A connection
// id is a uuid (the row id), shape-guarded so a non-uuid never reaches `WHERE id = $1`.
const SLUG_MAX = 128;
const LABEL_MAX = 256;
const NAME_MAX = 256;
const API_KEY_MAX = 4096;

const connectorIdSchema = z.string().min(1).max(SLUG_MAX);
const connectionIdSchema = z.uuid();
const saveApiKeySchema = z.object({
  connectorId: connectorIdSchema,
  accountLabel: z.string().min(1).max(LABEL_MAX),
  apiKey: z.string().min(1).max(API_KEY_MAX),
});
const connectProviderMcpSchema = z.object({
  connectorId: connectorIdSchema,
  accountLabel: z.string().min(1).max(LABEL_MAX),
});
// A name the person gives one of their accounts: trimmed, and short enough to read in a list.
const RENAME_MAX = 60;
const renameServiceSchema = z.object({
  connectionId: connectionIdSchema,
  name: z.string().trim().min(1).max(RENAME_MAX * 4),
});
const defaultForAgentsSchema = z.object({
  connectionId: connectionIdSchema,
  on: z.boolean(),
});
// Trimmed first, so a name of only spaces is refused like an empty one (interaction-02).
const requestConnectorSchema = z.object({
  name: z.string().trim().min(1).max(NAME_MAX),
});

// ---- presentation helpers ---------------------------------------------------------

// The most of the person's own requests Connectors lists.
const YOUR_REQUESTS_MAX = 20;

// Where a ready request's service is found: the catalogue, searched for its name.
function findHrefFor(name: string): string {
  return `/connectors?${new URLSearchParams({ view: "catalogue", q: name })}`;
}

// The connection store's status vs. the <Status> primitive's StatusKey: the stored
// 'needs_reconnect' reads as the UI's 'needs-reconnect' (CLAUDE.md "Reconnect needed").
function toStatusKey(status: ConnectionStatus): StatusKey {
  return status === "needs_reconnect" ? "needs-reconnect" : status;
}

// Connected services that need the person's attention come first (reconnect, then error),
// then the rest; within a status, by service name and then account.
const STATUS_ORDER: Record<StatusKey, number> = {
  "needs-reconnect": 0,
  error: 1,
  pending: 2,
  connected: 3,
};
function byAttentionThenName(a: ConnectionItem, b: ConnectionItem): number {
  return (
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    a.name.localeCompare(b.name) ||
    a.accountLabel.localeCompare(b.accountLabel)
  );
}


export function createConnectorsActions(deps: ConnectorsActionsDeps): ConnectorsActions {
  const {
    db,
    clock,
    catalogue,
    dekFor,
    fetch: fetchFn,
    googleEarlyAccess,
    oauthClientConfigFor,
    providerMcpConfig,
    listProviderTools,
    revokeProviderAccess,
  } = deps;

  // Resolve a catalogue entry by id, refusing an unknown connector at the boundary with a
  // 4xx (a connect/save against a connector that is not in the catalogue is a bad request,
  // not a 500). The id has already been shape-guarded by the caller.
  function requireEntry(connectorId: string) {
    const entry = catalogue.get(connectorId);
    if (!entry) {
      throw new HttpError(400, "Unknown connector");
    }
    return entry;
  }

  // The per-person gate decision for a catalogue entry (E09-S13): an unflagged entry is
  // always "connect"; a Google early-access entry is "connect" only for an allowlisted
  // email, else "ask_to_join". `email` is the session user's own address.
  function gateFor(connectorId: string, email: string): CatalogueItem["gate"] {
    return decisionFor(connectorId, email).kind;
  }
  // The one line a Google tile carries for an allowlisted person: what Google's
  // unverified-app screen will say and how to get past it.
  function noteFor(connectorId: string, email: string): Pick<CatalogueItem, "note"> {
    const decision = decisionFor(connectorId, email);
    return decision.kind === "connect" && decision.warning ? { note: decision.warning.unverifiedApp } : {};
  }
  function decisionFor(connectorId: string, email: string) {
    const entry = catalogue.get(connectorId);
    if (!entry) return { kind: "connect" as const, warning: null };
    return gateGoogleConnector(entry, email, googleEarlyAccess);
  }

  // How a connected account can be renewed and named (docs/adr/google-published-and-accounts.md).
  // A provider-hosted service reconnects (refreshing its tools) at any time; a Google or
  // Microsoft account reconnects in place once it needs it. Google and Microsoft accounts
  // are named by their address; anything else can be given a name, since two Notion
  // workspaces would otherwise both read "Notion".
  function reconnectAndRename(connection: ConnectionForPage): Pick<ConnectionItem, "reconnectable" | "reconnectLabel" | "renameable"> {
    const entry = catalogue.get(connection.connectorId);
    if (entry?.auth_kind === "provider_mcp") {
      return { reconnectable: deps.providerMcpAvailable === true, reconnectLabel: "Reconnect and refresh tools", renameable: true };
    }
    if (entry?.auth_kind === "oauth2") {
      return { reconnectable: catalogue.isConnectable(entry.id) && connection.status !== "connected", reconnectLabel: "Reconnect", renameable: false };
    }
    return { reconnectable: false, renameable: entry !== undefined };
  }

  // Build one connected-service card from its page read, naming the connector (the catalogue
  // display name) and the agents that may use it (an agent "uses" the service when its grants
  // list the service's connector slug).
  function toConnectionItem(
    connection: ConnectionForPage,
    agentsByConnector: ReadonlyMap<string, string[]>,
    timeZone: string,
    defaultIds: ReadonlySet<string>,
  ): ConnectionItem {
    const tools: ToolItem[] = connection.tools.map((tool) => ({
      name: tool.name,
      makesChange: tool.makesChange,
    }));
    const unavailable = deps.providerMcpAvailable === false && catalogue.get(connection.connectorId)?.auth_kind === "provider_mcp";
    return {
      ...(unavailable ? { unavailableReason: "This saved service account is unavailable until provider connection support is complete." } : {}),
      ...reconnectAndRename(connection),
      id: connection.id,
      connectorId: connection.connectorId,
      name: catalogue.get(connection.connectorId)?.name ?? connection.connectorId,
      accountLabel: connection.accountLabel,
      status: unavailable ? "error" : toStatusKey(connection.status),
      connectedAt: formatAccountTime(connection.connectedAt, timeZone, { dateOnly: true }),
      tools: unavailable ? [] : tools,
      agents: unavailable ? [] : agentsByConnector.get(connection.id) ?? [],
      defaultForAgents: defaultIds.has(connection.id),
    };
  }

  async function load(
    session: Session,
    input?: { query?: string; category?: string },
  ): Promise<ConnectorsViewData> {
    const userId = session.userId;

    // The session user's OWN connections (member-scoped, never credentials) — read first so
    // the catalogue can mark the services this person already has.
    const timeZone = await timeZoneFor(db, userId, await dekFor(userId));
    let connections = await listConnectionsForPage(db, userId, catalogue);
    const providerTools = await deps.providerToolsets?.(userId,connections);
    if (providerTools) connections = connections.map(connection => catalogue.get(connection.connectorId)?.auth_kind === "provider_mcp" ? {...connection,tools:(providerTools[connection.id]??[]).map(tool=>({name:tool.name,makesChange:true}))} : connection);
    const connectedConnectors = new Set(connections.map((connection) => connection.connectorId));

    // Browse the catalogue (pure, in-memory — no query) across EVERY category, so each
    // category can be offered with its count of matches and a miss means the term matched
    // nothing anywhere. Each entry's per-person gate is decided from the session user's own
    // email. Only services a person can act on are offered (brief: apart from the Google
    // early-access entries, which carry the ask-to-join funnel, the catalogue shows only
    // connectors a person can connect right now), so a provider whose sign-in isn't set up
    // is left out rather than shown as a dead "Unavailable" card.
    //
    // The catalogue's fine-grained data categories are shown as about fifteen plain groups
    // (catalogue-groups.ts). A `category` is kept only when it names one of those groups,
    // or a data category inside one (anything else is ignored), then narrows what's shown.
    const browse = browseCatalogue(catalogue, { query: input?.query });
    const user = await getUserById(db, userId);
    const email = user?.email ?? "";
    // The person's own service and early-access requests (member-scoped; "Contact us" messages
    // are on the Contact page). A Google entry they've already asked to join says so.
    const ownRequests = (await listConnectorRequestsForUser(db, userId)).filter((request) => request.kind !== "contact");
    const askedToJoin = new Set(
      ownRequests
        .filter((request) => request.kind === "google_early_access" && request.status === "requested" && request.handledAt === null)
        .map((request) => request.connectorId),
    );
    const offered = browse.groups
      .flatMap((group) => group.entries)
      .map((entry): CatalogueItem => {
        const mcpUnavailable = deps.providerMcpAvailable === false && catalogue.get(entry.id)?.auth_kind === "provider_mcp";
        return {
          id: entry.id,
          name: entry.name,
          category: catalogueGroupOf(entry.category),
          connectable: entry.connectable && !mcpUnavailable,
          gate: gateFor(entry.id, email),
          ...noteFor(entry.id, email),
          ...(gateFor(entry.id, email) === "ask_to_join" && askedToJoin.has(entry.id) ? { asked: true } : {}),
          ...(connectedConnectors.has(entry.id) ? { connected: true } : {}),
        };
      })
      .filter((item) => item.connectable || item.gate === "ask_to_join");
    const available = new Set(catalogue.categories().map(catalogueGroupOf));
    const category = resolveCatalogueGroup(input?.category, available);
    const byGroup = new Map<string, CatalogueItem[]>();
    for (const item of offered) {
      const bucket = byGroup.get(item.category!);
      if (bucket) bucket.push(item);
      else byGroup.set(item.category!, [item]);
    }
    const categories: CategoryCount[] = [...available]
      .sort(compareCatalogueGroups)
      .map((key) => ({ key, count: byGroup.get(key)?.length ?? 0 }))
      .filter((c) => c.count > 0 || c.key === category);
    const groups: CatalogueGroup[] = [...byGroup.entries()]
      .filter(([key]) => category === null || key === category)
      .sort(([a], [b]) => compareCatalogueGroups(a, b))
      .map(([key, items]) => ({ category: key, items: [...items].sort((a, b) => a.name.localeCompare(b.name)) }));
    // The services most people start with, at the top of the whole catalogue (not while a
    // search or category narrows it).
    const featured =
      browse.query === null && category === null
        ? POPULAR_SERVICES.flatMap((id) => offered.filter((item) => item.id === id))
        : [];

    // The session user's OWN agents (to name which agents use each service).
    const agents = await listAgentsForUser(db, userId);
    const agentsByConnector = new Map<string, string[]>();
    for (const agent of agents) {
      const grants = await getConnectionPermissions(db, userId, agent.connectionId);
      if (!grants || agent.status !== "connected") continue;
      for (const slug of grants.grantedConnectors) {
        const accounts = connections.filter(c => c.connectorId === slug);
        const selected = grants.connectorAccounts?.[slug] ?? (accounts.length === 1 ? accounts[0]!.id : undefined);
        if (!selected) continue;
        const bucket = agentsByConnector.get(selected);
        if (bucket) bucket.push(agent.displayName);
        else agentsByConnector.set(selected, [agent.displayName]);
      }
    }

    // The accounts the person turned on for new agents (docs/adr/default-services.md).
    const defaultIds = new Set(Object.values(await defaultAccountsForAgents(db, userId)));

    return {
      groups,
      featured,
      categories,
      category,
      connections: connections
        .map((connection) => toConnectionItem(connection, agentsByConnector, timeZone, defaultIds))
        .sort(byAttentionThenName),
      query: browse.query,
      // A miss is judged on what can be offered: a term that only matched a service that
      // can't be connected yet is a request for it, not "nothing to show".
      canRequest: offered.length === 0,
      requests: [...ownRequests]
        .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime())
        .slice(0, YOUR_REQUESTS_MAX)
        .map((request) => yourRequest(request, email, timeZone)),
    };
  }

  // One of the person's requests as Connectors lists it (docs/adr/requests-for-members.md):
  // ready once the service is in the catalogue for them (or they're on the Google list),
  // reviewed once the operator has closed it, otherwise still requested. A name the person
  // typed is redacted, cleaned and shortened; a ready service is named by the catalogue.
  const matchFor = connectableMatchFor(catalogue, googleEarlyAccess);
  function yourRequest(request: ConnectorRequest, email: string, timeZone: string): YourRequest {
    const askedAt = formatAccountTime(request.requestedAt, timeZone, { dateOnly: true });
    const typed = cleanShortText(redact(request.serviceName, () => false) as string, 80).trim() || "A service";
    if (request.kind === "google_early_access") {
      const entry = request.connectorId ? catalogue.get(request.connectorId) : undefined;
      const name = entry?.name ?? typed;
      const ready = entry !== undefined && catalogue.isConnectable(entry.id) && gateFor(entry.id, email) === "connect";
      return {
        id: request.id,
        name,
        kind: "early_access",
        askedAt,
        status: ready ? "ready" : request.handledAt ? "reviewed" : "waiting",
        ...(ready ? { findHref: findHrefFor(name) } : {}),
      };
    }
    const matched = request.matchedConnectorId ? catalogue.get(request.matchedConnectorId) : undefined;
    const found =
      matched && catalogue.isConnectable(matched.id) && gateFor(matched.id, email) === "connect"
        ? { name: matched.name }
        : matchFor(request.serviceName, email);
    if (found) {
      return { id: request.id, name: found.name, kind: "service", askedAt, status: "ready", findHref: findHrefFor(found.name) };
    }
    return { id: request.id, name: typed, kind: "service", askedAt, status: request.handledAt ? "reviewed" : "waiting" };
  }

  // Start a provider sign-in (oauth2) connection: shape-guard the connector id, resolve the
  // entry, and build the provider authorize URL from the entry's own endpoints + the
  // operator-configured client (the page redirects to it and carries the PKCE verifier/state
  // through the callback).
  async function connectProviderSignin(
    session: Session,
    input: { connectorId: string },
  ): Promise<unknown> {
    const connectorId = parseParams(connectorIdSchema, input.connectorId);
    const entry = requireEntry(connectorId);
    if (entry.auth_kind !== "oauth2") {
      throw new HttpError(400, "Connector is not a provider sign-in service");
    }
    if (deps.startProviderSignin) return deps.startProviderSignin(session, connectorId);
    return buildAuthorizeUrl({ entry, config: oauthClientConfigFor(connectorId) });
  }

  // Save an api-key connection for the session user. Validate the whole input at the boundary
  // (a 4xx before any write); the host comes only from the catalogue entry, never the caller.
  async function saveApiKeyConnection(
    session: Session,
    input: { connectorId: string; accountLabel: string; apiKey: string },
  ): Promise<unknown> {
    const { connectorId, accountLabel, apiKey } = parseParams(saveApiKeySchema, input);
    const entry = requireEntry(connectorId);
    const dek = await dekFor(session.userId);
    return saveApiKeyConnectionService(
      { entry, userId: session.userId, accountLabel, apiKey, dek },
      { db, clock, fetch: fetchFn },
    );
  }

  // Connect a provider_mcp connection for the session user. Validate at the boundary, resolve
  // the entry, and run the CIMD/DCR connect through the provider-mcp client (host from the
  // entry only).
  async function connectProviderMcp(
    session: Session,
    input: { connectorId: string; accountLabel: string },
  ): Promise<unknown> {
    if (deps.providerMcpAvailable === false) throw new HttpError(409, "Provider-hosted MCP connections are not available yet.");
    const { connectorId, accountLabel } = parseParams(connectProviderMcpSchema, input);
    const entry = requireEntry(connectorId);
    if (entry.auth_kind !== "provider_mcp") {
      throw new HttpError(400, "Connector is not a provider-hosted MCP service");
    }
    if (deps.startProviderMcp) return deps.startProviderMcp(session,connectorId);
    const dek = await dekFor(session.userId);
    return connectProviderMcpService(
      { entry, config: providerMcpConfig, userId: session.userId, accountLabel, dek },
      { db, clock, fetch: fetchFn, listTools: listProviderTools },
    );
  }

  // Disconnect ONE of the session user's own connected services. Shape-guard the id at the
  // boundary (a 4xx before any query) and resolve it member-scoped (another person's id is
  // refused). Then ask the provider to revoke the stored access where it allows it — best
  // effort, BEFORE the tokens are deleted, so a provider outage never keeps the person
  // connected — and in one transaction strip the service's connector from EVERY one of the
  // person's agents' grants, delete the connection with its encrypted credentials, and
  // record the disconnection.
  async function disconnectService(
    session: Session,
    connectionId: string,
  ): Promise<DisconnectServiceResult> {
    const id = parseParams(connectionIdSchema, connectionId);
    const userId = session.userId;

    // Resolve member-scoped: another person's id returns null, so they disconnect nothing and
    // nothing is touched. No write has happened yet.
    const connection = await getConnectionById(db, userId, id);
    if (connection === null) {
      return { ok: false, reason: "not_found" };
    }
    const connectorId = connection.connectorId;

    // Revoke the stored provider access WHERE THE PROVIDER ALLOWS IT: a provider sign-in
    // (oauth2) service is one whose tokens Warthog holds, so the provider can revoke them; an
    // api-key / provider-mcp service carries nothing Warthog revokes server-side. Scoped to
    // the session user and THIS connection (never a caller identity). A failure is recorded,
    // never allowed to block the disconnect itself.
    const entry = catalogue.get(connectorId);
    let providerRevoked: boolean | null = null;
    if (entry?.auth_kind === "oauth2") {
      try {
        const credentials = await getConnectionCredentials(db, userId, id, await dekFor(userId));
        await revokeProviderAccess({ userId, connectionId: id, connectorId, credentials: credentials ?? {} });
        providerRevoked = true;
      } catch {
        providerRevoked = false;
      }
    }

    // One transaction: the grant strip, the delete and the activity record commit together
    // or not at all. The record is LAST, so a failure in any step rolls the others back.
    const agents = await listAgentsForUser(db, userId);
    const recordingDek = await dekFor(userId);
    await withTransaction(db, async (tx) => {
      for (const agent of agents) {
        const grants = await getConnectionPermissions(tx, userId, agent.connectionId, { lock: true });
        if (!grants || !grants.grantedConnectors.includes(connectorId)) continue;
        if (grants.connectorAccounts?.[connectorId] && grants.connectorAccounts[connectorId] !== id) continue;
        await upsertPermissions(tx, {
          ...grants,
          grantedConnectors: grants.grantedConnectors.filter((slug) => slug !== connectorId),
        });
      }

      // Forget the connection and its credentials (member-scoped). Nothing references a
      // connection row, so re-granting the connector later cannot revive the old credential.
      await tx.query("DELETE FROM connections WHERE id = $1 AND user_id = $2", [id, userId]);

      // Warthog writes the record (principle 14): which service and account went, and whether
      // the provider confirmed the revocation (null when the kind has nothing to revoke).
      await createRedactingRecorder({ db: tx, clock, dekFor: async () => recordingDek }).record({
        userId,
        kind: "connection_change",
        source: "warthog",
        connectorId,
        outcome: "disconnected",
        payload: {
          service: entry?.name ?? connectorId,
          accountLabel: connection.accountLabel,
          providerRevoked,
        },
      });
    });

    return { ok: true, providerRevoked };
  }

  // Record a "Request a connector" for the session user (member-scoped), for the operator
  // to read in the admin portal. The name is validated at the boundary; stored verbatim
  // (bound as a parameter), so a SQL-shaped name is inert data.
  async function requestConnector(session: Session, input: { name: string }): Promise<unknown> {
    const { name } = parseParams(requestConnectorSchema, input);
    return requestConnectorService(
      { userId: session.userId, serviceName: name },
      { db, clock },
    );
  }

  // "Early access — ask to join" on a gated Google entry (E09-S13): record the request for
  // the session user, naming the catalogue's own service (never caller text). Only an entry that is gated FOR THIS PERSON can be asked for; an unknown
  // id, or one they can already connect, is a 4xx before any write.
  async function askToJoin(session: Session, input: { connectorId: string }): Promise<unknown> {
    const connectorId = parseParams(connectorIdSchema, input.connectorId);
    const entry = requireEntry(connectorId);
    const user = await getUserById(db, session.userId);
    if (gateFor(entry.id, user?.email ?? "") !== "ask_to_join") {
      throw new HttpError(400, "This service isn't in early access for this person");
    }
    return askToJoinEarlyAccess(
      { userId: session.userId, connector: { id: entry.id, name: entry.name } },
      { db, clock },
    );
  }

  // Name one of the person's own accounts (docs/adr/google-published-and-accounts.md). Google
  // and Microsoft accounts keep their address: Warthog recognises a reconnect by it. The name
  // is cleaned of invisible characters and shortened; another person's id renames nothing.
  async function renameService(session: Session, input: { connectionId: string; name: string }): Promise<{ readonly ok: boolean }> {
    const parsed = parseParams(renameServiceSchema, input);
    const name = cleanShortText(parsed.name.replace(/\s+/g, " "), RENAME_MAX).trim();
    if (!name) return { ok: false };
    const connection = await getConnectionById(db, session.userId, parsed.connectionId);
    const entry = connection ? catalogue.get(connection.connectorId) : undefined;
    if (!connection || !entry || entry.auth_kind === "oauth2") return { ok: false };
    await renameConnection(db, { userId: session.userId, id: connection.id, accountLabel: name });
    return { ok: true };
  }

  // Turn "On for new agents" on or off for one of the person's own accounts
  // (docs/adr/default-services.md): every agent connected afterwards starts with that service,
  // set to that account; agents already connected don't change. Turning on a second account of
  // a service moves it there. The change and its activity record commit together; another
  // person's id changes nothing and records nothing.
  async function setDefaultForAgents(session: Session, input: { connectionId: string; on: boolean }): Promise<{ readonly ok: boolean }> {
    const { connectionId, on } = parseParams(defaultForAgentsSchema, input);
    const userId = session.userId;
    const connection = await getConnectionById(db, userId, connectionId);
    if (!connection) return { ok: false };
    const before = Object.values(await defaultAccountsForAgents(db, userId)).includes(connection.id);
    const recordingDek = await dekFor(userId);
    const changed = await withTransaction(db, async (tx) => {
      if (!(await setConnectionDefault(tx, { userId, id: connection.id, on }))) return false;
      await createRedactingRecorder({ db: tx, clock, dekFor: async () => recordingDek }).record({
        userId,
        kind: "agent_defaults_change",
        source: "warthog",
        connectorId: connection.connectorId,
        outcome: "saved",
        payload: {
          service: catalogue.get(connection.connectorId)?.name ?? connection.connectorId,
          accountLabel: connection.accountLabel,
          before: { onForNewAgents: before },
          after: { onForNewAgents: on },
        },
      });
      return true;
    });
    return { ok: changed };
  }

  return {
    load,
    connectProviderSignin,
    saveApiKeyConnection,
    connectProviderMcp,
    disconnectService,
    renameService,
    setDefaultForAgents,
    requestConnector,
    askToJoin,
  };
}
