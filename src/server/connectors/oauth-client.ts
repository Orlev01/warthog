// E09-S06 — OAuth connector client (design §2 library table: "oauth4webapi … Warthog
// as OAuth client to Google/Microsoft/others (code+PKCE, refresh)"; design §7 connector
// engine). Provider sign-in connections (Google, Microsoft, …) use standard OAuth 2.1
// with PKCE S256 and refresh. This module:
//   1. builds an authorize URL from a catalogue entry's URLs + scopes with a PKCE S256
//      challenge and a CSRF state,
//   2. exchanges an authorization code + PKCE verifier for tokens and stores them
//      DEK-encrypted on a NEW connection (`../db/connections`, `../crypto/envelope`),
//   3. refreshes the stored tokens, updating the stored credentials.
//
// The provider HOST is taken ONLY from the catalogue entry's authorize/token URLs — never
// a value from a caller (CLAUDE.md security: "Connector requests never take a host from
// the caller"). The operator-configured client (id/secret/redirect) is INJECTED from
// `src/server/config.ts`, the one reader of the environment (INV-103); this module reads
// no `process.env` and holds no key — the DEK, the clock and the HTTP fetch are all
// injected seams, so tests freeze time and record requests without touching the network.

import {
  ClientSecretPost,
  authorizationCodeGrantRequest,
  calculatePKCECodeChallenge,
  customFetch,
  generateRandomCodeVerifier,
  generateRandomState,
  processAuthorizationCodeResponse,
  processRefreshTokenResponse,
  refreshTokenGrantRequest,
  validateAuthResponse,
  type AuthorizationServer,
  type Client,
  type TokenEndpointResponse,
} from "oauth4webapi";

import type { CatalogueEntry } from "../../domain/catalogue/schema";
import {
  createConnection,
  getConnectionCredentials,
  updateConnectionCredentials,
  type Connection,
  type ConnectionStatus,
} from "../db/connections";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";

// The operator-configured client. These come from config (the one env reader, INV-103)
// and are injected; this module never reads them from the environment itself.
export interface OAuthClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

// The injected seams: the parameterizing data access, the clock (expiry / connected-at,
// never Date.now()), and the HTTP fetch (SSRF-guarded in production, recorded in tests).
export interface OAuthClientDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly fetch: typeof fetch;
  readonly accountLabelFor?: (entry: CatalogueEntry, tokens: TokenEndpointResponse) => Promise<string>;
}

// What a built authorize request hands back: the URL the person is sent to, plus the raw
// PKCE verifier and CSRF state (the pending-flow secrets the caller stores to complete
// the exchange on the callback).
export interface AuthorizeRequest {
  readonly url: string;
  readonly codeVerifier: string;
  readonly state: string;
}

// Code-exchange inputs. `userId` is always the session's id (never a client value); the
// host comes only from `entry`. `status` defaults to 'connected' for a fresh connection.
export interface ExchangeCodeInput {
  readonly entry: CatalogueEntry;
  readonly config: OAuthClientConfig;
  readonly userId: string;
  readonly accountLabel: string;
  readonly code: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly dek: Uint8Array;
  readonly status?: ConnectionStatus;
}

// Refresh inputs: the owned connection to renew, member-scoped by the session's `userId`.
export interface RefreshTokensInput {
  readonly entry: CatalogueEntry;
  readonly config: OAuthClientConfig;
  readonly userId: string;
  readonly connectionId: string;
  readonly dek: Uint8Array;
}

// The authorization-server metadata oauth4webapi needs for the token grants, assembled
// ENTIRELY from the catalogue entry's own URLs — the token host can never be a caller
// value. Throws (never silently) when an oauth2 entry is missing its token endpoint.
function authorizationServer(entry: CatalogueEntry): AuthorizationServer {
  const tokenUrl = entry.auth.token_url;
  if (!tokenUrl) {
    throw new Error(`connector ${entry.id} has no token endpoint`);
  }
  return {
    // Google publishes a distinct issuer and token endpoint origin. Identity
    // scopes can return an ID token, whose issuer must still be checked exactly.
    // https://accounts.google.com/.well-known/openid-configuration
    issuer: tokenUrl === "https://oauth2.googleapis.com/token"
      ? "https://accounts.google.com" : new URL(tokenUrl).origin,
    authorization_endpoint: entry.auth.authorize_url,
    token_endpoint: tokenUrl,
  };
}

