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

import { createHash } from "node:crypto";

import { createAuthCode } from "./store";
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
// clock (expiry) and the randomness source (the opaque code).
export interface AuthorizeDeps {
  readonly db: Db;
  readonly config: Config;
  readonly clock: Clock;
  readonly random: Random;
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

export async function authorize(
  input: AuthorizeInput,
  deps: AuthorizeDeps,
): Promise<AuthorizeResult> {
  const { params, session, connectionId } = input;
  const { db, config, clock, random } = deps;

  // Must be signed in (the route resolves this from the session cookie).
  if (session == null) return { ok: false, error: "login_required" };

  // PKCE is mandatory and S256 only: a missing challenge, or any method other than
  // S256 (including an omitted method, which RFC 7636 defaults to "plain"), is rejected.
  const codeChallenge = params.get("code_challenge");
  if (codeChallenge == null || codeChallenge === "") {
    return { ok: false, error: "invalid_request" };
  }
  if (params.get("code_challenge_method") !== "S256") {
    return { ok: false, error: "invalid_request" };
  }

  // The resource parameter is required and must be exactly this server's MCP resource.
  const resource = params.get("resource");
  if (resource !== mcpResource(config)) {
    return { ok: false, error: "invalid_target" };
  }

  // The client and its redirect URI are required to form the authorization response.
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  if (clientId == null || clientId === "" || redirectUri == null || redirectUri === "") {
    return { ok: false, error: "invalid_request" };
  }

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
