// E11-S18 — Vault unlock endpoints: the injectable HTTP handlers over the existing
// server `createVaultUnlockActions` (design §4.2 "Device-held vault"; brief "Vault unlock
// methods"). INV-101 (admin-auth-required — this is an authenticated route),
// INV-102 (validate-and-parameterize-input), INV-103 (secrets-from-env).
//
// RED-first: the module under test (`./unlock-http`, `createVaultUnlockHttpHandlers`) does
// NOT exist yet, so importing it throws and EVERY test here fails until the builder writes
// it. That absence IS the point of test-first — as the TESTER I must NOT create or edit any
// implementation/source file to make these pass; the builder writes `unlock-http.ts` (and
// the two thin `route.ts` entries) afterwards, to the contract pinned below.
//
// WHY this exists (task E11-S18): the inbox release (E11-S17) and vault setup fetch
// `/api/vault/unlock-material/<method>` and POST `/api/vault/unlock-method`, which do not
// exist, so no device can unlock the vault. This endpoint pair is the HTTP surface over the
// already-built server actions:
//   GET  /api/vault/unlock-material/[method]   (method ∈ { passkey_prf, passphrase })
//        → { wrapped, params, options }:
//          • passphrase  — the person's wrapped VK envelope (null when none is set) and the
//            method's public params (its salt / iterations); no assertion options.
//          • passkey_prf — the wrapped VK plus WebAuthn authentication `options` whose PRF
//            extension EVALUATES the person's stored PRF salt (so the browser can derive the
//            same wrapping key locally). No secret is ever returned.
//   POST /api/vault/unlock-method
//        → saves a wrapped VK (+ public params) for the signed-in person's method; a later
//          GET returns it. Session-scoped, Origin-checked.
//
// These tests pin BEHAVIOUR (the HTTP outcome and the persisted/returned state, observed
// through the ALREADY-BUILT store + the real client contract), never the SOURCE TEXT of any
// module — a later behaviour-preserving rename must not redden them. State is arranged
// through the real repos (`createUser`, `saveWrappedKey`, real `createSession`) against an
// isolated in-memory PGlite (src/test/db). Tests never touch the network or Azure; every db
// handle is closed in a `finally`.
//
// ───────────────────────────────────────────────────────────────────────────────────────
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   import type { Session } from "../auth/session";
//   import type { Db } from "../db/index";
//   import type { Random } from "../seams/random";
//
//   interface VaultUnlockHttpSeams {                     // every seam optional, production
//     resolveSession?: (request: Request) => Promise<Session | null>; // default resolves the
//                                                                      // host-locked cookie
//     db?:            Db;      // the shared database (every query parameter-bound, INV-102)
//     random?:        Random;  // entropy for the fixed per-person PRF salt
//     rpId?:          string;  // the configured WebAuthn RP ID (never hard-coded)
//     publicOrigin?:  string;  // the origin a POST's Origin header is checked against
//   }
//
//   // Each route.ts exports ONLY its framework verb (OBS-025, pinned in the sibling
//   // route.test.ts): unlock-material/[method] exports GET, unlock-method exports POST. The
//   // injectable factory lives HERE in src/server/vault/unlock-http.ts.
//   createVaultUnlockHttpHandlers(seams?): {
//     getMaterial(request: Request, method: string): Promise<Response>;  // GET material
//     saveMethod(request: Request): Promise<Response>;                   // POST a method
//   }
//     (these tests tolerate a few reasonable method-name choices — see getMaterialFn /
//      saveMethodFn — so they pin the HTTP behaviour, not the exact property names.)
//
//     GET getMaterial(request, method):
//       1. method must be one of { passkey_prf, passphrase } — anything else is 404 (a read
//          is NOT Origin-gated: browsers omit Origin on a same-origin GET).
//       2. Resolve the session; no session → 401. Identity is the session's user id, never a
//          client value — member-scoped by it.
//       3. Return { wrapped, params, options } for the session user's method. No secret.
//
//     POST saveMethod(request):
//       1. The request Origin must equal the configured publicOrigin — a missing or foreign
//          Origin is 403 and stores nothing (design §5; cross-site writes are refused).
//       2. Resolve the session; no session → 401.
//       3. Validate the body ({ method, wrapped, params? }); malformed / oversized / mis-
//          shaped → a 4xx (never a 500, INV-102). Persist the wrapped VK for the SESSION
//          user's method (bound as parameters, INV-102).
//
// The obligation acceptance criteria (admin-auth-required, validate-and-parameterize-input,
// secrets-from-env) are pinned below alongside the behaviour, as the repo's route tests do.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createVaultUnlockHttpHandlers } from "./unlock-http";

// The already-built store this endpoint composes — used ONLY to arrange and cross-check
// persistence at the data layer (never re-implemented here).
import {
  getOrCreatePrfSalt,
  getWrappedKey,
  saveWrappedKey,
} from "../db/vault-unlock-methods";
import { createUser } from "../db/users";
import {
  createSession,
  verifySession,
  COOKIE_NAME,
  type Session,
} from "../auth/session";
import { systemRandom } from "../seams/random";
import { fixedClock, type Clock } from "../seams/clock";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";

