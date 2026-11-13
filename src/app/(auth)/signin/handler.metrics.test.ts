// Sign-in outcome metrics (docs/design/admin-portal.md §4): one `signin.attempt` per
// completed, failed or throttled attempt, carrying only the outcome, the factor and the
// failing step's category — never an address, code, handle or user id. The seam is optional
// and best effort. Driven through the real handler with the test software authenticator
// and the shared email-proof helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";

import { createSigninHandler, type SigninHandlerDeps } from "./handler";
import { emailProofFor } from "../../../test/totp-signin";
import { beginPasskeyRegistration, finishPasskeyRegistration } from "../../../server/auth/passkey";
import { enrollTotp } from "../../../server/auth/totp";
import { createUser } from "../../../server/db/users";
import { systemRandom } from "../../../server/seams/random";
import { fixedClock } from "../../../server/seams/clock";
import { createOutbox } from "../../../server/notify/outbox";
import { freshDb } from "../../../test/db";
import { createAuthenticator } from "../../../test/authenticator";
import type { RecordMetricInput } from "../../../server/metrics/record";
import type { Db } from "../../../server/db/index";

const T0 = new Date("2026-05-01T00:00:00.000Z");
const RP_ID = "warthog.com.au";
const ORIGIN = "https://warthog.com.au";
const HMAC_KEY = new Uint8Array(Buffer.from("warthog-signin-metrics-key-0123456789ab", "utf8"));

function collecting() {
  const metrics: RecordMetricInput[] = [];
  const seam: NonNullable<SigninHandlerDeps["recordMetric"]> = async (input) => { metrics.push(input); };
  return { metrics, seam };
}

function makeHandler(db: Db, secrets: Map<string, string>, recordMetric: SigninHandlerDeps["recordMetric"]) {
  return createSigninHandler({
    db, clock: fixedClock(T0), random: systemRandom, hmacKey: HMAC_KEY, emailSender: createOutbox(), rpId: RP_ID, publicOrigin: ORIGIN,
    totpSecrets: { get: async (userId) => secrets.get(userId) ?? null }, recordMetric,
  });
}

function post(body: unknown): Request {
  return new Request(`${ORIGIN}/api/signin`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) });
}

// A reference RFC 6238 code for the current step (SHA-1, 6 digits), independent of the module.
function totpFor(secretB32: string, at: Date): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of secretB32.replace(/=+$/, "").toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 1000 / 30)));
  const digest = createHmac("sha1", Buffer.from(out)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
  return (binary % 1_000_000).toString().padStart(6, "0");
}

const labels = (metrics: RecordMetricInput[]) => metrics.map((m) => [m.dimensions?.outcome, m.dimensions?.platform, m.dimensions?.errorCategory]);

test("passkey sign-ins record ok with the factor; a stranger's assertion and an unknown address record failures", async () => {
  const db = await freshDb();
  try {
    const { metrics, seam } = collecting();
    const handler = makeHandler(db, new Map(), seam);
    const email = "metrics-passkey@warthog.com.au";
    const user = await createUser(db, { email, wrappedDek: "wrapped" });
    const auth = createAuthenticator({ origin: ORIGIN });
    await finishPasskeyRegistration(db, { userId: user.id, response: await auth.register(await beginPasskeyRegistration(db, { userId: user.id, userName: email }, { rpId: RP_ID })) }, { rpId: RP_ID });

    const begin = async () => ((await (await handler.beginPasskey(post({ email }))).json()) as { options: PublicKeyCredentialRequestOptionsJSON }).options;
    assert.equal((await handler.finishPasskey(post({ email, authenticationResponse: await auth.authenticate(await begin()) }))).status, 303);
    // A credential another person registered, presented for this address.
    const intruder = await createUser(db, { email: "intruder@warthog.com.au", wrappedDek: "wrapped" });
    const stranger = createAuthenticator({ origin: ORIGIN });
    await finishPasskeyRegistration(db, { userId: intruder.id, response: await stranger.register(await beginPasskeyRegistration(db, { userId: intruder.id, userName: intruder.email }, { rpId: RP_ID })) }, { rpId: RP_ID });
    assert.equal((await handler.finishPasskey(post({ email, authenticationResponse: await stranger.authenticate(await begin()) }))).status, 401);
    assert.equal((await handler.finishPasskey(post({ email: "nobody@warthog.com.au", authenticationResponse: await auth.authenticate(await begin()) }))).status, 401);

    assert.deepEqual(labels(metrics), [["ok", "passkey", undefined], ["failed", undefined, "passkey"], ["failed", undefined, "passkey"]]);
    assert.ok(metrics.every((m) => m.name === "signin.attempt" && m.value === 1));
    assert.ok(!JSON.stringify(metrics).includes("warthog.com.au") && !JSON.stringify(metrics).includes(user.id), "no address or id in metrics");
  } finally {
    await db.close();
  }
});

test("authenticator sign-ins record ok with the totp factor, wrong codes and unverified handles record totp failures, and a bad email code records an email_code failure", async () => {
  const db = await freshDb();
  try {
    const { metrics, seam } = collecting();
    const secrets = new Map<string, string>();
    const handler = makeHandler(db, secrets, seam);
    const email = "metrics-totp@warthog.com.au";
    const user = await createUser(db, { email, wrappedDek: "wrapped" });
    const { secret } = await enrollTotp({ account: email, issuer: "Warthog" }, { random: systemRandom });
    secrets.set(user.id, secret);
    await db.query("INSERT INTO totp_secrets (user_id, secret_enc) VALUES ($1, 'v1:test')", [user.id]);
    // One email proof (the issuer allows one code a minute); a wrong authenticator code
    // leaves the handle usable, so the correct code then signs in with the same proof.
    const signinId = await emailProofFor(handler, db, email, { clock: fixedClock(T0), hmacKey: HMAC_KEY, origin: ORIGIN });

    assert.equal((await handler.signInWithTotp(post({ signinId, totp: "000000" }))).status, 401);
    assert.equal((await handler.signInWithTotp(post({ signinId: "f".repeat(64), totp: totpFor(secret, T0) }))).status, 401);
    assert.equal((await handler.signInWithTotp(post({ signinId, totp: totpFor(secret, T0) }))).status, 303);
    assert.equal((await handler.verifyTotpEmail(post({ email, code: "000000" }))).status, 401);

    assert.deepEqual(labels(metrics), [
      ["failed", undefined, "totp"], ["failed", undefined, "totp"], ["ok", "totp", undefined], ["failed", undefined, "email_code"],
    ]);
  } finally {
    await db.close();
  }
});

test("a throwing seam changes no response, and no seam records nothing", async () => {
  const db = await freshDb();
  try {
    const email = "metrics-silent@warthog.com.au";
    await createUser(db, { email, wrappedDek: "wrapped" });
    const broken = makeHandler(db, new Map(), async () => { throw new Error("metrics down"); });
    assert.equal((await broken.verifyTotpEmail(post({ email, code: "000000" }))).status, 401);
    const silent = makeHandler(db, new Map(), undefined);
    assert.equal((await silent.verifyTotpEmail(post({ email, code: "000000" }))).status, 401);
  } finally {
    await db.close();
  }
});
