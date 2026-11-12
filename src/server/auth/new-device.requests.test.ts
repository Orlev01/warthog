// Approve a sign-in from another device, inside the signed-in app (follow-up S3). The
// handshake already existed (request → approve with a fresh step-up → collect) but a member
// had no way to SEE a pending request: approval needed the new device's collection handle,
// which only the new device holds. These pin the member-scoped side:
//
//   • listDeviceSignInRequests(session) — the session's own pending, unexpired, unapproved
//     requests, each under an opaque approval id that is NOT the collection handle;
//   • approveDeviceSignInRequest — a fresh step-up, the session's own request only; the
//     approver gets no session, and the new device then collects exactly once;
//   • denyDeviceSignInRequest — discards the session's own request; the device can't collect;
//   • the request's push links to the requests screen and carries no handle or id, and a push
//     that can't be delivered never stops the request.
//
// Real migrations on PGlite and the real email-code/session seams; the outbox records pushes.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  requestNewDeviceApproval,
  collectNewDeviceApproval,
  listDeviceSignInRequests,
  approveDeviceSignInRequest,
  denyDeviceSignInRequest,
  SIGN_IN_REQUESTS_PATH,
  NEW_DEVICE_REQUEST_TTL_MS,
} from "./new-device";
import { issueEmailCode } from "./email-code";
import { createSession, recordStepUp, verifySession, type Session } from "./session";
import { createUser, type User } from "../db/users";
import { freshDb } from "../../test/db";
import { createOutbox, type Outbox } from "../notify/outbox";
import { systemRandom } from "../seams/random";
import type { Clock } from "../seams/clock";
import type { Db } from "../db/index";

const MINUTE_MS = 60_000;
const HMAC_KEY = new Uint8Array(Buffer.from("warthog-device-requests-hmac-key-012345", "utf8"));

function mutableClock(start: Date) {
  let current = start.getTime();
  const clock: Clock = { now: () => new Date(current) };
  return { clock, advance: (ms: number) => { current += ms; } };
}

async function setup() {
  const db = await freshDb();
  const outbox = createOutbox();
  const time = mutableClock(new Date("2026-11-13T00:00:00.000Z"));
  const deps = {
    clock: time.clock,
    random: systemRandom,
    hmacKey: HMAC_KEY,
    emailSender: outbox,
    pushSender: outbox,
  };
  async function person(label: string): Promise<User> {
    return createUser(db, { email: `${label}-${systemRandom.randomBytes(4).toString("hex")}@warthog.com.au`, wrappedDek: "wrapped" });
  }
  async function codeFor(email: string): Promise<string> {
    await issueEmailCode(db, email, { purpose: "device", clock: time.clock, random: systemRandom, hmacKey: HMAC_KEY, emailSender: outbox });
    const sent = outbox.list().filter((m) => m.channel === "email" && m.recipient === email).at(-1);
    return sent!.body.match(/(?<!\d)\d{6}(?!\d)/)![0];
  }
  async function request(user: User, deviceLabel = "Chrome on Mac") {
    const result = await requestNewDeviceApproval(db, { email: user.email, code: await codeFor(user.email), deviceLabel }, deps);
    assert.ok(result.ok, "the request starts");
    return result;
  }
  async function signedIn(user: User, steppedUp = true): Promise<Session> {
    const created = await createSession(db, user.id, { clock: time.clock, random: systemRandom });
    return steppedUp ? recordStepUp(db, created.session.id, { clock: time.clock }) : created.session;
  }
  return { db, outbox, time, deps, person, request, signedIn };
}

