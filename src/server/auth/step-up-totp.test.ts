import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { createTotpSecretStore } from "./totp-store";
import { checkTotpSignIn } from "./totp-attempts";
import { createSession, verifySession, COOKIE_NAME } from "./session";
import { createStepUpStepHandler } from "./step-up-handler";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";

const ORIGIN = "https://app.example.test";
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const CODE = "050471";
const clock = fixedClock(new Date(1111111111 * 1000));

async function fixture() {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  const user = await createUser(db, { email: "totp-stepup@example.test", wrappedDek: await keyWrapper.wrap(randomBytes(32)) });
  const totpSecrets = createTotpSecretStore({ db, keyWrapper });
  await totpSecrets.set(user.id, SECRET);
  const a = await createSession(db, user.id, { clock, random: systemRandom });
  const b = await createSession(db, user.id, { clock, random: systemRandom });
  const dispatch = createStepUpStepHandler({ getDeps: async () => ({
    db, clock, random: systemRandom, rpId: "app.example.test", publicOrigin: ORIGIN, totpSecrets,
  }) });
  const send = (body: unknown = { totp: CODE }, token: string | null = a.token, origin: string | null = ORIGIN) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.cookie = `${COOKIE_NAME}=${token}`;
    if (origin) headers.origin = origin;
    return dispatch(new Request(`${ORIGIN}/api/auth/step-up/totp`, {
      method: "POST", headers, body: JSON.stringify(body),
    }), "totp");
  };
  return { db, user, a, b, send };
}

// The rotated token a successful step-up sets in its `__Host-wh_session` cookie.
function rotatedToken(response: Response): string {
  const match = new RegExp(`${COOKIE_NAME}=([^;]+)`).exec(response.headers.get("set-cookie") ?? "");
  assert.ok(match, "a successful step-up sets a new session cookie");
  return match[1];
}

test("authenticator confirmation stamps only the current verified session and consumes its code", async () => {
  const f = await fixture();
  try {
    const confirmed = await f.send();
    assert.equal(confirmed.status, 200);
    const fresh = rotatedToken(confirmed);
    assert.equal((await verifySession(f.db, fresh, { clock }))?.steppedUpAt?.getTime(), clock.now().getTime());
    assert.equal((await verifySession(f.db, fresh, { clock }))?.id, f.a.session.id, "the same session carries on");
    assert.equal(await verifySession(f.db, f.a.token, { clock }), null, "a copy of the old token is signed out");
    assert.equal((await verifySession(f.db, f.b.token, { clock }))?.steppedUpAt, null);
    assert.equal((await f.send({ totp: CODE }, f.b.token)).status, 401);
    assert.equal((await verifySession(f.db, f.b.token, { clock }))?.steppedUpAt, null);
  } finally { await f.db.close(); }
});

test("authenticator step-up rejects absent/foreign Origin and absent session before consuming a code", async () => {
  const f = await fixture();
  try {
    for (const origin of [null, "https://foreign.example.test"]) assert.equal((await f.send({ totp: CODE }, f.a.token, origin)).status, 403);
    assert.equal((await f.send({ totp: CODE }, null)).status, 401);
    assert.equal((await f.send({ totp: CODE }, "invalid-session")).status, 401);
    assert.equal((await f.send()).status, 200);
  } finally { await f.db.close(); }
});

test("authenticator step-up rejects identity overrides and malformed codes without updating the session", async () => {
  const f = await fixture();
  try {
    for (const body of [{ totp: CODE, userId: "someone-else" }, { totp: "123" }, { totp: "a".repeat(70000) }, {}]) {
      const response = await f.send(body);
      assert.ok([400, 413].includes(response.status));
      assert.equal((await verifySession(f.db, f.a.token, { clock }))?.steppedUpAt, null);
    }
    assert.equal((await f.send()).status, 200);
  } finally { await f.db.close(); }
});

test("five incorrect authenticator attempts throttle later correct codes", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await f.send({ totp: "000000" })).status, 401);
    const response = await f.send();
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers.get("retry-after")) > 0);
    assert.equal((await verifySession(f.db, f.a.token, { clock }))?.steppedUpAt, null);
  } finally { await f.db.close(); }
});

test("authenticator codes already consumed by signin cannot confirm a session", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await checkTotpSignIn(f.db, { userId: f.user.id, secret: SECRET, code: CODE }, { clock }), { ok: true });
    assert.equal((await f.send()).status, 401);
    assert.equal((await verifySession(f.db, f.a.token, { clock }))?.steppedUpAt, null);
  } finally { await f.db.close(); }
});
