// Operator fix (found by the real-browser E2E): passkey verification derived the expected
// origin from the RP ID (`https://<rpId>`). The browser's origin is the app's public origin
// (`http://localhost:3000` in dev; `https://app.warthog.com.au` if the app is ever served from a
// subdomain of the RP ID), so every real registration and sign-in failed. Verification takes the
// configured origin.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
} from "./passkey";
import { freshDb } from "../../test/db";
import { createAuthenticator } from "../../test/authenticator";
import { createUser } from "../db/users";

const DEV = { rpId: "localhost", origin: "http://localhost:3000" };
const SUBDOMAIN = { rpId: "warthog.com.au", origin: "https://app.warthog.com.au" };

for (const cfg of [DEV, SUBDOMAIN]) {
  test(`registration and sign-in verify against the configured origin ${cfg.origin} (RP ID ${cfg.rpId})`, async () => {
    const db = await freshDb();
    try {
      const user = await createUser(db, { email: `origin-${cfg.rpId}@warthog.com.au`, wrappedDek: "wrapped" });
      const auth = createAuthenticator({ origin: cfg.origin });
      const regOptions = await beginPasskeyRegistration(db, { userId: user.id, userName: user.email }, cfg);
      const reg = await finishPasskeyRegistration(db, { userId: user.id, response: await auth.register(regOptions) }, cfg);
      assert.equal(reg.ok, true, `registration verifies for ${cfg.origin}: ${JSON.stringify(reg)}`);
      const authOptions = await beginPasskeyAuthentication(db, { userId: user.id }, cfg);
      const signIn = await finishPasskeyAuthentication(db, { userId: user.id, response: await auth.authenticate(authOptions) }, cfg);
      assert.equal(signIn.ok, true, `sign-in verifies for ${cfg.origin}: ${JSON.stringify(signIn)}`);
    } finally {
      await db.close();
    }
  });
}

test("a response made on a different origin is rejected", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "origin-foreign@warthog.com.au", wrappedDek: "wrapped" });
    const foreign = createAuthenticator({ origin: "https://evil.example" });
    const regOptions = await beginPasskeyRegistration(db, { userId: user.id, userName: user.email }, DEV);
    const reg = await finishPasskeyRegistration(db, { userId: user.id, response: await foreign.register(regOptions) }, DEV);
    assert.equal(reg.ok, false, "an attestation from another origin never registers");
  } finally {
    await db.close();
  }
});
