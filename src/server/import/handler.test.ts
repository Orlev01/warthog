// E16-S05 — Import endpoint: the injectable sibling handler
// (`src/server/import/handler.ts`), the HTTP boundary over the import service
// (`./import`, E16-S05). INV-102 validate-and-parameterize-input, INV-103
// secrets-from-env.
//
// RED-first: the factory `./handler` (`createImportHandler`) does not exist yet, so
// importing it throws and EVERY test here fails until the builder writes the module.
// That absence IS the point of test-first — as the TESTER I must NOT create or edit
// any implementation/source file to make these pass; the builder writes `handler.ts`
// afterwards (and, in a later story, the thin route/page entry that imports it and
// exports only its framework keys — OBS-025), to the contract these tests pin.
//
// WHY this exists (task E16-S05): a person uploads their export file; the server half
// reads it, validates it, and writes it into THEIR signed-in account through the
// import service. This endpoint is that boundary. It:
//   1. resolves the session (INV-101) — identity is the session's user id, never a
//      value read from the uploaded file; no session → it writes nothing;
//   2. rejects a malformed / oversized / wrong-version body with a 4xx (never an
//      uncontrolled 500 — INV-102);
//   3. unwraps the person's DEK and calls the import service for the SESSION user, so a
//      SQL-shaped value in an input field is bound as data, never woven into a query.
//
// These tests pin BEHAVIOUR (the HTTP outcome, and what lands in the real stores,
// observed through the ALREADY-BUILT seams), never the source text of any module — a
// later behaviour-preserving rename must not redden them. State is arranged through the
// real repos (`createUser`, a real `KeyWrapper`, real sessions) against an isolated
// in-memory PGlite (src/test/db). Tests never touch the network or Azure; every db
// handle is closed in a `finally`.
//
// ───────────────────────────────────────────────────────────────────────────────────
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   import type { Session } from "../auth/session";
//   import type { Db } from "../db/index";
//   import type { Clock } from "../seams/clock";
//   import type { KeyWrapper } from "../crypto/key-wrapper";
//
//   interface ImportHandlerSeams {                 // every seam optional, with a
//     resolveSession?: (request: Request) => Promise<Session | null>; // production default
//     db?:           Db;          // the shared database (every query parameter-bound)
//     clock?:        Clock;       // the created-at the dated stores stamp during restore
//     keyWrapper?:   KeyWrapper;  // unwraps the person's wrapped DEK to encrypt restored content
//     maxBodyBytes?: number;      // the upload size cap; an oversized body is a 4xx before parsing
//   }
//
//   // route.ts (a later story) exports ONLY its HTTP verb (OBS-025); the factory may
//   // return `{ POST(request) }` OR the bare `(request) => Response`. These tests accept
//   // either (see callPost), pinning the HTTP behaviour, not the shape.
//   createImportHandler(seams?: ImportHandlerSeams): { POST(request: Request): Promise<Response> }
//
//     POST (the request body is the uploaded export document, application/json):
//       1. Resolve the session. No session → 401 OR a redirect to sign-in, before any
//          write (INV-101). Identity is the session's user id, never a file value.
//       2. Reject an oversized body (> maxBodyBytes), malformed JSON, or a document that
//          fails validation (e.g. wrong version) with a 4xx — never a 500 (INV-102).
//       3. On a valid document, write it into the SESSION user's account via the import
//          service and return a 2xx.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createImportHandler } from "./handler";

