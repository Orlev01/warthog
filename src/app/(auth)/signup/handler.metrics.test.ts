// Sign-up funnel metrics (docs/design/admin-portal.md §4): every stage reached or refused is
// one `signup.step` event and the end is one `signup.completed` event, carrying only the
// stage, outcome and factor labels — never an address, name, code, handle or user id.
// The seam is optional and best effort: a handler built without it records nothing, and a
// throwing seam changes no response. Driven through the real handler over an isolated
// database with the test software authenticator and a fixed TOTP test vector.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";

import { createSignupHandler, type SignupHandlerDeps } from "./handler";
import { issueEmailCode } from "../../../server/auth/email-code";
import { createUser } from "../../../server/db/users";
import { localAesKeyWrapper } from "../../../server/crypto/key-wrapper";
import { systemRandom } from "../../../server/seams/random";
import type { Random } from "../../../server/seams/random";
import type { RecordMetricInput } from "../../../server/metrics/record";
import { createOutbox, type Outbox } from "../../../server/notify/outbox";
import { freshDb } from "../../../test/db";
import { createAuthenticator } from "../../../test/authenticator";
import type { Db } from "../../../server/db/index";

const ORIGIN = "https://warthog.com.au";
const RP_ID = "warthog.com.au";
const HMAC_KEY = new Uint8Array(Buffer.from("warthog-signup-metrics-key-0123456789ab", "utf8"));
// RFC 6238 test vector: secret "12345678901234567890" at T = 1111111111 s gives 050471.
const TOTP_SECRET_BYTES = Buffer.from("12345678901234567890");
const TOTP_CODE = "050471";
const TOTP_INSTANT = new Date(1111111111 * 1000);

function collecting(): { metrics: RecordMetricInput[]; seam: NonNullable<SignupHandlerDeps["recordMetric"]> } {
  const metrics: RecordMetricInput[] = [];
  return { metrics, seam: async (input) => { metrics.push(input); } };
}

function makeHandler(db: Db, outbox: Outbox, recordMetric: SignupHandlerDeps["recordMetric"], clock = { now: () => TOTP_INSTANT }) {
  // Size-20 draws give the fixed TOTP secret; everything else stays random.
  const random: Random = { randomBytes: (size) => (size === 20 ? Uint8Array.from(TOTP_SECRET_BYTES) : systemRandom.randomBytes(size)) };
  return createSignupHandler({ db, clock, random, hmacKey: HMAC_KEY, emailSender: outbox, keyWrapper: localAesKeyWrapper(new Uint8Array(32).fill(7)), rpId: RP_ID, publicOrigin: ORIGIN, recordMetric });
}

function post(body: unknown): Request {
  return new Request(`${ORIGIN}/api/signup`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) });
}

async function codeFor(db: Db, email: string, outbox: Outbox): Promise<string> {
  await issueEmailCode(db, email, { purpose: "signup", clock: { now: () => TOTP_INSTANT }, random: systemRandom, hmacKey: HMAC_KEY, emailSender: outbox });
  return outbox.list().filter((m) => m.channel === "email" && m.recipient === email).at(-1)!.body.match(/(?<!\d)\d{6}(?!\d)/)![0];
}

const labels = (metrics: RecordMetricInput[]) => metrics.map((m) => [m.name, m.value, m.dimensions?.outcome, m.dimensions?.platform]);

