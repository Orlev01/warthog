// E06-S01 — OAuth storage (`src/server/oauth/store.ts`, `db/migrations/0009_oauth.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so
// importing `./store` throws and `freshDb()` has no OAuth tables — every test here
// fails until the builder adds them. That absence IS the point of test-first; do
// not implement anything to make these pass.
//
// These tests pin BEHAVIOUR (what the data-access functions DO and what the
// migration produces), never the source text of the module or the SQL file — a
// later rename that preserves behaviour must not redden them. Table existence is
// proven by exercising the data access (a create/resolve round-trip only works if
// the table is there), not by grepping the migration or probing a column name.
//
// The contract this task defines (the builder implements exactly this):
//
//   Clients — the agent platform's registration (CIMD or DCR). A client is a
//   SHARED registration (one claude.ai registration serves many people), so it is
//   NOT connection-bound; only codes/tokens/keys are (design §6.1; brief: a client
//   like claude.ai is one registration used by every person who connects it).
//     createClient(db, { clientId, registration, redirectUris }): Promise<Client>
//       • `clientId` is the CIMD https URL or the DCR-issued id (stored verbatim,
//         as data — this module never interprets it); `registration` is
//         'cimd' | 'dcr'; `redirectUris` is the client's allowed redirect URIs.
//     getClient(db, clientId): Promise<Client | null>
//       • returns the one client with that id (bound as a parameter), or null.
//
//   Authorization codes — one-time codes bound to the consent's connection, stored
//   only as a hash (constitution: codes/tokens/keys stored only as hashes; design
//   §6.1 PKCE S256, resource required; E06-S04 "the code binds to the consent's
//   connection").
//     createAuthCode(db, { codeHash, connectionId, clientId, codeChallenge,
//                          redirectUri, resource, expiresAt }): Promise<AuthCode>
//     getAuthCode(db, codeHash): Promise<AuthCode | null>
//       • a code hash resolves to its connection and its PKCE challenge, or null.
//
//   Access & refresh tokens — opaque bearer values stored ONLY as SHA-256 hashes,
//   each bound to one connection (design §6.1: opaque random values stored as
//   SHA-256 hashes, bound to one agent connection; access 1 h, refresh 30 d).
//     createToken(db, { tokenHash, connectionId, kind, expiresAt }): Promise<Token>
//       • `kind` is 'access' | 'refresh'.
//     resolveToken(db, tokenHash): Promise<Token | null>
//       • a token hash resolves to its connection (AC2), or null when none.
//
//   Access keys — per-agent static bearers (`wh_ak_…`) stored only as hashes, same
//   connection model, no expiry (design §6.1).
//     createAccessKey(db, { keyHash, connectionId }): Promise<AccessKey>
//     resolveAccessKey(db, keyHash): Promise<AccessKey | null>
//       • a key hash resolves to its connection, or null when none.
//
//   `connectionId` is an OPAQUE identifier here (a uuid). The connections table is
//   created by a LATER migration (E09-S05, 0018_connections.sql) and E06-S01 does
//   not depend on it, so 0009 binds by a connection_id column, not a foreign key to
//   a table that does not exist yet.
//
// Acceptance criteria → tests:
//   AC1 "Stores CIMD/DCR clients, authorization codes, access and refresh tokens
//        (as SHA-256 hashes) and access keys, each bound to one connection." — each
//        entity is created and read back with its values intact; a token stored by
//        its SHA-256 hash resolves by that hash but NOT by the raw token (so the
//        plaintext bearer is never a stored key — it is kept only as a hash); both
//        'access' and 'refresh' kinds round-trip; each code/token/key carries back
//        the connection it was bound to.
//   AC2 "Lookups are parameterized and a token hash resolves to its connection; the
//        migration second run changes nothing." — resolveToken(hash) returns the
//        bound connection; two tokens for two connections each resolve to their own
//        connection; every lookup binds its argument as a parameter (proven on a
//        recording db); the real runner shows 0009_oauth applied and a second run
//        applies nothing new and does not throw.
//   AC3 [obligation:validate-and-parameterize-input] (INV-102) "A handler rejects
//        malformed or oversized input with a 4xx, and a SQL-injection probe in an
//        input field cannot alter a query (parameter binding is used)." — the
//        VALIDATE half is reused from the already-built boundary (`../http/validate`);
//        here we prove it COMPOSES with this task's data-access: a handler built on
//        the boundary rejects malformed/oversized input with a 4xx before any query
//        runs, and a probe routed through the store travels as a bound value — it
//        cannot drop or alter a table. The handler below is a test fixture (the
//        intended usage pattern), not an implementation file.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  createClient,
  getClient,
  createAuthCode,
  getAuthCode,
  createToken,
  resolveToken,
  createAccessKey,
  resolveAccessKey,
} from "./store";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "../db/index";
import { parseBody, HttpError } from "../http/validate";

