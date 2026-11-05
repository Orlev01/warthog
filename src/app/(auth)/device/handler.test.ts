// E04-S31 — New-device sign-in handler (`src/app/(auth)/device/handler.ts`).
//
// RED-first: the device handler does not exist yet, so importing `./handler` throws
// and every test here fails until the builder adds it. That absence IS the point of
// test-first — do NOT implement anything to make these pass.
//
// These tests pin BEHAVIOUR (the HTTP outcome of each step, what gets stored/sent,
// and which device ends up with a session), never the source text of the module — a
// later rename that preserves behaviour must not redden them. There is no browser, no
// Azure and no network: the email one-time code, the approver's session + step-up, the
// pending request and the new device's session are all driven through the REAL sibling
// seams (email-code, session/step-up, and the new-device module this handler serves)
// against an isolated in-memory PGlite (src/test/db). Notifications land in a per-test
// outbox (src/server/notify/outbox), never the network.
//
// Why a sibling `handler.ts` (not `actions.ts` or `page.tsx`): a Next "use server"
// actions file may export only async server actions, and a `page.tsx` entry file only
// its framework fields — neither can carry an injectable, unit-testable factory without
// breaking `next build`. So the testable seam lives in a plain sibling module
// (`handler.ts`, the convention's `createXHandler({ db })` factory); the thin
// `actions.ts` / route verbs wrap it. These tests drive that seam directly with fakes.
//
// Why this exists (brief "Sign in on another device"; design §5: "New-device sign-in:
// … approval from a signed-in device via push + step-up"; §18 "Approvals only inside
// the signed-in app"; INV-102 validate-and-parameterize): the new-device module exists
// but nothing serves it, so a person cannot add a device by approving it from one they
// already use. This handler is that front door for the approval handshake: the new
// device REQUESTS approval, an existing signed-in device APPROVES after a fresh step-up,
// and the new device COLLECTS its session.
//
// ─── The contract this task defines (the builder implements exactly this) ────────────
//
//   createDeviceHandler(deps): {
//     requestApproval(req: Request): Promise<Response>  // new device: { email, code, deviceLabel }
//     approve(req: Request):         Promise<Response>  // signed-in device: { requestId }
//     collect(req: Request):         Promise<Response>  // new device: { requestId } -> session
//   }
//
//   deps (one bundle; each step reads the subset it needs):
//     { db: Db; clock: Clock; random: Random; hmacKey: Uint8Array;
//       emailSender: EmailSender;   // first-factor verify (throttle alert) collaborator
//       pushSender: PushSender;     // the one approval push
//       publicOrigin: string }      // the configured public origin, for the Origin check
//
//   Every step verifies the request `Origin` against `publicOrigin` FIRST: a missing or
//   foreign Origin is refused with 403 and changes nothing (design §5). Every step
//   validates its JSON body at the boundary (parseBody): malformed, oversized or
//   mis-shaped input → a 4xx Response, never an uncontrolled 500 (INV-102). Every query
//   the steps run is parameterized, so a SQL-injection probe in an input field is bound
//   as data and cannot alter a query (INV-102).
//
//   requestApproval — body { email, code, deviceLabel }. Verifies the email one-time code
//     (the first factor) and resolves the person, then records a pending request and
//     sends ONE approval push naming the device, returning 200 { requestId } — the
//     requesting device's own collection handle. No session is minted.
//
//   approve — body { requestId }. The approver's identity comes ONLY from the
//     `__Host-wh_session` cookie (member-scoped: the userId is the session's, never a
//     client value). Accepted only when that session passes a fresh step-up AND the
//     request belongs to the approver's OWN account; marks the request approved and
//     returns NO session to the approver (200 { ok: true }, no session Set-Cookie). No
//     session / wrong owner / stale step-up → a 4xx and nothing is approved.
//
//   collect — body { requestId }. Before approval, for an unknown handle, or a second
//     time → a 4xx with no session cookie. Once approved it mints the new device's
//     session exactly once, carried in the `__Host-wh_session` Set-Cookie (single use —
//     the handle is dropped on a successful collect).
//
// ─── Acceptance criteria → tests ─────────────────────────────────────────────────────
//   AC1 a request approved from the person's signed-in device collects a session on the
//       new device, exactly once; a second collect, or a collect before approval, yields
//       no session.
//   AC2 approving requires the approver's own session: another person's session (and a
//       request with no session at all) cannot approve the request.
//   AC3 every step checks Origin: a missing or foreign Origin is 403 and changes nothing
//       (no request started, nothing approved, the one-shot collect handle not consumed).
//   AC4 a handler rejects malformed / oversized / mis-shaped input with a 4xx, and a
//       SQL-injection probe in an input field cannot alter a query (parameter binding).
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own freshDb() and createOutbox(). requestIds and session tokens are drawn
// from the REAL random seam so the process-wide pending-request store never collides
// across the tests in this file (same discipline the new-device / recovery tests use).

