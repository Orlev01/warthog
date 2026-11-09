// E06-S05 — the OAuth 2.1 token endpoint: code+PKCE exchange and refresh rotation
// (`src/server/oauth/token.ts`; the thin `src/app/oauth/token/route.ts` parses the
// form-urlencoded request body into params and wires it to the seam + config/db).
//
// RED-first: `./token` does not exist yet, so importing it throws — every test here
// fails at import until the builder writes the module. That absence IS the point of
// test-first; do not implement anything to make these pass.
//
// These tests pin BEHAVIOUR (what the token seam RETURNS, what it STORES, and what it
// later refuses), never the source text of any module — a later rename that preserves
// behaviour must not redden them. The minted access/refresh tokens are proven to be
// stored (addressed ONLY by their SHA-256 hash, bound to the connection, with the
// right TTLs) by reading them back through the already-built OAuth store
// (`resolveToken`), and rotation/reuse are proven by driving the seam itself — never
// by grepping a SQL file or probing a column.
//
// Seam note: an App-Router `route.ts` may export ONLY the known route keys (the HTTP
// verbs + config); `next build` rejects any other export (OBS-025). So the testable
// logic lives in the SIBLING server module `src/server/oauth/token.ts` — which the
// task's Touches already name — and the entry just parses the form-urlencoded body
// (`new URLSearchParams(await request.text())`), opens config/db and delegates. The
// "form-urlencoded" handling is that trivial route parse; the seam itself takes an
// already-parsed `URLSearchParams`, exactly as the sibling authorize seam does.
//
// Connection note: the token endpoint never takes a connection from the caller. The
// `authorization_code` grant resolves the connection from the one-time code (which
// E06-S04 bound to the consent's connection), and the `refresh_token` grant resolves
// it from the presented refresh token. `connectionId` is an OPAQUE uuid here (the
// connections table lands in a later migration, E09-S05), exactly as E06-S01's store
// treats it.
//
// The contract this task defines (the builder implements exactly this):
//
//   exchangeToken(input: TokenInput, deps: TokenDeps): Promise<TokenResult>
//     input:  { params: URLSearchParams }          // the parsed form-urlencoded body
//     deps:   { db: Db; clock: Clock; random: Random }
//     result: { ok: true;  body: TokenResponseBody }
//           | { ok: false; error: string }         // an OAuth error code, no tokens issued
//
//   TokenResponseBody (the JSON the endpoint returns, RFC 6749 §5.1):
//     { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string }
//
//   authorization_code grant: given `code`, a matching PKCE `code_verifier` (S256:
//     base64url(SHA-256(verifier)) must equal the challenge the code was bound to),
//     the `redirect_uri` and `client_id`, it mints an opaque access token (1 hour) and
//     an opaque refresh token (30 days), each stored ONLY as its SHA-256 hash bound to
//     the code's connection, and returns them. A verifier that does not match the
//     bound challenge is rejected (invalid_grant), no tokens issued.
//
//   refresh_token grant: a current refresh token is rotated — a fresh access+refresh
//     pair is issued on EVERY use and the presented refresh token is retired. Reusing
//     a RETIRED refresh token revokes the connection's tokens and is rejected with
//     invalid_grant (so the then-current refresh token stops working too).
//
// Acceptance criteria → tests:
//   AC1 "Exchanges a code with a matching PKCE verifier for a 1-hour access token and a
//        30-day refresh token." — a code + matching S256 verifier yields a Bearer
//        access token (expires_in 3600, stored with a 1-hour expiry) and a refresh
//        token (stored with a 30-day expiry), both bound to the code's connection and
//        stored only as SHA-256 hashes; a mismatched verifier is rejected (invalid_grant).
//   AC2 "Refresh rotates on every use and reuse of a retired refresh token revokes the
//        connection's tokens with invalid_grant." — each refresh issues a new, distinct
//        refresh token (rotation on every use); reusing a retired refresh token is
//        rejected with invalid_grant AND revokes the connection's tokens, so the
//        then-current refresh token no longer works.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import { createRevokeHandler } from "../../app/oauth/revoke/handler";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { exchangeToken, type TokenDeps } from "./token";
import { createClient, createAuthCode, resolveToken } from "./store";
import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import type { Db } from "../db/index";

