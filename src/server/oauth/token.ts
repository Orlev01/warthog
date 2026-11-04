// E06-S05 — the OAuth 2.1 token seam: authorization_code + PKCE exchange and
// refresh-token rotation (design §6.1).
//
// Warthog is its own authorization server. This is the logic behind `/oauth/token`:
// it takes the already-parsed form-urlencoded body (a `URLSearchParams`, exactly as
// the sibling authorize seam takes its query) and, through the db/clock/random seams,
// either mints tokens or rejects with an OAuth error code — no tokens issued on a
// rejection. The thin `route.ts` does the trivial form parse
// (`new URLSearchParams(await request.text())`) and delegates here.
//
// Two grants (RFC 6749 §4.1.3 / §6, with OAuth 2.1 refresh rotation + RFC 7636 PKCE):
//
//   authorization_code — resolve the one-time code (by its SHA-256 hash) to the
//     consent E06-S04 bound it to, consume it (it is one-time), verify the PKCE S256
//     relationship (base64url(SHA-256(verifier)) must equal the bound challenge) and
//     that the client/redirect match the ones the code was issued to, then mint an
//     opaque access token (1 hour) + refresh token (30 days), each stored ONLY as its
//     SHA-256 hash bound to the code's connection.
//
//   refresh_token — resolve the presented refresh token (by hash). A CURRENT refresh
//     token is rotated on EVERY use: it is retired and a fresh access+refresh pair is
//     issued, bound to the same connection. A refresh token that resolves but is no
//     longer current (retired by an earlier rotation, or lapsed) is a replay — the
//     connection's tokens are revoked and the request is rejected with invalid_grant,
//     so the then-current refresh token stops working too.
//
// The endpoint never takes a connection from the caller (constitution: connection
// scope is never read from the request): the connection is resolved from the code or
// from the presented refresh token. Tokens are opaque high-entropy bearers drawn from
// the random seam, kept only as hashes (constitution: tokens are stored only as
// hashes) — the raw bearer is returned once, in the response, and never persisted.

import { createHash } from "node:crypto";

import { createToken, getAuthCode, resolveToken } from "./store";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";

// Token lifetimes (design §6.1): access 1 hour, refresh 30 days.
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// `expires_in` in the response is the access token's lifetime in seconds (RFC 6749 §5.1).
const ACCESS_EXPIRES_IN_S = ACCESS_TTL_MS / 1000;

// 256 bits of entropy, rendered as hex — the same opaque-bearer shape codes/sessions use.
const TOKEN_ENTROPY_BYTES = 32;

// The parsed form-urlencoded request body.
export interface TokenInput {
  readonly params: URLSearchParams;
}

// The seams the token exchange depends on: the db (store), a clock (TTLs and the
// current-vs-retired check) and a randomness source (the opaque bearers).
export interface TokenDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
}

// The JSON the endpoint returns on success (RFC 6749 §5.1).
export interface TokenResponseBody {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly refresh_token: string;
}

// The outcome: a token response, or a rejection naming the OAuth error code — no
// tokens are issued on a rejection.
export type TokenResult =
  | { readonly ok: true; readonly body: TokenResponseBody }
  | { readonly ok: false; readonly error: string };

// SHA-256 hex of a value — how a token/code is addressed in storage (never the raw value).
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// The RFC 7636 S256 challenge for a verifier: base64url(SHA-256(verifier)), unpadded.
function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

// An opaque, high-entropy bearer value.
function mintBearer(random: Random): string {
  return Buffer.from(random.randomBytes(TOKEN_ENTROPY_BYTES)).toString("hex");
}

export async function exchangeToken(input: TokenInput, deps: TokenDeps): Promise<TokenResult> {
  const grantType = input.params.get("grant_type");
  if (grantType === "authorization_code") return exchangeAuthorizationCode(input.params, deps);
  if (grantType === "refresh_token") return exchangeRefreshToken(input.params, deps);
  return { ok: false, error: "unsupported_grant_type" };
}