import { test } from "node:test";
import assert from "node:assert/strict";

import { createDeviceHandler } from "./handler";

import { issueEmailCode } from "../../../server/auth/email-code";
import {
  createSession,
  recordStepUp,
  verifySession,
  COOKIE_NAME,
  type Session,
} from "../../../server/auth/session";
import { createUser, getUserByEmail, type User } from "../../../server/db/users";
import { createOutbox, type Outbox, type SentMessage } from "../../../server/notify/outbox";
import { systemRandom } from "../../../server/seams/random";
import { fixedClock, type Clock } from "../../../server/seams/clock";
import { freshDb } from "../../../test/db";
import type { Db } from "../../../server/db/index";

// A frozen instant: the approver steps up, approves and the new device collects all at
// the same clock, comfortably inside the step-up window and the session windows with no
// wall-clock dependence (same shape as the session / step-up tests).
const T0 = new Date("2026-05-01T00:00:00.000Z");

// The configured public origin the handler checks the request `Origin` against, and a
// foreign origin a cross-site request would carry.
const GOOD_ORIGIN = "https://warthog.com.au";
const FOREIGN_ORIGIN = "https://evil.example";

// One keyed HMAC for the email-code first factor: the test issuer and the handler's
// internal verify use the SAME key, so the emailed code verifies.
const HMAC_KEY = new Uint8Array(Buffer.from("warthog-device-handler-hmac-key-0123456789", "utf8"));

// A placeholder wrapped-DEK reference; createUser stores it verbatim. Its value is
// irrelevant — we only need a genuine `users` row so sessions and pending requests can
// hang off a real userId (the account id every member-scoped decision filters by).
const WRAPPED_DEK = "wrapped-dek-placeholder";

type DeviceHandler = ReturnType<typeof createDeviceHandler>;

// Build the handler under test with the real seams and the per-test outbox. The outbox
// satisfies both EmailSender and PushSender.
function makeHandler(db: Db, clock: Clock, outbox: Outbox): DeviceHandler {
  return createDeviceHandler({
    db,
    clock,
    random: systemRandom,
    hmacKey: HMAC_KEY,
    emailSender: outbox,
    pushSender: outbox,
    publicOrigin: GOOD_ORIGIN,
  });
}