async function sessionCount(db: Db, userId: string): Promise<number> {
  return Number((await db.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1", [userId])).rows[0]?.n);
}

test("a member sees their own pending request — label, when it was asked, when it expires — never its handle", async () => {
  const f = await setup();
  try {
    const owner = await f.person("owner");
    const started = f.time.clock.now();
    const req = await f.request(owner);
    const session = await f.signedIn(owner, false);
    const listed = listDeviceSignInRequests(session, { clock: f.time.clock });
    assert.equal(listed.length, 1);
    const [item] = listed;
    assert.equal(item!.deviceLabel, "Chrome on Mac");
    assert.deepEqual(item!.requestedAt, started);
    assert.deepEqual(item!.expiresAt, new Date(started.getTime() + NEW_DEVICE_REQUEST_TTL_MS));
    assert.match(item!.id, /^[0-9a-f]{32}$/);
    assert.notEqual(item!.id, req.requestId, "the listing never exposes the collection handle");
    assert.ok(!JSON.stringify(listed).includes(req.requestId));
  } finally {
    await f.db.close();
  }
});

test("another account's request is invisible, and can be neither approved nor denied by id", async () => {
  const f = await setup();
  try {
    const owner = await f.person("victim");
    const other = await f.person("intruder");
    await f.request(owner);
    const ownerId = listDeviceSignInRequests(await f.signedIn(owner), { clock: f.time.clock })[0]!.id;
    const intruder = await f.signedIn(other);
    assert.deepEqual(listDeviceSignInRequests(intruder, { clock: f.time.clock }), []);
    assert.deepEqual(
      await approveDeviceSignInRequest({ approvalId: ownerId, approvingSession: intruder }, { clock: f.time.clock }),
      { ok: false, reason: "not_found" },
    );
    assert.deepEqual(denyDeviceSignInRequest({ approvalId: ownerId, session: intruder }, { clock: f.time.clock }), { ok: false, reason: "not_found" });
    assert.equal(listDeviceSignInRequests(await f.signedIn(owner), { clock: f.time.clock }).length, 1, "the owner's request is untouched");
  } finally {
    await f.db.close();
  }
});

test("approving needs a fresh confirmation, hands the approver no session, and lets the device collect once", async () => {
  const f = await setup();
  try {
    const owner = await f.person("approve");
    const req = await f.request(owner);
    const stale = await f.signedIn(owner, false);
    const id = listDeviceSignInRequests(stale, { clock: f.time.clock })[0]!.id;
    assert.deepEqual(
      await approveDeviceSignInRequest({ approvalId: id, approvingSession: stale }, { clock: f.time.clock }),
      { ok: false, reason: "step_up_required" },
    );
    assert.equal((await collectNewDeviceApproval(f.db, { requestId: req.requestId }, f.deps)).ok, false, "not approved yet");

    const confirmed = await f.signedIn(owner);
    const before = await sessionCount(f.db, owner.id);
    const approved = await approveDeviceSignInRequest({ approvalId: id, approvingSession: confirmed }, { clock: f.time.clock });
    assert.deepEqual(approved, { ok: true }, "the approval returns nothing but ok");
    assert.equal(await sessionCount(f.db, owner.id), before, "approving mints no session");
    assert.deepEqual(listDeviceSignInRequests(confirmed, { clock: f.time.clock }), [], "an approved request leaves the list");
    assert.deepEqual(
      await approveDeviceSignInRequest({ approvalId: id, approvingSession: confirmed }, { clock: f.time.clock }),
      { ok: false, reason: "not_found" },
      "a request is approved once",
    );

    const collected = await collectNewDeviceApproval(f.db, { requestId: req.requestId }, f.deps);
    assert.ok(collected.ok);
    assert.equal(collected.session.userId, owner.id);
    assert.ok(await verifySession(f.db, collected.token, { clock: f.time.clock }));
    assert.equal((await collectNewDeviceApproval(f.db, { requestId: req.requestId }, f.deps)).ok, false, "single use");
  } finally {
    await f.db.close();
  }
});

test("denying discards the request: it leaves the list and the device can never collect", async () => {
  const f = await setup();
  try {
    const owner = await f.person("deny");
    const req = await f.request(owner);
    const session = await f.signedIn(owner, false);
    const id = listDeviceSignInRequests(session, { clock: f.time.clock })[0]!.id;
    assert.deepEqual(denyDeviceSignInRequest({ approvalId: id, session }, { clock: f.time.clock }), { ok: true });
    assert.deepEqual(listDeviceSignInRequests(session, { clock: f.time.clock }), []);
    const collected = await collectNewDeviceApproval(f.db, { requestId: req.requestId }, f.deps);
    assert.deepEqual(collected, { ok: false, reason: "unknown_request" });
    const confirmed = await f.signedIn(owner);
    assert.deepEqual(
      await approveDeviceSignInRequest({ approvalId: id, approvingSession: confirmed }, { clock: f.time.clock }),
      { ok: false, reason: "not_found" },
    );
  } finally {
    await f.db.close();
  }
});

test("an expired request leaves the list and can't be approved", async () => {
  const f = await setup();
  try {
    const owner = await f.person("expire");
    await f.request(owner);
    const id = listDeviceSignInRequests(await f.signedIn(owner), { clock: f.time.clock })[0]!.id;
    f.time.advance(NEW_DEVICE_REQUEST_TTL_MS);
    const confirmed = await f.signedIn(owner);
    assert.deepEqual(listDeviceSignInRequests(confirmed, { clock: f.time.clock }), []);
    assert.deepEqual(
      await approveDeviceSignInRequest({ approvalId: id, approvingSession: confirmed }, { clock: f.time.clock }),
      { ok: false, reason: "not_found" },
    );
  } finally {
    await f.db.close();
  }
});

test("several requests are listed newest first", async () => {
  const f = await setup();
  try {
    const owner = await f.person("several");
    await f.request(owner, "Safari on iPhone");
    f.time.advance(2 * MINUTE_MS);
    await f.request(owner, "Firefox on Windows");
    const listed = listDeviceSignInRequests(await f.signedIn(owner), { clock: f.time.clock });
    assert.deepEqual(listed.map((r) => r.deviceLabel), ["Firefox on Windows", "Safari on iPhone"]);
  } finally {
    await f.db.close();
  }
});

test("the request's push links to the requests screen and carries no handle or approval id", async () => {
  const f = await setup();
  try {
    const owner = await f.person("push");
    const req = await f.request(owner);
    const id = listDeviceSignInRequests(await f.signedIn(owner), { clock: f.time.clock })[0]!.id;
    const push = f.outbox.list().filter((m) => m.channel === "push").at(-1);
    assert.ok(push);
    assert.equal(push.link, SIGN_IN_REQUESTS_PATH);
    assert.equal(SIGN_IN_REQUESTS_PATH, "/settings/security/sign-in-requests");
    for (const secret of [req.requestId, id]) {
      assert.ok(!push.body.includes(secret) && !(push.link ?? "").includes(secret), "no handle or id rides in the push");
    }
  } finally {
    await f.db.close();
  }
});

test("a push that can't be delivered never stops the request: it still waits on the requests screen", async () => {
  const f = await setup();
  try {
    const owner = await f.person("nopush");
    const email = owner.email;
    await issueEmailCode(f.db, email, { purpose: "device", clock: f.time.clock, random: systemRandom, hmacKey: HMAC_KEY, emailSender: f.outbox });
    const code = f.outbox.list().filter((m) => m.channel === "email" && m.recipient === email).at(-1)!.body.match(/(?<!\d)\d{6}(?!\d)/)![0];
    const result = await requestNewDeviceApproval(
      f.db,
      { email, code, deviceLabel: "Chrome on Mac" },
      { ...f.deps, pushSender: { async sendPush() { throw new Error("No registered push device"); } } },
    );
    assert.equal(result.ok, true);
    assert.equal(listDeviceSignInRequests(await f.signedIn(owner), { clock: f.time.clock }).length, 1);
  } finally {
    await f.db.close();
  }
});
