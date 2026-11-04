// E06-S03 — Client registration, part 2: the DCR (RFC 7591) `/oauth/register`
// endpoint.
//
// RED-first: the route's handler does not exist yet, so every test here fails at
// import until the builder writes it. That absence IS the point of test-first — do
// not implement anything to make these pass.
//
// Seam note: an App-Router `route.ts` may export ONLY the known route keys (the HTTP
// verbs + config); `next build` rejects any other export (OBS-025). So the testable
// injection seam — a handler factory that takes an explicit `db` — lives in a SIBLING
// module, `handler.ts`, which `route.ts` imports and wires before exporting `POST`.
// The task's Touches list only `route.ts`; the sibling handler is the seam that keeps
// the entry thin and testable, so these tests import it directly.
//
// Location note: this TEST file lives beside the OAuth server code (as the E06-S02
// metadata tests do) and imports the handler by path; the gate's discovery glob
// (`src/**/*.test.ts`) finds it here, and ESM import resolution handles the relative
// path to `src/app/oauth/register/handler.ts` fine.
//
// These tests pin BEHAVIOUR (the HTTP response a POST produces and the stored state
// it leaves behind), never source text — a later rename that preserves behaviour must
// not redden them. The validation boundary (`../http/validate`) and data access
// (`./store`) are already built; this task composes them behind the endpoint.
//
// The contract this task defines (the builder implements exactly this):
//
//   createRegisterHandler({ db }): (request: Request) => Promise<Response>
//     • POST with a JSON body { redirect_uris: string[] }:
//         - every redirect_uri must satisfy the redirect rule (https anywhere, or
//           http://localhost / http://127.0.0.1 on any port); otherwise the whole
//           request is refused with a 4xx and nothing is stored.
//         - on success the server ISSUES a client_id (the caller does not choose it),
//           stores the client as a `dcr` registration, and returns a 201 whose body
//           carries `client_id` and `redirect_uris`.
//     • Malformed, oversized or mis-shaped input is rejected with a 4xx at the
//       validation boundary before any query runs (INV-102 / validate-and-parameterize).
//
// Acceptance criteria → tests (AC2): "DCR requires https redirect URIs (or
// http://localhost or 127.0.0.1 on any port) and rejects others".
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createRegisterHandler } from "../../app/oauth/register/handler";
import { getClient } from "./store";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";

// A db seam stand-in that records every call instead of running it, so a test can
// prove a rejected request NEVER reached a query. It satisfies the `Db` shape
// structurally (query + close) and returns no rows.
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