// The SHA-256 hex digest of an opaque secret — how a token/code/key is stored
// (design §6.1: tokens are stored as SHA-256 hashes). Computed here so the tests
// exercise a real hash, though the store treats it as an opaque string.
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Builder helpers: every create call must supply all of an entity's required
// fields (a NOT NULL column would reject a partial insert), so each helper fills a
// complete, independent record that a test can override field-by-field. Distinct
// ids/hashes per call keep rows from colliding.
function newAuthCode(overrides: Record<string, unknown> = {}) {
  const raw = `code-${randomUUID()}`;
  return {
    codeHash: sha256Hex(raw),
    connectionId: randomUUID(),
    clientId: "https://claude.ai/.well-known/oauth-client",
    codeChallenge: sha256Hex(`verifier-${randomUUID()}`),
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    resource: "https://warthog.com.au/mcp",
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    ...overrides,
  };
}

function newToken(overrides: Record<string, unknown> = {}) {
  const raw = `tok-${randomUUID()}`;
  return {
    tokenHash: sha256Hex(raw),
    connectionId: randomUUID(),
    kind: "access" as "access" | "refresh",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
  };
}

function newAccessKey(overrides: Record<string, unknown> = {}) {
  const raw = `wh_ak_${randomUUID()}`;
  return {
    keyHash: sha256Hex(raw),
    connectionId: randomUUID(),
    ...overrides,
  };
}

// A db seam stand-in that records every call instead of running it, so a test can
// prove WHAT reached the query layer and HOW (bound value vs. spliced text). It
// returns no rows, which is all a SELECT lookup needs to yield null. It satisfies
// the `Db` shape structurally (query + close).
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// --- AC1: clients (CIMD and DCR) are stored and read back ---------------------------

test("createClient stores a CIMD client and it reads back by its id", async () => {
  const db = await freshDb();
  try {
    const clientId = "https://claude.ai/.well-known/oauth-client";
    const redirectUris = ["https://claude.ai/api/mcp/auth_callback"];
    const created = await createClient(db, { clientId, registration: "cimd", redirectUris });

    assert.equal(created.clientId, clientId, "the client id is stored and returned verbatim");
    assert.equal(created.registration, "cimd", "the registration kind round-trips");
    assert.deepEqual(created.redirectUris, redirectUris, "the redirect URIs round-trip");

    const read = await getClient(db, clientId);
    assert.ok(read != null, "the created client must be readable by its id");
    assert.equal(read?.clientId, clientId, "the same client comes back");
    assert.equal(read?.registration, "cimd", "the stored registration round-trips");
    assert.deepEqual(read?.redirectUris, redirectUris, "the stored redirect URIs round-trip");
  } finally {
    await db.close();
  }
});

test("createClient stores a DCR client distinctly from a CIMD one", async () => {
  const db = await freshDb();
  try {
    const cimdId = "https://chatgpt.com/.well-known/oauth-client";
    const dcrId = `dcr-${randomUUID()}`;
    await createClient(db, { clientId: cimdId, registration: "cimd", redirectUris: ["https://chatgpt.com/cb"] });
    await createClient(db, { clientId: dcrId, registration: "dcr", redirectUris: ["https://gemini.example/cb"] });

    const cimd = await getClient(db, cimdId);
    const dcr = await getClient(db, dcrId);
    assert.equal(cimd?.registration, "cimd", "the CIMD client keeps its registration kind");
    assert.equal(dcr?.registration, "dcr", "the DCR client keeps its registration kind");
    assert.deepEqual(dcr?.redirectUris, ["https://gemini.example/cb"], "DCR redirect URIs round-trip");
  } finally {
    await db.close();
  }
});

