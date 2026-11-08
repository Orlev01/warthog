// Review fix W3.3 — the account-reset screens (`./reset-flow`, `ResetView` in
// `./auth-views`) and the signed-in banner that cancels a pending reset
// (`./pending-reset-banner`).
//
// The controller is driven without a DOM through injected fakes (the recover-flow
// pattern): email → POST send-code → code → POST request → "requested" with the date the
// reset completes. Errors are plain sentences. The view and the banner are render-tested
// for their copy, labels and real (never dead) controls.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { createResetFlow } from "./reset-flow";
import { ResetView, SigninView } from "./auth-views";
import { createCancelReset, PendingResetBanner } from "./pending-reset-banner";
import ResetPage from "../../app/(auth)/reset/page";

const EMAIL = "robin@example.com";
const CODE = "482913";
const COMPLETES_AT = "2026-05-08T00:00:00.000Z";

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A fake fetch answering each reset step from a script, recording what was posted.
function makeFetch(answers: Record<string, () => Response>) {
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

test("the flow sends a code, starts the reset with it and says when it completes", async () => {
  const { fetchImpl, calls } = makeFetch({
    "send-code": () => jsonResponse(200, { ok: true }),
    request: () => jsonResponse(200, { ok: true, completesAt: COMPLETES_AT }),
  });
  const flow = createResetFlow({ fetch: fetchImpl });
  assert.equal(flow.getState().phase, "identify");

  flow.setEmail(EMAIL);
  await flow.submitIdentify();
  assert.equal(flow.getState().phase, "email-code");

  flow.setEmailCode(CODE);
  await flow.submitEmailCode();
  assert.equal(flow.getState().phase, "requested");
  assert.equal(flow.getState().completesAt, COMPLETES_AT);
  assert.equal(flow.getState().error, undefined);

  assert.deepEqual(calls, [
    { url: "/api/auth/reset/send-code", body: { email: EMAIL } },
    { url: "/api/auth/reset/request", body: { email: EMAIL, code: CODE } },
  ]);
});

test("a wrong code keeps the person on the code step with a plain message", async () => {
  const { fetchImpl } = makeFetch({
    "send-code": () => jsonResponse(200, { ok: true }),
    request: () => jsonResponse(400, { error: "invalid_code" }),
  });
  const flow = createResetFlow({ fetch: fetchImpl });
  flow.setEmail(EMAIL);
  await flow.submitIdentify();
  flow.setEmailCode("000000");
  await flow.submitEmailCode();
  assert.equal(flow.getState().phase, "email-code");
  assert.match(flow.getState().error ?? "", /didn't match/i);
});

test("when no alert could be sent, or the network fails, the person is told to try later", async () => {
  for (const answer of [() => jsonResponse(503, { error: "alert_failed" }), () => Promise.reject(new Error("offline"))]) {
    const { fetchImpl } = makeFetch({
      "send-code": () => jsonResponse(200, { ok: true }),
      request: answer as () => Response,
    });
    const flow = createResetFlow({ fetch: fetchImpl });
    flow.setEmail(EMAIL);
    await flow.submitIdentify();
    flow.setEmailCode(CODE);
    await flow.submitEmailCode();
    assert.equal(flow.getState().phase, "email-code");
    assert.match(flow.getState().error ?? "", /try again/i);
  }
});

test("the reset screens explain the 7-day wait and what a reset erases, with labelled fields", () => {
  const identify = renderToStaticMarkup(<ResetView step="identify" />);
  assert.match(identify, /Reset your account/);
  assert.match(identify, /7 days/);
  assert.match(identify, /cancel/i);
  assert.match(identify, /erase/i);
  assert.match(identify, /<label[^>]*for="[^"]+"[^>]*>Email address/);
  assert.match(identify, /href="\/signin"/, "a way back to sign in");

  const code = renderToStaticMarkup(<ResetView step="email-code" />);
  assert.match(code, /<label[^>]*>Your code/);
  assert.match(code, /Start the reset/);

  const requested = renderToStaticMarkup(<ResetView step="requested" completesAt={COMPLETES_AT} />);
  assert.match(requested, /8 May 2026/, "the completion date in plain words");
  assert.match(requested, /role="status"/);
});

test("the sign-in screen offers the reset when everything is lost", () => {
  const markup = renderToStaticMarkup(<SigninView step="passkey" />);
  assert.match(markup, /href="\/reset"[^>]*>Lost everything\? Reset your account</);
});

test("the reset page renders the first step for a signed-out visitor", async () => {
  const markup = renderToStaticMarkup(await ResetPage());
  assert.match(markup, /Reset your account/);
});

test("the banner names the dates and offers a real cancel button", () => {
  const markup = renderToStaticMarkup(
    <PendingResetBanner requestedAt="2026-05-01T00:00:00.000Z" completesAt={COMPLETES_AT} />,
  );
  assert.match(markup, /role="alert"/);
  assert.match(markup, /1 May 2026/);
  assert.match(markup, /8 May 2026/);
  assert.match(markup, /<button[^>]*type="button"[^>]*>Cancel the reset<\/button>/);
  assert.doesNotMatch(markup, /<button[^>]*\sdisabled[=\s>]/, "the button is live");
});

test("cancelling posts to the cancel step and reports the outcome in plain words", async () => {
  const ok = makeFetch({ cancel: () => jsonResponse(200, { ok: true }) });
  assert.deepEqual(await createCancelReset(ok.fetchImpl)(), { ok: true });
  assert.deepEqual(ok.calls, [{ url: "/api/auth/reset/cancel", body: {} }]);

  const gone = makeFetch({ cancel: () => jsonResponse(404, { error: "no_pending_reset" }) });
  assert.deepEqual(await createCancelReset(gone.fetchImpl)(), { ok: true }, "nothing left to cancel is fine");

  const broken = makeFetch({ cancel: () => jsonResponse(500) });
  const result = await createCancelReset(broken.fetchImpl)();
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /try again/i);
});
