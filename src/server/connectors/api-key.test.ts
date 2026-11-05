// E09-S07 — API-key connections (`src/server/connectors/api-key.ts`).
//
// RED-first: the module does not exist yet, so importing `./api-key` throws and every
// test here fails at load — that absence IS the point of test-first. As the TESTER I
// must NOT create or edit the module (or any implementation/source file) to make these
// pass; the builder writes `api-key.ts` afterwards to this contract.
//
// WHY this exists (task E09-S07; design §7 "Connector engine"): most of the catalogue
// connects with the person's OWN key or personal token (`auth_kind: api_key | basic`;
// ≥ 60 such entries). This is the save-key path that
//   (1) stores the person's key DEK-encrypted on a NEW connection
//       (`../db/connections`, `../crypto/envelope`), and
//   (2) when the catalogue entry declares an optional `verify` request, RUNS it first —
//       a successful verify marks the connection "connected", a failing one marks it
//       "error" with a plain, key-free reason — so a key is confirmed to work before it
//       is relied on.
// The provider HOST is taken ONLY from the catalogue entry's `base_url` — never a value
// from a caller (CLAUDE.md security: "Connector requests never take a host from the
// caller"). The person's key is injected into the entry's header TEMPLATE
// (`auth.header`, design §7 — "header template like `Authorization: Bearer {key}`").
//
// These tests pin BEHAVIOUR (the connection stored/returned, the verify request sent,
// the status + reason) — never the source text of any file; a later rename that
// preserves behaviour must not redden them. The HTTP + time sources are injected seams
// (conventions: external services sit behind fakes; tests never touch the network) — a
// recording `fetch` stands in for the provider's verify endpoint (in production this is
// the SSRF-guarded fetch), a fixed clock freezes time. The db is the real in-memory
// PGlite with the real migrations (`../../test/db`), or a recording stand-in that proves
// what reached the query layer.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface ApiKeyClientDeps {        // injected seams
//     db: Db;                           // the parameterizing data seam
//     clock: Clock;                     // time (connectedAt), never Date.now()
//     fetch: typeof fetch;              // the HTTP seam (SSRF-guarded fetch in prod)
//   }
//
//   interface SaveApiKeyInput {
//     entry: CatalogueEntry;            // the api_key/basic catalogue entry (host + template
//                                       // + optional verify come from HERE, never a caller)
//     userId: string;                   // the SESSION's id (never a client value)
//     accountLabel: string;             // the account shown in the UI
//     apiKey: string;                   // the person's own key/token (stored encrypted)
//     dek: Uint8Array;                  // the owner's 256-bit data key (already unwrapped)
//   }
//
//   interface SaveApiKeyResult {
//     connection: Connection;           // the created connection — WITHOUT credentials
//     reason?: string;                  // a plain, key-free reason, present IFF the verify
//                                       // failed (status === "error"); absent on success
//   }
//
//   saveApiKeyConnection(input, deps): Promise<SaveApiKeyResult>
//     • Stores `apiKey` DEK-encrypted on a NEW connection owned by `userId`
//       (connectorId = entry.id, the given accountLabel). The key is NEVER part of the
//       returned Connection and never stored in a raw column.
//     • No `entry.verify` → no HTTP request is made; status defaults to "connected".
//     • `entry.verify` present → a verify request is sent to the ENTRY's base_url host
//       (host from the entry only) at `verify.path`, method `verify.method ?? "GET"`,
//       carrying the person's key in the entry's header template. A 2xx response →
//       status "connected" (no reason). A non-2xx response OR a transport failure →
//       status "error" + a plain reason that does NOT contain the key.
//
// Scopes of "absence" assertions are kept narrow to the exact surface under test (the
// key legitimately lives, encrypted, in a column and decrypted behind
// getConnectionCredentials — so the plaintext-leak scan is the raw columns only; the
// no-key-in-the-connection scan is the one returned object only).
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (isolated in-memory PGlite), so tests share no
// state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import {
  saveApiKeyConnection,
  type ApiKeyClientDeps,
  type SaveApiKeyResult,
} from "./api-key";
import { createUser } from "../db/users";
import {
  getConnectionById,
  getConnectionCredentials,
  listConnectionsForUser,
  type Connection,
} from "../db/connections";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";
import type { CatalogueEntry } from "../../domain/catalogue/schema";

