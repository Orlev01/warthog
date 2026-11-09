import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { freshDb } from "../../../test/db";
import { localAesKeyWrapper } from "../../../server/crypto/key-wrapper";
import { createTotpSecretStore } from "../../../server/auth/totp-store";
import { checkTotpSignIn } from "../../../server/auth/totp-attempts";
import { verifyRecoveryCode } from "../../../server/auth/recovery";
import { getUserByEmail } from "../../../server/db/users";
import { createSignupStepHandler } from "../../api/auth/signup/[step]/handler";

const ORIGIN = "https://app.example.test";
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const CODE = "050471";
async function setup() {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  let time = 1111111111 * 1000;
  const clock = { now: () => new Date(time) };
  let emailCode = "";
  const email = `enrol-${randomBytes(4).toString("hex")}@example.test`;
  const dispatch = createSignupStepHandler({ getDeps: async () => ({
    db, clock, keyWrapper, hmacKey: randomBytes(32), rpId: "app.example.test", publicOrigin: ORIGIN,
    random: { randomBytes: (size) => size === 20 ? Buffer.from("12345678901234567890") : randomBytes(size) },
    emailSender: { async sendEmail(message) { emailCode = message.body.match(/\b\d{6}\b/)![0]!; } },
  }) });
  const send = (step: string, body: unknown, origin: string | null = ORIGIN) => dispatch(new Request(`${ORIGIN}/api/auth/signup/${step}`, {
    method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  }), step);
  assert.equal((await send("send-code", { email, name: "Example Person" })).status, 200);
  const verified = await send("verify-email", { email, code: emailCode });
  assert.equal(verified.status, 200);
  const { signupId } = await verified.json() as { signupId: string };
  return { db, email, keyWrapper, clock, signupId, send, advance: (ms: number) => { time += ms; } };
}

test("authenticator-only signup confirms email, factor and recovery before atomic account creation", async () => {
  const f = await setup();
  try {
    assert.equal((await f.send("confirm", { signupId: f.signupId, savedConfirmed: true })).status, 400);
    const enrollment = await f.send("begin-totp", { signupId: f.signupId });
    assert.equal(enrollment.status, 200);
    assert.equal(enrollment.headers.get("cache-control"), "no-store");
    const details = await enrollment.json() as { secret: string; qr: string };
    assert.equal(details.secret, SECRET);
    assert.match(details.qr, /^data:image\/png;base64,/);
    assert.equal(await getUserByEmail(f.db, f.email), null);
    assert.equal((await f.send("confirm", { signupId: f.signupId, savedConfirmed: true })).status, 400);
    const confirmed = await f.send("verify-totp", { signupId: f.signupId, totp: CODE });
    assert.equal(confirmed.status, 200);
    const { recoveryCode } = await confirmed.json() as { recoveryCode: string };
    assert.equal((await f.send("confirm", { signupId: f.signupId, savedConfirmed: false })).status, 400);
    const result = await f.send("confirm", { signupId: f.signupId, savedConfirmed: true });
    assert.equal(result.status, 303);
    assert.match(result.headers.get("set-cookie") ?? "", /__Host-wh_session=/);
    const user = await getUserByEmail(f.db, f.email);
    assert.ok(user);
    const stored = await createTotpSecretStore({ db: f.db, keyWrapper: f.keyWrapper }).get(user.id);
    assert.equal(stored, SECRET);
    const rows = await f.db.query("SELECT secret_enc FROM totp_secrets WHERE user_id = $1", [user.id]);
    assert.ok(!(rows.rows[0]!.secret_enc as string).includes(SECRET));
    assert.equal((await f.db.query("SELECT credential_id FROM passkeys WHERE user_id = $1", [user.id])).rows.length, 0);
    assert.equal(await verifyRecoveryCode(f.db, user.id, recoveryCode), true);
    assert.deepEqual(await checkTotpSignIn(f.db, { userId: user.id, secret: SECRET, code: CODE }, { clock: f.clock }), { ok: false, reason: "invalid" });
    assert.equal((await f.send("confirm", { signupId: f.signupId, savedConfirmed: true })).status, 400);
  } finally { await f.db.close(); }
});

test("authenticator enrollment checks Origin and pending identity, and never bypasses expiry", async () => {
  const f = await setup();
  try {
    for (const step of ["begin-totp", "verify-totp"]) {
      const body = { signupId: f.signupId, ...(step === "verify-totp" ? { totp: CODE } : {}) };
      assert.equal((await f.send(step, body, null)).status, 403);
      assert.equal((await f.send(step, body, "https://foreign.example.test")).status, 403);
      assert.equal((await f.send(step, { ...body, signupId: "not-email-verified" })).status, 400);
    }
    assert.equal((await f.send("begin-totp", { signupId: f.signupId })).status, 200);
    f.advance(30 * 60 * 1000);
    assert.equal((await f.send("verify-totp", { signupId: f.signupId, totp: CODE })).status, 400);
    assert.equal(await getUserByEmail(f.db, f.email), null);
  } finally { await f.db.close(); }
});

test("five incorrect enrollment codes block a correct code and re-reading the QR cannot reset attempts", async () => {
  const f = await setup();
  try {
    assert.equal((await f.send("begin-totp", { signupId: f.signupId })).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await f.send("verify-totp", { signupId: f.signupId, totp: "000000" })).status, 400);
    await f.send("begin-totp", { signupId: f.signupId });
    assert.equal((await f.send("verify-totp", { signupId: f.signupId, totp: CODE })).status, 429);
    assert.equal(await getUserByEmail(f.db, f.email), null);
  } finally { await f.db.close(); }
});

test("completed authenticator enrollment cannot be replayed or replaced before account confirmation", async () => {
  const f = await setup();
  try {
    assert.equal((await f.send("begin-totp", { signupId: f.signupId })).status, 200);
    assert.equal((await f.send("verify-totp", { signupId: f.signupId, totp: CODE })).status, 200);
    assert.equal((await f.send("verify-totp", { signupId: f.signupId, totp: CODE })).status, 409);
    assert.equal((await f.send("begin-totp", { signupId: f.signupId })).status, 409);
  } finally { await f.db.close(); }
});