// --- fixtures ------------------------------------------------------------------------------

// The configured WebAuthn RP ID + public origin the handlers are built with. The GET's
// passkey options must carry THIS rpId (config-driven, not hard-coded), and the POST's
// Origin check must accept exactly THIS origin.
const RP_ID = "warthog.com.au";
const ORIGIN = "https://warthog.com.au";

// A frozen instant for the real session path (createSession / verifySession read it).
const T0 = new Date("2026-11-15T12:00:00.000Z");
const CLOCK: Clock = fixedClock(T0);

// A unique tag so accounts never collide on the users.email UNIQUE across tests.
function tag(): string {
  return randomBytes(6).toString("hex");
}

// A stand-in wrapped DEK for createUser (opaque; this flow never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}-${tag()}`).toString("base64");
}

// Create a person and return their id — the member scope every read/write filters by (the
// session's user id; a real users row so the FK on the vault tables is satisfied).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}-${tag()}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A representative opaque `v1:` wrapped-VK envelope (the shape the browser stores).
function wrappedEnvelope(seed: string): string {
  return `v1:${Buffer.from(`wrapped-vk-${seed}-${tag()}`).toString("base64")}`;
}

// A plain session for `userId` — the identity the endpoints must trust over any client
// value. Unlock material is non-secret, so no step-up is required (unlike a release).
function sessionFor(userId: string): Session {
  return {
    id: `sess-${userId}-${tag()}`,
    userId,
    createdAt: T0,
    lastSeenAt: T0,
    steppedUpAt: null,
  };
}

// A session that confirmed "it's you" `ageMs` before T0 — fresh within five minutes. Replacing
// an existing unlock method is a security change, so it needs one (review fix W1).
function steppedUpSessionFor(userId: string, ageMs = 60_000): Session {
  return { ...sessionFor(userId), steppedUpAt: new Date(T0.getTime() - ageMs) };
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
// over `db` (never trusting any other client value — INV-101). Proves a genuinely verified
// session is admitted and an unverifiable cookie is refused.
function realResolveSession(db: Db, clock: Clock) {
  return async (request: Request): Promise<Session | null> => {
    const token = readCookie(request, COOKIE_NAME);
    return token ? verifySession(db, token, { clock }) : null;
  };
}

// A GET to the unlock-material endpoint. The method rides in the path; a session cookie and
// an Origin header are attached when given.
function getRequest(
  method: string,
  opts: { cookie?: string; origin?: string } = {},
): Request {
  const url = `https://warthog.com.au/api/vault/unlock-material/${encodeURIComponent(method)}`;
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.cookie !== undefined) headers.cookie = `${COOKIE_NAME}=${opts.cookie}`;
  return new Request(url, { method: "GET", headers });
}

// A POST to the unlock-method endpoint. `rawBody` sends a verbatim string (for malformed
// JSON); otherwise `body` is JSON-encoded. A session cookie and an Origin header are
// attached when given.
function postRequest(
  opts: { body?: unknown; rawBody?: string; cookie?: string; origin?: string } = {},
): Request {
  const url = "https://warthog.com.au/api/vault/unlock-method";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.cookie !== undefined) headers.cookie = `${COOKIE_NAME}=${opts.cookie}`;
  const payload = opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(opts.body ?? {});
  return new Request(url, { method: "POST", headers, body: payload });
}

// Build the handlers under test from injected seams. `session` becomes the resolved session
// (or pass `resolveSession` for the real cookie→verifySession path).
function makeHandlers(opts: {
  db: Db;
  session?: Session | null;
  resolveSession?: (request: Request) => Promise<Session | null>;
  random?: typeof systemRandom;
  rpId?: string;
  publicOrigin?: string;
  clock?: Clock;
}): { handlers: unknown } {
  const resolveSession =
    opts.resolveSession ?? (async () => (opts.session === undefined ? null : opts.session));
  const handlers = createVaultUnlockHttpHandlers({
    db: opts.db,
    random: opts.random ?? systemRandom,
    rpId: opts.rpId ?? RP_ID,
    publicOrigin: opts.publicOrigin ?? ORIGIN,
    clock: opts.clock ?? CLOCK,
    resolveSession,
  });
  return { handlers };
}

// Extract the GET handler, tolerant of a few reasonable property names a factory might use
// for "serve the unlock material" — so these tests pin the HTTP behaviour, not the names.
function getMaterialFn(handlers: unknown): (r: Request, m: string) => Promise<Response> {
  const h = handlers as Record<string, unknown>;
  const fn = h.getMaterial ?? h.getUnlockMaterial ?? h.material ?? h.GET ?? h.get;
  if (typeof fn !== "function") {
    throw new Error("the vault-unlock handlers expose no GET unlock-material handler");
  }
  return (fn as (r: Request, m: string) => Promise<Response>).bind(handlers);
}

// Extract the POST handler, tolerant of a few reasonable property names.
function saveMethodFn(handlers: unknown): (r: Request) => Promise<Response> {
  const h = handlers as Record<string, unknown>;
  const fn = h.saveMethod ?? h.saveUnlockMethod ?? h.method ?? h.POST ?? h.post;
  if (typeof fn !== "function") {
    throw new Error("the vault-unlock handlers expose no POST unlock-method handler");
  }
  return (fn as (r: Request) => Promise<Response>).bind(handlers);
}

