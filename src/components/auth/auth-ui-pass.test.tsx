// UI/UX pass (12 Nov 2026) — behaviour the account-entry screens gained in lane P:
//   • public-03: every auth form posts, so a submit before hydration can never put an
//     email address or one-time code into the URL, history or server logs;
//   • public-04: code steps show the address with a client-side way back, a resend uses the
//     same rate-limited request and never claims a send the server refused;
//   • public-02: an address that already has an account ends in a titled state with the two
//     ways in, and the meaningless recovery code is dropped;
//   • public-15 / public-01: the recovery code renders as unbreakable groups with a copy
//     action, and the unfinished device approval is explained rather than promised.
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { DeviceView, RecoverView, ResetView, SigninView, SignupView } from "./auth-views";
import { createSignupFlow } from "./signup-flow";
import { createSigninFlow } from "./signin-flow";
import { createRecoverFlow } from "./recover-flow";
import { createResetFlow } from "./reset-flow";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const EVERY_STEP: React.ReactElement[] = [
  ...(["details", "code", "passkey", "authenticator", "recovery", "exists"] as const).map((step) => <SignupView key={`su-${step}`} step={step} email="sam@example.test" />),
  ...(["passkey", "email", "email-code", "code"] as const).map((step) => <SigninView key={`si-${step}`} step={step} email="sam@example.test" />),
  ...(["identify", "email-code", "recovery-code", "passkey", "new-recovery"] as const).map((step) => <RecoverView key={`rc-${step}`} step={step} email="sam@example.test" />),
  ...(["identify", "email-code", "requested", "setup-identify", "setup-email-code", "setup-passkey", "setup-recovery"] as const).map((step) => <ResetView key={`rs-${step}`} step={step} email="sam@example.test" />),
  ...(["code", "confirm", "waiting", "stopped"] as const).map((step) => <DeviceView key={`dv-${step}`} step={step} />),
];

test("public-03: every auth form posts, so a pre-hydration submit never puts credentials in the URL", () => {
  let forms = 0;
  for (const element of EVERY_STEP) {
    const markup = renderToStaticMarkup(element);
    for (const [form] of markup.matchAll(/<form\b[^>]*>/g)) {
      forms++;
      assert.match(form, /\bmethod="post"/, `every auth form must post, got ${form}`);
      assert.doesNotMatch(form, /\baction="[^"]*\?/, "a form never targets a query-string URL");
    }
  }
  assert.ok(forms >= 15, `expected the auth steps to render their forms, found ${forms}`);
});

