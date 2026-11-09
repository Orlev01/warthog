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
// Review fix A3 — single use is ATOMIC and a retried refresh is safe. The code is
// consumed by one `DELETE … RETURNING` and a refresh token claimed by one conditional
// `UPDATE … WHERE expires_at > now RETURNING`, so of two concurrent requests exactly one
// wins (before, both read the row and both minted a pair). The successor refresh token is
// DERIVED from the presented one with the server HMAC key (an unguessable 256-bit value;
// still stored only as its hash), so a client that retries a refresh within a short grace
// window — its first response lost to a timeout, or two requests sent at once — is handed
// the SAME successor back instead of having its connection revoked as a replay. Past the
// window, or once that successor has itself been used, a replay revokes as before.
//
// The endpoint never takes a connection from the caller (constitution: connection
// scope is never read from the request): the connection is resolved from the code or
// from the presented refresh token. Tokens are opaque high-entropy bearers drawn from
// the random seam, kept only as hashes (constitution: tokens are stored only as
// hashes) — the raw bearer is returned once, in the response, and never persisted.

import { createHash } from "node:crypto";

import { consumeAuthCode, createToken, getAuthCode, resolveToken } from "./store";
import { withTransaction } from "../db/index";
import { lockOAuthConnection } from "./connection-lock";
import { hmac } from "../crypto/hmac";
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

// How long after a refresh token is rotated a retry of it is answered with the same
// successor rather than treated as a replay (review fix A3). Long enough for an HTTP
// client's timeout-and-retry, short enough that a stolen token's window stays narrow.
export const REFRESH_REUSE_GRACE_MS = 30_000;

// Domain separation for the derived successor refresh token (the server HMAC key has
// other uses).
const SUCCESSOR_LABEL = "warthog/oauth/refresh-successor/v1:";

// The parsed form-urlencoded request body.
export interface TokenInput {
  readonly params: URLSearchParams;
}

// The seams the token exchange depends on: the db (store), a clock (TTLs and the
// current-vs-retired check), a randomness source (the opaque bearers) and the server
// HMAC key (`config.hmacKey`; the retry-safe successor refresh token is derived with it).
export interface TokenDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  readonly hmacKey: Uint8Array;
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

// The refresh token that succeeds `presented` on rotation: HMAC-SHA256 under the server
// key, so it is as unguessable as a random bearer to anyone without the key, yet the
// same every time the same token is rotated — which is what lets a retry be answered
// with it again without ever storing a bearer in plain text.
function successorOf(presented: string, hmacKey: Uint8Array): string {
  return hmac(hmacKey, `${SUCCESSOR_LABEL}${presented}`);
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

  const identified = await getAuthCode(db, sha256Hex(code));
  if (!identified) return { ok: false, error: "invalid_grant" };
  return withTransaction(db, async (tx) => {
    await lockOAuthConnection(tx, identified.connectionId);
    // Re-read and consume only after acquiring the same lock revocation uses.
    const authCode = await consumeAuthCode(tx, sha256Hex(code));
    if (!authCode || authCode.expiresAt.getTime() <= clock.now().getTime()) {
      return { ok: false, error: "invalid_grant" };
    }
    if (authCode.clientId !== clientId || authCode.redirectUri !== redirectUri ||
        s256Challenge(verifier) !== authCode.codeChallenge) {
      return { ok: false, error: "invalid_grant" };
    }
    return mintTokenPair({ ...deps, db: tx }, authCode.connectionId);
  });
}

// refresh_token grant: rotate a current refresh token; answer a quick retry with the
// same successor; detect and punish replay of a retired one.
async function exchangeRefreshToken(
  params: URLSearchParams,
  deps: TokenDeps,
): Promise<TokenResult> {
  const presented = params.get("refresh_token");
  if (!presented) return { ok: false, error: "invalid_request" };
  const identified = await resolveToken(deps.db, sha256Hex(presented));
  if (!identified || identified.kind !== "refresh") return { ok: false, error: "invalid_grant" };
  return withTransaction(deps.db, async (tx) => {
    await lockOAuthConnection(tx, identified.connectionId);
    return rotateRefreshToken(presented, { ...deps, db: tx });
  });
}