// Decode a WebAuthn PRF eval input to bytes. A JSON options object carries the eval input as
// a base64url string (what @simplewebauthn/browser decodes at unlock time); standard base64
// decodes byte-identically through the same lenient decoder, so both are accepted. HEX is
// deliberately NOT accepted — a hex-encoded eval would be base64url-decoded to garbage by the
// real browser and silently break unlock, so it must fail this assertion rather than pass it.
function decodeCandidates(s: string): Buffer[] {
  const out: Buffer[] = [];
  const push = (b: Buffer): void => {
    if (b.length > 0) out.push(b);
  };
  try {
    push(Buffer.from(s, "base64url"));
  } catch {
    /* not base64url */
  }
  try {
    push(Buffer.from(s, "base64"));
  } catch {
    /* not base64 */
  }
  return out;
}

// Whether a relation of this exact name exists — a non-throwing probe for survival tests.
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Flatten a response (status + headers + body) to a string, so a test can assert an ambient
// secret or token never appears anywhere in it.
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

// ===========================================================================================
// Construction is side-effect-free — importing a route entry that builds these at module load
// must boot no database and read no config (the server-composition-roots addendum; OBS-025).
// ===========================================================================================

test("constructing the handlers with no seams reads no config and opens no database", () => {
  // The defaults must resolve lazily, per request, so merely building the handlers (as the
  // thin route entry does at import) never throws, reads process.env, or opens a database.
  assert.doesNotThrow(() => createVaultUnlockHttpHandlers());
});

// ===========================================================================================
// AC1 — a signed-in GET /unlock-material/passphrase returns the person's own wrapped key and
// passphrase params (null wrapped when none is set); /passkey_prf additionally returns
// assertion options carrying the PRF extension with the person's PRF salt.
// ===========================================================================================

test("AC1: GET /passphrase returns the person's own wrapped key and passphrase params (and no assertion options)", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "pp-ok");
    const wrapped = wrappedEnvelope("pp");
    const params = { salt: "c2FsdHktc2FsdHktc2FsdA==", iterations: 600000 };
    await saveWrappedKey(db, { userId: a, method: "passphrase", wrappedKey: wrapped, params });

    const { handlers } = makeHandlers({ db, session: sessionFor(a) });
    const res = await getMaterialFn(handlers)(getRequest("passphrase", { origin: ORIGIN }), "passphrase");
    assert2xx(res);

    const body = (await res.json()) as {
      wrapped: unknown;
      params: unknown;
      options?: unknown;
    };
    assert.equal(body.wrapped, wrapped, "the person's own wrapped VK envelope is returned");
    assert.deepEqual(body.params, params, "the passphrase salt / iteration params are returned verbatim");
    assert.ok(body.options == null, "a passphrase method carries no passkey assertion options");
  } finally {
    await db.close();
  }
});

test("AC1: GET /passphrase returns a null wrapped key when the person has set none", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "pp-none");
    const { handlers } = makeHandlers({ db, session: sessionFor(a) });

    const res = await getMaterialFn(handlers)(getRequest("passphrase", { origin: ORIGIN }), "passphrase");
    assert2xx(res);

    const body = (await res.json()) as { wrapped: unknown; params: unknown };
    assert.equal(body.wrapped, null, "no passphrase set ⇒ a null wrapped key, never a fabricated one");
    assert.deepEqual(body.params, {}, "no params ⇒ an empty object");
  } finally {
    await db.close();
  }
});

test("AC1: GET /passkey_prf returns the wrapped key plus assertion options whose PRF extension evaluates the person's stored salt", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "prf-ok");
    const wrapped = wrappedEnvelope("prf");
    await saveWrappedKey(db, { userId: a, method: "passkey_prf", wrappedKey: wrapped, params: {} });

    const { handlers } = makeHandlers({ db, session: sessionFor(a), rpId: RP_ID });
    const res = await getMaterialFn(handlers)(getRequest("passkey_prf", { origin: ORIGIN }), "passkey_prf");
    assert2xx(res);

    const body = (await res.json()) as {
      wrapped: unknown;
      options?: {
        challenge?: unknown;
        rpId?: unknown;
        extensions?: { prf?: { eval?: { first?: unknown } } };
      } | null;
    };
    assert.equal(body.wrapped, wrapped, "the person's own wrapped VK envelope is returned");

    const options = body.options;
    assert.ok(options != null, "passkey_prf returns WebAuthn authentication options");
    assert.equal(typeof options.challenge, "string", "the options carry a challenge");
    assert.ok((options.challenge as string).length > 0, "the challenge is non-empty");
    assert.equal(options.rpId, RP_ID, "the options carry the CONFIGURED RP ID, never a hard-coded one");

    const evalFirst = options.extensions?.prf?.eval?.first;
    assert.equal(typeof evalFirst, "string", "the PRF extension carries an eval.first input");
    assert.ok((evalFirst as string).length > 0, "the PRF eval input is non-empty");

    // The eval input IS the person's fixed, stored PRF salt (so the browser derives the SAME
    // wrapping key it sealed with). getOrCreatePrfSalt returns that stable hex salt.
    const salt = await getOrCreatePrfSalt(db, a, { random: systemRandom });
    const saltBytes = Buffer.from(salt, "hex");
    assert.ok(
      decodeCandidates(evalFirst as string).some((c) => c.equals(saltBytes)),
      "the PRF extension evaluates the person's stored PRF salt bytes",
    );
  } finally {
    await db.close();
  }
});

