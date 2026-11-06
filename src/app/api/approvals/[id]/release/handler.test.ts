// E11-S10 — Approval release endpoint: the injectable sibling handler
// (`src/app/api/approvals/[id]/release/handler.ts`), the server half of a release
// (design §4.2 "Release" + the in-memory release store; §4.3 the released-value
// fingerprint; §5 step-up; brief "release — one-time hand-over of a high-tier value or
// card"). INV-101 admin-auth-required, INV-102 validate-and-parameterize-input,
// INV-103 secrets-from-env.
//
// RED-first: the sibling factory `./handler` (`createReleaseHandler`) does not exist
// yet, so importing it throws and EVERY test here fails until the builder writes the
// module. That absence IS the point of test-first — as the TESTER I must NOT create or
// edit any implementation/source file to make these pass; the builder writes
// `handler.ts` (and the thin `route.ts`) afterwards, to this contract.
//
// WHY this exists (task E11-S10): on approval, after a fresh step-up, the browser
// decrypts the high-tier value / card detail with the vault key (E11-S07..S09) and POSTs
// the PLAINTEXT to `/api/approvals/[id]/release`. This endpoint is the server half: it
//   1. requires an authenticated session (INV-101) AND a step-up within the last 5
//      minutes (design §5) — otherwise it releases nothing;
//   2. accepts the value only for an APPROVED approval OWNED BY THE SESSION USER;
//   3. places the value in the in-memory release store (TTL 5 min, single collection)
//      under the key the agent's `collect_release` will read it with; and
//   4. records a keyed one-way HMAC FINGERPRINT of the value (kept 90 days) — and NEVER
//      writes the value itself to the database, a log or a metric.
//
// These tests pin BEHAVIOUR (the HTTP outcome, what lands in the release store, and the
// persisted fingerprint — observed through the ALREADY-BUILT seams), never the source
// text of any module — a later behaviour-preserving rename must not redden them. State is
// arranged through the real repos (`createUser`, `createApproval` + `decide`, a real
// `KeyWrapper`) against an isolated in-memory PGlite (src/test/db). The release store is a
// real `createReleaseStore`, and the KEY a release is collected with is the SHARED
// one-source-of-truth `releaseKeyFor` the collector (`collect_release`, E07-S15) uses —
// so "collectable by the agent" is proven against the real key scheme, not a guess. Tests
// never touch the network or Azure; every db handle is closed in a `finally`.
//
// ───────────────────────────────────────────────────────────────────────────────────
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   import type { Session } from "../../../../../server/auth/session";
//   import type { Db } from "../../../../../server/db/index";
//   import type { Clock } from "../../../../../server/seams/clock";
//   import type { ReleaseStore } from "../../../../../server/crypto/release-store";
//   import type { KeyWrapper } from "../../../../../server/crypto/key-wrapper";
//
//   interface ReleaseSeams {                               // every seam optional, with a
//     resolveSession?: (request: Request) => Promise<Session | null>; // production default
//     db?:            Db;            // the shared database (every query parameter-bound)
//     clock?:         Clock;         // judges step-up freshness + the 90-day fingerprint window
//     releaseStore?:  ReleaseStore;  // the process-wide in-memory store the value is put into
//     keyWrapper?:    KeyWrapper;    // unwraps the person's DEK to fingerprint the value
//   }
//
//   // route.ts exports ONLY POST (OBS-025, pinned in the sibling route.test.ts). The
//   // factory may return `{ POST(request, id) }` OR the bare `(request, id) => Response`;
//   // these tests accept either (see callPost), pinning the HTTP behaviour, not the shape.
//   createReleaseHandler(seams?: ReleaseSeams): { POST(request: Request, id: string): Promise<Response> }
//
//     POST (the browser posts `{ value }`; the approval id rides in the path, never the body):
//       1. Resolve the session (`resolveSession`). No session → 401 OR a redirect to
//          sign-in, before anything else (INV-101). Identity is the session's user id,
//          never a client value.
//       2. Require a step-up within the last 5 minutes (`requireStepUp` over the session's
//          `steppedUpAt` + the clock). No / stale step-up → a 4xx, nothing released.
//       3. Shape-guard the id: a value that is not a well-formed approval id (uuid) is a
//          4xx BEFORE `WHERE id = $1`, never a raw uuid cast / 500 (OBS-049, INV-102).
//       4. Load the approval MEMBER-SCOPED by the session user; it must be `approved`
//          and owned by that user — else a 4xx, nothing released (another user's approval
//          can never be released).
//       5. Validate the body (`{ value }`): malformed / oversized / mis-shaped → a 4xx
//          (never a 500, INV-102), before any store/db write.
//       6. Put the value in the release store under `releaseKeyFor` for the approval's
//          agent connection, and persist `fingerprint(dek, value)` for 90 days — the
//          value itself is never written to the db, a log or a metric.
//
// The obligation acceptance criteria (admin-auth-required, validate-and-parameterize-
// input, secrets-from-env) are pinned below alongside the behaviour, as the repo's route
// tests do (connect/callback). The entry's export shape is pinned in `route.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createReleaseHandler } from "./handler";