async function rotateRefreshToken(presented: string, deps: TokenDeps): Promise<TokenResult> {
  const { db, clock, hmacKey } = deps;
  const presentedHash = sha256Hex(presented);
  const now = clock.now();

  // Current: claim it — retire it in the same statement that checks it is current, so of
  // two concurrent refreshes only one rotates — and mint the pair with the derived
  // successor, bound to the same connection.
  const claimed = await claimRefreshToken(db, presentedHash, now);
  if (claimed != null) {
    return mintTokenPair(deps, claimed, successorOf(presented, hmacKey));
  }

  const token = await resolveToken(db, presentedHash);
  if (token == null || token.kind !== "refresh") {
    return { ok: false, error: "invalid_grant" };
  }

  // Retired moments ago: a retry (or a request racing the one that rotated it). If the
  // successor it was rotated to is still current, hand that same successor back with a
  // fresh access token. If the successor is not there yet (the rotating request is still
  // writing it), refuse without revoking — the client is about to hold it.
  if (now.getTime() - token.expiresAt.getTime() < REFRESH_REUSE_GRACE_MS) {
    const successor = successorOf(presented, hmacKey);
    const next = await resolveToken(db, sha256Hex(successor));
    if (next == null) return { ok: false, error: "invalid_grant" };
    if (
      next.kind === "refresh" &&
      next.connectionId === token.connectionId &&
      next.expiresAt.getTime() > now.getTime()
    ) {
      return mintTokenPair(deps, token.connectionId, successor, { refreshExists: true });
    }
  }

  // A refresh token that resolves but is no longer current (retired by an earlier
  // rotation past the grace window, rotated onward already, or lapsed) is a replay:
  // revoke every token on the connection so the then-current refresh token stops working
  // too, and reject.
  await revokeConnectionTokens(db, token.connectionId);
  return { ok: false, error: "invalid_grant" };
}

// Mint and store an access/refresh pair bound to a connection, and return the response.
// The access token is always fresh; the refresh token is a fresh random one (a code
// exchange) or the derived successor of a rotated one — already stored when a retry is
// being answered with it (`refreshExists`).
async function mintTokenPair(
  deps: TokenDeps,
  connectionId: string,
  refreshToken: string = mintBearer(deps.random),
  opts: { readonly refreshExists?: boolean } = {},
): Promise<TokenResult> {
  const { db, clock, random } = deps;
  const now = clock.now();

  const accessToken = mintBearer(random);

  await createToken(db, {
    tokenHash: sha256Hex(accessToken),
    connectionId,
    kind: "access",
    expiresAt: new Date(now.getTime() + ACCESS_TTL_MS),
  });
  if (!opts.refreshExists) {
    await createToken(db, {
      tokenHash: sha256Hex(refreshToken),
      connectionId,
      kind: "refresh",
      expiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
    });
  }

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

// Claim a CURRENT refresh token by retiring it (expiring it at the current instant) in
// the same statement that checks it is current: it still resolves afterwards (so a later
// replay is detectable) but no longer counts as current. Returns its connection, or null
// when it was not a current refresh token — including when a concurrent request claimed
// it first.
async function claimRefreshToken(db: Db, tokenHash: string, now: Date): Promise<string | null> {
  const result = await db.query(
    `UPDATE oauth_tokens SET expires_at = $1::timestamptz
     WHERE token_hash = $2 AND kind = 'refresh' AND expires_at > $1::timestamptz
     RETURNING connection_id`,
    [now.toISOString(), tokenHash],
  );
  const row = result.rows[0];
  return row ? (row.connection_id as string) : null;
}

// Revoke every token bound to a connection (both kinds), used when a retired refresh
// token is replayed.
async function revokeConnectionTokens(db: Db, connectionId: string): Promise<void> {
  await db.query("DELETE FROM oauth_tokens WHERE connection_id = $1::uuid", [connectionId]);
}