import { createUser } from "../db/users";
import { listMemoriesForUser } from "../db/memories";
import { getPreferences } from "../db/preferences";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { createSession, COOKIE_NAME, verifySession, type Session } from "../auth/session";
import { fixedClock, type Clock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";

// --- fixtures -----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 key-encryption key for the KeyWrapper seam
const T0 = new Date("2026-11-07T09:00:00.000Z");
const CLOCK: Clock = fixedClock(T0);

function tag(): string {
  return Math.random().toString(36).slice(2);
}

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper`, returning their
// id and the raw DEK the restored content is encrypted under (so a test can read it
// back through the real stores).
async function makePerson(db: Db, who: string, keyWrapper: KeyWrapper): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}-${tag()}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

// A plain session for `userId` — the identity the endpoint must trust over any value in
// the uploaded file.
function sessionFor(userId: string): Session {
  return { id: `sess-${userId}-${tag()}`, userId, createdAt: T0, lastSeenAt: T0, steppedUpAt: null };
}

// A minimal valid export document (the E16-S01 envelope). `memory` carries a known
// content so a round-trip through the endpoint can be observed; the rest are the empty
// sections a sparse server-only export legitimately emits.
function validDoc(memoryContent: string): Record<string, unknown> {
  return {
    version: 1,
    exportedAt: T0.toISOString(),
    profile: { fields: [] },
    preferences: {},
    skills: [],
    memory: [{ id: randomUUID(), content: memoryContent, scope: "shared", sourceAgentId: null }],
    rules: [],
    tasks: [],
    lifeAdmin: [],
    connections: [],
    activity: [],
  };
}

// A POST to the import endpoint. The body is the uploaded export document. `rawBody`
// sends a verbatim string (for malformed JSON / an oversized blob); `body` JSON-encodes
// an arbitrary shape. A session cookie is attached when given.
function importRequest(opts: { body?: unknown; rawBody?: string; cookie?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie !== undefined) headers.cookie = `${COOKIE_NAME}=${opts.cookie}`;
  const payload = opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(opts.body ?? {});
  return new Request("https://warthog.com.au/api/import", { method: "POST", headers, body: payload });
}

// Invoke the handler's POST, tolerant of EITHER factory return shape this repo uses: a
// single-verb factory may return the bare `(request) => Response` or an object exposing
// `{ POST }`. Both are valid ways for a route entry to export only its POST verb
// (OBS-025), so these tests pin the HTTP behaviour, not the shape.
function callPost(handler: unknown, request: Request): Promise<Response> {
  const fn =
    typeof handler === "function"
      ? (handler as (r: Request) => Promise<Response>)
      : (handler as { POST?: (r: Request) => Promise<Response> }).POST;
  if (typeof fn !== "function") throw new Error("the import factory exposes no POST handler");
  return fn(request);
}

// Build the handler under test from injected seams. `session` becomes the resolved
// session (or pass `resolveSession` for the real cookie→verifySession path).
function makeHandler(opts: {
  db: Db;
  keyWrapper: KeyWrapper;
  session?: Session | null;
  resolveSession?: (request: Request) => Promise<Session | null>;
  clock?: Clock;
  maxBodyBytes?: number;
}): unknown {
  const resolveSession = opts.resolveSession ?? (async () => (opts.session === undefined ? null : opts.session));
  return createImportHandler({
    db: opts.db,
    clock: opts.clock ?? CLOCK,
    keyWrapper: opts.keyWrapper,
    resolveSession,
    maxBodyBytes: opts.maxBodyBytes,
  });
}

// Read one cookie's value out of a request's Cookie header (the real resolver's job).
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header == null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// The real session resolver: read the host-locked cookie and verify it server-side over
// `db` (never trusting any other client value — INV-101).
function realResolveSession(db: Db, clock: Clock) {
  return async (request: Request): Promise<Session | null> => {
    const token = readCookie(request, COOKIE_NAME);
    return token ? verifySession(db, token, { clock }) : null;
  };
}

function assert2xx(res: Response): void {
  assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx success, got ${res.status}`);
}

function assert4xx(res: Response): void {
  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx (never a 5xx), got ${res.status}`);
}

// An unauthenticated request is refused with 401 OR a redirect to sign-in — never a success.
function assertUnauthenticated(res: Response): void {
  if (res.status === 401) return;
  const loc = res.headers.get("location");
  assert.ok(
    res.status >= 300 && res.status < 400 && loc != null && /sign-?in/i.test(loc),
    `an unauthenticated import must be 401 or a redirect to sign-in, got ${res.status} (location: ${loc ?? "none"})`,
  );
}

// Flatten a response (status + headers + body) to a string, so a test can assert an
// ambient secret never appears anywhere in it.
async function serialiseResponse(res: Response): Promise<string> {
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}:${v}`).join(" ");
  let body = "";
  try {
    body = await res.clone().text();
  } catch {
    body = "";
  }
  return `${res.status} ${headers} ${body}`;
}

// =====================================================================================
// AC6 — a valid upload is written into the SESSION user's account.
// =====================================================================================

test("AC6: a valid document is imported into the session user's account and returns a 2xx", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "import-http-ok", keyWrapper);
    const content = `window seat ${randomUUID()}`;
    const handler = makeHandler({ db, keyWrapper, session: sessionFor(userId) });

    const res = await callPost(handler, importRequest({ body: validDoc(content) }));
    assert2xx(res);

    const memories = await listMemoriesForUser(db, userId, dek);
    const restored = memories.filter((m) => m.content === content);
    assert.equal(restored.length, 1, "the uploaded memory is restored under the session account");
    assert.equal(restored[0]!.userId, userId, "the restored row is owned by the session user, not any file value");
  } finally {
    await db.close();
  }
});