// A realistic consent: a verified platform (claude.ai via CIMD) at the founder's host.
const BASE_URL = "https://warthog.com.au";
const MCP_RESOURCE = "https://warthog.com.au/mcp";
const CLIENT_ID = "https://claude.ai/.well-known/oauth-client";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

// A real RFC 7636 (Appendix B) S256 pair: the challenge is DERIVED from the verifier
// in-test (see `s256Challenge`), so the exchange proves the S256 relationship rather
// than trusting a magic constant. A second, well-formed-but-different verifier stands
// in for the "wrong verifier" case — it is valid in shape, so the only reason to
// reject it is that its challenge does not match the one bound to the code.
const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const WRONG_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXX";

// A frozen instant so every TTL ("expires in 1 hour / 30 days") is deterministic and
// computed off the injected clock, never SQL now().
const NOW = new Date("2026-01-01T00:00:00.000Z");
const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// The SHA-256 hex digest of a value — how a token is addressed in storage
// (constitution: tokens are stored only as hashes; design §6.1). Computed here so the
// test reads the stored row back by the same hash the endpoint persists, proving the
// raw bearer is never a stored key.
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// The RFC 7636 S256 challenge for a verifier: base64url(SHA-256(verifier)), no padding.
function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

// The token seam needs only the db (store), a clock (TTLs) and a randomness source
// (the opaque bearers). systemRandom gives real entropy so successive tokens differ —
// a fixed source would make every minted token identical and hide rotation.
// Review fix A3: the token seam also takes the server HMAC key (the retry-safe refresh
// successor is derived from it). A test-only value.
const HMAC_KEY = new Uint8Array(32).fill(0x11);

function deps(db: Db, now: Date = NOW): TokenDeps {
  return { db, clock: fixedClock(now), random: systemRandom, hmacKey: HMAC_KEY };
}

// An isolated in-memory db with the consenting client already registered.
async function dbWithClient(): Promise<Db> {
  const db = await freshDb();
  await createClient(db, { clientId: CLIENT_ID, registration: "cimd", redirectUris: [REDIRECT_URI] });
  return db;
}

// Seed a one-time authorization code bound to a connection and a PKCE S256 challenge,
// exactly as E06-S04's authorize seam would. Returns the RAW code the client presents;
// the store holds only its hash, and the token seam looks it up by that hash.
async function seedAuthCode(
  db: Db,
  opts: { connectionId: string; codeChallenge?: string },
): Promise<string> {
  const rawCode = `code-${randomUUID()}`;
  await createAuthCode(db, {
    codeHash: sha256Hex(rawCode),
    connectionId: opts.connectionId,
    clientId: CLIENT_ID,
    codeChallenge: opts.codeChallenge ?? s256Challenge(CODE_VERIFIER),
    redirectUri: REDIRECT_URI,
    resource: MCP_RESOURCE,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
  return rawCode;
}

// The authorization_code grant body (form params). Starts fully valid; a test may
// override a single field (e.g. the verifier) to isolate the behaviour it exercises.
function codeExchangeParams(code: string, overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: CODE_VERIFIER,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    ...overrides,
  });
}

// The refresh_token grant body (form params).
function refreshParams(refreshToken: string): URLSearchParams {
  return new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
}

// --- AC1: a code + matching PKCE verifier yields a 1-hour access and 30-day refresh --