// --- fixtures ---------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// An instant deliberately in the past relative to the wall clock, so anything that
// wrongly read Date.now() instead of the injected clock would diverge here.
const T0 = new Date("2026-05-01T10:00:00.000Z");
const CLOCK = fixedClock(T0);

// The person's own key/token — the value that must be stored encrypted and presented to
// the provider at verify, and must NEVER leak into a raw column, the returned connection
// or a failure reason. A distinctive value so a leak scan is unambiguous.
const PERSON_KEY = "sk-PERSON-KEY-9f8e7d6c5b4a-SECRET";

// An api_key entry WITH a verify request (host = api.acme.example). The verify endpoint
// and the header template come from HERE; the key is injected into the template.
const ACME_ENTRY: CatalogueEntry = {
  id: "acme-notes",
  name: "Acme Notes",
  aliases: ["acme"],
  category: "notes",
  auth_kind: "api_key",
  base_url: "https://api.acme.example",
  auth: { header: "Authorization: Bearer {api_key}" },
  instructions: "Create a key in Acme settings. See https://docs.acme.example/keys.",
  verify: { path: "/v1/whoami" },
};

// An api_key entry WITHOUT a verify request: saving a key for it makes NO HTTP request
// and lands "connected" directly.
const PLAIN_ENTRY: CatalogueEntry = {
  id: "plainkey",
  name: "Plain Key Service",
  aliases: ["plainkey"],
  category: "developer-tools",
  auth_kind: "api_key",
  base_url: "https://api.plain.example",
  auth: { header: "X-API-Key: {api_key}" },
  instructions: "Create a key. See https://docs.plain.example/keys.",
};

// A `basic` entry WITH a verify request on a DIFFERENT host (api.other.example), used to
// show (a) the basic kind takes the same path and (b) the verify host tracks the ENTRY,
// not a fixed or caller value.
const BASIC_ENTRY: CatalogueEntry = {
  id: "basic-host",
  name: "Basic Host",
  aliases: ["basichost"],
  category: "files",
  auth_kind: "basic",
  base_url: "https://api.other.example",
  auth: { header: "Authorization: Basic {api_key}" },
  instructions: "Create an app password. See https://docs.other.example/basic.",
  verify: { path: "/account" },
};

const ACME_HOST = new URL(ACME_ENTRY.base_url).host;
const OTHER_HOST = new URL(BASIC_ENTRY.base_url).host;

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a layer
// up; this module only ever receives the already-unwrapped bytes.
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque base64; this module never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

function makeDeps(db: Db, clock: Clock, fetchFn: typeof globalThis.fetch): ApiKeyClientDeps {
  return { db, clock, fetch: fetchFn };
}

// --- the provider verify endpoint, faked ------------------------------------------

// What the module sent to the verify endpoint, captured for inspection (host, method,
// the header-injected key).
interface SeenRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

function bodyToString(body: BodyInit | null | undefined): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return String(body);
}

// A recording `fetch` stand-in: records every request and returns (or throws) whatever
// `respond` yields — a canned provider response, or a thrown error to simulate a
// transport failure. No network.
function recordingFetch(respond: () => Response): {
  fetch: typeof globalThis.fetch;
  requests: SeenRequest[];
} {
  const requests: SeenRequest[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const headers = new Headers((init?.headers as HeadersInit | undefined) ?? undefined);
    requests.push({
      url,
      method: String(init?.method ?? "GET"),
      headers,
      body: bodyToString(init?.body),
    });
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch: fn, requests };
}

const okResponse = (): Response => new Response("", { status: 200 });
const unauthorizedResponse = (): Response =>
  new Response("unauthorized", { status: 401, statusText: "Unauthorized" });

