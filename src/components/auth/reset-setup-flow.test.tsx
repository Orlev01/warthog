// Review fix W5 — "Reset finished? Set up a new passkey" (`./reset-flow` in set-up mode,
// `ResetView`'s set-up steps in `./auth-views`, the /reset/setup page).
//
// The controller is driven without a DOM through injected fakes (the recover-flow
// pattern): email → POST setup-send-code → code → POST setup-verify → keep the set-up
// handle and registration options → the passkey prompt → POST setup-finish → show the new
// recovery code once → "I've saved it" → /home. Errors are plain sentences. The views are
// render-tested for their copy, labelled fields and the links that lead here.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";

import { createResetFlow } from "./reset-flow";
import { ResetView, SigninView } from "./auth-views";
import ResetSetupPage from "../../app/(auth)/reset/setup/page";

const EMAIL = "robin@example.com";
const CODE = "482913";
const NEW_RECOVERY_CODE = "ABCDEFGHJKMNPQRS";
const SETUP_ID = "s".repeat(64);
const OPTIONS = { challenge: "c", rp: { id: "warthog.com.au", name: "Warthog" } } as unknown as PublicKeyCredentialCreationOptionsJSON;
const ATTESTATION = { id: "cred", rawId: "cred", type: "public-key", response: {} } as unknown as RegistrationResponseJSON;

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A fake fetch answering each reset step from a script, recording what was posted.
function makeFetch(answers: Record<string, () => Response | Promise<Response>>) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const step = url.split("/").at(-1)!;
    const answer = answers[step];
    if (!answer) throw new Error(`unexpected step ${step}`);
    return answer();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function setupFlow(answers: Record<string, () => Response | Promise<Response>>, startRegistration = async () => ATTESTATION) {
  const { fetchImpl, calls } = makeFetch(answers);
  const navigated: string[] = [];
  const flow = createResetFlow({
    fetch: fetchImpl,
    mode: "setup",
    startRegistration,
    navigate: (path) => navigated.push(path),
  });
  return { flow, calls, navigated };
}

const HAPPY = {
  "setup-send-code": () => jsonResponse(200, { ok: true }),
  "setup-verify": () => jsonResponse(200, { setupId: SETUP_ID, registrationOptions: OPTIONS }),
  "setup-finish": () => jsonResponse(200, { recoveryCode: NEW_RECOVERY_CODE }),
};

test("set-up walks email, code, a new passkey and the new recovery code, then goes home", async () => {
  const seen: unknown[] = [];
  const { flow, calls, navigated } = setupFlow(HAPPY, async (opts?: unknown) => {
    seen.push(opts);
    return ATTESTATION;
  });
  assert.equal(flow.getState().phase, "setup-identify");

  flow.setEmail(EMAIL);
  await flow.submitIdentify();
  assert.equal(flow.getState().phase, "setup-email-code");

  flow.setEmailCode(CODE);
  await flow.submitEmailCode();
  assert.equal(flow.getState().phase, "setup-passkey");

  await flow.createPasskey();
  assert.deepEqual(seen, [{ optionsJSON: OPTIONS }], "the passkey prompt gets the server's options");
  assert.equal(flow.getState().phase, "setup-recovery");
  assert.equal(flow.getState().newRecoveryCode, NEW_RECOVERY_CODE, "the new code is shown");

  await flow.confirm();
  assert.deepEqual(navigated, [], "Continue waits for the tick");
  flow.setSavedConfirmed(true);
  await flow.confirm();
  assert.deepEqual(navigated, ["/home"]);
  assert.equal(flow.getState().newRecoveryCode, undefined, "the code is dropped once saved");

  assert.deepEqual(calls, [
    { url: "/api/auth/reset/setup-send-code", body: { email: EMAIL } },
    { url: "/api/auth/reset/setup-verify", body: { email: EMAIL, code: CODE } },
    { url: "/api/auth/reset/setup-finish", body: { setupId: SETUP_ID, registrationResponse: ATTESTATION } },
  ]);
});