function registerRequest(body: string): Request {
  return new Request("https://warthog.com.au/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function is4xx(status: number): boolean {
  return status >= 400 && status < 500;
}

// --- AC2: a well-formed registration with https redirect URIs is accepted -----------

test("registers a client with https redirect URIs, returning a server-issued client_id", async () => {
  const db = await freshDb();
  try {
    const handler = createRegisterHandler({ db });
    const redirectUris = [
      `https://gemini.example/cb-${randomUUID()}`,
      "https://gemini.example/cb2",
    ];

    const res = await handler(registerRequest(JSON.stringify({ redirect_uris: redirectUris })));

    assert.equal(res.status, 201, "RFC 7591 registration returns 201 Created");
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(typeof body.client_id, "string", "the response carries a client_id");
    assert.ok((body.client_id as string).length > 0, "the issued client_id is non-empty");
    assert.deepEqual(body.redirect_uris, redirectUris, "the response echoes the redirect URIs");

    const stored = await getClient(db, body.client_id as string);
    assert.ok(stored != null, "the registration persists a client");
    assert.equal(stored?.registration, "dcr", "a DCR registration is stored as 'dcr'");
    assert.deepEqual(stored?.redirectUris, redirectUris, "the redirect URIs are persisted");
  } finally {
    await db.close();
  }
});

test("accepts http://localhost and http://127.0.0.1 redirect URIs (any port)", async () => {
  const db = await freshDb();
  try {
    const handler = createRegisterHandler({ db });
    const redirectUris = [
      "http://localhost:3000/callback",
      "http://127.0.0.1:52017/callback",
    ];

    const res = await handler(registerRequest(JSON.stringify({ redirect_uris: redirectUris })));

    assert.ok(res.ok, `expected a 2xx for local redirect URIs, got ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const stored = await getClient(db, body.client_id as string);
    assert.ok(stored != null, "the local-redirect registration persists a client");
    assert.deepEqual(stored?.redirectUris, redirectUris, "the local redirect URIs are persisted");
  } finally {
    await db.close();
  }
});

test("each registration issues a distinct client_id (the server mints the id)", async () => {
  const db = await freshDb();
  try {
    const handler = createRegisterHandler({ db });

    const first = (await (
      await handler(registerRequest(JSON.stringify({ redirect_uris: ["https://one.example/cb"] })))
    ).json()) as Record<string, unknown>;
    const second = (await (
      await handler(registerRequest(JSON.stringify({ redirect_uris: ["https://two.example/cb"] })))
    ).json()) as Record<string, unknown>;

    assert.notEqual(
      first.client_id,
      second.client_id,
      "two registrations must not collide on a client_id",
    );
    assert.ok((await getClient(db, first.client_id as string)) != null, "the first client persists");
    assert.ok((await getClient(db, second.client_id as string)) != null, "the second client persists");
  } finally {
    await db.close();
  }
});

// --- AC2: disallowed redirect URIs are rejected and nothing is stored ---------------

const disallowedRedirectUris = [
  "http://example.com/cb", // http to a non-local host
  "http://10.0.0.1/cb", // private-IP http host
  "http://169.254.169.254/cb", // link-local http host
  "ftp://localhost/cb", // not http(s)
  "http://localhost.evil.com/cb", // "localhost" is only a subdomain label here
];

for (const uri of disallowedRedirectUris) {
  test(`rejects a registration whose redirect URI is disallowed and stores nothing: ${uri}`, async () => {
    const db = recordingDb();
    const handler = createRegisterHandler({ db });

    const res = await handler(registerRequest(JSON.stringify({ redirect_uris: [uri] })));

    assert.ok(is4xx(res.status), `expected a 4xx for ${uri}, got ${res.status}`);
    assert.equal(db.calls.length, 0, "a disallowed redirect URI must never reach a query");
  });
}

test("rejects the whole request when any redirect URI is disallowed (all-or-nothing)", async () => {
  const db = recordingDb();
  const handler = createRegisterHandler({ db });

  // One allowed, one disallowed — the registration must be refused as a whole.
  const res = await handler(
    registerRequest(
      JSON.stringify({ redirect_uris: ["https://ok.example/cb", "http://evil.example/cb"] }),
    ),
  );

  assert.ok(is4xx(res.status), `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mixed list with any bad URI must store nothing");
});

// --- INV-102 / validate-and-parameterize: bad input is rejected before any query ---

test("rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createRegisterHandler({ db });

  const res = await handler(registerRequest("{ not valid json"));

  assert.ok(is4xx(res.status), `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createRegisterHandler({ db });

  // ~2 MiB body — over any reasonable per-route cap, rejected by size before parse.
  const res = await handler(
    registerRequest(
      JSON.stringify({ redirect_uris: ["https://x.example/" + "a".repeat(2 * 1024 * 1024)] }),
    ),
  );

  assert.ok(is4xx(res.status), `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("rejects a mis-shaped body (redirect_uris not an array) with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createRegisterHandler({ db });

  const res = await handler(registerRequest(JSON.stringify({ redirect_uris: "https://x.example/cb" })));

  assert.ok(is4xx(res.status), `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("rejects a body missing redirect_uris with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createRegisterHandler({ db });

  const res = await handler(registerRequest(JSON.stringify({})));

  assert.ok(is4xx(res.status), `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a missing required field must never reach a query");
});
