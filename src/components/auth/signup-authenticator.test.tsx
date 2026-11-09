import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createSignupFlow } from "./signup-flow";
import { SignupView } from "./auth-views";

test("signup can enroll an authenticator and confirm recovery without invoking WebAuthn", async () => {
  const sent: Array<{ step: string; body: unknown }> = [];
  const navigated: string[] = [];
  const responses: Record<string, unknown> = {
    "send-code": { ok: true }, "verify-email": { signupId: "pending", registrationOptions: {} },
    "begin-totp": { secret: "SYNTHETICSECRET", qr: "data:image/png;base64,AA==" },
    "verify-totp": { recoveryCode: "SYNTHETIC-RECOVERY" }, "confirm": { ok: true },
  };
  const flow = createSignupFlow({
    fetch: async (url, init) => {
      const step = String(url).split("/").at(-1)!;
      sent.push({ step, body: JSON.parse(init!.body as string) });
      return new Response(JSON.stringify(responses[step]), { status: 200 });
    }, startRegistration: async () => { throw new Error("must not invoke WebAuthn"); }, navigate: (url) => navigated.push(url),
  });
  flow.setEmail("person@example.test"); flow.setName("Example Person");
  await flow.submitEmail(); flow.setCode("123456"); await flow.submitCode();
  await flow.useAuthenticatorApp();
  assert.equal(flow.getState().phase, "authenticator");
  assert.equal(flow.getState().authenticatorSecret, "SYNTHETICSECRET");
  flow.setCode("050471"); await flow.submitAuthenticatorCode();
  assert.equal(flow.getState().phase, "recovery");
  assert.equal(flow.getState().authenticatorSecret, undefined);
  assert.equal(flow.getState().recoveryCode, "SYNTHETIC-RECOVERY");
  flow.setSavedConfirmed(true); await flow.confirm();
  assert.deepEqual(navigated, ["/home"]);
  assert.deepEqual(sent.slice(2), [
    { step: "begin-totp", body: { signupId: "pending" } },
    { step: "verify-totp", body: { signupId: "pending", totp: "050471" } },
    { step: "confirm", body: { signupId: "pending", savedConfirmed: true } },
  ]);
});

test("signup freezes submitted identity and ignores duplicate submissions while pending", async () => {
  let resolve!: (response: Response) => void;
  const calls: unknown[] = [];
  const flow = createSignupFlow({
    fetch: async (_url, init) => { calls.push(JSON.parse(init!.body as string)); return new Promise((done) => { resolve = done; }); },
    startRegistration: async () => { throw new Error("unused"); }, navigate: () => {},
  });
  flow.setEmail("first@example.test"); flow.setName("First Person");
  const sending = flow.submitEmail();
  flow.setEmail("second@example.test"); flow.setName("Second Person");
  const repeated = flow.submitEmail();
  assert.equal(calls.length, 1);
  assert.equal(flow.getState().email, "first@example.test");
  assert.equal(flow.getState().working, true);
  resolve(new Response('{"ok":true}', { status: 200 }));
  await Promise.all([sending, repeated]);
  assert.equal(flow.getState().working, false);
});

test("signup offers the fallback and labels the enrollment input and manual key", () => {
  assert.match(renderToStaticMarkup(<SignupView step="passkey" />), /Use an authenticator app/);
  const markup = renderToStaticMarkup(<SignupView step="authenticator" authenticatorSecret="SYNTHETICSECRET" authenticatorQr="data:image/png;base64,AA==" />);
  assert.match(markup, /Authenticator app code/);
  assert.match(markup, /SYNTHETICSECRET/);
  assert.match(markup, /alt="Authenticator app setup code"/);
});