test("a wrong code, a throttled address or a reset that hasn't finished each say so plainly", async () => {
  const cases: [number, RegExp][] = [
    [400, /didn't match/i],
    [429, /wait a few minutes/i],
    [409, /no finished reset/i],
    [500, /try again/i],
  ];
  for (const [status, copy] of cases) {
    const { flow } = setupFlow({ ...HAPPY, "setup-verify": () => jsonResponse(status, { error: "x" }) });
    flow.setEmail(EMAIL);
    await flow.submitIdentify();
    flow.setEmailCode(CODE);
    await flow.submitEmailCode();
    assert.equal(flow.getState().phase, "setup-email-code", `${status}: stays on the code step`);
    assert.match(flow.getState().error ?? "", copy, `${status}`);
  }
});

test("a dismissed passkey prompt posts nothing and lets the person try again", async () => {
  let attempts = 0;
  const { flow, calls } = setupFlow(HAPPY, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("NotAllowedError");
    return ATTESTATION;
  });
  flow.setEmail(EMAIL);
  await flow.submitIdentify();
  flow.setEmailCode(CODE);
  await flow.submitEmailCode();

  await flow.createPasskey();
  assert.equal(flow.getState().phase, "setup-passkey");
  assert.match(flow.getState().error ?? "", /cancelled/i);
  assert.equal(calls.filter((c) => c.url.endsWith("setup-finish")).length, 0, "nothing was posted");

  await flow.createPasskey();
  assert.equal(flow.getState().phase, "setup-recovery", "the second try goes through");
});

test("a finish the server refuses sends the person back to start again", async () => {
  const { flow } = setupFlow({ ...HAPPY, "setup-finish": () => jsonResponse(400, { error: "bad_attestation" }) });
  flow.setEmail(EMAIL);
  await flow.submitIdentify();
  flow.setEmailCode(CODE);
  await flow.submitEmailCode();
  await flow.createPasskey();
  assert.equal(flow.getState().phase, "setup-identify");
  assert.match(flow.getState().error ?? "", /start again/i);
  assert.equal(flow.getState().newRecoveryCode, undefined);
});

test("the set-up screens are labelled and plain, and the code is shown once with a tick", () => {
  const identify = renderToStaticMarkup(<ResetView step="setup-identify" />);
  assert.match(identify, /Set up a new passkey/);
  assert.match(identify, /<label[^>]*for="[^"]+"[^>]*>Email address/);
  assert.match(identify, /href="\/signin"/, "a way back to sign in");

  const code = renderToStaticMarkup(<ResetView step="setup-email-code" />);
  assert.match(code, /<label[^>]*>Your code/);

  const passkey = renderToStaticMarkup(<ResetView step="setup-passkey" />);
  assert.match(passkey, /<button[^>]*type="button"[^>]*>Create a passkey<\/button>/);
  assert.match(passkey, /old passkeys/i, "it says the old passkeys will stop working");

  const recovery = renderToStaticMarkup(<ResetView step="setup-recovery" recoveryCode={NEW_RECOVERY_CODE} />);
  assert.match(recovery, /ABCD EFGH JKMN PQRS/, "the new code, grouped");
  assert.match(recovery, /only show it once/i);
  assert.match(recovery, /I&#x27;ve saved it/);
  assert.match(recovery, /<button[^>]*disabled[^>]*>Continue<\/button>/, "Continue waits for the tick");
});

test("/reset and sign-in lead to the set-up, and its page renders for a signed-out visitor", async () => {
  const reset = renderToStaticMarkup(<ResetView step="identify" />);
  assert.match(reset, /href="\/reset\/setup"[^>]*>Reset finished\? Set up a new passkey</);
  const signin = renderToStaticMarkup(<SigninView step="passkey" />);
  assert.match(signin, /href="\/reset\/setup"[^>]*>Reset finished\? Set up a new passkey</);

  const page = renderToStaticMarkup(await ResetSetupPage());
  assert.match(page, /Set up a new passkey/);
  assert.match(page, /Email address/);
});
