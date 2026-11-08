// E01-S05 — the HTTP input-validation boundary (`src/server/http/validate.ts`).
//
// RED-first: the module does not exist yet, so every test here fails at import
// until the builder writes it. These tests pin BEHAVIOUR (what the helpers return
// or throw, and what a handler built on them does), never the source text of the
// module — a later rename that preserves behaviour must not redden them.
//
// The contract this task defines (the builder implements exactly this):
//
//   parseBody<T>(schema, request, opts?): Promise<T>
//     • reads the request's JSON body and validates it against a zod schema.
//     • malformed JSON        -> rejects with an HttpError whose status is 4xx
//                                 (never lets a raw SyntaxError escape -> no 500).
//     • a schema violation     -> rejects with a 4xx HttpError.
//     • an oversized body      -> rejects with a 4xx HttpError. The 2-arg form
//                                 (no opts) is protected by a DEFAULT byte cap;
//                                 `opts.maxBytes` lets a caller set a tighter cap.
//     • a well-formed body     -> returns the parsed, typed value.
//
//   parseParams<T>(schema, params): T
//     • validates already-materialised path params (e.g. `{ id }`) to their
//       declared shape at the boundary. A non-conforming value throws a 4xx
//       HttpError and NEVER returns a cast value that could reach a query (OBS-049:
//       a mis-shaped id reaching `WHERE id = $1` is a bigint-cast 500, not a 4xx).
//
//   HttpError extends Error { readonly status: number }
//     • the one error type the boundary throws; `status` is always in the 4xx
//       range, so a catch-all mapping it to a Response yields a 4xx, never a 500.
//
// Obligation mapping:
//   [obligation:validate-and-parameterize-input] (INV-102). The VALIDATE half lives
//   here — all external input (bodies, id params) is validated server-side before it
//   reaches a query or render, and malformed/oversized input is rejected with a 4xx.
//   The PARAMETERIZE half (bound values, never concatenated SQL) was characterised on
//   the db seam in E01-S03; here we prove the two COMPOSE: a handler built on this
//   boundary binds a SQL-injection probe as a parameter (it cannot alter the query),
//   and a non-conforming id is rejected before any query runs. The handlers below are
//   test fixtures (the intended usage pattern), not the module under test.
//   [obligation:secrets-from-env] (INV-103). `src/server/config.ts` is the only reader
//   of process.env and E01-S02 owns proving config flows from env; this pure boundary
//   reads no env and holds no secret, so its share of the obligation is a purity guard:
//   an env value never leaks into a parsed result or an error message (see last test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { parseBody, parseParams, readTextCapped, HttpError } from "./validate";
import { createDb } from "../db/index";

// --- helpers ---------------------------------------------------------------------

// Build a JSON POST request carrying `body` verbatim (body may be malformed on
// purpose). A fresh request per call, since a request body is read-once.
function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

// Run `fn` and hand back whatever it throws / rejects with (or undefined if it did
// not throw). Works for the async parseBody and the sync parseParams alike.
async function caught(fn: () => unknown): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

// Assert a value is the boundary's own 4xx failure: an HttpError (so a catch-all
// renders a 4xx, not a 500) carrying a numeric status in the 4xx range.
function assertHttp4xx(err: unknown, msg?: string): void {
  assert.ok(err !== undefined, msg ?? "expected the boundary to reject the input");
  assert.ok(
    err instanceof HttpError,
    "expected an HttpError (a raw error would be mapped to a 500 by a catch-all)",
  );
  assert.ok(err instanceof Error, "HttpError must be a real Error");
  const status = (err as HttpError).status;
  assert.equal(typeof status, "number", "HttpError must carry a numeric status");
  assert.ok(status >= 400 && status < 500, `expected a 4xx status, got ${status}`);
}

// A db seam stand-in that records every call instead of running it, so a test can
// prove WHAT reached (or did not reach) the query layer. Matches the `Db.query`
// shape from E01-S03: `query(text, values?)`.
interface RecordingDb {
  readonly calls: { text: string; values: unknown[] }[];
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] });
    },
  };
}

// --- fixtures: handlers built on the boundary (the intended usage pattern) -------
//
// A route handler validates at the boundary, then runs a PARAMETERIZED query, and
// turns any HttpError into a Response with that 4xx status. These are test fixtures
// that EXERCISE the module under test — they are not implementation files.

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

