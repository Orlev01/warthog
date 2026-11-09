// E06-S06 — the `/oauth/revoke` endpoint's testable handler (RFC 7009). Revoking cuts
// an agent off by deleting the presented token's CONNECTION's tokens (design §6.1).
//
// The App-Router `route.ts` may export ONLY the known route keys (the HTTP verbs +
// config) or `next build` rejects it (OBS-025), so the injection seam that lets the
// handler be unit-tested with an explicit `db` lives HERE, in a sibling module;
// `route.ts` imports `createRevokeHandler`, wires the real db, and exports only `POST`
// (exactly as `/oauth/register` does).
//
// The connection is NEVER taken from the caller (constitution): the endpoint resolves
// it from the presented token (by the token's SHA-256 hash — the same contract
// `/oauth/token` mints under), then deletes that connection's tokens. An invalid or
// missing token is not an error (RFC 7009 §2.2): the endpoint still responds 2xx and
// revokes nothing.

import { createHash } from "node:crypto";

import { withTransaction, type Db } from "../../../server/db/index";
import { lockOAuthConnection } from "../../../server/oauth/connection-lock";
import { readOAuthForm } from "../../../server/oauth/form";
import { resolveToken } from "../../../server/oauth/store";

// SHA-256 hex of a value — how a token is addressed in storage (design §6.1); the
// presented bearer is resolved by its hash, never stored or compared in the clear.
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// RFC 7009 revocation responds 200 with an empty body, whether or not the token was
// found — an invalid token is not an error (§2.2).
function ok(): Response {
  return new Response(null, { status: 200 });
}

export function createRevokeHandler({ db }: { db: Db }): (request: Request) => Promise<Response> {
  return async function revoke(request: Request): Promise<Response> {
    // RFC 7009 §2.1: a form-urlencoded body carrying the `token` to revoke, read under
    // a size cap (an oversized body is a 413, never buffered whole).
    const params = await readOAuthForm(request);
    if (params instanceof Response) return params;
    const token = params.get("token");
    // No token presented: nothing to revoke, and a missing one is not a server error.
    if (!token) return ok();

    // Resolve the presented bearer to its connection by hash. An unknown/unresolvable
    // token matches nothing and revokes nothing — still a 2xx (§2.2).
    const resolved = await resolveToken(db, sha256Hex(token));
    if (resolved == null) return ok();

    await withTransaction(db, async (tx) => {
      await lockOAuthConnection(tx, resolved.connectionId);
      // A rotation may have completed while we waited. Revoke the whole family
      // under the same lock, including pending codes that could mint new tokens.
      await tx.query("DELETE FROM oauth_tokens WHERE connection_id = $1::uuid", [resolved.connectionId]);
      await tx.query("DELETE FROM oauth_auth_codes WHERE connection_id = $1::uuid", [resolved.connectionId]);
    });
    return ok();
  };
}