import { createUser } from "../../../../../server/db/users";
import { createApproval, decide } from "../../../../../server/db/approvals";
import { lookupForUser } from "../../../../../server/db/release-fingerprints";
import { fingerprint } from "../../../../../server/crypto/hmac";
import { createReleaseStore, type ReleaseStore } from "../../../../../server/crypto/release-store";
import { localAesKeyWrapper, type KeyWrapper } from "../../../../../server/crypto/key-wrapper";
import {
  createSession,
  verifySession,
  recordStepUp,
  COOKIE_NAME,
  type Session,
} from "../../../../../server/auth/session";
import { releaseKeyFor } from "../../../../../server/mcp/tools/collect-release";
import { fixedClock, type Clock } from "../../../../../server/seams/clock";
import { systemRandom } from "../../../../../server/seams/random";
import { freshDb } from "../../../../../test/db";
import type { Db } from "../../../../../server/db/index";
import type { AgentConnection } from "../../../../../server/mcp/context";

// --- fixtures -----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 key-encryption key for the KeyWrapper seam

// A frozen instant everything reads time through: the session, the step-up, the release
// store's TTL and the 90-day fingerprint window all anchor here, so freshness is
// deterministic with no wall-clock dependence.
const T0 = new Date("2026-11-15T12:00:00.000Z");
const CLOCK: Clock = fixedClock(T0);

const MINUTE_MS = 60 * 1000;
const STEP_UP_WINDOW_MS = 5 * MINUTE_MS; // design §5: a step-up is fresh for 5 minutes
const DAY_MS = 24 * 60 * MINUTE_MS;

