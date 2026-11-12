import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/browser";
import { createRecoverFlow } from "./recover-flow";
import { createResetFlow } from "./reset-flow";
import { createDeviceFlow } from "./device-flow";
import { RecoverView, ResetView, DeviceView, SigninView, SignupView } from "./auth-views";

const registration = { id: "test-credential", rawId: "test-credential", type: "public-key", response: {}, clientExtensionResults: {} } as RegistrationResponseJSON;
const options = { challenge: "test-challenge", rp: { name: "Test" }, user: { id: "test-user", name: "test@example.com", displayName: "Test" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }] };
const json = (body: unknown, status = 200) => Response.json(body, { status });

for (const name of ["recover", "reset", "reset setup"] as const) {
  test(`${name} blocks repeated requests and input edits synchronously and permits retry after failure`, async () => {
    const response = Promise.withResolvers<Response>();
    let requests = 0;
    const fetchImpl = (async () => { requests++; return response.promise; }) as typeof fetch;
    const flow = name === "recover"
      ? createRecoverFlow({ fetch: fetchImpl, startRegistration: async () => registration, navigate: () => {} })
      : createResetFlow({ fetch: fetchImpl, mode: name === "reset setup" ? "setup" : "reset" });
    flow.setEmail("test@example.com");
    const first = flow.submitIdentify();
    void flow.submitIdentify();
    flow.setEmail("changed@example.com");
    assert.equal(requests, 1);
    assert.equal(flow.getState().busy, true);
    assert.equal(flow.getState().email, "test@example.com");
    response.resolve(json({ error: "unavailable" }, 503));
    await first;
    assert.equal(flow.getState().busy, false);
    assert.ok(flow.getState().error);
    await flow.submitIdentify();
    assert.equal(requests, 2);
  });
}

for (const name of ["recover", "reset setup"] as const) {
  test(`${name} permits only one passkey ceremony and one recovery-code response`, async () => {
    const ceremony = Promise.withResolvers<RegistrationResponseJSON>();
    let prompts = 0;
    const requests: string[] = [];
    const fetchImpl = (async (input) => {
      const step = String(input).split("/").at(-1)!;
      requests.push(step);
      return json(step === "identify" ? { recoveryId: "test-recovery" }
        : step === "setup-verify" ? { setupId: "test-setup", registrationOptions: options }
        : step === "verify-code" ? { registrationOptions: options }
        : { recoveryCode: "NEW-RECOVERY-CODE" });
    }) as typeof fetch;
    const deps = { fetch: fetchImpl, startRegistration: async () => { prompts++; return ceremony.promise; }, navigate: () => {} };
    const flow = name === "recover" ? createRecoverFlow(deps) : createResetFlow({ ...deps, mode: "setup" });
    await flow.submitIdentify();
    await flow.submitEmailCode();
    if ("submitRecoveryCode" in flow) await flow.submitRecoveryCode();
    const first = flow.createPasskey();
    void flow.createPasskey();
    assert.equal(prompts, 1);
    assert.equal(flow.getState().busy, true);
    ceremony.resolve(registration);
    await first;
    assert.equal(flow.getState().busy, false);
    assert.equal(flow.getState().newRecoveryCode, "NEW-RECOVERY-CODE");
    assert.equal(requests.filter((step) => step === "register-passkey" || step === "setup-finish").length, 1);
    assert.equal(flow.getState().error, undefined);
  });
}

test("device approval polling is exclusive and ignores responses belonging to a restarted request", async () => {
  const oldPoll = Promise.withResolvers<Response>();
  let polls = 0, requests = 0;
  const navigations: string[] = [];
  const flow = createDeviceFlow({
    fetch: (async (input) => {
      if (String(input).endsWith("/request")) return json({ requestId: `request-${++requests}` });
      polls++;
      return polls === 1 ? oldPoll.promise : json({ error: "not_approved" }, 409);
    }) as typeof fetch,
    navigate: (path) => { navigations.push(path); },
  });
  await flow.requestApproval();
  const firstPoll = flow.poll();
  void flow.poll();
  assert.equal(polls, 1, "a slow collect request must not overlap the next interval tick");
  flow.startAgain();
  await flow.requestApproval();
  await flow.poll();
  oldPoll.resolve(json({ ok: true }));
  await firstPoll;
  assert.deepEqual(navigations, [], "an abandoned request must not navigate the new flow");
  assert.equal(flow.getState().phase, "waiting");
});

test("device approval rejects a missing collection handle instead of waiting forever", async () => {
  const flow = createDeviceFlow({ fetch: (async () => json({})) as typeof fetch, navigate: () => {} });
  await flow.requestApproval();
  assert.equal(flow.getState().phase, "code");
  assert.ok(flow.getState().error);
});

test("device code sending blocks competing approval requests and clears pending after a connection failure", async () => {
  const response = Promise.withResolvers<Response>();
  let requests = 0;
  const flow = createDeviceFlow({
    fetch: (async () => { requests++; return response.promise; }) as typeof fetch,
    navigate: () => {},
  });
  flow.setEmail("test@example.com");
  const sending = flow.sendCode();
  void flow.sendCode();
  void flow.requestApproval();
  flow.setEmail("changed@example.com");
  assert.equal(requests, 1);
  assert.equal(flow.getState().email, "test@example.com");
  response.reject(new Error("private connection detail"));
  await assert.doesNotReject(sending);
  assert.equal(flow.getState().busy, false);
  assert.ok(flow.getState().error);
  assert.ok(!flow.getState().error?.includes("private connection detail"));
});