test("the passkey path records each stage and the completion with the passkey factor; refusals are recorded too", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const { metrics, seam } = collecting();
    const handler = makeHandler(db, outbox, seam);
    const email = "funnel-passkey@example.test";

    const code = await codeFor(db, email, outbox);
    assert.equal((await handler.sendCode(post({ email }))).status, 429, "a second code within a minute is throttled");
    assert.equal((await handler.verifyEmail(post({ email, code: code[0] === "0" ? "1" + code.slice(1) : "0" + code.slice(1) }))).status, 400);
    const verified = await handler.verifyEmail(post({ email, code }));
    assert.equal(verified.status, 200);
    const { signupId, registrationOptions } = (await verified.json()) as { signupId: string; registrationOptions: PublicKeyCredentialCreationOptionsJSON };
    const auth = createAuthenticator({ origin: ORIGIN });
    const registered = await handler.registerPasskey(post({ signupId, registrationResponse: await auth.register(registrationOptions) }));
    assert.equal(registered.status, 200);
    const confirmed = await handler.confirmSignup(post({ signupId, savedConfirmed: true }));
    assert.equal(confirmed.status, 303);

    assert.deepEqual(labels(metrics), [
      ["signup.step", 1, "throttled", undefined],
      ["signup.step", 1, "code_rejected", undefined],
      ["signup.step", 1, "email_verified", undefined],
      ["signup.step", 1, "factor_enrolled", "passkey"],
      ["signup.completed", 1, "ok", "passkey"],
    ]);
    const serialised = JSON.stringify(metrics);
    for (const secret of [email, signupId, code, "funnel"]) assert.ok(!serialised.includes(secret), `no ${secret === email ? "address" : "handle or code"} in metrics`);
  } finally {
    await db.close();
  }
});

test("a fresh code is recorded as sent, and the authenticator path completes with the totp factor", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const { metrics, seam } = collecting();
    const handler = makeHandler(db, outbox, seam);
    const email = "funnel-totp@example.test";
    assert.equal((await handler.sendCode(post({ email, name: "Example Person" }))).status, 200);
    const code = outbox.list().at(-1)!.body.match(/(?<!\d)\d{6}(?!\d)/)![0];
    const verified = await handler.verifyEmail(post({ email, code }));
    const { signupId } = (await verified.json()) as { signupId: string };
    assert.equal((await handler.beginTotp(post({ signupId }))).status, 200);
    assert.equal((await handler.verifyTotp(post({ signupId, totp: "000000" }))).status, 400, "a wrong authenticator code enrols nothing");
    assert.equal((await handler.verifyTotp(post({ signupId, totp: TOTP_CODE }))).status, 200);
    assert.equal((await handler.confirmSignup(post({ signupId, savedConfirmed: true }))).status, 303);
    assert.deepEqual(labels(metrics), [
      ["signup.step", 1, "code_sent", undefined],
      ["signup.step", 1, "email_verified", undefined],
      ["signup.step", 1, "factor_enrolled", "totp"],
      ["signup.completed", 1, "ok", "totp"],
    ]);
    assert.ok(!JSON.stringify(metrics).includes("Example"), "no name in metrics");
  } finally {
    await db.close();
  }
});

test("an address that already has an account records account_exists, and a throwing seam changes no response", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const { metrics, seam } = collecting();
    const email = "taken@example.test";
    await createUser(db, { email, wrappedDek: "wrapped" });
    const handler = makeHandler(db, outbox, seam);
    const code = await codeFor(db, email, outbox);
    const { signupId, registrationOptions } = (await (await handler.verifyEmail(post({ email, code }))).json()) as { signupId: string; registrationOptions: PublicKeyCredentialCreationOptionsJSON };
    const auth = createAuthenticator({ origin: ORIGIN });
    await handler.registerPasskey(post({ signupId, registrationResponse: await auth.register(registrationOptions) }));
    assert.equal((await handler.confirmSignup(post({ signupId, savedConfirmed: true }))).status, 409);
    assert.deepEqual(labels(metrics).at(-1), ["signup.completed", 1, "account_exists", "passkey"]);

    const broken = makeHandler(db, outbox, async () => { throw new Error("metrics down"); });
    const other = "fine@example.test";
    const otherCode = await codeFor(db, other, outbox);
    const started = await broken.verifyEmail(post({ email: other, code: otherCode }));
    assert.equal(started.status, 200, "a metrics failure never fails the step");
    const silent = makeHandler(db, outbox, undefined);
    assert.equal((await silent.verifyEmail(post({ email: other, code: "000000" }))).status, 400, "no seam: the handler still answers");
  } finally {
    await db.close();
  }
});