// A unique tag so accounts never collide on the users.email UNIQUE across tests.
function tag(): string {
  return Math.random().toString(36).slice(2);
}

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper`, returning their id
// and the raw DEK the approval detail is encrypted under (and the fingerprint is keyed by).
async function makePerson(
  db: Db,
  who: string,
  keyWrapper: KeyWrapper,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}-${tag()}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

// Arrange an APPROVED approval owned by `userId` for agent connection `agentId`: create it
// PENDING (real repo + envelope-encrypted detail) then move it to `approved` via the real
// `decide`. Returns the approval id.
async function makeApprovedApproval(
  db: Db,
  opts: { userId: string; agentId: string; dek: Uint8Array; clock?: Clock },
): Promise<string> {
  const clock = opts.clock ?? CLOCK;
  const created = await createApproval(
    db,
    { userId: opts.userId, agentId: opts.agentId, detail: { field: "passport_number" } },
    opts.dek,
    clock,
  );
  await decide(db, { userId: opts.userId, id: created.id, decision: { status: "approved" } }, opts.dek, clock);
  return created.id;
}

// Arrange a PENDING (not yet approved) approval owned by `userId`. Returns its id.
async function makePendingApproval(
  db: Db,
  opts: { userId: string; agentId: string; dek: Uint8Array; clock?: Clock },
): Promise<string> {
  const created = await createApproval(
    db,
    { userId: opts.userId, agentId: opts.agentId, detail: { field: "passport_number" } },
    opts.dek,
    opts.clock ?? CLOCK,
  );
  return created.id;
}

// A plain session for `userId` with a chosen step-up instant — identity the endpoint must
// trust over any client value, and the `steppedUpAt` the step-up freshness check reads.
function sessionFor(userId: string, steppedUpAt: Date | null): Session {
  return { id: `sess-${userId}-${tag()}`, userId, createdAt: T0, lastSeenAt: T0, steppedUpAt };
}

// The release-store KEY the collecting agent connection reads this approval's value with.
// A connection's id IS its agent id (the E07-S09 shape), so the key derives from the
// approval's `agentId` under its owning person — the SAME `releaseKeyFor` the collector
// (`collect_release`) uses, so this is the real cross-task contract, not a guess.
function keyForApproval(userId: string, agentId: string): string {
  const connection: AgentConnection = { userId, connectionId: agentId, agentId, active: true };
  return releaseKeyFor(connection);
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

// The REAL session resolver: read the `__Host-wh_session` cookie and verify it server-side
// over `db` (never trusting any other client value — INV-101). Used to prove a genuinely
// verified + stepped-up session is admitted and an unverifiable cookie is refused.
function realResolveSession(db: Db, clock: Clock) {
  return async (request: Request): Promise<Session | null> => {
    const token = readCookie(request, COOKIE_NAME);
    return token ? verifySession(db, token, { clock }) : null;
  };
}

// A POST to the release endpoint. The approval id rides in the path; the value rides in the
// JSON body. `rawBody` sends a verbatim string (for malformed JSON); `body` JSON-encodes an
// arbitrary shape; otherwise `{ value }` is sent. A session cookie is attached when given.
function releaseRequest(
  id: string,
  opts: { value?: unknown; body?: unknown; rawBody?: string; cookie?: string } = {},
): Request {
  const url = `https://warthog.com.au/api/approvals/${encodeURIComponent(id)}/release`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie !== undefined) headers.cookie = `${COOKIE_NAME}=${opts.cookie}`;
  let payload: string;
  if (opts.rawBody !== undefined) payload = opts.rawBody;
  else if (opts.body !== undefined) payload = JSON.stringify(opts.body);
  else payload = JSON.stringify({ value: opts.value });
  return new Request(url, { method: "POST", headers, body: payload });
}

// Invoke the handler's POST, tolerant of EITHER factory return shape this repo uses: a
// single-verb factory may return the bare `(request, id) => Response` (as
// `createConnectCallbackHandler`'s sibling-style allows) or an object exposing
// `{ POST }` (as `createMcpRouteHandler` does). Both are valid ways for `route.ts` to
// export only its POST verb (OBS-025), so these tests pin the HTTP behaviour, not the shape.
function callPost(handler: unknown, request: Request, id: string): Promise<Response> {
  const fn =
    typeof handler === "function"
      ? (handler as (r: Request, id: string) => Promise<Response>)
      : (handler as { POST?: (r: Request, id: string) => Promise<Response> }).POST;
  if (typeof fn !== "function") {
    throw new Error("the release factory exposes no POST handler");
  }
  return fn(request, id);
}

// Build the handler under test from injected seams. `session` becomes the resolved session
// (or pass `resolveSession` for the real cookie→verifySession path). The release store
// defaults to a real store on the same clock, so the value's TTL is judged deterministically.
function makeHandler(opts: {
  db: Db;
  keyWrapper: KeyWrapper;
  session?: Session | null;
  resolveSession?: (request: Request) => Promise<Session | null>;
  clock?: Clock;
  releaseStore?: ReleaseStore;
}): { handler: unknown; store: ReleaseStore; clock: Clock } {
  const clock = opts.clock ?? CLOCK;
  const store = opts.releaseStore ?? createReleaseStore(clock);
  const resolveSession =
    opts.resolveSession ?? (async () => (opts.session === undefined ? null : opts.session));
  const handler = createReleaseHandler({
    db: opts.db,
    clock,
    releaseStore: store,
    keyWrapper: opts.keyWrapper,
    resolveSession,
  });
  return { handler, store, clock };
}