test("a code with a matching PKCE verifier mints a 1-hour access token and a 30-day refresh token", async () => {
  const db = await dbWithClient();
  try {
    const connectionId = randomUUID();
    const code = await seedAuthCode(db, { connectionId });

    const result = await exchangeToken({ params: codeExchangeParams(code) }, deps(db));

    assert.ok(result.ok, "a code with a matching S256 verifier is exchanged for tokens");
    if (!result.ok) throw new Error("unreachable: result was not ok");
    const body = result.body;

    assert.equal(body.token_type, "Bearer", "the token type is Bearer (RFC 6749 §5.1)");
    assert.equal(body.expires_in, 3600, "the access token lives one hour (expires_in = 3600s)");
    assert.ok(body.access_token.length >= 32, "the access token is an opaque, high-entropy value");
    assert.ok(body.refresh_token.length >= 32, "the refresh token is an opaque, high-entropy value");
    assert.notEqual(body.access_token, body.refresh_token, "the access and refresh tokens are distinct");

    // The access token is stored addressed ONLY by its SHA-256 hash, bound to the
    // code's connection, with a 1-hour expiry.
    const access = await resolveToken(db, sha256Hex(body.access_token));
    assert.ok(access != null, "the access token is persisted, addressed by its SHA-256 hash");
    assert.equal(access?.connectionId, connectionId, "the access token binds to the code's connection");
    assert.equal(access?.kind, "access", "it is stored as an access token");
    assert.equal(
      access?.expiresAt.getTime(),
      NOW.getTime() + ACCESS_TTL_MS,
      "the access token expires one hour from now (off the injected clock)",
    );

    // The refresh token is stored the same way, with a 30-day expiry.
    const refresh = await resolveToken(db, sha256Hex(body.refresh_token));
    assert.ok(refresh != null, "the refresh token is persisted, addressed by its SHA-256 hash");
    assert.equal(refresh?.connectionId, connectionId, "the refresh token binds to the code's connection");
    assert.equal(refresh?.kind, "refresh", "it is stored as a refresh token");
    assert.equal(
      refresh?.expiresAt.getTime(),
      NOW.getTime() + REFRESH_TTL_MS,
      "the refresh token expires thirty days from now (off the injected clock)",
    );

    // The raw bearers are never a stored key — only their hashes resolve.
    assert.equal(await resolveToken(db, body.access_token), null, "the raw access token is not stored in plaintext");
    assert.equal(await resolveToken(db, body.refresh_token), null, "the raw refresh token is not stored in plaintext");
  } finally {
    await db.close();
  }
});

test("a code exchanged with a verifier that does not match the bound S256 challenge is rejected", async () => {
  const db = await dbWithClient();
  try {
    // The code is bound to the challenge for CODE_VERIFIER; the exchange presents a
    // different (but well-formed) verifier, so only the S256 mismatch can reject it.
    const code = await seedAuthCode(db, { connectionId: randomUUID() });

    const result = await exchangeToken(
      { params: codeExchangeParams(code, { code_verifier: WRONG_VERIFIER }) },
      deps(db),
    );

    assert.equal(result.ok, false, "a mismatched PKCE verifier must be rejected — no tokens issued");
    if (result.ok) throw new Error("unreachable: a mismatched verifier was accepted");
    assert.equal(result.error, "invalid_grant", "a PKCE mismatch is rejected with invalid_grant");
  } finally {
    await db.close();
  }
});

test("an authorization code cannot be exchanged twice (it is one-time)", async () => {
  const db = await dbWithClient();
  try {
    const code = await seedAuthCode(db, { connectionId: randomUUID() });

    const first = await exchangeToken({ params: codeExchangeParams(code) }, deps(db));
    assert.ok(first.ok, "the first exchange of a fresh code succeeds");

    const second = await exchangeToken({ params: codeExchangeParams(code) }, deps(db));
    assert.equal(second.ok, false, "the same authorization code cannot be exchanged a second time");
  } finally {
    await db.close();
  }
});

// --- AC2: refresh rotates on every use ----------------------------------------------