test("getClient returns null for an unknown client id (no row, not an error)", async () => {
  const db = await freshDb();
  try {
    await createClient(db, {
      clientId: "https://present.example/client",
      registration: "dcr",
      redirectUris: ["https://present.example/cb"],
    });
    const missing = await getClient(db, "https://nobody.example/client");
    assert.equal(missing, null, "a client id that matches no row yields null");
  } finally {
    await db.close();
  }
});

// --- AC1: authorization codes are stored, connection-bound, and read back by hash ---

test("createAuthCode stores a code bound to its connection and it reads back by its hash", async () => {
  const db = await freshDb();
  try {
    const code = newAuthCode({ connectionId: randomUUID() });
    const created = await createAuthCode(db, code);
    assert.equal(created.connectionId, code.connectionId, "the created code carries its connection");

    const read = await getAuthCode(db, code.codeHash);
    assert.ok(read != null, "the code must be readable by its hash");
    assert.equal(read?.connectionId, code.connectionId, "a code hash resolves to its connection");
    assert.equal(read?.codeChallenge, code.codeChallenge, "the PKCE challenge round-trips");
    assert.equal(read?.clientId, code.clientId, "the client id round-trips");
    assert.equal(read?.redirectUri, code.redirectUri, "the redirect URI round-trips");
    assert.equal(read?.resource, code.resource, "the resource round-trips");
    assert.equal(
      new Date(read?.expiresAt as unknown as string | number | Date).getTime(),
      code.expiresAt.getTime(),
      "the expiry round-trips to the same instant",
    );
  } finally {
    await db.close();
  }
});

test("getAuthCode returns null for a code hash that matches nothing", async () => {
  const db = await freshDb();
  try {
    await createAuthCode(db, newAuthCode());
    const missing = await getAuthCode(db, sha256Hex(`never-issued-${randomUUID()}`));
    assert.equal(missing, null, "an unknown code hash yields null");
  } finally {
    await db.close();
  }
});

// --- AC1/AC2: tokens are stored only as hashes, each bound to one connection --------

test("a token stored by its SHA-256 hash resolves by that hash to its connection", async () => {
  const db = await freshDb();
  try {
    const rawToken = `opaque-access-${randomUUID()}`;
    const tokenHash = sha256Hex(rawToken);
    const connectionId = randomUUID();
    await createToken(db, { tokenHash, connectionId, kind: "access", expiresAt: new Date(Date.now() + 3600_000) });

    const byHash = await resolveToken(db, tokenHash);
    assert.ok(byHash != null, "the token resolves by its stored hash");
    assert.equal(byHash?.connectionId, connectionId, "a token hash resolves to its connection (AC2)");
    assert.equal(byHash?.kind, "access", "the token kind round-trips");

    // The plaintext bearer is never a stored key — only its hash is. Looking the
    // raw token up (instead of its hash) must find nothing.
    const byRaw = await resolveToken(db, rawToken);
    assert.equal(byRaw, null, "the raw token is not stored; only its hash resolves");
  } finally {
    await db.close();
  }
});

test("access and refresh tokens are both stored and keep their kind", async () => {
  const db = await freshDb();
  try {
    const connectionId = randomUUID();
    const access = newToken({ connectionId, kind: "access" });
    const refresh = newToken({ connectionId, kind: "refresh" });
    await createToken(db, access);
    await createToken(db, refresh);

    assert.equal((await resolveToken(db, access.tokenHash))?.kind, "access", "the access token keeps kind 'access'");
    assert.equal((await resolveToken(db, refresh.tokenHash))?.kind, "refresh", "the refresh token keeps kind 'refresh'");
  } finally {
    await db.close();
  }
});

test("each token is bound to exactly one connection: two tokens resolve to their own connections", async () => {
  const db = await freshDb();
  try {
    const connA = randomUUID();
    const connB = randomUUID();
    assert.notEqual(connA, connB, "two connections are distinct");
    const tokA = newToken({ connectionId: connA });
    const tokB = newToken({ connectionId: connB });
    await createToken(db, tokA);
    await createToken(db, tokB);

    assert.equal((await resolveToken(db, tokA.tokenHash))?.connectionId, connA, "token A resolves to connection A");
    assert.equal((await resolveToken(db, tokB.tokenHash))?.connectionId, connB, "token B resolves to connection B");
    assert.notEqual(
      (await resolveToken(db, tokA.tokenHash))?.connectionId,
      connB,
      "token A does not resolve to the other connection",
    );
  } finally {
    await db.close();
  }
});