// Redirect every console channel into an array for the duration of a call, so a test can
// assert the released value was never written to logs/metrics. Restores on teardown.
function captureConsole(): { lines: string[]; restore: () => void } {
  const methods = ["log", "info", "warn", "error", "debug", "trace"];
  const sink = console as unknown as Record<string, (...args: unknown[]) => void>;
  const originals = new Map<string, ((...args: unknown[]) => void) | undefined>();
  const lines: string[] = [];
  for (const m of methods) {
    originals.set(m, sink[m]);
    sink[m] = (...args: unknown[]): void => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
  return {
    lines,
    restore(): void {
      for (const m of methods) {
        const original = originals.get(m);
        if (original) sink[m] = original;
      }
    },
  };
}

// Whether a relation of this exact name exists — a non-throwing probe for survival tests.
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
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
    `an unauthenticated release must be 401 or a redirect to sign-in, got ${res.status} (location: ${loc ?? "none"})`,
  );
}

// =====================================================================================
// AC1 — an approved approval for the session user WITH a fresh step-up releases the value
// (into the store) and writes its fingerprint; WITHOUT a recent step-up it releases nothing.
// =====================================================================================

test("AC1: an approved approval for the session user with a fresh step-up stores the value and writes its HMAC fingerprint", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-ok", keyWrapper);
    const agentId = randomUUID();
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // A unique canary with characters outside hex, so any later appearance in the db or a
    // log could only be the raw value leaking.
    const VALUE = `passport ∂ ${randomUUID()} 42!!`;
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });

    const res = await callPost(handler, releaseRequest(approvalId, { value: VALUE }), approvalId);
    assert2xx(res);

    // The value is held in the in-memory release store, collectable under the SAME key
    // the agent's `collect_release` reads (and nowhere else).
    assert.equal(
      store.collect(keyForApproval(userId, agentId)),
      VALUE,
      "the decrypted value is placed in the release store for the agent's single collection",
    );

    // A keyed one-way fingerprint of the value is persisted — the value never is.
    const fps = await lookupForUser(db, userId, CLOCK);
    assert.ok(
      fps.includes(fingerprint(dek, VALUE)),
      "the keyed HMAC fingerprint of the released value is persisted",
    );
  } finally {
    await db.close();
  }
});

test("AC1: a post without a recent step-up is rejected and releases nothing", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-nostepup", keyWrapper);
    const agentId = randomUUID();
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // Signed in, but the session has NEVER stepped up (steppedUpAt === null).
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, null) });

    const res = await callPost(handler, releaseRequest(approvalId, { value: `v-${randomUUID()}` }), approvalId);
    assert4xx(res);

    assert.equal(store.collect(keyForApproval(userId, agentId)), undefined, "no value is placed in the release store");
    assert.deepEqual(await lookupForUser(db, userId, CLOCK), [], "no fingerprint is persisted without a step-up");
  } finally {
    await db.close();
  }
});

test("AC1: a step-up older than five minutes is rejected and releases nothing", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-stalestepup", keyWrapper);
    const agentId = randomUUID();
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // Stepped up six minutes ago — just past the 5-minute window at the clock (T0).
    const stale = new Date(T0.getTime() - (STEP_UP_WINDOW_MS + MINUTE_MS));
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, stale) });

    const res = await callPost(handler, releaseRequest(approvalId, { value: `v-${randomUUID()}` }), approvalId);
    assert4xx(res);

    assert.equal(store.collect(keyForApproval(userId, agentId)), undefined, "a stale step-up releases nothing");
    assert.deepEqual(await lookupForUser(db, userId, CLOCK), [], "and writes no fingerprint");
  } finally {
    await db.close();
  }
});

test("AC1: a genuinely verified session that recorded a step-up is admitted (real cookie → verifySession → requireStepUp)", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-real-ok", keyWrapper);
    const agentId = randomUUID();
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // A real session that then records a step-up at the clock — the whole chain exercised.
    const { token, session } = await createSession(db, userId, { clock: CLOCK, random: systemRandom });
    await recordStepUp(db, session.id, { clock: CLOCK });

    const VALUE = `real-${randomUUID()}`;
    const { handler, store } = makeHandler({ db, keyWrapper, resolveSession: realResolveSession(db, CLOCK) });

    const res = await callPost(handler, releaseRequest(approvalId, { value: VALUE, cookie: token }), approvalId);
    assert2xx(res);
    assert.equal(store.collect(keyForApproval(userId, agentId)), VALUE, "the value is released for the agent's collection");
  } finally {
    await db.close();
  }
});

