// Settings › Security › Sign-in requests (follow-up S3): the screen's testable seam. The
// rules live in src/server/auth/new-device.ts (new-device.requests.test.ts); here: the
// screen lists only the session's own requests, validates the id it is handed before it
// reaches the store, and maps each answer to a plain outcome code.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createSignInRequestActions, signInRequestNotice } from "./actions";
import { requestNewDeviceApproval, collectNewDeviceApproval } from "../../../../../../server/auth/new-device";
import { issueEmailCode } from "../../../../../../server/auth/email-code";
import { createSession, recordStepUp } from "../../../../../../server/auth/session";
import { createUser } from "../../../../../../server/db/users";
import { createOutbox } from "../../../../../../server/notify/outbox";
import { fixedClock } from "../../../../../../server/seams/clock";
import { systemRandom } from "../../../../../../server/seams/random";
import { freshDb } from "../../../../../../test/db";

const clock = fixedClock(new Date("2026-11-13T01:00:00.000Z"));
const HMAC_KEY = new Uint8Array(Buffer.from("sign-in-requests-screen-hmac-key-0123456", "utf8"));

async function setup() {
  const db = await freshDb();
  const outbox = createOutbox();
  const deps = { clock, random: systemRandom, hmacKey: HMAC_KEY, emailSender: outbox, pushSender: outbox };
  const owner = await createUser(db, { email: `screen-${systemRandom.randomBytes(4).toString("hex")}@warthog.com.au`, wrappedDek: "w" });
  await issueEmailCode(db, owner.email, { purpose: "device", clock, random: systemRandom, hmacKey: HMAC_KEY, emailSender: outbox });
  const code = outbox.list().filter((m) => m.channel === "email").at(-1)!.body.match(/(?<!\d)\d{6}(?!\d)/)![0];
  const request = await requestNewDeviceApproval(db, { email: owner.email, code, deviceLabel: "Safari on iPhone" }, deps);
  assert.ok(request.ok);
  const plain = (await createSession(db, owner.id, { clock, random: systemRandom })).session;
  const confirmed = await recordStepUp(db, plain.id, { clock });
  return { db, deps, owner, request, plain, confirmed, actions: createSignInRequestActions({ db, clock }) };
}

test("the screen lists the session's own requests and approves one after a fresh confirmation", async () => {
  const f = await setup();
  try {
    const [listed] = f.actions.load(f.plain);
    assert.equal(listed?.deviceLabel, "Safari on iPhone");
    assert.deepEqual(await f.actions.approve(f.plain, listed!.id), { ok: false, reason: "step_up_required" });
    assert.deepEqual(await f.actions.approve(f.confirmed, listed!.id), { ok: true });
    assert.ok((await collectNewDeviceApproval(f.db, { requestId: f.request.requestId }, f.deps)).ok);
  } finally {
    await f.db.close();
  }
});

test("deny discards the request; an unknown or malformed id changes nothing", async () => {
  const f = await setup();
  try {
    const [listed] = f.actions.load(f.plain);
    assert.deepEqual(f.actions.deny(f.plain, "not-an-id"), { ok: false, reason: "invalid_request" });
    assert.deepEqual(await f.actions.approve(f.confirmed, f.request.requestId), { ok: false, reason: "invalid_request" }, "the collection handle is not an approval id");
    assert.deepEqual(f.actions.deny(f.plain, "0".repeat(32)), { ok: false, reason: "not_found" });
    assert.equal(f.actions.load(f.plain).length, 1);
    assert.deepEqual(f.actions.deny(f.plain, listed!.id), { ok: true });
    assert.deepEqual(f.actions.load(f.plain), []);
  } finally {
    await f.db.close();
  }
});

test("the screen knows which ways the member can confirm it's them (metadata only)", async () => {
  const f = await setup();
  try {
    assert.deepEqual(await f.actions.factors(f.plain), { passkey: false, authenticator: false });
    await f.db.query("INSERT INTO totp_secrets (user_id, secret_enc) VALUES ($1, $2)", [f.owner.id, "opaque"]);
    assert.deepEqual(await f.actions.factors(f.plain), { passkey: false, authenticator: true });
  } finally {
    await f.db.close();
  }
});

test("each outcome code has plain copy; unknown codes render nothing", () => {
  assert.match(signInRequestNotice("approved")?.text ?? "", /Approved/);
  assert.match(signInRequestNotice("denied")?.text ?? "", /denied/i);
  assert.match(signInRequestNotice("not_found")?.text ?? "", /expired or was already answered/);
  assert.equal(signInRequestNotice("approved")?.tone, "done");
  assert.equal(signInRequestNotice("<script>"), null);
  assert.equal(signInRequestNotice(undefined), null);
});
