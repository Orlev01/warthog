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
// disconnectService is the one that CHANGES data: it removes EVERY one of the person's
// agents' access to the disconnected service (the connector slug is stripped from each
// agent's grants, in one transaction) AND revokes the stored provider access where the
// provider allows it (the oauth2 provider-sign-in kind, whose tokens Warthog holds).
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
//     catalogue, per-user DEK lookup, outbound fetch, email sender, operator address, the
//     Google allowlist, the provider client configs and the provider-revocation seam are
//     all INJECTED, so no ambient env value can leak into the loaded screen.

import { z } from "zod";

import { parseParams, HttpError } from "@/server/http/validate";
import { withTransaction, type Db } from "@/server/db/index";
import type { Clock } from "@/server/seams/clock";
import type { Session } from "@/server/auth/session";
import type { EmailSender } from "@/server/notify/senders";
import { getUserById } from "@/server/db/users";
import { getConnectionById } from "@/server/db/connections";
import { listAgentsForUser } from "@/server/db/agents";
import { getConnectionPermissions, upsertPermissions } from "@/server/db/agent-permissions";
import {
  browseCatalogue,
  listConnectionsForPage,
  type ConnectionForPage,
} from "@/server/connectors/page-data";
import { gateGoogleConnector } from "@/server/connectors/google-early-access";
import { saveApiKeyConnection as saveApiKeyConnectionService } from "@/server/connectors/api-key";
import { requestConnector as requestConnectorService } from "@/server/connectors/requests";
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
  ConnectionItem,
  ToolItem,
} from "@/components/connectors/connectors-view";

// What the provider-revocation seam is told: the acting person and the connection whose
// stored provider access to revoke (and its connector slug, for the provider adapter).
// Identity is the session's, never a caller value.
export interface RevokeProviderAccessInput {
  readonly userId: string;
  readonly connectionId: string;
  readonly connectorId: string;
}