test("AC1: a genuinely verified session with NO step-up is rejected (a signed-in session is not enough)", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-real-nostepup", keyWrapper);
    const agentId = randomUUID();
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // A real session, but it never stepped up.
    const { token } = await createSession(db, userId, { clock: CLOCK, random: systemRandom });

    const { handler, store } = makeHandler({ db, keyWrapper, resolveSession: realResolveSession(db, CLOCK) });
    const res = await callPost(handler, releaseRequest(approvalId, { value: `v-${randomUUID()}`, cookie: token }), approvalId);
    assert4xx(res);
    assert.equal(store.collect(keyForApproval(userId, agentId)), undefined, "a signed-in-but-not-stepped-up session releases nothing");
  } finally {
    await db.close();
  }
});

test("AC1: only an APPROVED approval is releasable — a pending approval is rejected even with a fresh step-up", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-pending", keyWrapper);
    const agentId = randomUUID();
    const approvalId = await makePendingApproval(db, { userId, agentId, dek });

    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
    const res = await callPost(handler, releaseRequest(approvalId, { value: `v-${randomUUID()}` }), approvalId);
    assert4xx(res);

    assert.equal(store.collect(keyForApproval(userId, agentId)), undefined, "a value cannot be released against a pending approval");
    assert.deepEqual(await lookupForUser(db, userId, CLOCK), [], "and no fingerprint is written");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — the value is never written to the database, a log or a metric; only its
// fingerprint is persisted, and for 90 days.
// =====================================================================================

test("AC2: the released value is never written to the database — only its one-way fingerprint is persisted", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-nodb", keyWrapper);
    const agentId = randomUUID();
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    const VALUE = `tax-file ∂ ${randomUUID()} !!`;
    const { handler } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
    assert2xx(await callPost(handler, releaseRequest(approvalId, { value: VALUE }), approvalId));

    // Scope the absence check narrowly to the ONE table this endpoint writes to.
    const rows = (await db.query("SELECT * FROM release_fingerprints WHERE user_id = $1", [userId])).rows;
    assert.equal(rows.length, 1, "exactly one fingerprint row is written for the release");
    for (const row of rows) {
      for (const value of Object.values(row)) {
        assert.ok(
          !(typeof value === "string" && value.includes(VALUE)),
          "the plaintext value is never stored in any column of release_fingerprints",
        );
      }
    }
    assert.equal(rows[0]!.fingerprint, fingerprint(dek, VALUE), "the persisted column is the keyed HMAC fingerprint of the value");
    assert.notEqual(rows[0]!.fingerprint, VALUE, "what is persisted is the fingerprint, not the plaintext");
  } finally {
    await db.close();
  }
});

test("AC2: a successful release never writes the value to logs/metrics (console)", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-nolog", keyWrapper);
    const agentId = randomUUID();
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    const VALUE = `log-canary ∂ ${randomUUID()} !!`;
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });

    const capture = captureConsole();
    let res: Response;
    try {
      res = await callPost(handler, releaseRequest(approvalId, { value: VALUE }), approvalId);
    } finally {
      capture.restore();
    }
    assert2xx(res);

    // The value still reaches the agent (through the store), but never a log line.
    assert.equal(store.collect(keyForApproval(userId, agentId)), VALUE, "the value still round-trips to the store for the agent");
    for (const line of capture.lines) {
      assert.ok(!line.includes(VALUE), "the released value must never be written to logs/metrics in the clear");
    }
  } finally {
    await db.close();
  }
});