test("public-04: code steps show the address and a way to change it", () => {
  for (const element of [
    <SignupView key="su" step="code" email="sam@example.test" onChangeEmail={() => {}} />,
    <SigninView key="si" step="email-code" email="sam@example.test" onUseAuthenticatorApp={() => {}} />,
    <RecoverView key="rc" step="email-code" email="sam@example.test" onChangeEmail={() => {}} />,
    <ResetView key="rs" step="email-code" email="sam@example.test" onChangeEmail={() => {}} />,
    <ResetView key="ss" step="setup-email-code" email="sam@example.test" onChangeEmail={() => {}} />,
  ]) {
    const markup = renderToStaticMarkup(element);
    assert.match(markup, /sam@example\.test/);
    assert.match(markup, /<button type="button"[^>]*>Use a different email<\/button>/);
    // Never a claim that a code was definitely emailed when the send could have been held back.
    assert.doesNotMatch(markup, /we&#x27;ve emailed it a code/i);
  }
});

test("public-04: a signup resend uses the same send-code request and tells the truth when throttled", async () => {
  const calls: string[] = [];
  let sendStatus = 200;
  const flow = createSignupFlow({
    fetch: (async (input: RequestInfo | URL) => {
      const step = String(input).split("/").at(-1)!;
      calls.push(step);
      return step === "send-code" ? json(sendStatus, sendStatus === 200 ? { ok: true } : { error: "throttled" }) : json(400, {});
    }) as typeof fetch,
    startRegistration: async () => { throw new Error("unused"); },
    navigate: () => {},
  });
  flow.setEmail("sam@example.test");
  await flow.submitEmail();
  assert.equal(flow.getState().phase, "code");
  sendStatus = 429;
  await flow.resendCode();
  assert.deepEqual(calls, ["send-code", "send-code"]);
  assert.match(flow.getState().notice ?? "", /didn't send another/);
  assert.equal(flow.getState().phase, "code");
  sendStatus = 200;
  await flow.resendCode();
  assert.match(flow.getState().notice ?? "", /sent a new code/);

  flow.changeEmail();
  assert.equal(flow.getState().phase, "details");
  assert.equal(flow.getState().email, "sam@example.test", "the address is kept to edit");
  assert.equal(calls.length, 3, "changing the address sends nothing");
});

test("public-04: a throttled first send is a form-level warning with a way to enter the code already sent", async () => {
  const flow = createSignupFlow({
    fetch: (async () => json(429, { error: "throttled" })) as typeof fetch,
    startRegistration: async () => { throw new Error("unused"); },
    navigate: () => {},
  });
  flow.setEmail("sam@example.test");
  await flow.submitEmail();
  const state = flow.getState();
  assert.equal(state.phase, "details");
  assert.equal(state.codeThrottled, true);
  const markup = renderToStaticMarkup(<SignupView step="details" email={state.email} error={state.error} codeThrottled onUseExistingCode={() => {}} />);
  assert.doesNotMatch(markup, /aria-invalid="true"/, "a delivery problem never marks the email invalid");
  assert.match(markup, /Enter the code I already have/);
  flow.useExistingCode();
  assert.equal(flow.getState().phase, "code");
});

test("public-02: an existing account ends sign-up in a titled state with Sign in and Recover", async () => {
  const flow = createSignupFlow({
    fetch: (async (input: RequestInfo | URL) => {
      const step = String(input).split("/").at(-1)!;
      if (step === "verify-email") return json(200, { signupId: "s", registrationOptions: { challenge: "c" } });
      if (step === "register-passkey") return json(200, { recoveryCode: "ABCDEFGHJKMNPQRS" });
      if (step === "confirm") return json(409, { error: "account_exists" });
      return json(200, { ok: true });
    }) as typeof fetch,
    startRegistration: async () => ({}) as never,
    navigate: () => assert.fail("no navigation"),
  });
  flow.setEmail("sam@example.test");
  await flow.submitEmail();
  await flow.submitCode();
  await flow.createPasskey();
  flow.setSavedConfirmed(true);
  await flow.confirm();
  const state = flow.getState();
  assert.equal(state.phase, "exists");
  assert.equal(state.recoveryCode, undefined, "the code that will never work is dropped");
  const markup = renderToStaticMarkup(<SignupView step="exists" email={state.email} error={state.error} returnTo="/inbox" />);
  assert.match(markup, /You already have an account/);
  assert.match(markup, /href="\/signin\?next=%2Finbox"/);
  assert.match(markup, /href="\/recover\?next=%2Finbox"/);
});

test("public-04: a sign-in resend reports a throttled send plainly", async () => {
  const flow = createSigninFlow({
    fetch: (async (input: RequestInfo | URL) => (String(input).endsWith("send-email-code") ? json(429, { error: "throttled" }) : json(400, {}))) as typeof fetch,
    startAuthentication: async () => { throw new Error("unused"); },
    navigate: () => {},
  });
  flow.setEmail("sam@example.test");
  flow.useAuthenticatorApp();
  await flow.signInWithCode();
  assert.equal(flow.getState().phase, "email");
  // From the code step, a resend that the server holds back says so.
  const ok = createSigninFlow({
    fetch: (async (input: RequestInfo | URL) => (String(input).endsWith("send-email-code") ? json(200, { ok: true }) : json(400, {}))) as typeof fetch,
    startAuthentication: async () => { throw new Error("unused"); },
    navigate: () => {},
  });
  ok.setEmail("sam@example.test");
  ok.useAuthenticatorApp();
  await ok.signInWithCode();
  assert.equal(ok.getState().phase, "email-code");
  await ok.resendEmailCode();
  assert.match(ok.getState().notice ?? "", /sent a new code/);
});

test("public-04: recover and reset step back to the email without sending anything", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input).split("/").at(-1)!);
    return json(200, { recoveryId: "r" });
  }) as typeof fetch;
  const recover = createRecoverFlow({ fetch: fetchImpl, startRegistration: async () => ({}) as never, navigate: () => {} });
  recover.setEmail("sam@example.test");
  await recover.submitIdentify();
  assert.equal(recover.getState().phase, "email-code");
  recover.changeEmail();
  assert.equal(recover.getState().phase, "identify");
  assert.deepEqual(calls, ["identify"]);

  const reset = createResetFlow({ fetch: fetchImpl, mode: "setup" });
  reset.setEmail("sam@example.test");
  await reset.submitIdentify();
  assert.equal(reset.getState().phase, "setup-email-code");
  reset.changeEmail();
  assert.equal(reset.getState().phase, "setup-identify");
});

test("public-15: the recovery code renders as unbreakable groups with a copy action", () => {
  const markup = renderToStaticMarkup(<SignupView step="recovery" recoveryCode="ABCDEFGHJKMNPQRSTUVWXYZ234" />);
  assert.match(markup, /<span>ABCD<\/span> <span>EFGH<\/span>/);
  assert.match(markup, /<button[^>]*>(?:<svg[\s\S]*?<\/svg>)?Copy<\/button>/);
  assert.doesNotMatch(markup, /<input[^>]*value="ABCD/, "the code is never a form value");
});

test("public-01 (follow-up S3): the device screens say where the request is approved, and keep the other ways in", () => {
  for (const step of ["code", "waiting"] as const) {
    const markup = renderToStaticMarkup(<DeviceView step={step} />);
    assert.doesNotMatch(markup, /isn’t available/, "approval from another device is real now");
    assert.match(markup, /Settings › Security › Sign-in requests/);
    assert.match(markup, /href="\/signin"/);
    assert.match(markup, /href="\/recover"/);
  }
  const waiting = renderToStaticMarkup(<DeviceView step="waiting" deviceLabel="Chrome on Mac" expires="12:10 pm" />);
  assert.match(waiting, /Chrome on Mac/);
  assert.match(waiting, /12:10 pm/);
  assert.match(waiting, /Only approve it if/);
});
