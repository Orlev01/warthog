// E06-S08 — bearer verification for the protected resource (`/mcp`), design §6.1.
//
// The MCP endpoint is an OAuth 2.1 protected resource: a request must carry a valid
// `Authorization: Bearer <token>` or it is challenged with a 401. This is the server
// seam a later MCP route (`src/app/mcp/route.ts`) calls around `createMcpHandler`; a
// `route.ts` may export ONLY the known route keys, so the verification logic lives here
// and the entry stays thin over it (OBS-025).
//
// A presented bearer is one of two Warthog credentials, both stored ONLY as their
// SHA-256 hash (never the raw value): an OAuth access token minted by `/oauth/token`,
// or a per-agent access key (`wh_ak_…`) for a platform that can only send a static
// Bearer header (design §6.1). Verification resolves either to the one connection it
// binds to. Disconnect deletes a connection's tokens and keys (design §6.1), so a
// credential that still resolves is, by construction, one of an active connection.
//
// Rejected — a missing header, a non-Bearer scheme, an unknown bearer, an expired
// access token, or a refresh token presented as a bearer (a refresh token is only for
// the token endpoint) — yields a 401 carrying the RFC 9728 / RFC 6750 challenge that
// points the client at the protected-resource metadata document. That URL is built from
// the CONFIGURED public base URL (`config.publicBaseUrl`), never the request host, so a
// challenge cannot be steered by a spoofed Host header.

import { createHash } from "node:crypto";

import { resolveToken } from "./store";
import { verifyAccessKey } from "./access-key";
import type { Db } from "../db/index";
import type { Config } from "../config";
import type { Clock } from "../seams/clock";

// The seams verification draws on: the db (credential store), config (the challenge's
// resource_metadata URL) and the clock (token expiry).
export interface VerifyBearerDeps {
  readonly db: Db;
  readonly config: Config;
  readonly clock: Clock;
}

// The outcome: the resolved connection, or a 401 challenge carrying the WWW-Authenticate
// header value the client should see (a discriminated union, the repo idiom).
export type BearerVerification =
  | { readonly ok: true; readonly connectionId: string }
  | { readonly ok: false; readonly status: 401; readonly wwwAuthenticate: string };

// SHA-256 hex of a value — how a token is addressed in storage (never the raw bearer),
// the same contract `/oauth/token` mints under (design §6.1).
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// The protected-resource metadata URL for the challenge: the configured public base URL
// (trailing slash stripped) plus the RFC 9728 well-known path, never the request host.
function resourceMetadataUrl(config: Config): string {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/.well-known/oauth-protected-resource`;
}

// The RFC 9728 / RFC 6750 challenge: the Bearer scheme, a resource_metadata parameter
// pointing at the metadata document, and the scope this resource requires.
function bearerChallenge(config: Config): string {
  return `Bearer resource_metadata="${resourceMetadataUrl(config)}", scope="warthog"`;
}

// The raw bearer from an `Authorization: Bearer <token>` header, or null when the header
// is absent or does not use the Bearer scheme (the scheme is matched case-insensitively,
// as RFC 7235 permits).
function readBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header == null) return null;
  const space = header.indexOf(" ");
  if (space === -1) return null;
  if (header.slice(0, space).toLowerCase() !== "bearer") return null;
  const token = header.slice(space + 1).trim();
  return token === "" ? null : token;
}

export async function verifyBearer(
  request: Request,
  deps: VerifyBearerDeps,
): Promise<BearerVerification> {
  const { db, config, clock } = deps;
  const reject: BearerVerification = {
    ok: false,
    status: 401,
    wwwAuthenticate: bearerChallenge(config),
  };

  const bearer = readBearer(request);
  if (bearer == null) return reject;

  // An OAuth token: resolve it by hash. Only an unexpired ACCESS token grants access at
  // the protected resource — a refresh token (token-endpoint only) or an expired token
  // is rejected, never fallen through to the access-key path.
  const token = await resolveToken(db, sha256Hex(bearer));
  if (token != null) {
    if (token.kind !== "access") return reject;
    if (token.expiresAt.getTime() <= clock.now().getTime()) return reject;
    return { ok: true, connectionId: token.connectionId };
  }

  // Otherwise it may be a per-agent access key (`wh_ak_…`), which verifies as a bearer
  // to the one connection it binds to (design §6.1). Access keys have no expiry — they
  // are retired by disconnecting the connection.
  const key = await verifyAccessKey(db, bearer);
  if (key != null) return { ok: true, connectionId: key.connectionId };

  return reject;
}