// A JSON POST request carrying an `Origin` header and, optionally, a session cookie.
// `origin: null` sends no Origin at all (the cross-site / no-origin case). A raw string
// body is sent verbatim (for malformed JSON); anything else is JSON-encoded.
function deviceRequest(
  body: unknown,
  opts: { origin?: string | null; sessionToken?: string } = {},
): Request {
  const origin = opts.origin === undefined ? GOOD_ORIGIN : opts.origin;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  if (opts.sessionToken) headers.cookie = `${COOKIE_NAME}=${opts.sessionToken}`;
  return new Request("https://warthog.com.au/api/device", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// Create a genuine person row and return it. Distinct labels give distinct (unique)
// emails within a test, so two users never collide on the users.email UNIQUE.
async function freshUser(db: Db, label: string): Promise<User> {
  return createUser(db, { email: `${label}@warthog.com.au`, wrappedDek: WRAPPED_DEK });
}

// Pull the standalone 6-digit code out of a delivered email body (robust to the copy).
function extractCode(body: string): string {
  const match = body.match(/(?<!\d)\d{6}(?!\d)/);
  assert.ok(match, `the email body must carry a standalone 6-digit code: ${JSON.stringify(body)}`);
  return match[0];
}

// Issue an email one-time code for `email` through the REAL issuer and read the plaintext
// back from the one delivered email — exactly how the person receives it. The resulting
// code is the first factor requestApproval requires.
async function issueCodeFor(db: Db, email: string, clock: Clock, outbox: Outbox): Promise<string> {
  await issueEmailCode(db, email, { clock, random: systemRandom, hmacKey: HMAC_KEY, emailSender: outbox });
  const msg = outbox
    .list()
    .filter((m) => m.channel === "email" && m.recipient === email)
    .at(-1);
  assert.ok(msg, `issuing a code must deliver an email to ${email}`);
  return extractCode(msg.body);
}

// A 6-digit string that is NOT `code` (a genuine wrong guess of the same shape).
function wrongCode(code: string): string {
  const first = code[0] === "0" ? "1" : "0";
  return first + code.slice(1);
}

// Create a signed-in session for `userId` with a FRESH step-up stamped, returning the
// (stepped-up) Session plus the raw token the device holds — the shape an approver
// presents: an existing device approves after a step-up, carrying its session cookie.
async function freshStepUpSession(
  db: Db,
  userId: string,
  clock: Clock,
): Promise<{ session: Session; token: string }> {
  const created = await createSession(db, userId, { clock, random: systemRandom });
  const stepped = await recordStepUp(db, created.session.id, { clock });
  return { session: stepped, token: created.token };
}

// The push messages the outbox recorded (approval prompts travel on the push channel).
function pushes(outbox: Outbox): SentMessage[] {
  return outbox.list().filter((m) => m.channel === "push");
}

// How many sessions this person holds — the "is this device signed in" probe, filtered
// by the account id (parameterized, as feature code must be).
async function countSessions(db: Db, userId: string): Promise<number> {
  const result = await db.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1", [userId]);
  return Number(result.rows[0]?.n ?? -1);
}

// Pull the session token out of a response's `Set-Cookie` (the host-locked session
// cookie, value up to the first `;`). Asserts the response actually carries it.
function sessionTokenFromResponse(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "a successful collect must set a session cookie");
  assert.ok(
    setCookie.startsWith(`${COOKIE_NAME}=`),
    `the session cookie must be the host-locked ${COOKIE_NAME} cookie: ${JSON.stringify(setCookie)}`,
  );
  return setCookie.slice(`${COOKIE_NAME}=`.length).split(";")[0]!;
}

// Assert a response does NOT hand out a session cookie (no new device gets signed in
// here). Narrowly scoped to THIS response's Set-Cookie header.
function assertNoSessionCookie(res: Response, message: string): void {
  const setCookie = res.headers.get("set-cookie");
  assert.ok(!setCookie || !setCookie.includes(COOKIE_NAME), message);
}

// Start an approval request over the good origin and return the pending request's
// collection handle. Asserts the step itself succeeded so a later step fails for the
// right reason.
async function startRequest(
  handler: DeviceHandler,
  email: string,
  code: string,
  deviceLabel: string,
): Promise<string> {
  const res = await handler.requestApproval(deviceRequest({ email, code, deviceLabel }));
  assert.equal(res.status, 200, "a valid email code starts the approval request");
  const body = (await res.json()) as { requestId: string };
  assert.equal(typeof body.requestId, "string", "requestApproval hands back a collection handle");
  assert.ok(body.requestId.length > 0, "the collection handle is non-empty");
  return body.requestId;
}

// =====================================================================================
// AC1 — the approval handshake: request → approve (from a signed-in device) → collect a
// session on the NEW device, exactly once. A second collect, or a collect before
// approval, yields no session.
// =====================================================================================

test("device: a request approved from the signed-in device collects a session on the new device, exactly once", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, clock, outbox);
    const person = await freshUser(db, "handshake");
    const code = await issueCodeFor(db, person.email, clock, outbox);

    // New device requests approval — one push is sent, and it hands back a handle.
    const requestId = await startRequest(handler, person.email, code, "Oren's new iPhone");
    assert.equal(pushes(outbox).length, 1, "requesting approval sends exactly one push");

    // The person's EXISTING signed-in device (same account) steps up and approves.
    const approver = await freshStepUpSession(db, person.id, clock);
    const approveRes = await handler.approve(
      deviceRequest({ requestId }, { sessionToken: approver.token }),
    );
    assert.equal(approveRes.status, 200, "a stepped-up owner approves the request");
    // Approving hands the approver NO new session — the point of the handshake. (Narrowly
    // scoped to the approve response's own Set-Cookie.)
    assertNoSessionCookie(approveRes, "approving must not mint a session for the approver");

    // The new device collects — and ONLY now does a session for the new device appear.
    const collectRes = await handler.collect(deviceRequest({ requestId }));
    assert.ok(collectRes.status < 400, `the approved request collects a session, got ${collectRes.status}`);
    const token = sessionTokenFromResponse(collectRes);

    // The collected token is a real, verifiable session for the person, and DISTINCT from
    // the approver's — the approver's device is not the one being signed in.
    const verified = await verifySession(db, token, { clock });
    assert.ok(verified, "the collected session token verifies");
    assert.equal(verified.userId, person.id, "the new device's session belongs to the person");
    assert.notEqual(token, approver.token, "the collected session is not the approver's session");

    // Approving did not disturb the approver's own session.
    const approverStillValid = await verifySession(db, approver.token, { clock });
    assert.ok(approverStillValid, "the approver's own session remains valid after approving");

    // A SECOND collect of the same handle yields no session — single use, like the
    // one-time release store.
    const secondCollect = await handler.collect(deviceRequest({ requestId }));
    assert.ok(
      secondCollect.status >= 400 && secondCollect.status < 500,
      `a second collect is a 4xx, got ${secondCollect.status}`,
    );
    assertNoSessionCookie(secondCollect, "a second collect hands out no further session");
  } finally {
    await db.close();
  }
});