// The whole of what a captured request reveals, for narrow "a secret must not appear"
// scans (a key could ride in a header, the URL, or a body — scan all).
function requestText(requests: SeenRequest[]): string {
  return requests
    .map((r) => {
      const headersText = [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
      return [r.url, r.method, headersText, r.body].join("\n");
    })
    .join("\n");
}

// --- a recording db seam (proves what reached the query layer) ---------------------

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

// Assert a probe reached the query layer as a BOUND value and never as spliced SQL text
// (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// Whether a relation of this exact name exists — a non-throwing probe scoped to the one
// table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Every string cell of the connections table, for a narrow at-rest leak scan.
async function rawConnectionsText(db: Db): Promise<string> {
  const all = await db.query("SELECT * FROM connections");
  const parts: string[] = [];
  for (const row of all.rows) {
    for (const cell of Object.values(row)) {
      if (typeof cell === "string") parts.push(cell);
    }
  }
  return parts.join("\n");
}

// Assert a returned Connection carries NO credentials, scoped to the one object: no
// `credentials` key and no key value folded in. The same key lives (encrypted) in a raw
// column — this is the client-facing shape only (AC2).
function assertNoKeyInConnection(connection: Connection, key: string): void {
  const obj = connection as unknown as Record<string, unknown>;
  assert.ok(!("credentials" in obj), "the connection shape carries no credentials field");
  assert.ok(!("apiKey" in obj) && !("api_key" in obj), "the connection shape carries no key field");
  assert.ok(!JSON.stringify(connection).includes(key), "no key value is folded into the connection");
}

// ===========================================================================
// AC1 — saving a key stores it DEK-encrypted; with no verify request the connection is
// "connected" directly.
// ===========================================================================

test("saveApiKeyConnection stores the key DEK-encrypted on a new connection (no verify → connected)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "save");
    const dek = freshDek();
    const f = recordingFetch(okResponse);

    const { connection, reason } = await saveApiKeyConnection(
      { entry: PLAIN_ENTRY, userId, accountLabel: "oren@plain", apiKey: PERSON_KEY, dek },
      makeDeps(db, CLOCK, f.fetch),
    );

    // The returned connection: owned, for this connector, with the label and a status.
    assert.equal(connection.userId, userId, "the connection is owned by the session user");
    assert.equal(connection.connectorId, PLAIN_ENTRY.id, "the connector is the entry's id");
    assert.equal(connection.accountLabel, "oren@plain", "the account label is recorded");
    assert.equal(connection.status, "connected", "with no verify request, the connection is connected");
    assert.equal(reason, undefined, "a connected result carries no failure reason");
    assert.equal(new Date(connection.connectedAt).getTime(), T0.getTime(), "connectedAt is the injected clock");
    assertNoKeyInConnection(connection, PERSON_KEY);

    // No verify declared → no HTTP request is made at all.
    assert.equal(f.requests.length, 0, "an entry with no verify request makes no outbound call");

    // It is now one of the person's connections.
    const listed = await listConnectionsForUser(db, userId);
    assert.equal(listed.length, 1, "the connection is persisted and listed");
    assert.equal(listed[0]!.id, connection.id, "the listed connection is the one just created");

    // The key round-trips only under the owner's DEK.
    const creds = await getConnectionCredentials(db, userId, connection.id, dek);
    assert.ok(JSON.stringify(creds).includes(PERSON_KEY), "the key is stored and decrypts under the DEK");
  } finally {
    await db.close();
  }
});

test("the saved key is stored only encrypted — the plaintext never appears in a raw column", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "atrest");
    const dek = freshDek();
    const f = recordingFetch(okResponse);

    const { connection } = await saveApiKeyConnection(
      { entry: PLAIN_ENTRY, userId, accountLabel: "oren@plain", apiKey: PERSON_KEY, dek },
      makeDeps(db, CLOCK, f.fetch),
    );

    // Scoped narrowly to the connections table: the raw columns must not hold the
    // plaintext key (it is DEK-encrypted), yet it decrypts behind the accessor.
    const raw = await rawConnectionsText(db);
    assert.ok(!raw.includes(PERSON_KEY), "the key is not stored in plaintext in any column");

    const creds = await getConnectionCredentials(db, userId, connection.id, dek);
    assert.ok(JSON.stringify(creds).includes(PERSON_KEY), "but it decrypts under the owner's DEK");
  } finally {
    await db.close();
  }
});