test("AC1: the PRF eval salt is stable across GETs for one person and differs between people", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "prf-a");
    const b = await makeUser(db, "prf-b");
    await saveWrappedKey(db, { userId: a, method: "passkey_prf", wrappedKey: wrappedEnvelope("a"), params: {} });
    await saveWrappedKey(db, { userId: b, method: "passkey_prf", wrappedKey: wrappedEnvelope("b"), params: {} });

    const ha = makeHandlers({ db, session: sessionFor(a) }).handlers;
    const hb = makeHandlers({ db, session: sessionFor(b) }).handlers;

    const evalFor = async (h: unknown): Promise<string> => {
      const res = await getMaterialFn(h)(getRequest("passkey_prf", { origin: ORIGIN }), "passkey_prf");
      const body = (await res.json()) as { options?: { extensions?: { prf?: { eval?: { first?: string } } } } };
      const e = body.options?.extensions?.prf?.eval?.first;
      assert.equal(typeof e, "string", "each passkey_prf GET carries a PRF eval input");
      return e as string;
    };

    const a1 = await evalFor(ha);
    const a2 = await evalFor(ha);
    const b1 = await evalFor(hb);

    assert.equal(a1, a2, "the same person's PRF eval salt is stable across calls (a fixed per-person salt)");
    assert.notEqual(a1, b1, "a different person gets a different PRF eval salt");
  } finally {
    await db.close();
  }
});

// ===========================================================================================
// AC2 — POST /unlock-method stores a wrapped vault key for the signed-in person's method, and
// a later GET returns it; another person's material is never returned (member-scoped by the
// session).
// ===========================================================================================

test("AC2: POST /unlock-method stores a wrapped key and a later GET returns it (round-trip)", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "rt-a");
    const { handlers } = makeHandlers({ db, session: sessionFor(a) });

    const wrapped = wrappedEnvelope("rt");
    const params = { salt: "YWJjZGVmZ2hpamtsbW5vcA==", iterations: 310000 };
    const post = await saveMethodFn(handlers)(
      postRequest({ body: { method: "passphrase", wrapped, params }, origin: ORIGIN }),
    );
    assert2xx(post);

    const get = await getMaterialFn(handlers)(getRequest("passphrase", { origin: ORIGIN }), "passphrase");
    assert2xx(get);
    const body = (await get.json()) as { wrapped: unknown; params: unknown };
    assert.equal(body.wrapped, wrapped, "the GET returns exactly what the POST stored");
    assert.deepEqual(body.params, params, "the POSTed public params round-trip verbatim");

    // Cross-check at the data layer: it was persisted under the session user.
    const stored = await getWrappedKey(db, a, "passphrase");
    assert.equal(stored?.wrappedKey, wrapped, "the wrapped key is persisted for the signed-in person");
  } finally {
    await db.close();
  }
});

test("AC2: a re-save for a method replaces its wrapped key (one wrapped key per method)", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "replace");
    // Replacing an existing method needs a fresh step-up (review fix W1).
    const { handlers } = makeHandlers({ db, session: steppedUpSessionFor(a) });
    const save = saveMethodFn(handlers);

    const first = wrappedEnvelope("first");
    const second = wrappedEnvelope("second");
    assert2xx(await save(postRequest({ body: { method: "passkey_prf", wrapped: first }, origin: ORIGIN })));
    assert2xx(await save(postRequest({ body: { method: "passkey_prf", wrapped: second }, origin: ORIGIN })));

    const get = await getMaterialFn(handlers)(getRequest("passkey_prf", { origin: ORIGIN }), "passkey_prf");
    const body = (await get.json()) as { wrapped: unknown };
    assert.equal(body.wrapped, second, "the latest wrapped key replaces the earlier one");
  } finally {
    await db.close();
  }
});

test("AC2: material is member-scoped by the session — each person's POST and GET see only their own", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "ms-a");
    const b = await makeUser(db, "ms-b");
    const ha = makeHandlers({ db, session: sessionFor(a) }).handlers;
    const hb = makeHandlers({ db, session: sessionFor(b) }).handlers;

    const wA = wrappedEnvelope("ms-a");
    const wB = wrappedEnvelope("ms-b");
    assert2xx(await saveMethodFn(ha)(postRequest({ body: { method: "passphrase", wrapped: wA }, origin: ORIGIN })));
    assert2xx(await saveMethodFn(hb)(postRequest({ body: { method: "passphrase", wrapped: wB }, origin: ORIGIN })));

    const aGet = (await (await getMaterialFn(ha)(getRequest("passphrase", { origin: ORIGIN }), "passphrase")).json()) as { wrapped: unknown };
    const bGet = (await (await getMaterialFn(hb)(getRequest("passphrase", { origin: ORIGIN }), "passphrase")).json()) as { wrapped: unknown };

    assert.equal(aGet.wrapped, wA, "A's GET returns A's wrapped key");
    assert.equal(bGet.wrapped, wB, "B's GET returns B's wrapped key");
    assert.notEqual(aGet.wrapped, bGet.wrapped, "the two people never see each other's material");

    assert.equal((await getWrappedKey(db, a, "passphrase"))?.wrappedKey, wA, "A's row holds A's key");
    assert.equal((await getWrappedKey(db, b, "passphrase"))?.wrappedKey, wB, "B's row holds B's key");
  } finally {
    await db.close();
  }
});