test("device: a collect before approval yields no session", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, clock, outbox);
    const person = await freshUser(db, "early-collect");
    const code = await issueCodeFor(db, person.email, clock, outbox);

    const requestId = await startRequest(handler, person.email, code, "new laptop");

    // Nobody has approved yet: collecting is refused and no session cookie is set.
    const res = await handler.collect(deviceRequest({ requestId }));
    assert.ok(res.status >= 400 && res.status < 500, `collect before approval is a 4xx, got ${res.status}`);
    assertNoSessionCookie(res, "collecting before approval hands out no session");
    assert.equal(await countSessions(db, person.id), 0, "no session exists for the person before approval");

    // An unknown handle likewise collects nothing (and does not crash).
    const unknown = await handler.collect(deviceRequest({ requestId: "no-such-request-id" }));
    assert.ok(unknown.status >= 400 && unknown.status < 500, `an unknown handle is a 4xx, got ${unknown.status}`);
    assertNoSessionCookie(unknown, "an unknown handle hands out no session");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — approving requires the approver's OWN session (member-scoped by the session's
// userId, never a client value): another person's session, and no session at all,
// cannot approve.
// =====================================================================================

test("device: another person's session cannot approve the request", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, clock, outbox);
    const owner = await freshUser(db, "owner");
    const stranger = await freshUser(db, "stranger");

    const code = await issueCodeFor(db, owner.email, clock, outbox);
    const requestId = await startRequest(handler, owner.email, code, "owner's new tablet");

    // The stranger is fully signed in on their OWN account and has stepped up — yet the
    // request belongs to the owner, so their session must not approve it. The ONLY thing
    // separating them from the owner is whose session the cookie carries.
    const strangerSession = await freshStepUpSession(db, stranger.id, clock);
    const rejected = await handler.approve(
      deviceRequest({ requestId }, { sessionToken: strangerSession.token }),
    );
    assert.ok(
      rejected.status >= 400 && rejected.status < 500,
      `a stranger's session cannot approve, got ${rejected.status}`,
    );
    assertNoSessionCookie(rejected, "a refused approval mints no session");

    // So the requesting device still cannot collect, and the owner has no session.
    const stillPending = await handler.collect(deviceRequest({ requestId }));
    assert.ok(stillPending.status >= 400 && stillPending.status < 500, "nothing is collectable after a refused approval");
    assertNoSessionCookie(stillPending, "a stranger's attempt leaves nothing to collect");
    assert.equal(await countSessions(db, owner.id), 0, "a stranger's attempt mints no session for the owner");

    // The OWNER's own stepped-up session approves the SAME request — proving the block was
    // the identity, not the request or the step-up.
    const ownerSession = await freshStepUpSession(db, owner.id, clock);
    const approved = await handler.approve(
      deviceRequest({ requestId }, { sessionToken: ownerSession.token }),
    );
    assert.equal(approved.status, 200, "the request's own owner approves it");

    const collected = await handler.collect(deviceRequest({ requestId }));
    assert.ok(collected.status < 400, `the owner-approved request collects a session, got ${collected.status}`);
    const collectedSession = await verifySession(db, sessionTokenFromResponse(collected), { clock });
    assert.ok(collectedSession, "the collected session verifies");
    assert.equal(collectedSession.userId, owner.id, "the collected session belongs to the owner");
  } finally {
    await db.close();
  }
});