test("the saved key belongs to its owner only — another person cannot read the connection", async () => {
  const db = await freshDb();
  try {
    const owner = await makeUser(db, "owner");
    const other = await makeUser(db, "other");
    const dek = freshDek();
    const f = recordingFetch(okResponse);

    const { connection } = await saveApiKeyConnection(
      { entry: PLAIN_ENTRY, userId: owner, accountLabel: "oren@plain", apiKey: PERSON_KEY, dek },
      makeDeps(db, CLOCK, f.fetch),
    );

    assert.ok(await getConnectionById(db, owner, connection.id), "the owner can read their connection");
    assert.equal(
      await getConnectionById(db, other, connection.id),
      null,
      "another person cannot read it (member-scoped by the session's user id)",
    );
    assert.deepEqual(await listConnectionsForUser(db, other), [], "and it is not in another person's list");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — a declared verify request runs before the connection is marked connected: a
// 2xx marks it connected, carrying the person's key in the entry's header template to
// the ENTRY's host.
// ===========================================================================

test("a successful verify (2xx) marks the connection connected and presents the key at the entry's host", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "verify-ok");
    const dek = freshDek();
    const f = recordingFetch(okResponse);

    const { connection, reason } = await saveApiKeyConnection(
      { entry: ACME_ENTRY, userId, accountLabel: "oren@acme", apiKey: PERSON_KEY, dek },
      makeDeps(db, CLOCK, f.fetch),
    );

    assert.equal(connection.status, "connected", "a successful verify marks the connection connected");
    assert.equal(reason, undefined, "a successful verify carries no failure reason");
    assertNoKeyInConnection(connection, PERSON_KEY);

    // Exactly one verify request, to the ENTRY's host, at the verify path, GET by default.
    assert.equal(f.requests.length, 1, "exactly one verify request was made");
    const sent = f.requests[0]!;
    const u = new URL(sent.url);
    assert.equal(u.host, ACME_HOST, "the verify request goes to the catalogue entry's host");
    assert.ok(u.pathname.includes("/v1/whoami"), "…at the entry's verify path");
    assert.equal(sent.method.toUpperCase(), "GET", "the default verify method is GET");

    // The person's key is injected into the entry's header template (Authorization: Bearer
    // {api_key}) — present in the Authorization header, never leaked into the URL.
    const auth = sent.headers.get("authorization");
    assert.ok(auth !== null, "the verify request carries the entry's templated auth header");
    assert.ok(auth!.includes("Bearer"), "the header follows the template's scheme");
    assert.ok(auth!.includes(PERSON_KEY), "the person's key is injected into the header template");
    assert.ok(!sent.url.includes(PERSON_KEY), "the key is not leaked into the verify URL");

    // The connection is persisted with the key decryptable under the owner's DEK.
    const creds = await getConnectionCredentials(db, userId, connection.id, dek);
    assert.ok(JSON.stringify(creds).includes(PERSON_KEY), "the verified key is stored and decrypts under the DEK");
  } finally {
    await db.close();
  }
});

test("the verify host tracks the ENTRY, not a fixed or caller value — a basic entry verifies against its own host", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "verify-host");
    const dek = freshDek();

    const acmeFetch = recordingFetch(okResponse);
    await saveApiKeyConnection(
      { entry: ACME_ENTRY, userId, accountLabel: "oren@acme", apiKey: PERSON_KEY, dek },
      makeDeps(db, CLOCK, acmeFetch.fetch),
    );

    const basicFetch = recordingFetch(okResponse);
    const { connection } = await saveApiKeyConnection(
      { entry: BASIC_ENTRY, userId, accountLabel: "oren@other", apiKey: PERSON_KEY, dek },
      makeDeps(db, CLOCK, basicFetch.fetch),
    );

    assert.equal(new URL(acmeFetch.requests[0]!.url).host, ACME_HOST, "the api_key entry verifies at its host");
    assert.equal(new URL(basicFetch.requests[0]!.url).host, OTHER_HOST, "the basic entry verifies at its host");
    assert.notEqual(ACME_HOST, OTHER_HOST, "the host tracks the entry, not a fixed value");
    assert.equal(connection.status, "connected", "the basic-kind key is verified and connected");

    // The basic entry's template (Authorization: Basic {api_key}) carries the key too.
    const auth = basicFetch.requests[0]!.headers.get("authorization");
    assert.ok(auth !== null && auth.includes("Basic") && auth.includes(PERSON_KEY), "the basic header carries the key");
  } finally {
    await db.close();
  }
});

