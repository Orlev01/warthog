// Operator fix (found by the real-browser E2E): the sign-up handler verified the passkey
// attestation against `https://<rpId>`, but a browser reports the app's public origin. In local
// development that is http://localhost:3000 with RP ID localhost, so every real sign-up failed
// with bad_attestation. Pins the whole journey under a dev-shaped config.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";

import { createSignupHandler } from "./handler";
import { localAesKeyWrapper } from "../../../server/crypto/key-wrapper";
import { systemRandom } from "../../../server/seams/random";
import { fixedClock } from "../../../server/seams/clock";
import { createOutbox } from "../../../server/notify/outbox";
import { freshDb } from "../../../test/db";
import { createAuthenticator } from "../../../test/authenticator";

const ORIGIN = "http://localhost:3000";
const RP_ID = "localhost";

function post(body: unknown): Request {
  return new Request(`${ORIGIN}/api/auth/signup/x`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

test("a dev-shaped config (http://localhost:3000, RP ID localhost) completes sign-up with a browser-shaped passkey", async () => {
  const db = await freshDb();
  try {
    const outbox = createOutbox();
    const handler = createSignupHandler({
      db,
      clock: fixedClock(new Date("2026-05-01T00:00:00.000Z")),
      random: systemRandom,
      hmacKey: new Uint8Array(32).fill(7),
      emailSender: outbox,
      keyWrapper: localAesKeyWrapper(new Uint8Array(32).fill(9)),
      rpId: RP_ID,
      publicOrigin: ORIGIN,
    });
    const email = "dev-origin@warthog.test";
    assert.equal((await handler.sendCode(post({ email }))).status, 200);
    const code = outbox.list().at(-1)?.body.match(/(?<!\d)\d{6}(?!\d)/)?.[0];
    assert.ok(code, "the code is delivered");

    const started = (await (await handler.verifyEmail(post({ email, code }))).json()) as {
      signupId: string;
      registrationOptions: PublicKeyCredentialCreationOptionsJSON;
    };
    const auth = createAuthenticator({ origin: ORIGIN });
    const registerRes = await handler.registerPasskey(
      post({ signupId: started.signupId, registrationResponse: await auth.register(started.registrationOptions) }),
    );
    assert.equal(registerRes.status, 200, `the attestation verifies against the public origin: ${await registerRes.clone().text()}`);

    const confirmRes = await handler.confirmSignup(post({ signupId: started.signupId, savedConfirmed: true }));
    assert.ok(confirmRes.status >= 300 && confirmRes.status < 400, `confirm redirects, got ${confirmRes.status}`);
    assert.equal(confirmRes.headers.get("location"), "/home");
  } finally {
    await db.close();
  }
});