test("AC2: a person who has saved nothing for a method gets null — never another person's key", async () => {
  const db = await freshDb();
  try {
    const owner = await makeUser(db, "owner");
    const intruder = await makeUser(db, "intruder");
    await saveWrappedKey(db, { userId: owner, method: "passphrase", wrappedKey: wrappedEnvelope("owner") });

    const hb = makeHandlers({ db, session: sessionFor(intruder) }).handlers;
    const res = await getMaterialFn(hb)(getRequest("passphrase", { origin: ORIGIN }), "passphrase");
    assert2xx(res);
    const body = (await res.json()) as { wrapped: unknown };
    assert.equal(body.wrapped, null, "the owner's wrapped key is never returned to another person");
  } finally {
    await db.close();
  }
});

test("AC2: a userId smuggled in the POST body can never cause a write under another person", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "smuggle-a");
    const victim = await makeUser(db, "smuggle-victim");
    const { handlers } = makeHandlers({ db, session: sessionFor(a) });

    const wrapped = wrappedEnvelope("smuggle");
    const res = await saveMethodFn(handlers)(
      postRequest({
        // Identity is the session's user id; a body-supplied userId must be ignored.
        body: { method: "passphrase", wrapped, userId: victim, user_id: victim },
        origin: ORIGIN,
      }),
    );
    assert.ok(res.status < 500, `a smuggled userId must never be a 5xx, got ${res.status}`);

    // The security invariant, regardless of whether the extra key is stripped or rejected:
    // the victim's row is NEVER written from another person's session.
    assert.equal(await getWrappedKey(db, victim, "passphrase"), null, "the victim's material is never written");
  } finally {
    await db.close();
  }
});

// ===========================================================================================
// AC [obligation:admin-auth-required] (INV-101) — both endpoints require a server-verified
// session; identity is never a client value. No session → 401.
// ===========================================================================================

test("[admin-auth-required] a GET with no session is 401", async () => {
  const db = await freshDb();
  try {
    const { handlers } = makeHandlers({ db, session: null });
    const res = await getMaterialFn(handlers)(getRequest("passphrase", { origin: ORIGIN }), "passphrase");
    assert.equal(res.status, 401, "an unauthenticated read is rejected");
  } finally {
    await db.close();
  }
});

test("[admin-auth-required] a POST with no session is 401 (a valid Origin, so only the session is missing)", async () => {
  const db = await freshDb();
  try {
    const { handlers } = makeHandlers({ db, session: null });
    const res = await saveMethodFn(handlers)(
      postRequest({ body: { method: "passphrase", wrapped: wrappedEnvelope("unauth") }, origin: ORIGIN }),
    );
    assert.equal(res.status, 401, "an unauthenticated write is rejected");
  } finally {
    await db.close();
  }
});

test("[admin-auth-required] a garbage/unknown session cookie is treated as unauthenticated (real verifySession)", async () => {
  const db = await freshDb();
  try {
    const { handlers } = makeHandlers({ db, resolveSession: realResolveSession(db, CLOCK) });
    const res = await getMaterialFn(handlers)(
      getRequest("passphrase", { origin: ORIGIN, cookie: `no-such-session-${tag()}` }),
      "passphrase",
    );
    assert.equal(res.status, 401, "an unverifiable cookie is unauthenticated");
  } finally {
    await db.close();
  }
});

test("[admin-auth-required] a genuinely verified session is admitted (real cookie → verifySession)", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "real-ok");
    const wrapped = wrappedEnvelope("real");
    await saveWrappedKey(db, { userId: a, method: "passphrase", wrappedKey: wrapped });
    const { token } = await createSession(db, a, { clock: CLOCK, random: systemRandom });

    const { handlers } = makeHandlers({ db, resolveSession: realResolveSession(db, CLOCK) });
    const res = await getMaterialFn(handlers)(getRequest("passphrase", { origin: ORIGIN, cookie: token }), "passphrase");
    assert2xx(res);
    const body = (await res.json()) as { wrapped: unknown };
    assert.equal(body.wrapped, wrapped, "a verified session reads its own material");
  } finally {
    await db.close();
  }
});

// ===========================================================================================
// AC — Origin: a missing or foreign Origin on POST is 403; a GET is not Origin-gated.
// ===========================================================================================