test("device: approving with no session cannot approve (the approver's identity must come from a session)", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, clock, outbox);
    const person = await freshUser(db, "no-session-approver");
    const code = await issueCodeFor(db, person.email, clock, outbox);

    const requestId = await startRequest(handler, person.email, code, "new phone");

    // No session cookie at all: there is no approver identity to act on.
    const rejected = await handler.approve(deviceRequest({ requestId }));
    assert.ok(
      rejected.status >= 400 && rejected.status < 500,
      `approving with no session is a 4xx, got ${rejected.status}`,
    );
    assertNoSessionCookie(rejected, "approving with no session mints nothing");

    // The request stays unapproved, so the new device has nothing to collect.
    const stillPending = await handler.collect(deviceRequest({ requestId }));
    assert.ok(stillPending.status >= 400 && stillPending.status < 500, "nothing is collectable without an approval");
    assert.equal(await countSessions(db, person.id), 0, "no session is minted for the person");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — every step verifies Origin (missing or foreign → 403, changes nothing). The
// strongest "changes nothing": a foreign-origin approve does not approve, and a
// foreign-origin collect does not burn the one-shot collection handle.
// =====================================================================================

test("device: every step refuses a missing or foreign Origin (403) and changes nothing", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, clock, outbox);
    const person = await freshUser(db, "origin");
    const code = await issueCodeFor(db, person.email, clock, outbox);

    // requestApproval: a foreign Origin and a missing Origin are both forbidden, and
    // neither starts a request (no push is sent).
    assert.equal(
      (await handler.requestApproval(deviceRequest({ email: person.email, code, deviceLabel: "x" }, { origin: FOREIGN_ORIGIN }))).status,
      403,
      "requestApproval from a foreign Origin is forbidden",
    );
    assert.equal(
      (await handler.requestApproval(deviceRequest({ email: person.email, code, deviceLabel: "x" }, { origin: null }))).status,
      403,
      "requestApproval with no Origin is forbidden",
    );
    assert.equal(pushes(outbox).length, 0, "a cross-site request starts nothing and sends no push");

    // Start a real request over the good origin so approve / collect have a handle.
    const requestId = await startRequest(handler, person.email, code, "new device");
    const approver = await freshStepUpSession(db, person.id, clock);

    // approve: the SAME valid approver session, so the ONLY reason to reject is the Origin.
    assert.equal(
      (await handler.approve(deviceRequest({ requestId }, { origin: FOREIGN_ORIGIN, sessionToken: approver.token }))).status,
      403,
      "approve from a foreign Origin is forbidden",
    );
    assert.equal(
      (await handler.approve(deviceRequest({ requestId }, { origin: null, sessionToken: approver.token }))).status,
      403,
      "approve with no Origin is forbidden",
    );
    // Nothing was approved: a good-origin collect still finds the request unapproved.
    const stillPending = await handler.collect(deviceRequest({ requestId }));
    assert.ok(stillPending.status >= 400 && stillPending.status < 500, "a cross-site approve did not approve the request");
    assertNoSessionCookie(stillPending, "a cross-site approve leaves nothing to collect");

    // Now approve over the good origin — the only blocker above was the Origin.
    assert.equal(
      (await handler.approve(deviceRequest({ requestId }, { sessionToken: approver.token }))).status,
      200,
      "the same approval over the good Origin is accepted",
    );

    // collect: a foreign or missing Origin is forbidden AND must not consume the one-shot
    // handle — the real new device can still collect afterwards.
    assert.equal(
      (await handler.collect(deviceRequest({ requestId }, { origin: FOREIGN_ORIGIN }))).status,
      403,
      "collect from a foreign Origin is forbidden",
    );
    assert.equal(
      (await handler.collect(deviceRequest({ requestId }, { origin: null }))).status,
      403,
      "collect with no Origin is forbidden",
    );
    assert.equal(await countSessions(db, person.id), 1, "a cross-site collect mints no session (only the approver's exists)");

    // The good-origin collect still works — the foreign attempts did not burn the handle.
    const collected = await handler.collect(deviceRequest({ requestId }));
    assert.ok(collected.status < 400, `the good-Origin collect succeeds, got ${collected.status}`);
    const verified = await verifySession(db, sessionTokenFromResponse(collected), { clock });
    assert.ok(verified, "the good-Origin collect hands out a verifiable session");
    assert.equal(verified.userId, person.id, "the collected session belongs to the person");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC4 — validate-and-parameterize: 4xx on bad input, and a SQL-injection probe is bound.