test("a caller-controlled key cannot redirect the verify request — the host comes only from the entry", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "verify-noredirect");
    const dek = freshDek();
    const f = recordingFetch(okResponse);

    // A key shaped like a URL / host: it must ride in the header as an opaque value and
    // never influence where the verify request is sent.
    const malicious = "http://169.254.169.254/latest/meta-data/";
    await saveApiKeyConnection(
      { entry: ACME_ENTRY, userId, accountLabel: "oren@acme", apiKey: malicious, dek },
      makeDeps(db, CLOCK, f.fetch),
    );

    assert.equal(f.requests.length, 1, "exactly one verify request was made");
    assert.equal(
      new URL(f.requests[0]!.url).host,
      ACME_HOST,
      "the verify host is still the entry's — a caller value never sets it",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — a failing verify marks the connection "error" with a plain, key-free reason; the
// key is still stored DEK-encrypted either way.
// ===========================================================================

test("a failing verify (non-2xx) marks the connection error with a plain reason, and still stores the key encrypted", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "verify-401");
    const dek = freshDek();
    const f = recordingFetch(unauthorizedResponse);

    const { connection, reason } = await saveApiKeyConnection(
      { entry: ACME_ENTRY, userId, accountLabel: "oren@acme", apiKey: PERSON_KEY, dek },
      makeDeps(db, CLOCK, f.fetch),
    );

    assert.equal(connection.status, "error", "a rejected key marks the connection error");
    assert.equal(typeof reason, "string", "a failing verify yields a reason");
    assert.ok((reason ?? "").trim().length > 0, "the reason is a non-empty, plain string");
    assert.ok(!(reason ?? "").includes(PERSON_KEY), "the reason never contains the person's key (redacted/plain)");
    assertNoKeyInConnection(connection, PERSON_KEY);

    // The connection is persisted (error status) and the key is still stored encrypted,
    // decryptable under the owner's DEK so the person can retry.
    const stored = await getConnectionById(db, userId, connection.id);
    assert.equal(stored!.status, "error", "the stored status is error");
    const raw = await rawConnectionsText(db);
    assert.ok(!raw.includes(PERSON_KEY), "the key is still stored encrypted, never in plaintext");
    const creds = await getConnectionCredentials(db, userId, connection.id, dek);
    assert.ok(JSON.stringify(creds).includes(PERSON_KEY), "the key decrypts under the owner's DEK");
  } finally {
    await db.close();
  }
});

test("a verify transport failure marks the connection error with a plain, key-free reason", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "verify-throw");
    const dek = freshDek();
    const f = recordingFetch(() => {
      throw new Error("connect ECONNREFUSED");
    });

    const { connection, reason } = await saveApiKeyConnection(
      { entry: ACME_ENTRY, userId, accountLabel: "oren@acme", apiKey: PERSON_KEY, dek },
      makeDeps(db, CLOCK, f.fetch),
    );

    assert.equal(f.requests.length, 1, "a verify request was attempted");
    assert.equal(connection.status, "error", "a transport failure marks the connection error");
    assert.ok((reason ?? "").trim().length > 0, "a transport failure yields a plain reason");
    assert.ok(!(reason ?? "").includes(PERSON_KEY), "the reason never contains the person's key");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
// `../http/validate` boundary rejects malformed / oversized / missing / mis-typed input
// with a 4xx BEFORE any query or verify request runs, takes the user id from the SESSION
// (never the body), refuses an unknown connector (host comes only from the catalogue),
// and a SQL-injection probe routed through the save path is BOUND as a parameter.
//
// The handler below is a TEST FIXTURE that exercises the real validation boundary and
// this task's save path — the intended usage, not an implementation file. (The route
// `route.ts` exports only its HTTP verbs; this factory lives beside it — a sibling
// seam — per the App-Router rules.)
// ===========================================================================