test("[origin] a POST with no Origin header is 403 and stores nothing", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "origin-none");
    const { handlers } = makeHandlers({ db, session: sessionFor(a) });

    // A valid session but NO Origin header → the only reason to reject is the missing Origin.
    const res = await saveMethodFn(handlers)(
      postRequest({ body: { method: "passphrase", wrapped: wrappedEnvelope("no-origin") } }),
    );
    assert.equal(res.status, 403, "a missing Origin is forbidden on a write");
    assert.equal(await getWrappedKey(db, a, "passphrase"), null, "nothing is stored when the Origin is missing");
  } finally {
    await db.close();
  }
});

test("[origin] a POST with a foreign Origin is 403 and stores nothing", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "origin-foreign");
    const { handlers } = makeHandlers({ db, session: sessionFor(a) });

    const res = await saveMethodFn(handlers)(
      postRequest({
        body: { method: "passphrase", wrapped: wrappedEnvelope("foreign") },
        origin: "https://evil.example.com",
      }),
    );
    assert.equal(res.status, 403, "a cross-site Origin is forbidden on a write");
    assert.equal(await getWrappedKey(db, a, "passphrase"), null, "a cross-site write stores nothing");
  } finally {
    await db.close();
  }
});

test("[origin] a GET is NOT Origin-gated — a same-origin read (which browsers send without an Origin header) succeeds", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "get-no-origin");
    const wrapped = wrappedEnvelope("get-no-origin");
    await saveWrappedKey(db, { userId: a, method: "passphrase", wrappedKey: wrapped });

    const { handlers } = makeHandlers({ db, session: sessionFor(a) });
    // No Origin header at all — the shape of a real same-origin fetch GET.
    const res = await getMaterialFn(handlers)(getRequest("passphrase"), "passphrase");
    assert.notEqual(res.status, 403, "a read must not be forbidden for want of an Origin header");
    assert2xx(res);
    const body = (await res.json()) as { wrapped: unknown };
    assert.equal(body.wrapped, wrapped, "the material is served to the signed-in person");
  } finally {
    await db.close();
  }
});

// ===========================================================================================
// AC — an unknown method is 404. The GET serves only { passkey_prf, passphrase }.
// ===========================================================================================

test("[unknown-method] a GET for a method outside { passkey_prf, passphrase, recovery } is 404, and a method probe cannot alter a query", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "unknown-method");
    const { handlers } = makeHandlers({ db, session: sessionFor(a) });
    const get = getMaterialFn(handlers);

    // Every one of these is plainly unknown ("recovery" is now served — review fix W1),
    // including a path-traversal and a SQL-injection probe.
    const unknown = [
      "RECOVERY",
      "banana",
      "PASSPHRASE",
      "passkey",
      "../../etc/passwd",
      "robert'); DROP TABLE vault_unlock_methods; --",
      "",
    ];
    for (const method of unknown) {
      const res = await get(getRequest(method, { origin: ORIGIN }), method);
      assert.equal(res.status, 404, `an unknown method ${JSON.stringify(method)} must be 404`);
    }

    // The injection probe never ran as SQL: the table is intact.
    await db.query("SELECT 1 FROM vault_unlock_methods LIMIT 1");
    assert.equal(await tableExists(db, "vault_unlock_methods"), true, "the table survives every unknown-method probe");
  } finally {
    await db.close();
  }
});

// ===========================================================================================
// AC [obligation:validate-and-parameterize-input] (INV-102) — malformed / oversized / mis-
// shaped input is a 4xx (never a 500); a SQL-shaped value is treated purely as data (bound).
// ===========================================================================================