test("AC6: a genuinely verified session (real cookie → verifySession) is admitted", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "import-http-real", keyWrapper);
    const { token } = await createSession(db, userId, { clock: CLOCK, random: systemRandom });
    const content = `real-import ${randomUUID()}`;

    const handler = makeHandler({ db, keyWrapper, resolveSession: realResolveSession(db, CLOCK) });
    const res = await callPost(handler, importRequest({ body: validDoc(content), cookie: token }));
    assert2xx(res);

    const memories = await listMemoriesForUser(db, userId, dek);
    assert.ok(memories.some((m) => m.content === content), "the document is imported for the verified session user");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC6 — malformed / oversized / wrong-version input is a 4xx, never a 500, and writes
// nothing. [obligation:validate-and-parameterize-input]
// =====================================================================================

test("AC6: malformed JSON is rejected with a 4xx and writes nothing", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "import-http-badjson", keyWrapper);
    const handler = makeHandler({ db, keyWrapper, session: sessionFor(userId) });

    const res = await callPost(handler, importRequest({ rawBody: "{ not valid json" }));
    assert4xx(res);
    assert.deepEqual(await listMemoriesForUser(db, userId, dek), [], "malformed input writes nothing");
  } finally {
    await db.close();
  }
});

test("AC6: an oversized upload is rejected with a 4xx before it is parsed", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "import-http-big", keyWrapper);
    // A tiny cap makes the size boundary deterministic without allocating a huge buffer.
    const handler = makeHandler({ db, keyWrapper, session: sessionFor(userId), maxBodyBytes: 64 });

    const res = await callPost(handler, importRequest({ body: validDoc(`x`.repeat(2048)) }));
    assert4xx(res);
    assert.deepEqual(await listMemoriesForUser(db, userId, dek), [], "an oversized body writes nothing");
  } finally {
    await db.close();
  }
});

test("AC6: a wrong-version document is rejected with a 4xx and writes nothing", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "import-http-badver", keyWrapper);
    const handler = makeHandler({ db, keyWrapper, session: sessionFor(userId) });

    const doc = { ...validDoc(`v ${randomUUID()}`), version: 2 };
    const res = await callPost(handler, importRequest({ body: doc }));
    assert4xx(res);
    assert.deepEqual(await listMemoriesForUser(db, userId, dek), [], "a wrong-version document writes nothing");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC6 — identity comes from the session, not the uploaded file; no session writes nothing.
// =====================================================================================

test("AC6: an unauthenticated upload is refused and writes nothing", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    // A person exists, but the request carries no session.
    const { userId, dek } = await makePerson(db, "import-http-noauth", keyWrapper);
    const handler = makeHandler({ db, keyWrapper, session: null });

    const res = await callPost(handler, importRequest({ body: validDoc(`nope ${randomUUID()}`) }));
    assertUnauthenticated(res);
    assert.deepEqual(await listMemoriesForUser(db, userId, dek), [], "no session → nothing is written to any account");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC6 (parameter binding) — a SQL-injection probe in an input field is stored as inert
// data and cannot alter a query. [obligation:validate-and-parameterize-input]
// =====================================================================================

test("AC6: a SQL-injection probe in an uploaded field is bound as data, not executed", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "import-http-sqli", keyWrapper);
    const handler = makeHandler({ db, keyWrapper, session: sessionFor(userId) });

    const probe = `Robert'); DROP TABLE memories;-- ${randomUUID()}`;
    const res = await callPost(handler, importRequest({ body: validDoc(probe) }));
    assert2xx(res);

    const memories = await listMemoriesForUser(db, userId, dek);
    assert.equal(memories.length, 1, "the memories table survives the probe (the value was bound, not executed)");
    assert.equal(memories[0]!.content, probe, "the SQL-shaped value round-trips verbatim as inert data");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC7 — config is read from the environment; no ambient secret leaks into the response.
// [obligation:secrets-from-env]
// =====================================================================================

test("AC7: no ambient environment secret ever appears in the endpoint's response", async () => {
  const db = await freshDb();
  const CANARY = `env-secret-${randomUUID()}`;
  process.env.WARTHOG_IMPORT_HANDLER_CANARY = CANARY;
  try {
    const keyWrapper = keyWrapperFor();
    const { userId } = await makePerson(db, "import-http-env", keyWrapper);
    const handler = makeHandler({ db, keyWrapper, session: sessionFor(userId) });

    // Exercise both a success and a rejection; neither response may echo an ambient secret.
    const ok = await serialiseResponse(await callPost(handler, importRequest({ body: validDoc(`env ${randomUUID()}`) })));
    const bad = await serialiseResponse(await callPost(handler, importRequest({ rawBody: "{ bad" })));
    assert.ok(!ok.includes(CANARY), "a successful response never carries an ambient secret");
    assert.ok(!bad.includes(CANARY), "an error response never carries an ambient secret");
  } finally {
    delete process.env.WARTHOG_IMPORT_HANDLER_CANARY;
    await db.close();
  }
});
