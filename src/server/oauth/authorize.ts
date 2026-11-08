// E06-S04 — the OAuth 2.1 authorize seam and consent binding (design §6.1).
//
// Warthog is its own authorization server. This is the pure logic behind
// `/oauth/authorize`: given an already-resolved session (the browser's
// `__Host-wh_session` cookie, verified at the thin route entry), the agent's query and
// the connection the person consented to, it enforces the authorization rules and —
// only when they all hold — mints a one-time authorization code.
//
// The rules (design §6.1): the request must be signed in; PKCE is MANDATORY and
// **S256 only** (a plain challenge, or an omitted method — which RFC 7636 defaults to
// "plain" — is rejected); and the `resource` parameter is REQUIRED and must equal this
// server's MCP resource (`https://<public host>/mcp`). Any failure rejects with no code
// issued.
//
// On success the code is opaque, high-entropy and stored ONLY as its SHA-256 hash
// (constitution: codes are stored only as hashes) bound to the consent's connection
// together with the PKCE challenge, client, redirect URI, resource and a hard expiry —
// through the already-built store (`createAuthCode`). The response is a redirect back
// to the client's redirect URI carrying `code`, the echoed `state` and `iss` (the
// CONFIGURED issuer, RFC 9207) — never a request-derived or fixed value.
//
// The seam takes the connection as an OPAQUE uuid the caller supplies: the consent
// decision that creates the connection is wired in later (E10-S03), and the seam's job
// is only to BIND the issued code to it.
//
// Review fix A1 — the client and its redirect URI are ENFORCED. `response_type` must be
// `code`; the `client_id` must resolve to a known client (a DCR row, or a CIMD document
// fetched through the SSRF-guarded fetcher — the injected `resolveClient` seam); and the
// `redirect_uri` must EXACTLY equal one the client registered AND pass the shared
// redirect rule (https, or http on localhost / 127.0.0.1). Until then a crafted link
// could name any client and any redirect — including `javascript:` — and the consent
// screen's Approve/Refuse redirected straight to it. The checks run BEFORE the session
// check, so only a valid request is sent through sign-in (review fix A4).

import { createHash } from "node:crypto";

import { createAuthCode } from "./store";
import { putPendingAuthorization } from "./pending";
import { isAllowedRedirectUri, type ClientResolver } from "./clients";
import type { Db } from "../db/index";
import type { Config } from "../config";
import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";
import type { Session } from "../auth/session";

// A one-time authorization code is short-lived: 60 seconds is ample for a client to
// immediately exchange it at the token endpoint, and well under RFC 6749's 10-minute
// ceiling.
const CODE_TTL_MS = 60_000;

// 256 bits of entropy, rendered as hex — the same opaque-bearer shape sessions use.
const CODE_ENTROPY_BYTES = 32;

// The authorize request, as resolved at the route entry: the agent's query, the
// signed-in session (null when there is none) and the consent's connection.
export interface AuthorizeInput {
  readonly params: URLSearchParams;
  readonly session: Session | null;
  readonly connectionId: string;
}

// The seams authorize depends on: the db (store), config (issuer + MCP resource), the
// clock (expiry), the randomness source (the opaque code) and the client resolver (a
// client_id → its registered redirect URIs; `systemClientResolver(db)` in production).
export interface AuthorizeDeps {
  readonly db: Db;
  readonly config: Config;
  readonly clock: Clock;
  readonly random: Random;
  readonly resolveClient: ClientResolver;
}

// The outcome: a redirect carrying the issued code, or a rejection naming the OAuth
// error — no code is issued on rejection.
export type AuthorizeResult =
  | { readonly ok: true; readonly redirectTo: string; readonly code: string }
  | { readonly ok: false; readonly error: string };

// The configured issuer: the public base URL with any trailing slash stripped (the
// same derivation the metadata endpoints use, design §6.1).
function issuer(config: Config): string {
  return config.publicBaseUrl.replace(/\/$/, "");
}

// This server's MCP resource: the issuer plus `/mcp` (design §6.1).
function mcpResource(config: Config): string {
  return `${issuer(config)}/mcp`;
}

// SHA-256 hex of a value — how the code is addressed in storage (never the raw code).
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// The redirect URI an authorize request may be answered at, or null when it may not be
// answered at all: the client must resolve, and the requested redirect_uri must EXACTLY
// equal (string comparison — no normalisation, RFC 9700 §4.1.3) one of its registered
// redirect URIs and also pass the shared scheme rule, so a `javascript:` or plain-http
// URI planted in a registration is still refused. Shared by the validator below and the
// consent decision's Refuse, so NOTHING redirects to an unvalidated URI.
export async function validatedRedirectUri(
  params: URLSearchParams,
  resolveClient: ClientResolver,
): Promise<{ readonly ok: true; readonly redirectUri: string } | { readonly ok: false; readonly error: string }> {
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  if (clientId == null || clientId === "" || redirectUri == null || redirectUri === "") {
    return { ok: false, error: "invalid_request" };
  }
  const client = await resolveClient(clientId);
  if (client == null) return { ok: false, error: "invalid_client" };
  if (!client.redirectUris.includes(redirectUri) || !isAllowedRedirectUri(redirectUri)) {
    return { ok: false, error: "invalid_request" };
  }
  return { ok: true, redirectUri };
}