function saveKeyHandler(opts: {
  deps: ApiKeyClientDeps;
  dek: Uint8Array;
  sessionUserId: string;
  resolveEntry: (connectorId: string) => CatalogueEntry | undefined;
}): (req: Request) => Promise<Response> {
  // The body carries the connector slug, the chosen account label and the person's key.
  // The user id comes from the SESSION, never the body. Lengths are capped so an absurd
  // value is rejected, yet generous enough that a probe can still REACH the query.
  const schema = z.object({
    connectorId: z.string().min(1).max(64),
    accountLabel: z.string().min(1).max(200),
    apiKey: z.string().min(1).max(4096),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 8 * 1024 });
      // The host comes ONLY from the catalogue: an unknown connector is refused here,
      // before the save path is ever asked to reach a provider.
      const entry = opts.resolveEntry(body.connectorId);
      if (!entry) throw new HttpError(400, "unknown connector");
      const { connection, reason } = await saveApiKeyConnection(
        {
          entry,
          userId: opts.sessionUserId,
          accountLabel: body.accountLabel,
          apiKey: body.apiKey,
          dek: opts.dek,
        },
        opts.deps,
      );
      return new Response(JSON.stringify({ id: connection.id, status: connection.status, reason }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
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
  return new Request("https://warthog.com.au/connections/key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

// The catalogue the handler resolves against: only the no-verify entry (so the
// validation-boundary tests need no fetch to succeed), resolved by its id.
const CATALOGUE = (id: string): CatalogueEntry | undefined =>
  id === PLAIN_ENTRY.id ? PLAIN_ENTRY : undefined;

test("the handler rejects malformed JSON with a 4xx and reaches neither a query nor a verify request", async () => {
  const db = recordingDb();
  const f = recordingFetch(okResponse);
  const handler = saveKeyHandler({
    deps: makeDeps(db, CLOCK, f.fetch),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
  assert.equal(f.requests.length, 0, "malformed input must never reach a verify request");
});

test("the handler rejects an oversized body with a 4xx and reaches neither a query nor a verify request", async () => {
  const db = recordingDb();
  const f = recordingFetch(okResponse);
  const handler = saveKeyHandler({
    deps: makeDeps(db, CLOCK, f.fetch),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  // ~20 KiB key blob, well over the handler's 8 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest(
      JSON.stringify({ connectorId: PLAIN_ENTRY.id, accountLabel: "oren@plain", apiKey: "a".repeat(20 * 1024) }),
    ),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
  assert.equal(f.requests.length, 0, "an oversized body must never reach a verify request");
});

test("the handler rejects a body missing the key with a 4xx", async () => {
  const db = recordingDb();
  const f = recordingFetch(okResponse);
  const handler = saveKeyHandler({
    deps: makeDeps(db, CLOCK, f.fetch),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  // No apiKey — a key cannot be saved without one.
  const res = await handler(
    jsonRequest(JSON.stringify({ connectorId: PLAIN_ENTRY.id, accountLabel: "oren@plain" })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
  assert.equal(f.requests.length, 0, "a schema violation must never reach a verify request");
});

test("the handler rejects a mis-typed field with a 4xx", async () => {
  const db = recordingDb();
  const f = recordingFetch(okResponse);
  const handler = saveKeyHandler({
    deps: makeDeps(db, CLOCK, f.fetch),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  // apiKey must be a string — a number is a schema violation, rejected before any query.
  const res = await handler(
    jsonRequest(JSON.stringify({ connectorId: PLAIN_ENTRY.id, accountLabel: "oren@plain", apiKey: 12345 })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
  assert.equal(f.requests.length, 0, "a mis-typed field must never reach a verify request");
});

test("the handler refuses an unknown connector with a 4xx — the host comes only from the catalogue", async () => {
  const db = recordingDb();
  const f = recordingFetch(okResponse);
  const handler = saveKeyHandler({
    deps: makeDeps(db, CLOCK, f.fetch),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  const res = await handler(
    jsonRequest(JSON.stringify({ connectorId: "not-in-the-catalogue", accountLabel: "x", apiKey: PERSON_KEY })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(f.requests.length, 0, "an unknown connector never produces an outbound request");
  assert.equal(db.calls.length, 0, "an unknown connector never reaches a query");
});

test("the handler accepts a well-formed save and records the connection for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const f = recordingFetch(okResponse);
    const handler = saveKeyHandler({
      deps: makeDeps(db, CLOCK, f.fetch),
      dek,
      sessionUserId: userId,
      resolveEntry: CATALOGUE,
    });

    const res = await handler(
      jsonRequest(JSON.stringify({ connectorId: PLAIN_ENTRY.id, accountLabel: "oren@plain", apiKey: PERSON_KEY })),
    );

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const payload = (await res.json()) as { id: string; status: string };
    assert.equal(payload.status, "connected", "a no-verify save reports connected");

    const stored = await getConnectionById(db, userId, payload.id);
    assert.ok(stored, "a valid save is persisted for the session user");
    assert.equal(stored!.connectorId, PLAIN_ENTRY.id, "with the entry's connector id");
    assert.equal(stored!.accountLabel, "oren@plain", "and the submitted account label");

    const creds = await getConnectionCredentials(db, userId, payload.id, dek);
    assert.ok(JSON.stringify(creds).includes(PERSON_KEY), "the saved key round-trips under the DEK");

    // The key is never handed back to the client in the response body.
    assert.ok(!JSON.stringify(payload).includes(PERSON_KEY), "the response never returns the stored key (AC2)");
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const dek = freshDek();
    const f = recordingFetch(okResponse);
    const handler = saveKeyHandler({
      deps: makeDeps(db, CLOCK, f.fetch),
      dek,
      sessionUserId: sessionUser,
      resolveEntry: CATALOGUE,
    });

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(
      jsonRequest(
        JSON.stringify({ userId: attacker, connectorId: PLAIN_ENTRY.id, accountLabel: "oren@plain", apiKey: PERSON_KEY }),
      ),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal((await listConnectionsForUser(db, sessionUser)).length, 1, "recorded under the SESSION user");
    assert.deepEqual(
      await listConnectionsForUser(db, attacker),
      [],
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe routed through the save path is BOUND as a parameter, never spliced into the SQL", async () => {
  const db = recordingDb();
  const f = recordingFetch(okResponse);
  const probe = "oren'); DROP TABLE connections; --";
  const handler = saveKeyHandler({
    deps: makeDeps(db, CLOCK, f.fetch),
    dek: freshDek(),
    sessionUserId: "session-user",
    resolveEntry: CATALOGUE,
  });

  // A valid-shaped (if nasty) account label: it passes validation and the probe reaches
  // the INSERT as a value (the no-verify entry needs no provider round-trip).
  await handler(
    jsonRequest(JSON.stringify({ connectorId: PLAIN_ENTRY.id, accountLabel: probe, apiKey: PERSON_KEY })),
  );

  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe account label is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const dek = freshDek();
    const f = recordingFetch(okResponse);
    const probe = "oren'); DROP TABLE connections; --";
    const handler = saveKeyHandler({
      deps: makeDeps(db, CLOCK, f.fetch),
      dek,
      sessionUserId: userId,
      resolveEntry: CATALOGUE,
    });

    const res = await handler(
      jsonRequest(JSON.stringify({ connectorId: PLAIN_ENTRY.id, accountLabel: probe, apiKey: PERSON_KEY })),
    );
    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "connections"), true, "the connections table must still exist");

    const { id } = (await res.json()) as { id: string };
    const stored = await getConnectionById(db, userId, id);
    assert.equal(stored!.accountLabel, probe, "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 [obligation:secrets-from-env] (INV-103) — config is injected (read from env only
// by src/server/config.ts); this module reads no process.env and folds no ambient secret
// into the verify request, the stored key, or the returned connection. Shown
// behaviourally: the INJECTED key is what the verify header carries, and a decoy secret
// planted in the environment never appears anywhere the save path produces.
// ===========================================================================

const DECOY_SECRET = "env-decoy-SECRET-must-never-be-used";

test("the verify request carries the INJECTED key, and no ambient env secret reaches the request, the connection, or a stored column", async () => {
  const prev = process.env.WARTHOG_CONNECTOR_SECRET;
  process.env.WARTHOG_CONNECTOR_SECRET = DECOY_SECRET;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac4-secrets");
    const dek = freshDek();
    const f = recordingFetch(okResponse);

    const { connection } = await saveApiKeyConnection(
      { entry: ACME_ENTRY, userId, accountLabel: "oren@acme", apiKey: PERSON_KEY, dek },
      makeDeps(db, CLOCK, f.fetch),
    );

    // The verify header carries the injected key, never an ambient env value.
    const sent = requestText(f.requests);
    assert.ok(sent.includes(PERSON_KEY), "the injected key is what the verify request presents");
    assert.ok(!sent.includes(DECOY_SECRET), "no ambient env secret is sent in the verify request");

    // The decoy never lands in the returned connection or a stored column.
    assert.ok(!JSON.stringify(connection).includes(DECOY_SECRET), "the decoy never lands in the returned connection");
    const raw = await rawConnectionsText(db);
    assert.ok(!raw.includes(DECOY_SECRET), "the decoy never lands in a stored column");
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_CONNECTOR_SECRET;
    else process.env.WARTHOG_CONNECTOR_SECRET = prev;
  }
});