test("resolveToken returns null for a token hash that matches nothing", async () => {
  const db = await freshDb();
  try {
    await createToken(db, newToken());
    const missing = await resolveToken(db, sha256Hex(`never-minted-${randomUUID()}`));
    assert.equal(missing, null, "an unknown token hash yields null");
  } finally {
    await db.close();
  }
});

// --- AC1: access keys are stored only as hashes and resolve to their connection ----

test("an access key stored by its hash resolves to its connection", async () => {
  const db = await freshDb();
  try {
    const rawKey = `wh_ak_${randomUUID()}`;
    const keyHash = sha256Hex(rawKey);
    const connectionId = randomUUID();
    await createAccessKey(db, { keyHash, connectionId });

    const resolved = await resolveAccessKey(db, keyHash);
    assert.ok(resolved != null, "the access key resolves by its stored hash");
    assert.equal(resolved?.connectionId, connectionId, "an access key hash resolves to its connection");

    const byRaw = await resolveAccessKey(db, rawKey);
    assert.equal(byRaw, null, "the raw access key is not stored; only its hash resolves");
  } finally {
    await db.close();
  }
});

test("resolveAccessKey returns null for a key hash that matches nothing", async () => {
  const db = await freshDb();
  try {
    await createAccessKey(db, newAccessKey());
    const missing = await resolveAccessKey(db, sha256Hex(`never-issued-${randomUUID()}`));
    assert.equal(missing, null, "an unknown access key hash yields null");
  } finally {
    await db.close();
  }
});

// --- AC2: every lookup binds its argument as a parameter (no spliced SQL) -----------

test("resolveToken binds the token hash as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "deadbeef'; DROP TABLE oauth_tokens; --";

  const result = await resolveToken(db, probe);
  assert.equal(result, null, "no row matches (the recording db returns none)");

  assert.equal(db.calls.length, 1, "resolveToken issues exactly one query");
  const call = db.calls[0]!;
  assert.deepEqual(call.values, [probe], "the token hash travels as a bound value");
  assert.ok(call.text.includes("$1"), "the statement uses a placeholder, not an inlined value");
  assert.ok(!call.text.includes(probe), "the value is bound, never concatenated into the SQL text");
  assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
});

test("getClient binds the client id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "https://evil.example/x' OR '1'='1";

  const result = await getClient(db, probe);
  assert.equal(result, null, "no row matches (the recording db returns none)");

  assert.equal(db.calls.length, 1, "getClient issues exactly one query");
  const call = db.calls[0]!;
  assert.deepEqual(call.values, [probe], "the client id travels as a bound value");
  assert.ok(call.text.includes("$1"), "the statement uses a placeholder, not an inlined value");
  assert.ok(!call.text.includes(probe), "the client id is bound, never concatenated into the SQL text");
  assert.ok(!call.text.includes("OR '1'='1"), "no injected condition appears in the statement text");
});

test("resolveAccessKey binds the key hash as a parameter", async () => {
  const db = recordingDb();
  const probe = "x'; DELETE FROM oauth_access_keys; --";

  const result = await resolveAccessKey(db, probe);
  assert.equal(result, null, "no row matches (the recording db returns none)");

  assert.equal(db.calls.length, 1, "resolveAccessKey issues exactly one query");
  const call = db.calls[0]!;
  assert.deepEqual(call.values, [probe], "the key hash travels as a bound value");
  assert.ok(call.text.includes("$1"), "the statement uses a placeholder, not an inlined value");
  assert.ok(!call.text.includes("DELETE FROM"), "no injected statement appears in the SQL text");
});

// --- AC3: end-to-end — a probe stored and looked up cannot alter the query ----------

test("a SQL-injection probe in a client id is stored as data and cannot drop a table", async () => {
  const db = await freshDb();
  try {
    const safe = await createClient(db, {
      clientId: "https://safe.example/client",
      registration: "dcr",
      redirectUris: ["https://safe.example/cb"],
    });
    // A probe client id created through the data-access layer: if it were
    // concatenated rather than bound, the trailing statement would drop a table.
    const probeId = "https://evil.example/x'); DROP TABLE oauth_clients; --";
    const probe = await createClient(db, {
      clientId: probeId,
      registration: "dcr",
      redirectUris: ["https://evil.example/cb"],
    });
    assert.equal(probe.clientId, probeId, "the probe id is stored verbatim as data");

    // Subsequent reads still work — the table survived (the injection was data, not
    // SQL). Proven behaviourally, without naming the table in the test.
    assert.equal((await getClient(db, safe.clientId))?.clientId, "https://safe.example/client");
    const back = await getClient(db, probeId);
    assert.ok(back != null, "the probe id is stored and found as literal data");
    assert.equal(back?.clientId, probeId, "it resolves to the row it was stored against");

    // A classic match-all probe matches nobody — it was bound, not interpreted.
    const matchAll = await getClient(db, "' OR '1'='1' --");
    assert.equal(matchAll, null, "a match-all probe returns no client (bound, not evaluated)");
  } finally {
    await db.close();
  }
});