// The OAuth authorization rules, shared by `authorize` (which issues the code) and
// `beginAuthorization` (which carries the request to consent): `response_type` is
// `code`; the client resolves and the redirect URI is one it registered (above); PKCE is
// mandatory and S256 only (a missing challenge, or any method other than S256 —
// including an omitted method, which RFC 7636 defaults to "plain" — is rejected); the
// `resource` is required and must be exactly this server's MCP resource; and, LAST, the
// request must be signed in — so `login_required` means "valid, just signed out" and a
// malformed request is refused at once rather than bounced through sign-in. The two
// seams reject with the SAME error vocabulary, so the route maps each identically.
async function validateAuthorizeRequest(
  params: URLSearchParams,
  session: Session | null,
  deps: AuthorizeDeps,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  if (params.get("response_type") !== "code") {
    return { ok: false, error: "unsupported_response_type" };
  }

  const redirect = await validatedRedirectUri(params, deps.resolveClient);
  if (!redirect.ok) return redirect;

  const codeChallenge = params.get("code_challenge");
  if (codeChallenge == null || codeChallenge === "") {
    return { ok: false, error: "invalid_request" };
  }
  if (params.get("code_challenge_method") !== "S256") {
    return { ok: false, error: "invalid_request" };
  }

  const resource = params.get("resource");
  if (resource !== mcpResource(deps.config)) {
    return { ok: false, error: "invalid_target" };
  }

  if (session == null) return { ok: false, error: "login_required" };
  return { ok: true };
}

export async function authorize(
  input: AuthorizeInput,
  deps: AuthorizeDeps,
): Promise<AuthorizeResult> {
  const { params, session, connectionId } = input;
  const { db, config, clock, random } = deps;

  // Enforce the authorization rules; any failure rejects with no code issued.
  const valid = await validateAuthorizeRequest(params, session, deps);
  if (!valid.ok) return valid;

  // The client and its registered redirect URI (validated above).
  const clientId = params.get("client_id")!;
  const redirectUri = params.get("redirect_uri")!;
  const codeChallenge = params.get("code_challenge")!;
  const resource = params.get("resource")!;

  // Mint an opaque code and store ONLY its hash, bound to the consent's connection
  // together with the PKCE challenge, client, redirect URI, resource and expiry.
  const code = Buffer.from(random.randomBytes(CODE_ENTROPY_BYTES)).toString("hex");
  const expiresAt = new Date(clock.now().getTime() + CODE_TTL_MS);
  await createAuthCode(db, {
    codeHash: sha256Hex(code),
    connectionId,
    clientId,
    codeChallenge,
    redirectUri,
    resource,
    expiresAt,
  });

  // Redirect back to the client carrying the code, the echoed state and iss (RFC 9207).
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  const state = params.get("state");
  if (state != null) redirect.searchParams.set("state", state);
  redirect.searchParams.set("iss", issuer(config));

  return { ok: true, redirectTo: redirect.toString(), code };
}

// E10-S12 — begin the consent-first authorize flow. The thin GET `/oauth/authorize`
// route now delegates HERE instead of issuing a code outright. This enforces the SAME
// rules as `authorize` (signed in, PKCE S256, matching resource) and rejects with the
// SAME error vocabulary, but on success it mints NO code and sends nothing to the
// client: it carries the whole authorize request SERVER-SIDE (the pending store) and
// returns an opaque handle plus a redirect to the internal `/oauth/consent` screen. The
// route puts the handle in a host-locked cookie, so the consent page and the decision
// read the request back by its handle and never trust a form/URL field. The code is
// issued only once the person approves (the decision calls `authorize` above).
export interface BeginAuthorizationInput {
  readonly params: URLSearchParams;
  readonly session: Session | null;
}

export type BeginAuthorizationResult =
  | { readonly ok: true; readonly handle: string; readonly redirectTo: string }
  | { readonly ok: false; readonly error: string };

export async function beginAuthorization(
  input: BeginAuthorizationInput,
  deps: AuthorizeDeps,
): Promise<BeginAuthorizationResult> {
  const { params, session } = input;
  const { random } = deps;

  // Enforce the authorization rules; a rejection never reaches consent.
  const valid = await validateAuthorizeRequest(params, session, deps);
  if (!valid.ok) return valid;
  if (session == null) return { ok: false, error: "login_required" }; // (validated above)

  // Carry the request server-side under an opaque handle, bound to the signed-in person
  // who started it (only they can see or decide it), and send them to the internal
  // consent screen — no code is issued and nothing is sent to the client.
  const handle = putPendingAuthorization(params, session.userId, random);
  return { ok: true, handle, redirectTo: "/oauth/consent" };
}