test("AC2: the fingerprint is persisted for ninety days (present inside the window, gone after it)", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-90d", keyWrapper);
    const agentId = randomUUID();
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    const VALUE = `fp-${randomUUID()}`;
    const { handler } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
    assert2xx(await callPost(handler, releaseRequest(approvalId, { value: VALUE }), approvalId));

    const fp = fingerprint(dek, VALUE);
    const within = await lookupForUser(db, userId, fixedClock(new Date(T0.getTime() + 89 * DAY_MS)));
    assert.ok(within.includes(fp), "the fingerprint is still live 89 days after the release");
    const after = await lookupForUser(db, userId, fixedClock(new Date(T0.getTime() + 91 * DAY_MS)));
    assert.ok(!after.includes(fp), "the fingerprint has lapsed 91 days after the release (a 90-day window)");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a user cannot release against another user's approval; a malformed id is a 4xx
// (never a raw uuid cast / 500).
// =====================================================================================

test("AC3: a user cannot release against another user's approval, even when signed in and freshly stepped up", async () => {
  const db = await freshDb();
  try {
    const kwAlice = keyWrapperFor();
    const { userId: alice, dek: dekAlice } = await makePerson(db, "owner-alice", kwAlice);
    const agentId = randomUUID();
    const approvalId = await makeApprovedApproval(db, { userId: alice, agentId, dek: dekAlice });

    const kwBob = keyWrapperFor();
    const { userId: bob } = await makePerson(db, "intruder-bob", kwBob);

    // Bob is fully signed in AND freshly stepped up, posting against ALICE's approval id.
    const { handler, store } = makeHandler({ db, keyWrapper: kwBob, session: sessionFor(bob, T0) });
    const res = await callPost(handler, releaseRequest(approvalId, { value: `intrusion-${randomUUID()}` }), approvalId);
    assert4xx(res);

    assert.equal(store.collect(keyForApproval(alice, agentId)), undefined, "nothing is released under the owner's key");
    assert.equal(store.collect(keyForApproval(bob, agentId)), undefined, "nor under the intruder's key");
    assert.deepEqual(await lookupForUser(db, alice, CLOCK), [], "no fingerprint is written for the owner");
    assert.deepEqual(await lookupForUser(db, bob, CLOCK), [], "nor for the intruder");
  } finally {
    await db.close();
  }
});

test("AC3: an id that is not a well-formed approval id is rejected with a 4xx (never a raw cast / 500) and changes nothing", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId } = await makePerson(db, "release-badid", keyWrapper);

    // None of these is a uuid — a raw `WHERE id = $1` against the uuid column would throw a
    // 500; the boundary must shape-guard them to a 4xx first. The last is a SQL-injection
    // probe (OBS-049 / INV-102): bound/guarded as data, it cannot run as SQL.
    const badIds = ["not-a-uuid", "1", "0", "-1", "1.5", " ", "", "../../etc/passwd", "robert'); DROP TABLE approvals; --"];
    for (const badId of badIds) {
      const { handler } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
      const res = await callPost(handler, releaseRequest(badId, { value: `v-${randomUUID()}` }), badId);
      assert.ok(
        res.status >= 400 && res.status < 500,
        `a malformed id ${JSON.stringify(badId)} must be a 4xx (never a 5xx raw cast), got ${res.status}`,
      );
    }

    // The injection probe never ran as SQL: the approvals table is intact and nothing was released.
    await db.query("SELECT 1 FROM approvals LIMIT 1");
    assert.equal(await tableExists(db, "approvals"), true, "the approvals table survives every malformed id");
    assert.deepEqual(await lookupForUser(db, userId, CLOCK), [], "a malformed id releases nothing");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC [obligation:admin-auth-required] (INV-101) — the endpoint requires a server-verified
// session; identity is never a client value. (The public-route half of the obligation is
// satisfied by Warthog's public routes and their own tests — this task adds only an
// authenticated route, so only the admin half is exercised here.)
// =====================================================================================

test("[admin-auth-required] an unauthenticated request (no session) is rejected (401 or redirect to sign-in) and releases nothing", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-unauth", keyWrapper);
    const agentId = randomUUID();
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    const { handler, store } = makeHandler({ db, keyWrapper, session: null });
    const res = await callPost(handler, releaseRequest(approvalId, { value: `v-${randomUUID()}` }), approvalId);

    assertUnauthenticated(res);
    assert.equal(store.collect(keyForApproval(userId, agentId)), undefined, "an unauthenticated request releases nothing");
    assert.deepEqual(await lookupForUser(db, userId, CLOCK), [], "and writes no fingerprint");
  } finally {
    await db.close();
  }
});