test("pending recovery, reset and device forms freeze editable fields and expose progress", () => {
  for (const element of [<RecoverView key="recover" step="identify" busy />, <ResetView key="reset" step="identify" busy />, <DeviceView key="device" step="code" busy />]) {
    const html = renderToStaticMarkup(element);
    const fields = [...html.matchAll(/<input\b([^>]*)>/g)];
    assert.ok(fields.length > 0);
    // Frozen but still focusable (a11y-01): read-only and aria-disabled, not natively
    // disabled, so focus never drops to the page while a step is working.
    assert.ok(fields.every((field) => /readOnly=""/.test(field[1]!) && /aria-disabled="true"/.test(field[1]!)));
    assert.ok(fields.every((field) => !/\sdisabled=""/.test(field[1]!)));
    assert.match(html, /Please wait|Sending|Working/);
  }
});

test("a rotated or expired recovery proof returns to a usable restart form", async () => {
  for (const reason of ["not_verified", "unknown_recovery"]) {
    const flow = createRecoverFlow({
      fetch: (async (input) => {
        const step = String(input).split("/").at(-1);
        return step === "register-passkey" ? json({ error: reason }, 400)
          : json(step === "identify" ? { recoveryId: "test-recovery" } : { registrationOptions: options });
      }) as typeof fetch,
      startRegistration: async () => registration,
      navigate: () => { assert.fail("a rejected recovery must not sign in"); },
    });
    flow.setEmail("test@example.com");
    flow.setRecoveryCode("OLD-RECOVERY-CODE");
    await flow.submitIdentify();
    await flow.submitEmailCode();
    await flow.submitRecoveryCode();
    await flow.createPasskey();
    assert.equal(flow.getState().phase, "identify");
    assert.equal(flow.getState().email, "test@example.com");
    assert.equal(flow.getState().recoveryCode, "");
    assert.equal(flow.getState().busy, false);
    assert.match(flow.getState().error ?? "", /start again/i);
  }
});

test("malformed auth responses stay on a retryable step with a safe visible error", async () => {
  for (const body of [null, {}]) {
    const fetchImpl = (async () => json(body)) as typeof fetch;
    const recover = createRecoverFlow({ fetch: fetchImpl, startRegistration: async () => registration, navigate: () => {} });
    await assert.doesNotReject(recover.submitIdentify());
    assert.equal(recover.getState().phase, "identify");
    assert.equal(recover.getState().busy, false);
    assert.ok(recover.getState().error);
    const reset = createResetFlow({ fetch: fetchImpl, mode: "setup" });
    await reset.submitIdentify();
    await assert.doesNotReject(reset.submitEmailCode());
    assert.equal(reset.getState().phase, "setup-email-code");
    assert.equal(reset.getState().busy, false);
    assert.ok(reset.getState().error);
  }
});

test("successful device collection stops polling and navigates only once", async () => {
  let collects = 0, navigations = 0;
  const flow = createDeviceFlow({
    fetch: (async (input) => {
      if (String(input).endsWith("/request")) return json({ requestId: "test-request" });
      collects++;
      return json({ ok: true });
    }) as typeof fetch,
    navigate: () => { navigations++; },
  });
  await flow.requestApproval();
  await flow.poll();
  await flow.poll();
  assert.equal(collects, 1);
  assert.equal(navigations, 1);
});

test("pending auth submits retain focusability and ignore Enter/form submission", () => {
  let calls = 0;
  const submit = () => { calls++; };
  const views = [
    SigninView({ step: "email", busy: true, onSubmitCode: submit }),
    SigninView({ step: "email-code", busy: true, onSubmitCode: submit }),
    SigninView({ step: "code", busy: true, onSubmitCode: submit }),
    SignupView({ step: "details", working: true, onSubmit: submit }),
    RecoverView({ step: "identify", busy: true, onSubmitIdentify: submit }),
    ResetView({ step: "identify", busy: true, onSubmitIdentify: submit }),
    DeviceView({ step: "code", busy: true, onSubmit: submit }),
  ];
  for (const view of views) {
    const html = renderToStaticMarkup(view);
    const submitButton = [...html.matchAll(/<button([^>]*)>/g)].find((button) => button[1]?.includes('type="submit"'));
    assert.ok(submitButton);
    assert.match(submitButton[1]!, /aria-disabled="true"/);
    assert.match(submitButton[1]!, /aria-busy="true"/);
    assert.doesNotMatch(submitButton[1]!, /\sdisabled=""/);
    const children = React.Children.toArray(view.props.children);
    const form = children.find((child): child is React.ReactElement<{ onSubmit: (event: React.FormEvent<HTMLFormElement>) => void }> => React.isValidElement(child) && child.type === "form");
    assert.ok(form);
    let prevented = false;
    form.props.onSubmit({ preventDefault: () => { prevented = true; } } as React.FormEvent<HTMLFormElement>);
    assert.equal(prevented, true);
    assert.equal(calls, 0, "aria-disabled must be backed by the form/Enter handler guard");
  }
});