test("[validate-and-parameterize-input] a malformed or mis-shaped POST body is a 4xx (never a 500) and stores nothing", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "malformed");
    const { handlers } = makeHandlers({ db, session: sessionFor(a) });
    const save = saveMethodFn(handlers);

    // A valid session + valid Origin, so the ONLY reason to reject is the body itself.
    const buildBad: Array<() => Request> = [
      () => postRequest({ rawBody: "{ not valid json at all", origin: ORIGIN }), // malformed JSON
      () => postRequest({ body: {}, origin: ORIGIN }), // no method, no wrapped
      () => postRequest({ body: { method: "passphrase" }, origin: ORIGIN }), // no wrapped
      () => postRequest({ body: { wrapped: wrappedEnvelope("x") }, origin: ORIGIN }), // no method
      () => postRequest({ body: { method: "banana", wrapped: wrappedEnvelope("x") }, origin: ORIGIN }), // bad method
      () => postRequest({ body: { method: "passphrase", wrapped: "" }, origin: ORIGIN }), // empty wrapped
      () => postRequest({ body: { method: "passphrase", wrapped: 123 }, origin: ORIGIN }), // non-string wrapped
      () => postRequest({ body: { method: "passphrase", wrapped: wrappedEnvelope("x"), params: "nope" }, origin: ORIGIN }), // bad params
    ];
    for (const build of buildBad) {
      const res = await save(build());
      assert4xx(res);
    }
    assert.equal(await getWrappedKey(db, a, "passphrase"), null, "no mis-shaped POST stored anything");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] an oversized POST body is rejected with a 4xx before any store", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "oversize");
    const { handlers } = makeHandlers({ db, session: sessionFor(a) });

    // A wrapped envelope padded far past any genuine one (~2 MiB), with a valid session + Origin.
    const huge = `v1:${"x".repeat(2 * 1024 * 1024)}`;
    const res = await saveMethodFn(handlers)(
      postRequest({ body: { method: "passphrase", wrapped: huge }, origin: ORIGIN }),
    );
    assert4xx(res);
    assert.equal(await getWrappedKey(db, a, "passphrase"), null, "an oversized body stores nothing");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] a SQL-shaped wrapped value is stored only as bound data, the table survives, and it round-trips", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "sql-value");
    const { handlers } = makeHandlers({ db, session: sessionFor(a) });

    // Classic injection shapes in both the opaque envelope and a public param: bound as
    // parameters, they are stored as data and cannot alter any statement (INV-102).
    const wrapped = "v1:robert'); DROP TABLE vault_unlock_methods; --";
    const params = { salt: "x'); DROP TABLE vault_prf_salts; --", iterations: 310000 };
    const post = await saveMethodFn(handlers)(
      postRequest({ body: { method: "passphrase", wrapped, params }, origin: ORIGIN }),
    );
    assert2xx(post);

    await db.query("SELECT 1 FROM vault_unlock_methods LIMIT 1");
    assert.equal(await tableExists(db, "vault_unlock_methods"), true, "the unlock-methods table survives the probe");
    assert.equal(await tableExists(db, "vault_prf_salts"), true, "the prf-salts table survives the probe");

    const get = await getMaterialFn(handlers)(getRequest("passphrase", { origin: ORIGIN }), "passphrase");
    const body = (await get.json()) as { wrapped: unknown; params: unknown };
    assert.equal(body.wrapped, wrapped, "the SQL-shaped envelope round-trips verbatim as data");
    assert.deepEqual(body.params, params, "the SQL-shaped param round-trips verbatim as data");
  } finally {
    await db.close();
  }
});

// ===========================================================================================
// AC [obligation:secrets-from-env] (INV-103) + "no secret is ever returned" — config flows
// through the injected seams; no ambient env secret and no session token is folded into a
// response.
// ===========================================================================================

test("[secrets-from-env] no ambient env secret is folded into a GET response (passphrase or passkey_prf)", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const a = await makeUser(db, "secrets");
    await saveWrappedKey(db, { userId: a, method: "passphrase", wrappedKey: wrappedEnvelope("pp"), params: { salt: "AAAA" } });
    await saveWrappedKey(db, { userId: a, method: "passkey_prf", wrappedKey: wrappedEnvelope("prf"), params: {} });

    // The handlers run purely from their injected seams, so no ambient process.env is read.
    const { handlers } = makeHandlers({ db, session: sessionFor(a) });
    const get = getMaterialFn(handlers);
    for (const method of ["passphrase", "passkey_prf"]) {
      const res = await get(getRequest(method, { origin: ORIGIN }), method);
      const serialised = await serialiseResponse(res);
      assert.ok(!serialised.includes(DECOY), `no ambient env secret appears in the ${method} response`);
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

test("[no-secret] the GET response never carries the session token and is limited to the non-secret material fields", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "no-secret");
    await saveWrappedKey(db, { userId: a, method: "passphrase", wrappedKey: wrappedEnvelope("ns"), params: { salt: "AAAA" } });
    const { token } = await createSession(db, a, { clock: CLOCK, random: systemRandom });

    const { handlers } = makeHandlers({ db, resolveSession: realResolveSession(db, CLOCK) });
    const res = await getMaterialFn(handlers)(getRequest("passphrase", { origin: ORIGIN, cookie: token }), "passphrase");
    assert2xx(res);

    const serialised = await serialiseResponse(res);
    assert.ok(!serialised.includes(token), "the session token never appears in the unlock-material response");

    // The response carries only the opaque wrapped envelope, salts (in params) and public
    // options — no internal fields (the DEK, the raw salt as a top-level secret, etc.).
    const body = (await res.json()) as Record<string, unknown>;
    const allowed = new Set(["wrapped", "params", "options"]);
    for (const key of Object.keys(body)) {
      assert.ok(allowed.has(key), `the response must carry only { wrapped, params, options }; found "${key}"`);
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================================
// Review fix W1 — the vault recovery phrase. The browser wraps the vault key under a key
// derived from a phrase only it ever sees and saves that envelope as method 'recovery'; the
// endpoint serves it back to the session person so they can unlock with the phrase. Replacing
// any EXISTING method is a security change: without a fresh step-up the POST inserts only.
// ===========================================================================================

test("W1: GET /recovery returns the person's own recovery envelope with no assertion options", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "recovery-get");
    const b = await makeUser(db, "recovery-get-other");
    const envelope = wrappedEnvelope("recovery-a");
    await saveWrappedKey(db, { userId: a, method: "recovery", wrappedKey: envelope });
    await saveWrappedKey(db, { userId: b, method: "recovery", wrappedKey: wrappedEnvelope("recovery-b") });

    const { handlers } = makeHandlers({ db, session: sessionFor(a) });
    const res = await getMaterialFn(handlers)(getRequest("recovery"), "recovery");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { wrapped: unknown; params: unknown; options: unknown };
    assert.equal(body.wrapped, envelope, "the session person's own recovery envelope comes back");
    assert.deepEqual(body.params, {});
    assert.equal(body.options, null, "a phrase unlock needs no passkey ceremony");
  } finally {
    await db.close();
  }
});