test("[admin-auth-required] a garbage/unknown session cookie is treated as unauthenticated (real verifySession)", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-garbage", keyWrapper);
    const agentId = randomUUID();
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    const { handler, store } = makeHandler({ db, keyWrapper, resolveSession: realResolveSession(db, CLOCK) });
    const res = await callPost(
      handler,
      releaseRequest(approvalId, { value: `v-${randomUUID()}`, cookie: `no-such-session-${randomUUID()}` }),
      approvalId,
    );

    assertUnauthenticated(res);
    assert.equal(store.collect(keyForApproval(userId, agentId)), undefined, "an unverifiable cookie releases nothing");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC [obligation:validate-and-parameterize-input] (INV-102) — malformed / oversized /
// mis-shaped input is a 4xx (never a 500); a SQL-shaped value is treated purely as data
// (only its one-way fingerprint reaches the db, which survives).
// =====================================================================================

test("[validate-and-parameterize-input] a malformed or mis-shaped body is a 4xx (never a 500) and releases nothing", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-malformed", keyWrapper);
    const agentId = randomUUID();
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // A valid session + fresh step-up + a valid approval id, so the ONLY reason to reject
    // is the body itself.
    const buildBad: Array<() => Request> = [
      () => releaseRequest(approvalId, { rawBody: "{ not valid json at all" }), // malformed JSON
      () => releaseRequest(approvalId, { body: {} }), // no value
      () => releaseRequest(approvalId, { body: { value: null } }),
      () => releaseRequest(approvalId, { body: { value: 123 } }),
      () => releaseRequest(approvalId, { body: { value: {} } }),
      () => releaseRequest(approvalId, { body: { value: [] } }),
    ];
    for (const build of buildBad) {
      const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
      const res = await callPost(handler, build(), approvalId);
      assert4xx(res);
      assert.equal(store.collect(keyForApproval(userId, agentId)), undefined, "mis-shaped input releases nothing");
    }
    assert.deepEqual(await lookupForUser(db, userId, CLOCK), [], "mis-shaped input writes no fingerprint");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] an oversized value is rejected with a 4xx before any release", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-oversize", keyWrapper);
    const agentId = randomUUID();
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // A value padded past any reasonable cap (~2 MiB), with a valid session + step-up.
    const huge = "x".repeat(2 * 1024 * 1024);
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
    const res = await callPost(handler, releaseRequest(approvalId, { value: huge }), approvalId);

    assert4xx(res);
    assert.equal(store.collect(keyForApproval(userId, agentId)), undefined, "an oversized value releases nothing");
    assert.deepEqual(await lookupForUser(db, userId, CLOCK), [], "and writes no fingerprint");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] a SQL-shaped value is stored only as its fingerprint, the table survives, and the value round-trips to the store", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-sqlvalue", keyWrapper);
    const agentId = randomUUID();
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // A value shaped like a classic injection. Only its one-way HMAC (hex) ever reaches the
    // db, bound as a parameter — so a SQL-shaped value cannot alter a statement.
    const VALUE = "robert'); DROP TABLE release_fingerprints; --";
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
    const res = await callPost(handler, releaseRequest(approvalId, { value: VALUE }), approvalId);
    assert2xx(res);

    await db.query("SELECT 1 FROM release_fingerprints LIMIT 1");
    assert.equal(await tableExists(db, "release_fingerprints"), true, "the release_fingerprints table survives the probe");
    assert.equal(store.collect(keyForApproval(userId, agentId)), VALUE, "the SQL-shaped value round-trips verbatim as data to the store");
    assert.ok(
      (await lookupForUser(db, userId, CLOCK)).includes(fingerprint(dek, VALUE)),
      "only the keyed fingerprint of the value is persisted",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC [obligation:secrets-from-env] (INV-103) — config flows in through the injected seams;
// no ambient env secret is folded into the release response or its persisted state.
// =====================================================================================

test("[secrets-from-env] no ambient env secret is folded into a release response or the persisted fingerprint", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-secrets", keyWrapper);
    const agentId = randomUUID();
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // The handler runs purely from its injected seams (no config seam passed), so no
    // ambient process.env is read — a decoy secret can never surface.
    const { handler } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
    const res = await callPost(handler, releaseRequest(approvalId, { value: `v-${randomUUID()}` }), approvalId);

    const serialised = await serialiseResponse(res);
    assert.ok(!serialised.includes(DECOY), "no ambient env secret appears in the release response");
    for (const fp of await lookupForUser(db, userId, CLOCK)) {
      assert.ok(!fp.includes(DECOY), "no ambient env secret is folded into the persisted fingerprint");
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