// --- AC3: a handler on the validation boundary rejects bad input and binds probes ---
//
// A route handler validates external input at the boundary (`parseBody`), then calls
// this task's parameterized data-access. A rejected input maps to a 4xx Response and
// NEVER reaches a query. This handler is a test fixture that EXERCISES the modules —
// it is not an implementation file.

function createRegisterClientHandler(db: Db): (req: Request) => Promise<Response> {
  const schema = z.object({
    clientId: z.string().min(1).max(2000),
    redirectUris: z.array(z.string().max(2000)).max(16),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const { clientId, redirectUris } = await parseBody(schema, req, { maxBytes: 8 * 1024 });
      const client = await createClient(db, { clientId, registration: "dcr", redirectUris });
      return new Response(JSON.stringify({ clientId: client.clientId }), { status: 201 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a
      // test sees the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("a handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createRegisterClientHandler(db);

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("a handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createRegisterClientHandler(db);

  // ~16 KiB body, well over the handler's 8 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ clientId: "https://x.example/" + "a".repeat(16 * 1024), redirectUris: [] })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("a handler rejects a mis-shaped body (wrong types) with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createRegisterClientHandler(db);

  // redirectUris must be an array of strings; a number is a schema violation.
  const res = await handler(jsonRequest(JSON.stringify({ clientId: "https://x.example/c", redirectUris: 7 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("a handler accepts a well-formed registration and persists the client", async () => {
  const db = await freshDb();
  try {
    const handler = createRegisterClientHandler(db);
    const clientId = `https://gemini.example/client-${randomUUID()}`;

    const res = await handler(jsonRequest(JSON.stringify({ clientId, redirectUris: ["https://gemini.example/cb"] })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const stored = await getClient(db, clientId);
    assert.ok(stored != null, "a valid registration creates a client");
    assert.deepEqual(stored?.redirectUris, ["https://gemini.example/cb"], "the redirect URIs are persisted");
  } finally {
    await db.close();
  }
});

test("a handler cannot be SQL-injected: a probe client id is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const handler = createRegisterClientHandler(db);
    const probeId = "https://evil.example/x'); DROP TABLE oauth_clients; --";

    const res = await handler(jsonRequest(JSON.stringify({ clientId: probeId, redirectUris: [] })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) id is accepted");
    const stored = await getClient(db, probeId);
    assert.ok(stored != null, "the probe is stored as an ordinary client id value");
    assert.equal(stored?.clientId, probeId, "it is stored verbatim, not interpreted as SQL");

    // The table survived: a fresh registration still works after the probe.
    const after = `https://after.example/client-${randomUUID()}`;
    const res2 = await handler(jsonRequest(JSON.stringify({ clientId: after, redirectUris: [] })));
    assert.ok(res2.status >= 200 && res2.status < 300, "the table survived — another client registers");
    assert.ok((await getClient(db, after)) != null, "the later client is readable");
  } finally {
    await db.close();
  }
});

// --- AC2: the migration applies and a second run changes nothing --------------------

test("the oauth migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    // 0009_oauth applied: the OAuth tables exist, proven behaviourally — a store
    // round-trip only succeeds if the tables are there (never by grepping the SQL).
    const code = newAuthCode();
    await createAuthCode(db, code);
    assert.equal(
      (await getAuthCode(db, code.codeHash))?.connectionId,
      code.connectionId,
      "a code round-trips, so the oauth tables exist after the project migrations",
    );

    // The project migration set includes the oauth migration (its recorded name is
    // the task's named deliverable, stable once applied).
    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0009_oauth"),
      "db/migrations/0009_oauth.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0009's CREATE would throw "already exists", so an empty result AND
    // no throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