test("W1: GET /recovery returns a null envelope when the person has no recovery phrase yet", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "recovery-none");
    const { handlers } = makeHandlers({ db, session: sessionFor(a) });
    const res = await getMaterialFn(handlers)(getRequest("recovery"), "recovery");
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { wrapped: unknown }).wrapped, null);
  } finally {
    await db.close();
  }
});

test("W1: a first recovery envelope is saved with only a session (no step-up needed to add a method)", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "recovery-first");
    const { handlers } = makeHandlers({ db, session: sessionFor(a) });
    const envelope = wrappedEnvelope("first-recovery");
    assert2xx(await saveMethodFn(handlers)(postRequest({ body: { method: "recovery", wrapped: envelope }, origin: ORIGIN })));
    assert.equal((await getWrappedKey(db, a, "recovery"))?.wrappedKey, envelope);
  } finally {
    await db.close();
  }
});

test("W1: overwriting an existing method without a step-up is 403 step_up_required and keeps the stored envelope", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "overwrite-no-step-up");
    for (const method of ["passkey_prf", "passphrase", "recovery"] as const) {
      const kept = wrappedEnvelope(`kept-${method}`);
      await saveWrappedKey(db, { userId: a, method, wrappedKey: kept, params: { salt: "kept" } });

      const { handlers } = makeHandlers({ db, session: sessionFor(a) });
      const res = await saveMethodFn(handlers)(
        postRequest({ body: { method, wrapped: wrappedEnvelope(`garbage-${method}`), params: { salt: "x" } }, origin: ORIGIN }),
      );
      assert.equal(res.status, 403, `replacing ${method} with no step-up is refused`);
      assert.deepEqual(await res.json(), { error: "step_up_required" });
      const stored = await getWrappedKey(db, a, method);
      assert.equal(stored?.wrappedKey, kept, `the ${method} envelope is unchanged`);
      assert.deepEqual(stored?.params, { salt: "kept" }, `the ${method} params are unchanged`);
    }
  } finally {
    await db.close();
  }
});

test("W1: overwriting with a stale step-up (over five minutes old) is refused", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "overwrite-stale");
    const kept = wrappedEnvelope("kept");
    await saveWrappedKey(db, { userId: a, method: "recovery", wrappedKey: kept });
    const { handlers } = makeHandlers({ db, session: steppedUpSessionFor(a, 6 * 60_000) });
    const res = await saveMethodFn(handlers)(postRequest({ body: { method: "recovery", wrapped: wrappedEnvelope("new") }, origin: ORIGIN }));
    assert.equal(res.status, 403);
    assert.equal((await getWrappedKey(db, a, "recovery"))?.wrappedKey, kept);
  } finally {
    await db.close();
  }
});

test("W1: overwriting with a fresh step-up replaces the method (replacing the recovery phrase)", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "overwrite-fresh");
    await saveWrappedKey(db, { userId: a, method: "recovery", wrappedKey: wrappedEnvelope("old") });
    const replacement = wrappedEnvelope("replacement");
    const { handlers } = makeHandlers({ db, session: steppedUpSessionFor(a) });
    assert2xx(await saveMethodFn(handlers)(postRequest({ body: { method: "recovery", wrapped: replacement }, origin: ORIGIN })));
    assert.equal((await getWrappedKey(db, a, "recovery"))?.wrappedKey, replacement);
  } finally {
    await db.close();
  }
});

test("W1: concurrent first saves without a step-up keep exactly one envelope; the others are refused", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "first-save-race");
    const { handlers } = makeHandlers({ db, session: sessionFor(a) });
    const save = saveMethodFn(handlers);
    const envelopes = ["one", "two", "three"].map((seed) => wrappedEnvelope(seed));
    const responses = await Promise.all(
      envelopes.map((wrapped) => save(postRequest({ body: { method: "passkey_prf", wrapped }, origin: ORIGIN }))),
    );
    const statuses = responses.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 200).length, 1, `exactly one first save wins; got ${statuses}`);
    assert.equal(statuses.filter((s) => s === 403).length, 2, "the losers are told a step-up is needed to replace it");
    const winner = envelopes[statuses.indexOf(200)];
    assert.equal((await getWrappedKey(db, a, "passkey_prf"))?.wrappedKey, winner, "the stored vault key is the winner's");
  } finally {
    await db.close();
  }
});

test("W1: the unlock-material response is never cached", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "no-store");
    const { handlers } = makeHandlers({ db, session: sessionFor(a) });
    for (const method of ["passkey_prf", "passphrase", "recovery"]) {
      const res = await getMaterialFn(handlers)(getRequest(method), method);
      assert.match(res.headers.get("cache-control") ?? "", /no-store/, `${method} material is sent with no-store`);
    }
  } finally {
    await db.close();
  }
});
