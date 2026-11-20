import { createProviderRuntime, type ProviderFlow } from "./provider-runtime";
import type { TokenEndpointResponse } from "oauth4webapi";
import type { Config } from "../config";
import { withTransaction, type Db } from "../db/index";
import { getUserById } from "../db/users";
import { getConnectionById, getConnectionCredentials } from "../db/connections";
import type { Session } from "../auth/session";
import { selectKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { createRedactingRecorder } from "../mcp/recorder";
import { systemClock, type Clock } from "../seams/clock";
import { loadCatalogue, type CatalogueIndex } from "./catalogue";
import { join } from "node:path";
import { oauthClientFor, oauthClientConfigured, providerFor, renewable, withIdentityScope } from "./client-config";
import { buildAuthorizeUrl, exchangeCodeForConnection, refreshConnectionTokens } from "./oauth-client";
import { createGuardedProviderFetch } from "./provider-mcp";
import { pendingConnects, type PendingConnectFlow } from "./pending";
import { gateGoogleConnector } from "./google-early-access";
import { scheduleConnectionRefresh } from "./jobs";
import { HttpError } from "../http/validate";
import type { CatalogueEntry } from "../../domain/catalogue/schema";
import { tryRecord, type MetricSeam } from "../metrics/seam";
import { CONNECTOR_CONNECT, CONNECTOR_REFRESH, CONNECT_OUTCOMES, REFRESH_OUTCOMES } from "../metrics/names";

function reportConnectorFailure(stage: string, error: unknown) {
  const detail = error as { code?: unknown; cause?: { claim?: unknown } } | null;
  const allowedCodes = new Set(["OAUTH_JWT_CLAIM_COMPARISON_FAILED", "OAUTH_JWT_TIMESTAMP_CHECK_FAILED",
    "OAUTH_INVALID_RESPONSE", "OAUTH_RESPONSE_BODY_ERROR", "OAUTH_RESPONSE_IS_NOT_JSON"]);
  const code = typeof detail?.code === "string" && allowedCodes.has(detail.code) ? detail.code : "unexpected";
  const claim = typeof detail?.cause?.claim === "string" && ["iss", "aud", "exp", "iat", "nonce"].includes(detail.cause.claim)
    ? detail.cause.claim : undefined;
  // No provider response body, raw error, claims, identity or credential values.
  console.error("[warthog connector]", JSON.stringify({ stage, code, ...(claim ? { claim } : {}) }));
}

export interface CompleteConnectorInput extends PendingConnectFlow { readonly userId: string; readonly code: string; readonly state: string; readonly iss?:string; readonly providerState?:ProviderFlow["providerState"]; readonly reconnectId?:string }

export function createConnectorRuntime(deps: {
  config: Config; db: Db; clock?: Clock; fetch?: typeof fetch; keyWrapper?: KeyWrapper; catalogue?: CatalogueIndex;
  // Optional, best-effort connect/refresh outcome metrics (docs/design/admin-portal.md §4):
  // the connector id, the outcome and, on a failed connect, the failing stage — never an
  // account label, token or identity value.
  recordMetric?: MetricSeam;
}) {
  const { config, db, recordMetric } = deps;
  const clock = deps.clock ?? systemClock;
  const request = deps.fetch ?? createGuardedProviderFetch();
  const wrapper = deps.keyWrapper ?? selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  const catalogue = deps.catalogue ?? loadCatalogue({ dir: join(process.cwd(), "catalogue/connectors"), isOAuthClientConfigured: (id) => oauthClientConfigured(config, id) });
  function entryFor(id: string) {
    const entry = catalogue.get(id);
    if (!entry || entry.auth_kind !== "oauth2" || !providerFor(id)) throw new HttpError(400, "Unknown provider sign-in service.");
    oauthClientFor(config, id);
    return withIdentityScope(entry);
  }
  async function allowed(userId: string, entry: CatalogueEntry) {
    const user = await getUserById(db, userId);
    if (!user) throw new HttpError(401, "Sign in again.");
    if (gateGoogleConnector(entry, user.email, config.googleEarlyAccess).kind !== "connect") throw new HttpError(403, "Google early access is not enabled for this account.");
    return user;
  }
  async function keyFor(userId: string) {
    const user = await getUserById(db, userId);
    if (!user) throw new HttpError(401, "Sign in again.");
    return wrapper.unwrap(user.wrappedDek);
  }
  async function accountLabelFor(entry: CatalogueEntry, tokens: TokenEndpointResponse): Promise<string> {
    const provider = providerFor(entry.id);
    const endpoint = provider === "google" ? "https://www.googleapis.com/oauth2/v2/userinfo"
      : provider === "linkedin" ? "https://api.linkedin.com/v2/userinfo"
      : "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName";
    const response = await request(endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` }, redirect: "error" });
    if (!response.ok) throw new Error("Provider account could not be verified");
    const profile = await response.json() as { email?: unknown; mail?: unknown; userPrincipalName?: unknown };
    const label = profile.email ?? profile.mail ?? profile.userPrincipalName;
    if (typeof label !== "string" || label.length > 256 || !label.includes("@")) throw new Error("Provider account could not be verified");
    return label;
  }
  async function schedule(tx: Db, userId: string, connectionId: string, dek: Uint8Array, connectorId: string) {
    const credentials = await getConnectionCredentials(tx, userId, connectionId, dek);
    if (typeof credentials?.expires_at !== "string") throw new Error("Provider did not say when access ends. Reconnect and consent again.");
    // A provider with no renewal (LinkedIn) still gets the job: due at expiry, it finds nothing to
    // renew with and the connection goes to "Reconnect needed".
    if (renewable(providerFor(connectorId)) && typeof credentials.refresh_token !== "string") throw new Error("Provider did not grant renewable access. Reconnect and consent again.");
    const expiry = new Date(credentials.expires_at);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= clock.now().getTime()) throw new Error("Provider returned expired access");
    // Avoid an immediate infinite refresh loop for providers issuing short tokens.
    await scheduleConnectionRefresh(tx, { userId, connectionId, expiresAt: new Date(Math.max(expiry.getTime(), clock.now().getTime() + 360_000)) });
  }
  const provider = createProviderRuntime({db,catalogue,clock,publicBaseUrl:config.publicBaseUrl,dekFor:keyFor,fetch:deps.fetch});
  return {
    takeProvider: provider.take,
    async begin(session: Session, connectorId: string, reconnectId?:string): Promise<{ url: string }> {
      if (catalogue.get(connectorId)?.auth_kind === "provider_mcp") return provider.begin(session,connectorId,reconnectId);
      const entry = entryFor(connectorId);
      await allowed(session.userId, entry);
      // Reconnecting goes straight to the account being reconnected; signing in to a
      // different account there adds it as another account instead.
      const existing = reconnectId ? await getConnectionById(db, session.userId, reconnectId) : null;
      if (reconnectId && (!existing || existing.connectorId !== connectorId)) throw new HttpError(404, "Service connection not found.");
      const auth = await buildAuthorizeUrl({ entry, config: oauthClientFor(config, connectorId), ...(existing ? { loginHint: existing.accountLabel } : {}) });
      pendingConnects().put(session.userId, session.id, auth.state, { connectorId, accountLabel: entry.name, codeVerifier: auth.codeVerifier, ...(existing ? { reconnectId: existing.id } : {}) });
      return { url: auth.url };
    },
    take(session: Pick<Session, "userId" | "id">, state: string) { return pendingConnects().take(session.userId, session.id, state); },
    async complete(input: CompleteConnectorInput) {
      if (input.providerState) return provider.complete({...input,providerState:input.providerState});
      const entry = entryFor(input.connectorId);
      await allowed(input.userId, entry);
      const dek = await keyFor(input.userId);
      let stage = "token_exchange";
      try {
        const connection = await withTransaction(db, async (tx) => {
          const connection = await exchangeCodeForConnection({ ...input, entry, config: oauthClientFor(config, entry.id), dek }, { db: tx, clock, fetch: request, accountLabelFor });
          stage = "schedule_refresh";
          await schedule(tx, input.userId, connection.id, dek, entry.id);
          stage = "record_activity";
          await createRedactingRecorder({ db: tx, clock, dekFor: async () => dek }).record({ userId: input.userId,
            kind: "connection_change", source: "warthog", connectorId: entry.id, outcome: connection.reused ? "reconnected" : "connected", payload: { service: entry.name } });
          return connection;
        });
        await tryRecord(recordMetric, { name: CONNECTOR_CONNECT, value: 1, dimensions: { connectorId: entry.id, outcome: CONNECT_OUTCOMES.ok } });
        return connection;
      } catch (error) {
        reportConnectorFailure(stage, error);
        await tryRecord(recordMetric, { name: CONNECTOR_CONNECT, value: 1, dimensions: { connectorId: entry.id, outcome: CONNECT_OUTCOMES.failed, errorCategory: stage } });
        throw new HttpError(502, "The service could not be connected. Try connecting again.");
      }
      finally { dek.fill(0); }
    },
    async refresh(target: { userId: string; connectionId: string }) {
      const connection = await getConnectionById(db, target.userId, target.connectionId);
      if (!connection || connection.status !== "connected") return;
      const connectorId = connection.connectorId;
      // Every way this renewal can fail is one `connector.refresh` failure for its connector;
      // a renewal that goes through is one success.
      if (!renewable(providerFor(connectorId))) {
        // Access that can't be renewed has ended, as expected: the job handler marks the
        // connection "Reconnect needed" and tells the person.
        await tryRecord(recordMetric, { name: CONNECTOR_REFRESH, value: 1, dimensions: { connectorId, outcome: REFRESH_OUTCOMES.lapsed } });
        throw new Error("Connector access ended");
      }
      try {
        const entry = entryFor(connectorId);
        await allowed(target.userId, entry);
        const dek = await keyFor(target.userId);
        try {
          await withTransaction(db, async (tx) => {
            await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`connector-refresh:${target.connectionId}`]);
            if (!(await getConnectionById(tx, target.userId, target.connectionId))) return;
            await refreshConnectionTokens({ ...target, entry, config: oauthClientFor(config, entry.id), dek }, { db: tx, clock, fetch: request });
            await schedule(tx, target.userId, target.connectionId, dek, connectorId);
          });
        } catch { throw new Error("Connector refresh failed"); }
        finally { dek.fill(0); }
      } catch (error) {
        await tryRecord(recordMetric, { name: CONNECTOR_REFRESH, value: 1, dimensions: { connectorId, outcome: REFRESH_OUTCOMES.failed } });
        throw error;
      }
      await tryRecord(recordMetric, { name: CONNECTOR_REFRESH, value: 1, dimensions: { connectorId, outcome: REFRESH_OUTCOMES.ok } });
    },
    async revoke(input: { userId: string; connectionId: string; connectorId: string; credentials: Record<string, unknown> }) {
      if (providerFor(input.connectorId) !== "google") throw new Error("Remove Warthog access in your provider account to revoke its consent.");
      const token = input.credentials.refresh_token ?? input.credentials.access_token;
      if (typeof token !== "string") throw new Error("Provider revocation failed");
      try {
        const response = await request("https://oauth2.googleapis.com/revoke", { method: "POST", redirect: "error",
          headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
        if (!response.ok) throw new Error();
      } catch { throw new Error("Provider revocation failed"); }
    },
  };
}