// =====================================================================================

test("device: each step rejects malformed or mis-shaped input with a 4xx (never a 500)", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, clock, outbox);
    // A valid stepped-up session for the approve step, so its ONLY reason to reject is the
    // body itself (not a missing approver).
    const person = await freshUser(db, "bad-input");
    const approver = await freshStepUpSession(db, person.id, clock);

    // All carry a valid Origin, so the ONLY reason to reject is the input.
    const badRequest: unknown[] = ["{ not valid json at all", {}, { email: 123, code: 1, deviceLabel: [] }];
    for (const body of badRequest) {
      const res = await handler.requestApproval(deviceRequest(body));
      assert.ok(
        res.status >= 400 && res.status < 500,
        `bad requestApproval input ${JSON.stringify(body)} must be a 4xx, got ${res.status}`,
      );
    }

    const badApprove: unknown[] = ["{ not valid json", {}, { requestId: 5 }];
    for (const body of badApprove) {
      const res = await handler.approve(deviceRequest(body, { sessionToken: approver.token }));
      assert.ok(
        res.status >= 400 && res.status < 500,
        `bad approve input ${JSON.stringify(body)} must be a 4xx, got ${res.status}`,
      );
    }

    const badCollect: unknown[] = ["{ not valid json", {}, { requestId: [] }];
    for (const body of badCollect) {
      const res = await handler.collect(deviceRequest(body));
      assert.ok(
        res.status >= 400 && res.status < 500,
        `bad collect input ${JSON.stringify(body)} must be a 4xx, got ${res.status}`,
      );
    }
  } finally {
    await db.close();
  }
});

test("device: an oversized body is rejected with a 4xx before any work", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, clock, outbox);

    // A schema-valid shape padded past any reasonable body cap (~2 MiB). The size guard
    // must reject it with a 4xx rather than process it.
    const huge = { email: "huge@warthog.com.au", code: "000000", deviceLabel: "x".repeat(2 * 1024 * 1024) };
    const res = await handler.requestApproval(deviceRequest(huge));
    assert.ok(res.status >= 400 && res.status < 500, `an oversized body must be a 4xx, got ${res.status}`);
    assert.equal(pushes(outbox).length, 0, "an oversized body starts nothing and sends no push");
  } finally {
    await db.close();
  }
});

test("device: a SQL-injection probe in the email field is bound as data and cannot alter a query", async () => {
  const clock = fixedClock(T0);
  const outbox = createOutbox();
  const db = await freshDb();
  try {
    const handler = makeHandler(db, clock, outbox);

    // A real account with a live email code exists; if the probe below were concatenated
    // into SQL rather than bound, the trailing statement would drop the users table and
    // take this row with it.
    const survivor = await freshUser(db, "survivor");
    await issueCodeFor(db, survivor.email, clock, outbox);

    // Fire the classic injection probe through the email field with a valid Origin. It is
    // handled (never an uncontrolled 500): whether rejected at the validation boundary or
    // reaching the query bound as a parameter, it never runs as SQL.
    const probe = "robert'); DROP TABLE users; --@warthog.com.au";
    const res = await handler.requestApproval(deviceRequest({ email: probe, code: "000000", deviceLabel: "probe" }));
    assert.ok(res.status < 500, `the probe must be handled, not crash the server (got ${res.status})`);

    // The injection did NOT execute: the users table still exists and still holds the
    // baseline account, and the email_codes table is intact.
    assert.equal(
      (await getUserByEmail(db, survivor.email))?.id,
      survivor.id,
      "the baseline account survived — the probe was data, not SQL",
    );
    await db.query("SELECT 1 FROM email_codes LIMIT 1");
  } finally {
    await db.close();
  }
});