test("every refresh rotates the refresh token: each use issues a new, distinct refresh token", async () => {
  const db = await dbWithClient();
  try {
    const connectionId = randomUUID();
    const code = await seedAuthCode(db, { connectionId });

    const first = await exchangeToken({ params: codeExchangeParams(code) }, deps(db));
    assert.ok(first.ok, "the initial code exchange succeeds");
    if (!first.ok) throw new Error("unreachable: initial exchange was not ok");
    const r1 = first.body.refresh_token;
    const a1 = first.body.access_token;

    // First refresh: a current refresh token yields a fresh pair, rotated.
    const second = await exchangeToken({ params: refreshParams(r1) }, deps(db));
    assert.ok(second.ok, "a current refresh token is accepted");
    if (!second.ok) throw new Error("unreachable: first refresh was not ok");
    const r2 = second.body.refresh_token;
    const a2 = second.body.access_token;
    assert.notEqual(r2, r1, "the refresh token rotates: a new refresh token is issued on use");
    assert.notEqual(a2, a1, "a fresh access token is issued alongside it");
    assert.equal(second.body.token_type, "Bearer", "the refreshed response is a Bearer grant");
    assert.equal(second.body.expires_in, 3600, "the refreshed access token also lives one hour");

    // Second refresh with the ROTATED token: it rotates again (on every use).
    const third = await exchangeToken({ params: refreshParams(r2) }, deps(db));
    assert.ok(third.ok, "the rotated refresh token is itself usable");
    if (!third.ok) throw new Error("unreachable: second refresh was not ok");
    const r3 = third.body.refresh_token;
    assert.notEqual(r3, r2, "the refresh token rotates again on the next use");
    assert.notEqual(r3, r1, "each rotation issues a distinct refresh token");

    // The newest refresh token resolves bound to the same connection with a fresh
    // 30-day expiry, stored only as its hash.
    const stored = await resolveToken(db, sha256Hex(r3));
    assert.ok(stored != null, "the current refresh token is persisted by its hash");
    assert.equal(stored?.connectionId, connectionId, "it stays bound to the original connection");
    assert.equal(stored?.kind, "refresh", "it is a refresh token");
    assert.equal(
      stored?.expiresAt.getTime(),
      NOW.getTime() + REFRESH_TTL_MS,
      "a rotated refresh token carries a fresh 30-day expiry",
    );
  } finally {
    await db.close();
  }
});

// --- AC2: reuse of a retired refresh token revokes the connection's tokens ----------

test("reusing a retired refresh token is rejected with invalid_grant and revokes the connection's tokens", async () => {
  const db = await dbWithClient();
  try {
    const connectionId = randomUUID();
    const code = await seedAuthCode(db, { connectionId });

    const first = await exchangeToken({ params: codeExchangeParams(code) }, deps(db));
    assert.ok(first.ok, "the initial code exchange succeeds");
    if (!first.ok) throw new Error("unreachable: initial exchange was not ok");
    const r1 = first.body.refresh_token;

    // Rotate once: R1 is now retired, R2 is the current refresh token.
    const rotated = await exchangeToken({ params: refreshParams(r1) }, deps(db));
    assert.ok(rotated.ok, "the first refresh succeeds and retires R1");
    if (!rotated.ok) throw new Error("unreachable: rotation was not ok");
    const r2 = rotated.body.refresh_token;

    // Reusing the RETIRED token R1 — after the short retry grace window (review fix A3)
    // — is rejected with invalid_grant.
    const later = new Date(NOW.getTime() + 5 * 60_000);
    const reuse = await exchangeToken({ params: refreshParams(r1) }, deps(db, later));
    assert.equal(reuse.ok, false, "reusing a retired refresh token must be rejected");
    if (reuse.ok) throw new Error("unreachable: reuse of a retired token was accepted");
    assert.equal(reuse.error, "invalid_grant", "the reuse is rejected with invalid_grant");

    // The reuse revoked the connection's tokens: the then-current refresh token R2 —
    // valid moments ago — no longer works. This proves connection-level revocation
    // through the seam's own behaviour, without assuming how revocation is stored.
    const afterRevoke = await exchangeToken({ params: refreshParams(r2) }, deps(db, later));
    assert.equal(afterRevoke.ok, false, "the connection's current refresh token is revoked by the reuse");
    if (afterRevoke.ok) throw new Error("unreachable: a revoked token was accepted");
    assert.equal(afterRevoke.error, "invalid_grant", "the revoked token is rejected with invalid_grant");
  } finally {
    await db.close();
  }
});