function createItemHandler(db: Queryable): (req: Request) => Promise<Response> {
  const schema = z.object({ label: z.string().min(1) });
  return async (req: Request): Promise<Response> => {
    try {
      // A tight per-route cap; the boundary still has its own default.
      const body = await parseBody(schema, req, { maxBytes: 64 * 1024 });
      await db.query("INSERT INTO items (label) VALUES ($1)", [body.label]);
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so
      // a test sees the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function createGetItemHandler(db: Queryable): (params: unknown) => Promise<Response> {
  // A numeric id shape (OBS-049): a non-numeric value must be rejected here, never
  // cast at `WHERE id = $1`.
  const paramsSchema = z.object({ id: z.string().regex(/^[1-9][0-9]*$/) });
  return async (params: unknown): Promise<Response> => {
    try {
      const { id } = parseParams(paramsSchema, params);
      const res = await db.query("SELECT id, label FROM items WHERE id = $1", [id]);
      return new Response(JSON.stringify({ rows: res.rows }), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid id" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

// --- AC1: parseBody rejects malformed/oversized with a 4xx, never a raw 500 ------

test("parseBody returns the validated, typed value for a well-formed body", async () => {
  const schema = z.object({ label: z.string().min(1).max(50) });
  const data = await parseBody(schema, jsonRequest(JSON.stringify({ label: "hello" })));
  assert.deepEqual(data, { label: "hello" });
});

test("parseBody rejects malformed JSON with a 4xx HttpError (no raw SyntaxError -> no 500)", async () => {
  const schema = z.object({ label: z.string() });
  const err = await caught(() => parseBody(schema, jsonRequest("{ this is not valid json")));
  assertHttp4xx(err, "malformed JSON must be rejected at the boundary");
  assert.ok(
    !(err instanceof SyntaxError),
    "a raw JSON SyntaxError must not escape (a catch-all would turn it into a 500)",
  );
});

test("parseBody rejects a schema violation with a 4xx HttpError", async () => {
  const schema = z.object({ label: z.string().min(1).max(50) });
  // Wrong type.
  assertHttp4xx(await caught(() => parseBody(schema, jsonRequest(JSON.stringify({ label: 123 })))));
  // Missing required field.
  assertHttp4xx(await caught(() => parseBody(schema, jsonRequest(JSON.stringify({})))));
  // Fails a stated constraint (too long).
  assertHttp4xx(
    await caught(() => parseBody(schema, jsonRequest(JSON.stringify({ label: "x".repeat(200) })))),
  );
});

test("parseBody honours a caller-supplied byte cap, rejecting an oversized body with a 4xx", async () => {
  // `note` has no max length, so only the SIZE cap — not the schema — can reject it.
  const schema = z.object({ note: z.string() });
  const body = JSON.stringify({ note: "a".repeat(5000) });
  const err = await caught(() => parseBody(schema, jsonRequest(body), { maxBytes: 100 }));
  assertHttp4xx(err, "a body over maxBytes must be rejected");
});

test("parseBody rejects an oversized body with a 4xx even with no explicit cap (a default limit protects the 2-arg form)", async () => {
  const schema = z.object({ note: z.string() });
  // ~10 MiB of schema-valid JSON: far above any sane default request-body limit, so
  // only a default byte cap can be the reason it is rejected.
  const huge = JSON.stringify({ note: "a".repeat(10 * 1024 * 1024) });
  const err = await caught(() => parseBody(schema, jsonRequest(huge)));
  assertHttp4xx(err, "the 2-arg form must still reject a grossly oversized body");
});

// --- review fix F2: the cap is enforced WHILE reading, never after buffering -------
//
// An unauthenticated client can stream hundreds of MiB at an auth route. The boundary must stop
// reading as soon as the running byte count crosses the cap (and cancel the stream), and must
// refuse a declared Content-Length over the cap before reading a single byte.

const MiB = 1024 * 1024;

// A request whose body is a pull-based stream of `chunkBytes` chunks (up to `totalBytes`),
// recording how many bytes the reader actually pulled and whether it cancelled the stream.
function streamedRequest(opts: {
  totalBytes: number;
  chunkBytes: number;
  headers?: Record<string, string>;
  pullThrows?: boolean;
}): { request: Request; stats: { pulled: number; cancelled: boolean } } {
  const stats = { pulled: 0, cancelled: false };
  const chunk = new TextEncoder().encode("a".repeat(opts.chunkBytes));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.pullThrows) throw new Error("the body must not be read");
      if (stats.pulled >= opts.totalBytes) {
        controller.close();
        return;
      }
      stats.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  const request = new Request("https://warthog.com.au/api/items", {
    method: "POST",
    headers: { "content-type": "application/json", ...opts.headers },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, stats };
}

test("parseBody stops reading an oversized streamed body once the cap is crossed, and cancels it", async () => {
  const schema = z.object({ note: z.string() });
  const { request, stats } = streamedRequest({ totalBytes: 64 * MiB, chunkBytes: MiB });
  const err = await caught(() => parseBody(schema, request, { maxBytes: 64 * 1024 }));
  assertHttp4xx(err, "an oversized streamed body must be rejected");
  assert.equal((err as HttpError).status, 413);
  // Read at most the cap plus the chunk in flight (and one the stream may have queued ahead),
  // never the whole 64 MiB.
  assert.ok(stats.pulled <= 3 * MiB, `read ${stats.pulled} bytes of a 64 KiB-capped body`);
  assert.equal(stats.cancelled, true, "the body stream must be cancelled once refused");
});

test("parseBody refuses a declared Content-Length over the cap without reading the body", async () => {
  const schema = z.object({ note: z.string() });
  const { request } = streamedRequest({
    totalBytes: MiB,
    chunkBytes: 1024,
    headers: { "content-length": String(1_000_000_000) },
    pullThrows: true,
  });
  const err = await caught(() => parseBody(schema, request, { maxBytes: 64 * 1024 }));
  assertHttp4xx(err);
  assert.equal((err as HttpError).status, 413);
});

test("parseBody still parses a streamed body under the cap (multi-byte text survives chunking)", async () => {
  const schema = z.object({ note: z.string() });
  const text = JSON.stringify({ note: "café ✓ ".repeat(500) });
  const bytes = new TextEncoder().encode(text);
  // Split mid-character on purpose: a decoder per chunk would corrupt the text.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });
  const request = new Request("https://warthog.com.au/api/items", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  assert.deepEqual(await parseBody(schema, request, { maxBytes: 64 * 1024 }), JSON.parse(text));
});

test("readTextCapped returns the body text under the cap and refuses an over-cap body with a 413", async () => {
  const form = "grant_type=authorization_code&code=abc";
  const ok = new Request("https://warthog.com.au/oauth/token", { method: "POST", body: form });
  assert.equal(await readTextCapped(ok, 1024), form);

  const big = new Request("https://warthog.com.au/oauth/token", { method: "POST", body: "a".repeat(2048) });
  const err = await caught(() => readTextCapped(big, 1024));
  assertHttp4xx(err);
  assert.equal((err as HttpError).status, 413);

  // No body at all reads as empty text (as request.text() would).
  assert.equal(await readTextCapped(new Request("https://warthog.com.au/oauth/token"), 1024), "");
});

// --- AC2: an id param is validated to its shape; a bad id never reaches a query --

test("parseParams returns the typed value for a conforming id", () => {
  const schema = z.object({ id: z.string().regex(/^[1-9][0-9]*$/) });
  const out = parseParams(schema, { id: "42" });
  assert.deepEqual(out, { id: "42" });
});

test("parseParams rejects a non-conforming id with a 4xx, never returning a cast value", async () => {
  const schema = z.object({ id: z.string().regex(/^[1-9][0-9]*$/) });
  assertHttp4xx(await caught(() => parseParams(schema, { id: "not-a-number" })));
  // A SQL-injection probe in the id position is rejected as a shape violation.
  assertHttp4xx(await caught(() => parseParams(schema, { id: "1 OR 1=1" })));
  // A missing id is rejected (not silently defaulted).
  assertHttp4xx(await caught(() => parseParams(schema, {})));
});

test("a handler rejects a non-conforming id with a 4xx and the bad id never reaches a query", async () => {
  const db = recordingDb();
  const handler = createGetItemHandler(db);

  const res = await handler({ id: "nope'); DROP TABLE items; --" });

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a non-conforming id must be rejected before any query runs");
});

test("a handler passes a conforming id to the query as a bound parameter", async () => {
  const db = recordingDb();
  const handler = createGetItemHandler(db);

  const res = await handler({ id: "42" });

  assert.equal(res.status, 200);
  assert.equal(db.calls.length, 1, "a valid id should reach exactly one query");
  const call = db.calls[0]!;
  assert.deepEqual(call.values, ["42"], "the id is bound as a parameter");
  assert.ok(call.text.includes("$1"), "the query uses a placeholder, not an inlined value");
  assert.ok(!call.text.includes("42"), "the id value is bound, never concatenated into the SQL text");
});

// --- AC3/AC5: a handler rejects bad input with a 4xx; a probe cannot alter a query

test("a handler rejects malformed body input with a 4xx (not a 500)", async () => {
  const db = recordingDb();
  const handler = createItemHandler(db);

  const res = await handler(jsonRequest("{ not json at all"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("a handler rejects an oversized body with a 4xx", async () => {
  const db = recordingDb();
  const handler = createItemHandler(db);

  // `label` has no max, so the ~100 KiB body is schema-valid; only the handler's
  // 64 KiB byte cap can reject it.
  const res = await handler(jsonRequest(JSON.stringify({ label: "a".repeat(100 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("a handler accepts a well-formed body and binds its field as a query parameter", async () => {
  const db = recordingDb();
  const handler = createItemHandler(db);

  const res = await handler(jsonRequest(JSON.stringify({ label: "groceries" })));

  assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0]!.values, ["groceries"], "the body field is bound as a parameter");
});

test("a SQL-injection probe in a body field is bound as a parameter, not woven into the SQL text", async () => {
  const db = recordingDb();
  const handler = createItemHandler(db);
  const probe = "Robert'); DROP TABLE students; --";

  const res = await handler(jsonRequest(JSON.stringify({ label: probe })));

  assert.ok(res.status >= 200 && res.status < 300, "a valid (if nasty) string is accepted as data");
  assert.equal(db.calls.length, 1);
  const call = db.calls[0]!;
  // The probe travels as a bound value...
  assert.deepEqual(call.values, [probe]);
  // ...and is NOT concatenated into the statement text (scoped to this one INSERT).
  assert.ok(call.text.includes("$1"), "the statement uses a placeholder");
  assert.ok(!call.text.includes(probe), "the probe value is never spliced into the SQL text");
  assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
});

test("end-to-end: a handler built on the boundary cannot be SQL-injected (probe stored as data; table survives)", async () => {
  const db = await createDb("pglite:memory");
  try {
    await db.query("CREATE TABLE items (id serial PRIMARY KEY, label text NOT NULL)");
    const handler = createItemHandler(db);
    const probe = "Robert'); DROP TABLE items; --";

    const res = await handler(jsonRequest(JSON.stringify({ label: probe })));
    assert.ok(res.status >= 200 && res.status < 300, "the probe is accepted as ordinary data");

    // The injection did NOT execute: the table still exists and holds exactly one
    // row, whose label is the probe stored verbatim.
    const rows = (await db.query("SELECT label FROM items")).rows as { label: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.label, probe);
  } finally {
    await db.close();
  }
});

// --- AC4/AC5: secrets from env — the pure boundary leaks no env value ------------

test("the validation boundary is pure w.r.t. the environment: no env value flows into a result or an error", async () => {
  const SENTINEL = "SENTINEL_SECRET_env_only_7f3a";
  const KEY = "WARTHOG_VALIDATE_SENTINEL";
  const saved = process.env[KEY];
  try {
    process.env[KEY] = SENTINEL;
    const schema = z.object({ label: z.string() });

    // A good parse returns only the caller's data — never an ambient env value.
    const data = await parseBody(schema, jsonRequest(JSON.stringify({ label: "hello" })));
    assert.equal(JSON.stringify(data).includes(SENTINEL), false, "no env value leaks into parsed output");

    // A rejection message is safe — it does not carry an ambient secret either.
    const err = await caught(() => parseBody(schema, jsonRequest("{ not json")));
    assertHttp4xx(err);
    assert.equal(
      String((err as HttpError).message).includes(SENTINEL),
      false,
      "no env value leaks into an error message",
    );
  } finally {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  }
});
