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
import { oauthClientFor, oauthClientConfigured, providerFor, withIdentityScope } from "./client-config";
import { buildAuthorizeUrl, exchangeCodeForConnection, refreshConnectionTokens } from "./oauth-client";
import { createGuardedProviderFetch } from "./provider-mcp";
import { pendingConnects, type PendingConnectFlow } from "./pending";
import { gateGoogleConnector } from "./google-early-access";
import { scheduleConnectionRefresh, scheduleGoogleLapse } from "./jobs";
import { HttpError } from "../http/validate";
import type { CatalogueEntry } from "../../domain/catalogue/schema";

export interface CompleteConnectorInput extends PendingConnectFlow { readonly userId: string; readonly code: string; readonly state: string }

export function createConnectorRuntime(deps: {
  config: Config; db: Db; clock?: Clock; fetch?: typeof fetch; keyWrapper?: KeyWrapper; catalogue?: CatalogueIndex;
}) {
  const { config, db } = deps;
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
    const endpoint = providerFor(entry.id) === "google" ? "https://www.googleapis.com/oauth2/v2/userinfo"
      : "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName";
    const response = await request(endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` }, redirect: "error" });
    if (!response.ok) throw new Error("Provider account could not be verified");
    const profile = await response.json() as { email?: unknown; mail?: unknown; userPrincipalName?: unknown };
    const label = profile.email ?? profile.mail ?? profile.userPrincipalName;
    if (typeof label !== "string" || label.length > 256 || !label.includes("@")) throw new Error("Provider account could not be verified");
    return label;
  }
  async function schedule(tx: Db, userId: string, connectionId: string, dek: Uint8Array) {
    const credentials = await getConnectionCredentials(tx, userId, connectionId, dek);
    if (typeof credentials?.refresh_token !== "string" || typeof credentials.expires_at !== "string") throw new Error("Provider did not grant renewable access. Reconnect and consent again.");
    const expiry = new Date(credentials.expires_at);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= clock.now().getTime()) throw new Error("Provider returned expired access");
    // Avoid an immediate infinite refresh loop for providers issuing short tokens.
    await scheduleConnectionRefresh(tx, { userId, connectionId, expiresAt: new Date(Math.max(expiry.getTime(), clock.now().getTime() + 360_000)) });
  }
  return {
    async begin(session: Session, connectorId: string): Promise<{ url: string }> {
      const entry = entryFor(connectorId);
      await allowed(session.userId, entry);
      const auth = await buildAuthorizeUrl({ entry, config: oauthClientFor(config, connectorId) });
      pendingConnects().put(session.userId, session.id, auth.state, { connectorId, accountLabel: entry.name, codeVerifier: auth.codeVerifier });
      return { url: auth.url };
    },
    take(session: Pick<Session, "userId" | "id">, state: string) { return pendingConnects().take(session.userId, session.id, state); },
    async complete(input: CompleteConnectorInput) {
      const entry = entryFor(input.connectorId);
      await allowed(input.userId, entry);
      const dek = await keyFor(input.userId);
      try {
        return await withTransaction(db, async (tx) => {
          const connection = await exchangeCodeForConnection({ ...input, entry, config: oauthClientFor(config, entry.id), dek }, { db: tx, clock, fetch: request, accountLabelFor });
          await schedule(tx, input.userId, connection.id, dek);
          if (entry.google_early_access) await scheduleGoogleLapse(tx, { userId: input.userId, connectionId: connection.id, connectedAt: clock.now() });
          await createRedactingRecorder({ db: tx, clock, dekFor: async () => dek }).record({ userId: input.userId,
            kind: "connection_change", source: "warthog", connectorId: entry.id, outcome: "connected", payload: { service: entry.name } });
          return connection;
        });
      } catch { throw new HttpError(502, "The service could not be connected. Try connecting again."); }
      finally { dek.fill(0); }
    },
    async refresh(target: { userId: string; connectionId: string }) {
      const connection = await getConnectionById(db, target.userId, target.connectionId);
      if (!connection || connection.status !== "connected") return;
      const entry = entryFor(connection.connectorId);
      await allowed(target.userId, entry);
      if (entry.google_early_access && new Date(connection.connectedAt).getTime() + 7 * 86_400_000 <= clock.now().getTime()) throw new Error("Google consent has expired");
      const dek = await keyFor(target.userId);
      try {
        await withTransaction(db, async (tx) => {
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`connector-refresh:${target.connectionId}`]);
          if (!(await getConnectionById(tx, target.userId, target.connectionId))) return;
          await refreshConnectionTokens({ ...target, entry, config: oauthClientFor(config, entry.id), dek }, { db: tx, clock, fetch: request });
          await schedule(tx, target.userId, target.connectionId, dek);
        });
      } catch { throw new Error("Connector refresh failed"); }
      finally { dek.fill(0); }
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
