// The passkey PRF ceremony in a real browser (operator browser E2E after review wave 2).
//
// The server sends the PRF eval salt as base64url JSON, and @simplewebauthn/browser's
// startAuthentication passes `extensions` to navigator.credentials.get VERBATIM — but WebAuthn
// requires a BufferSource there, so a real browser rejected every vault unlock. And the
// browser hands the PRF output back as an ArrayBuffer, while every caller reads a base64url
// string. These tests pin both conversions around an injected `startAuthentication`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { startVaultAuthentication } from "./prf-ceremony";

const SALT = new Uint8Array(32).map((_, i) => i + 1);
const SALT_B64URL = Buffer.from(SALT).toString("base64url");
const OUTPUT = new Uint8Array(32).map((_, i) => 255 - i);

function options() {
  return {
    challenge: "Y2hhbGxlbmdl",
    rpId: "localhost",
    allowCredentials: [],
    extensions: { prf: { eval: { first: SALT_B64URL } } },
  };
}

test("the PRF eval salt reaches the browser as bytes, and the output comes back as base64url", async () => {
  let seen: unknown;
  const assertion = await startVaultAuthentication(options(), async ({ optionsJSON }) => {
    seen = optionsJSON;
    return {
      id: "cred",
      clientExtensionResults: { prf: { results: { first: OUTPUT.buffer } } },
    };
  });

  const first = (seen as { extensions: { prf: { eval: { first: unknown } } } }).extensions.prf.eval.first;
  assert.ok(first instanceof Uint8Array, "the salt is a BufferSource, not a string");
  assert.deepEqual([...(first as Uint8Array)], [...SALT]);
  assert.equal(assertion.clientExtensionResults?.prf?.results?.first, Buffer.from(OUTPUT).toString("base64url"));
});

test("a second salt converts too, and options without PRF pass through unchanged", async () => {
  const withSecond = options();
  (withSecond.extensions.prf.eval as Record<string, string>).second = SALT_B64URL;
  let seen: { extensions?: { prf?: { eval?: Record<string, unknown> } } } | undefined;
  await startVaultAuthentication(withSecond, async ({ optionsJSON }) => {
    seen = optionsJSON as typeof seen;
    return { id: "cred", clientExtensionResults: {} };
  });
  assert.ok(seen?.extensions?.prf?.eval?.second instanceof Uint8Array);

  const plain = { challenge: "Y2hhbGxlbmdl", rpId: "localhost" };
  let passed: unknown;
  const out = await startVaultAuthentication(plain, async ({ optionsJSON }) => {
    passed = optionsJSON;
    return { id: "cred", clientExtensionResults: {} };
  });
  assert.deepEqual(passed, plain);
  assert.equal(out.clientExtensionResults?.prf?.results?.first, undefined, "no PRF output is invented");
});

test("an output that is already base64url (a test fake) is left as it is", async () => {
  const out = await startVaultAuthentication(options(), async () => ({
    id: "cred",
    clientExtensionResults: { prf: { results: { first: "AAAA" } } },
  }));
  assert.equal(out.clientExtensionResults?.prf?.results?.first, "AAAA");
});