// authorization_code grant: a one-time code + its matching PKCE verifier → a fresh
// access/refresh pair bound to the code's connection.
async function exchangeAuthorizationCode(
  params: URLSearchParams,
  deps: TokenDeps,
): Promise<TokenResult> {
  const { db, clock } = deps;

  const code = params.get("code");
  const verifier = params.get("code_verifier");
  const redirectUri = params.get("redirect_uri");
  const clientId = params.get("client_id");
  if (!code || !verifier || !redirectUri || !clientId) {
    return { ok: false, error: "invalid_request" };
  }

  // Resolve the code by its hash (the raw code is never a stored key); then consume it
  // so it can never be exchanged a second time, regardless of how this attempt ends.
  const authCode = await getAuthCode(db, sha256Hex(code));
  if (authCode == null) return { ok: false, error: "invalid_grant" };
  await deleteAuthCode(db, authCode.codeHash);

  // An expired code is no longer exchangeable.
  if (authCode.expiresAt.getTime() <= clock.now().getTime()) {
    return { ok: false, error: "invalid_grant" };
  }

  // The client and redirect URI must match the ones the code was issued to.
  if (authCode.clientId !== clientId || authCode.redirectUri !== redirectUri) {
    return { ok: false, error: "invalid_grant" };
  }

  // PKCE S256: the verifier must hash to the challenge the code was bound to.
  if (s256Challenge(verifier) !== authCode.codeChallenge) {
    return { ok: false, error: "invalid_grant" };
  }

  return mintTokenPair(deps, authCode.connectionId);
}

// refresh_token grant: rotate a current refresh token; detect and punish replay of a
// retired one.
async function exchangeRefreshToken(
  params: URLSearchParams,
  deps: TokenDeps,
): Promise<TokenResult> {
  const { db, clock } = deps;

  const presented = params.get("refresh_token");
  if (!presented) return { ok: false, error: "invalid_request" };

  const token = await resolveToken(db, sha256Hex(presented));
  if (token == null || token.kind !== "refresh") {
    return { ok: false, error: "invalid_grant" };
  }

  // A refresh token that resolves but is no longer current (retired by an earlier
  // rotation, or lapsed) is a replay: revoke every token on the connection so the
  // then-current refresh token stops working too, and reject.
  if (token.expiresAt.getTime() <= clock.now().getTime()) {
    await revokeConnectionTokens(db, token.connectionId);
    return { ok: false, error: "invalid_grant" };
  }

  // Current: rotate on every use — retire the presented token and mint a fresh pair
  // bound to the same connection.
  await retireToken(db, token.tokenHash, clock.now());
  return mintTokenPair(deps, token.connectionId);
}

// Mint and store an access/refresh pair bound to a connection, and return the response.
async function mintTokenPair(deps: TokenDeps, connectionId: string): Promise<TokenResult> {
  const { db, clock, random } = deps;
  const now = clock.now();

  const accessToken = mintBearer(random);
  const refreshToken = mintBearer(random);

  await createToken(db, {
    tokenHash: sha256Hex(accessToken),
    connectionId,
    kind: "access",
    expiresAt: new Date(now.getTime() + ACCESS_TTL_MS),
  });
  await createToken(db, {
    tokenHash: sha256Hex(refreshToken),
    connectionId,
    kind: "refresh",
    expiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
  });

  return {
    ok: true,
    body: {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_EXPIRES_IN_S,
      refresh_token: refreshToken,
    },
  };
}

// Consume a one-time authorization code: once resolved it is removed, so a replayed
// code finds nothing. (`oauth_auth_codes` is not an activity table, so DELETE is fine.)
async function deleteAuthCode(db: Db, codeHash: string): Promise<void> {
  await db.query("DELETE FROM oauth_auth_codes WHERE code_hash = $1", [codeHash]);
}

// Retire a refresh token by expiring it at the current instant: it still resolves (so a
// later replay is detectable), but no longer counts as current.
async function retireToken(db: Db, tokenHash: string, now: Date): Promise<void> {
  await db.query("UPDATE oauth_tokens SET expires_at = $1::timestamptz WHERE token_hash = $2", [
    now.toISOString(),
    tokenHash,
  ]);
}

// Revoke every token bound to a connection (both kinds), used when a retired refresh
// token is replayed.
async function revokeConnectionTokens(db: Db, connectionId: string): Promise<void> {
  await db.query("DELETE FROM oauth_tokens WHERE connection_id = $1::uuid", [connectionId]);
}
