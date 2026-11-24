// E06-S06 — the `/oauth/revoke` endpoint (RFC 7009): revoking cuts an agent off by
// deleting the presented token's CONNECTION's tokens (design §6.1; brief NFR: a
// disconnected agent's next request is refused).
//
// RED-first: the route's handler does not exist yet, so every test here fails at
// import until the builder writes it. That absence IS the point of test-first — do not
// implement anything to make these pass.
//
// Seam note: an App-Router `route.ts` may export ONLY the known route keys (the HTTP
// verbs + config); `next build` rejects any other export (OBS-025). So the testable
// injection seam — a handler factory that takes an explicit `db` — lives in the SIBLING
// module `src/app/oauth/revoke/handler.ts`, which `route.ts` imports and wires before
// exporting `POST` (exactly as `/oauth/register` does). The task's Touches list only
// `route.ts`; the sibling handler is the seam that keeps the entry thin and testable,
// so these tests import it directly.
//
// Location note: this TEST file lives beside the OAuth server code (as the E06-S03
// register-handler tests do) and imports the handler by path; the gate's discovery glob
// (`src/**/*.test.ts`) finds it here.
//
// These tests pin BEHAVIOUR (the HTTP response a POST produces and the stored state it
// leaves behind), never source text. The connection is NEVER taken from the caller
// (constitution): the endpoint resolves it from the presented token, then deletes that
// connection's tokens. Tokens are read back through the already-built store
// (`resolveToken`) — the same SHA-256 contract `/oauth/token` mints them under — and
// the "cut off" is also shown end-to-end: a revoked refresh token no longer exchanges.
//
// The contract this task defines (the builder implements exactly this):
//
//   createRevokeHandler({ db }): (request: Request) => Promise<Response>
//     • POST, form-urlencoded (RFC 7009 §2.1), `token=<access-or-refresh token>`:
//         - resolves the token to its connection and deletes ALL of that connection's
//           tokens (access AND refresh), then responds 2xx.
//         - an unknown / unresolvable token still responds 2xx and deletes nothing
//           (RFC 7009 §2.2: invalid tokens are not an error).
//         - revocation is scoped to the token's connection; other connections are
//           untouched.
//
// `connectionId` is an OPAQUE uuid here (the connections table lands in a later
// migration, E09-S05), exactly as E06-S01's store and the token seam treat it.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { createRevokeHandler } from "../../app/oauth/revoke/handler";
import { createToken, resolveToken } from "./store";
import { exchangeToken, type TokenDeps } from "./token";
import { freshDb } from "../../test/db";
import { systemClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import type { Db } from "../db/index";

// The SHA-256 hex digest of a value — how a token is addressed in storage (design
// §6.1; `/oauth/token` mints tokens as SHA-256 hashes). Computed here so the test
// seeds a token under the same hash the endpoint resolves by, and reads stored state
// back by that hash — proving deletion without assuming how the delete is spelled.
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Seed a token bound to a connection, stored under its SHA-256 hash exactly as
// `/oauth/token` would, and return the RAW bearer the client presents. A far-future
// expiry keeps it current, so only revocation can remove it.
async function seedToken(
  db: Db,
  opts: { connectionId: string; kind: "access" | "refresh" },
): Promise<string> {
  const raw = `${opts.kind}-${randomUUID()}`;
  await createToken(db, {
    tokenHash: sha256Hex(raw),
    connectionId: opts.connectionId,
    kind: opts.kind,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  return raw;
}

// A form-urlencoded RFC 7009 revocation request. Omitting `token` sends an empty body
// (the "no token" case).
function revokeRequest(token?: string): Request {
  const body = new URLSearchParams();
  if (token !== undefined) body.set("token", token);
  return new Request("https://warthog.com.au/oauth/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

// --- Revoke deletes the connection's tokens -----------------------------------------

test("revoking with an access token deletes every token on its connection", async () => {
  const db = await freshDb();
  try {
    const handler = createRevokeHandler({ db });
    const connectionId = randomUUID();
    const access = await seedToken(db, { connectionId, kind: "access" });
    const refresh = await seedToken(db, { connectionId, kind: "refresh" });

    // Sanity: both tokens resolve before the revocation.
    assert.ok((await resolveToken(db, sha256Hex(access))) != null, "the access token exists before revoke");
    assert.ok((await resolveToken(db, sha256Hex(refresh))) != null, "the refresh token exists before revoke");

    const res = await handler(revokeRequest(access));
    assert.ok(res.ok, `RFC 7009 revocation responds 2xx, got ${res.status}`);

    assert.equal(await resolveToken(db, sha256Hex(access)), null, "the presented access token is deleted");
    assert.equal(
      await resolveToken(db, sha256Hex(refresh)),
      null,
      "the connection's refresh token is deleted too — the whole connection is cut off",
    );
  } finally {
    await db.close();
  }
});

test("revoking with a refresh token also deletes the connection's tokens, and the refresh token stops working", async () => {
  const db = await freshDb();
  try {
    const handler = createRevokeHandler({ db });
    const connectionId = randomUUID();
    const access = await seedToken(db, { connectionId, kind: "access" });
    const refresh = await seedToken(db, { connectionId, kind: "refresh" });

    const res = await handler(revokeRequest(refresh));
    assert.ok(res.ok, `RFC 7009 revocation responds 2xx, got ${res.status}`);

    assert.equal(await resolveToken(db, sha256Hex(access)), null, "the connection's access token is deleted");
    assert.equal(await resolveToken(db, sha256Hex(refresh)), null, "the presented refresh token is deleted");

    // End-to-end: the revoked refresh token can no longer be exchanged at /oauth/token
    // — the agent is genuinely cut off, not merely missing from one table read.
    const deps: TokenDeps = { db, clock: systemClock, random: systemRandom, hmacKey: new Uint8Array(32).fill(0x11), resource: "https://warthog.example/mcp" };
    const after = await exchangeToken(
      { params: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }) },
      deps,
    );
    assert.equal(after.ok, false, "a revoked refresh token can no longer be exchanged for new tokens");
  } finally {
    await db.close();
  }
});

// --- RFC 7009: an invalid token is not an error -------------------------------------

test("revoking an unknown token responds 2xx and deletes nothing", async () => {
  const db = await freshDb();
  try {
    const handler = createRevokeHandler({ db });
    const connectionId = randomUUID();
    const survivor = await seedToken(db, { connectionId, kind: "access" });

    const res = await handler(revokeRequest(`unknown-${randomUUID()}`));
    assert.ok(res.ok, `an unknown token is not an error (RFC 7009 §2.2), got ${res.status}`);

    assert.ok(
      (await resolveToken(db, sha256Hex(survivor))) != null,
      "an unrelated token survives — an unknown token revokes nothing",
    );
  } finally {
    await db.close();
  }
});

test("a revocation with no token does not 500 and deletes nothing", async () => {
  const db = await freshDb();
  try {
    const handler = createRevokeHandler({ db });
    const connectionId = randomUUID();
    const survivor = await seedToken(db, { connectionId, kind: "access" });

    const res = await handler(revokeRequest());
    assert.ok(res.status < 500, `a missing token must not be a server error, got ${res.status}`);

    assert.ok(
      (await resolveToken(db, sha256Hex(survivor))) != null,
      "a token-less revocation deletes nothing",
    );
  } finally {
    await db.close();
  }
});

// --- Revocation is scoped to the token's connection ---------------------------------

test("revoking one connection's token leaves another connection's tokens intact", async () => {
  const db = await freshDb();
  try {
    const handler = createRevokeHandler({ db });
    const connA = randomUUID();
    const connB = randomUUID();
    const aAccess = await seedToken(db, { connectionId: connA, kind: "access" });
    const aRefresh = await seedToken(db, { connectionId: connA, kind: "refresh" });
    const bAccess = await seedToken(db, { connectionId: connB, kind: "access" });
    const bRefresh = await seedToken(db, { connectionId: connB, kind: "refresh" });

    const res = await handler(revokeRequest(aAccess));
    assert.ok(res.ok, `revocation responds 2xx, got ${res.status}`);

    assert.equal(await resolveToken(db, sha256Hex(aAccess)), null, "connection A's access token is revoked");
    assert.equal(await resolveToken(db, sha256Hex(aRefresh)), null, "connection A's refresh token is revoked");
    assert.ok(
      (await resolveToken(db, sha256Hex(bAccess))) != null,
      "connection B's access token is untouched",
    );
    assert.ok(
      (await resolveToken(db, sha256Hex(bRefresh))) != null,
      "connection B's refresh token is untouched — revocation is per-connection",
    );
  } finally {
    await db.close();
  }
});

// --- Review fix: the unauthenticated body is capped while it streams -----------------

test("an oversized revocation body is refused with 413 before it is parsed, and revokes nothing", async () => {
  const db = await freshDb();
  try {
    const handler = createRevokeHandler({ db });
    const connectionId = randomUUID();
    const access = await seedToken(db, { connectionId, kind: "access" });

    const body = new URLSearchParams({ token: access, pad: "x".repeat(32 * 1024) });
    const res = await handler(
      new Request("https://warthog.com.au/oauth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );

    assert.equal(res.status, 413, "an oversized body is a 413");
    assert.ok((await resolveToken(db, sha256Hex(access))) != null, "nothing was revoked");
  } finally {
    await db.close();
  }
});