// The stored credential set, derived from a token endpoint response. A refresh response
// MAY omit a new refresh token (Google does), meaning "keep the one you have" — so the
// previously stored refresh token is carried forward when the response has none. The
// expiry is computed from the injected clock so a later caller can renew before it lapses.
function toStoredCredentials(
  tokens: TokenEndpointResponse,
  clock: Clock,
  previousRefreshToken?: string,
): Record<string, unknown> {
  const credentials: Record<string, unknown> = { access_token: tokens.access_token };
  const refreshToken = tokens.refresh_token ?? previousRefreshToken;
  if (refreshToken !== undefined) credentials.refresh_token = refreshToken;
  if (tokens.token_type !== undefined) credentials.token_type = tokens.token_type;
  if (tokens.scope !== undefined) credentials.scope = tokens.scope;
  if (tokens.expires_in !== undefined) {
    credentials.expires_at = new Date(clock.now().getTime() + tokens.expires_in * 1000).toISOString();
  }
  return credentials;
}

// Build the provider authorize URL at the ENTRY's authorize endpoint (host from the entry
// only), carrying the standard OAuth 2.1 authorization-code parameters, the entry's scopes
// and a PKCE S256 challenge, and return the raw verifier + state alongside it. A fresh
// verifier and state are drawn per call.
export async function buildAuthorizeUrl(params: {
  entry: CatalogueEntry;
  config: OAuthClientConfig;
}): Promise<AuthorizeRequest> {
  const authorizeEndpoint = params.entry.auth.authorize_url;
  if (!authorizeEndpoint) {
    throw new Error(`connector ${params.entry.id} has no authorize endpoint`);
  }

  const codeVerifier = generateRandomCodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const state = generateRandomState();

  const url = new URL(authorizeEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.config.clientId);
  url.searchParams.set("redirect_uri", params.config.redirectUri);
  url.searchParams.set("scope", (params.entry.auth.scopes ?? []).join(" "));
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  if (new URL(authorizeEndpoint).hostname === "accounts.google.com") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }

  return { url: url.href, codeVerifier, state };
}

// Exchange the authorization code + PKCE verifier at the ENTRY's token endpoint and store
// the resulting tokens DEK-encrypted on a NEW connection owned by `userId`. Returns the
// created Connection — WITHOUT credentials (that shape is enforced by the store).
export async function exchangeCodeForConnection(
  input: ExchangeCodeInput,
  deps: OAuthClientDeps,
): Promise<Connection> {
  const as = authorizationServer(input.entry);
  const client: Client = { client_id: input.config.clientId };
  const clientAuth = ClientSecretPost(input.config.clientSecret);

  const callbackParameters = validateAuthResponse(
    as,
    client,
    new URLSearchParams({ code: input.code, state: input.state }),
    input.state,
  );

  const response = await authorizationCodeGrantRequest(
    as,
    client,
    clientAuth,
    callbackParameters,
    input.config.redirectUri,
    input.codeVerifier,
    { [customFetch]: deps.fetch },
  );
  const tokens = await processAuthorizationCodeResponse(as, client, response);

  return createConnection(
    deps.db,
    {
      userId: input.userId,
      connectorId: input.entry.id,
      accountLabel: deps.accountLabelFor ? await deps.accountLabelFor(input.entry, tokens) : input.accountLabel,
      credentials: toStoredCredentials(tokens, deps.clock),
      status: input.status,
    },
    input.dek,
    deps.clock,
  );
}

// Read the owned connection's stored refresh token, present it to the ENTRY's token
// endpoint (host from the entry only), and update the stored credentials with the renewed
// token set. Returns the updated Connection (no credentials). Member-scoped throughout by
// the session's `userId`.
export async function refreshConnectionTokens(
  input: RefreshTokensInput,
  deps: OAuthClientDeps,
): Promise<Connection> {
  const stored = await getConnectionCredentials(deps.db, input.userId, input.connectionId, input.dek);
  if (!stored) {
    throw new Error(`refreshConnectionTokens: no connection ${input.connectionId} for this user`);
  }
  const refreshToken = stored.refresh_token;
  if (typeof refreshToken !== "string") {
    throw new Error(`refreshConnectionTokens: connection ${input.connectionId} has no refresh token`);
  }

  const as = authorizationServer(input.entry);
  const client: Client = { client_id: input.config.clientId };
  const clientAuth = ClientSecretPost(input.config.clientSecret);

  const response = await refreshTokenGrantRequest(as, client, clientAuth, refreshToken, {
    [customFetch]: deps.fetch,
  });
  const tokens = await processRefreshTokenResponse(as, client, response);

  return updateConnectionCredentials(
    deps.db,
    {
      userId: input.userId,
      id: input.connectionId,
      credentials: toStoredCredentials(tokens, deps.clock, refreshToken),
    },
    input.dek,
  );
}