test("a refresh token that was never issued is rejected", async () => {
  const db = await dbWithClient();
  try {
    const result = await exchangeToken({ params: refreshParams(`never-issued-${randomUUID()}`) }, deps(db));
    assert.equal(result.ok, false, "an unknown refresh token cannot be exchanged for tokens");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix A3 — single use is ATOMIC, and a retried refresh is safe.
//
// Until this fix a code was read and then deleted, and a refresh token was read and then
// retired, with nothing tying the two together: two concurrent exchanges of one code
// both minted a token pair, two concurrent refreshes forked the token family, and an
// agent's HTTP client that retried a timed-out refresh had its whole connection revoked
// as a "replay". Now the code is consumed by one DELETE … RETURNING and the refresh token
// claimed by one conditional UPDATE … RETURNING, so exactly one request wins; and the
// successor refresh token is derived from the presented one with the server key, so a
// retry within a short grace window gets the SAME successor back (no plaintext stored)
// instead of revoking the connection. Past the window, or once the successor itself has
// been used, a replay still revokes the connection's tokens.
// =====================================================================================

async function liveRefreshTokens(db: Db, connectionId: string, now: Date): Promise<number> {
  const result = await db.query(
    "SELECT count(*)::int AS n FROM oauth_tokens WHERE connection_id = $1::uuid AND kind = 'refresh' AND expires_at > $2::timestamptz",
    [connectionId, now.toISOString()],
  );
  return Number(result.rows[0]!.n);
}

test("two concurrent exchanges of one authorization code: exactly one mints tokens", async () => {
  const db = await dbWithClient();
  try {
    const connectionId = randomUUID();
    const code = await seedAuthCode(db, { connectionId });
    const results = await Promise.all([
      exchangeToken({ params: codeExchangeParams(code) }, deps(db)),
      exchangeToken({ params: codeExchangeParams(code) }, deps(db)),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1, "the code is redeemed exactly once");
    assert.equal(await liveRefreshTokens(db, connectionId, NOW), 1, "one token family exists");
  } finally {
    await db.close();
  }
});

test("two concurrent refreshes with one token do not fork the token family", async () => {
  const db = await dbWithClient();
  try {
    const connectionId = randomUUID();
    const first = await exchangeToken({ params: codeExchangeParams(await seedAuthCode(db, { connectionId })) }, deps(db));
    if (!first.ok) throw new Error("unreachable");
    const r1 = first.body.refresh_token;

    const results = await Promise.all([
      exchangeToken({ params: refreshParams(r1) }, deps(db)),
      exchangeToken({ params: refreshParams(r1) }, deps(db)),
    ]);
    const issued = new Set(results.flatMap((r) => (r.ok ? [r.body.refresh_token] : [])));
    assert.ok(issued.size >= 1, "at least one refresh succeeds");
    assert.equal(issued.size, 1, "every successful refresh hands back the same successor");
    assert.equal(await liveRefreshTokens(db, connectionId, NOW), 1, "exactly one live refresh token");

    const [successor] = [...issued];
    const next = await exchangeToken({ params: refreshParams(successor!) }, deps(db));
    assert.ok(next.ok, "the connection was not revoked: the successor still refreshes");
  } finally {
    await db.close();
  }
});

test("a refresh retried within the grace window gets the same successor and keeps the connection", async () => {
  const db = await dbWithClient();
  try {
    const connectionId = randomUUID();
    const first = await exchangeToken({ params: codeExchangeParams(await seedAuthCode(db, { connectionId })) }, deps(db));
    if (!first.ok) throw new Error("unreachable");
    const r1 = first.body.refresh_token;

    const rotated = await exchangeToken({ params: refreshParams(r1) }, deps(db));
    assert.ok(rotated.ok);
    if (!rotated.ok) throw new Error("unreachable");

    // The response was lost; the client retries a few seconds later with the same token.
    const retried = await exchangeToken({ params: refreshParams(r1) }, deps(db, new Date(NOW.getTime() + 5_000)));
    assert.ok(retried.ok, "a quick retry is not treated as theft");
    if (!retried.ok) throw new Error("unreachable");
    assert.equal(retried.body.refresh_token, rotated.body.refresh_token, "the same successor is handed back");
    assert.ok(retried.body.access_token.length >= 32, "with a usable access token");
    assert.equal(await liveRefreshTokens(db, connectionId, NOW), 1, "still one live refresh token");
  } finally {
    await db.close();
  }
});

test("replaying a token whose successor has already been used revokes the connection, even within the window", async () => {
  const db = await dbWithClient();
  try {
    const connectionId = randomUUID();
    const first = await exchangeToken({ params: codeExchangeParams(await seedAuthCode(db, { connectionId })) }, deps(db));
    if (!first.ok) throw new Error("unreachable");
    const r1 = first.body.refresh_token;
    const second = await exchangeToken({ params: refreshParams(r1) }, deps(db));
    if (!second.ok) throw new Error("unreachable");
    const third = await exchangeToken({ params: refreshParams(second.body.refresh_token) }, deps(db));
    if (!third.ok) throw new Error("unreachable");

    const replay = await exchangeToken({ params: refreshParams(r1) }, deps(db));
    assert.equal(replay.ok, false, "a token two generations old is a replay");
    if (!replay.ok) assert.equal(replay.error, "invalid_grant");
    const current = await exchangeToken({ params: refreshParams(third.body.refresh_token) }, deps(db));
    assert.equal(current.ok, false, "the connection's tokens were revoked");
  } finally {
    await db.close();
  }
});


function interceptDb(db: Db, intercept: (text: string, values: unknown[] | undefined, run: () => ReturnType<Db["query"]>) => ReturnType<Db["query"]>): Db {
  return {
    inTransaction: db.inTransaction,
    query: (text, values) => intercept(text, values, () => db.query(text, values)),
    close: () => db.close(),
    ...(db.transaction ? { transaction: <T>(fn: (tx: Db) => Promise<T>) => db.transaction!((tx) => fn(interceptDb(tx, intercept))) } : {}),
  };
}

for (const grant of ["authorization_code", "refresh_token"] as const) {
  test(`${grant} rolls back its credential claim and access token if refresh insertion fails`, async () => {
    const db = await dbWithClient();
    try {
      const connectionId = randomUUID();
      const code = await seedAuthCode(db, { connectionId });
      let params = codeExchangeParams(code);
      if (grant === "refresh_token") {
        const first = await exchangeToken({ params }, deps(db));
        assert.ok(first.ok);
        params = refreshParams(first.body.refresh_token);
      }
      const before = await db.query("SELECT token_hash, kind, expires_at FROM oauth_tokens ORDER BY token_hash");
      const failing = interceptDb(db, async (text, values, run) => {
        if (/INSERT INTO oauth_tokens/i.test(text) && values?.includes("refresh")) throw new Error("synthetic refresh insert failure");
        return run();
      });
      await assert.rejects(exchangeToken({ params }, deps(failing)), /synthetic refresh insert failure/);
      assert.deepEqual((await db.query("SELECT token_hash, kind, expires_at FROM oauth_tokens ORDER BY token_hash")).rows, before.rows);
      assert.ok((await exchangeToken({ params }, deps(db))).ok, "the original credential still works after rollback");
    } finally { await db.close(); }
  });
}

test("a refresh racing a successful revocation cannot recreate tokens after revocation", async () => {
  const db = await dbWithClient();
  try {
    const connectionId = randomUUID();
    const first = await exchangeToken({ params: codeExchangeParams(await seedAuthCode(db, { connectionId })) }, deps(db));
    assert.ok(first.ok);
    let reached!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { reached = resolve; });
    const continueRefresh = new Promise<void>((resolve) => { resume = resolve; });
    const racing = interceptDb(db, async (text, _values, run) => {
      const result = await run();
      if (/UPDATE oauth_tokens SET expires_at/i.test(text)) { reached(); await continueRefresh; }
      return result;
    });
    const refreshing = exchangeToken({ params: refreshParams(first.body.refresh_token) }, deps(racing));
    await paused;
    const revoking = createRevokeHandler({ db })(new Request("https://warthog.com.au/oauth/revoke", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: first.body.refresh_token }),
    }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    resume();
    const [, revoked] = await Promise.all([refreshing, revoking]);
    assert.equal(revoked.status, 200);
    assert.equal((await db.query("SELECT token_hash FROM oauth_tokens WHERE connection_id = $1", [connectionId])).rows.length, 0);
    assert.equal((await exchangeToken({ params: refreshParams(first.body.refresh_token) }, deps(db))).ok, false);
  } finally { await db.close(); }
});