// Every seam injected — no process.env, no secret (INV-103).
export interface ConnectorsActionsDeps {
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
  // The operator email sender (requestConnector).
  readonly email: EmailSender;
  // The operator address, injected from config (INV-103), never baked in.
  readonly operatorEmail: string;
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
  "connectAction" | "disconnectAction" | "requestAction"
>;

// The outcome of a disconnect: success, or a refusal naming its reason (the connection is
// not this person's / does not exist). Never a silent success.
export type DisconnectServiceResult =
  | { readonly ok: true }
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
  requestConnector(session: Session, input: { name: string }): Promise<unknown>;
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
const requestConnectorSchema = z.object({
  name: z.string().min(1).max(NAME_MAX),
});

// ---- presentation helpers ---------------------------------------------------------

// The connection store's status vs. the <Status> primitive's StatusKey: the stored
// 'needs_reconnect' reads as the UI's 'needs-reconnect' (CLAUDE.md "Reconnect needed").
function toStatusKey(status: ConnectionStatus): StatusKey {
  return status === "needs_reconnect" ? "needs-reconnect" : status;
}

// A stored instant → an absolute, readable date label the view renders verbatim (the view
// reaches for no clock). Shown in UTC so a seeded instant is deterministic.
function formatDate(value: Date | string): string {
  return new Date(value).toLocaleDateString("en-AU", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function createConnectorsActions(deps: ConnectorsActionsDeps): ConnectorsActions {
  const {
    db,
    clock,
    catalogue,
    dekFor,
    fetch: fetchFn,
    email,
    operatorEmail,
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
    const entry = catalogue.get(connectorId);
    if (!entry) return "connect";
    return gateGoogleConnector(entry, email, googleEarlyAccess).kind;
  }

  // Build one connected-service card from its page read, naming the connector (the catalogue
  // display name) and the agents that may use it (an agent "uses" the service when its grants
  // list the service's connector slug).
  function toConnectionItem(
    connection: ConnectionForPage,
    agentsByConnector: ReadonlyMap<string, string[]>,
  ): ConnectionItem {
    const tools: ToolItem[] = connection.tools.map((tool) => ({
      name: tool.name,
      makesChange: tool.makesChange,
    }));
    return {
      id: connection.id,
      name: catalogue.get(connection.connectorId)?.name ?? connection.connectorId,
      accountLabel: connection.accountLabel,
      status: toStatusKey(connection.status),
      connectedAt: formatDate(connection.connectedAt),
      tools,
      agents: agentsByConnector.get(connection.connectorId) ?? [],
    };
  }

  async function load(
    session: Session,
    input?: { query?: string; category?: string },
  ): Promise<ConnectorsViewData> {
    const userId = session.userId;

    // Browse the catalogue (pure, in-memory — no query), then decide each entry's per-person
    // gate from the session user's own email.
    const browse = browseCatalogue(catalogue, { category: input?.category, query: input?.query });
    const user = await getUserById(db, userId);
    const email = user?.email ?? "";
    const groups: CatalogueGroup[] = browse.groups.map((group) => ({
      category: group.category,
      items: group.entries.map(
        (entry): CatalogueItem => ({
          id: entry.id,
          name: entry.name,
          connectable: entry.connectable,
          gate: gateFor(entry.id, email),
        }),
      ),
    }));

    // The session user's OWN connections (member-scoped, never credentials) and OWN agents
    // (to name which agents use each service).
    const connections = await listConnectionsForPage(db, userId, catalogue);
    const agents = await listAgentsForUser(db, userId);
    const agentsByConnector = new Map<string, string[]>();
    for (const agent of agents) {
      const grants = await getConnectionPermissions(db, userId, agent.connectionId);
      if (!grants) continue;
      for (const slug of grants.grantedConnectors) {
        const bucket = agentsByConnector.get(slug);
        if (bucket) bucket.push(agent.displayName);
        else agentsByConnector.set(slug, [agent.displayName]);
      }
    }

    return {
      groups,
      connections: connections.map((connection) => toConnectionItem(connection, agentsByConnector)),
      query: browse.query,
      canRequest: browse.canRequest,
    };
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
    const { connectorId, accountLabel } = parseParams(connectProviderMcpSchema, input);
    const entry = requireEntry(connectorId);
    if (entry.auth_kind !== "provider_mcp") {
      throw new HttpError(400, "Connector is not a provider-hosted MCP service");
    }
    const dek = await dekFor(session.userId);
    return connectProviderMcpService(
      { entry, config: providerMcpConfig, userId: session.userId, accountLabel, dek },
      { db, clock, fetch: fetchFn, listTools: listProviderTools },
    );
  }

  // Disconnect ONE of the session user's own connected services. Shape-guard the id at the
  // boundary (a 4xx before any query), resolve it member-scoped (another person's id is
  // refused), then strip the service's connector from EVERY one of the person's agents'
  // grants in one transaction and — where the provider allows it — revoke the stored provider
  // access after the commit.
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

    // Strip the disconnected service's connector from every one of the person's own agents'
    // grants, in one transaction so they all commit together or roll back together.
    const agents = await listAgentsForUser(db, userId);
    await withTransaction(db, async (tx) => {
      for (const agent of agents) {
        const grants = await getConnectionPermissions(tx, userId, agent.connectionId);
        if (!grants || !grants.grantedConnectors.includes(connectorId)) continue;
        await upsertPermissions(tx, {
          ...grants,
          grantedConnectors: grants.grantedConnectors.filter((slug) => slug !== connectorId),
        });
      }
    });

    // Revoke the stored provider access WHERE THE PROVIDER ALLOWS IT: a provider sign-in
    // (oauth2) service is one whose tokens Warthog holds, so the provider can revoke them; an
    // api-key / provider-mcp service carries nothing Warthog revokes server-side. Fired after
    // the commit, scoped to the session user and THIS connection (never a caller identity).
    const entry = catalogue.get(connectorId);
    if (entry?.auth_kind === "oauth2") {
      await revokeProviderAccess({ userId, connectionId: id, connectorId });
    }

    return { ok: true };
  }

  // Record a "Request a connector" for the session user (member-scoped) and email the
  // operator at the injected address. The name is validated at the boundary; stored verbatim
  // (bound as a parameter), so a SQL-shaped name is inert data.
  async function requestConnector(session: Session, input: { name: string }): Promise<unknown> {
    const { name } = parseParams(requestConnectorSchema, input);
    return requestConnectorService(
      { userId: session.userId, serviceName: name },
      { db, email, operatorEmail, clock },
    );
  }

  return {
    load,
    connectProviderSignin,
    saveApiKeyConnection,
    connectProviderMcp,
    disconnectService,
    requestConnector,
  };
}
