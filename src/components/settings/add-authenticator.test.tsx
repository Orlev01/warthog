// Settings › Security — set up an authenticator app (follow-up S1). The interactive
// behaviour is the framework-free controller `createAddAuthenticator`, driven here with fake
// server actions (no DOM): start asks the server for the pending secret, a step-up refusal
// offers "Confirm it's you" and resumes, the code is verified, and every refusal is a plain
// sentence. The rendered control is checked with react-dom/server.
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { AddAuthenticator, createAddAuthenticator } from "./add-authenticator";

const QR = "data:image/png;base64,AAAA";
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

type BeginResult = Awaited<ReturnType<Parameters<typeof createAddAuthenticator>[0]["begin"]>>;
type VerifyResult = Awaited<ReturnType<Parameters<typeof createAddAuthenticator>[0]["verify"]>>;

function harness(begins: BeginResult[], verifies: VerifyResult[] = []) {
  const calls: string[] = [];
  let done = 0;
  const flow = createAddAuthenticator({
    begin: async () => {
      calls.push("begin");
      return begins.shift() ?? { ok: false, reason: "unavailable" };
    },
    verify: async (code) => {
      calls.push(`verify:${code}`);
      return verifies.shift() ?? { ok: false, reason: "invalid_code" };
    },
    onDone: () => { done += 1; },
  });
  return { flow, calls, done: () => done };
}

test("start shows the QR and setup key; a correct code finishes and leaves the screen", async () => {
  const h = harness([{ ok: true, secret: SECRET, qr: QR }], [{ ok: true }]);
  await h.flow.start();
  const scan = h.flow.getState();
  assert.equal(scan.phase, "scan");
  assert.equal(scan.secret, SECRET);
  assert.equal(scan.qr, QR);
  h.flow.setCode("050471");
  await h.flow.submit();
  assert.deepEqual(h.calls, ["begin", "verify:050471"]);
  assert.equal(h.done(), 1, "success hands over to the page (which shows the outcome)");
  assert.equal(h.flow.getState().secret, undefined, "the secret is dropped once set up");
});

test("a step-up refusal offers Confirm it's you, and confirming resumes the set-up", async () => {
  const h = harness([{ ok: false, reason: "step_up_required" }, { ok: true, secret: SECRET, qr: QR }]);
  await h.flow.start();
  assert.equal(h.flow.getState().confirmRequired, true);
  assert.equal(h.flow.getState().phase, "idle");
  await h.flow.confirmed();
  assert.equal(h.flow.getState().confirmRequired, false);
  assert.equal(h.flow.getState().phase, "scan");
  assert.deepEqual(h.calls, ["begin", "begin"]);
});

test("a stale confirmation while entering the code asks for a fresh code after confirming", async () => {
  const h = harness([{ ok: true, secret: SECRET, qr: QR }], [{ ok: false, reason: "step_up_required" }]);
  await h.flow.start();
  h.flow.setCode("050471");
  await h.flow.submit();
  assert.equal(h.flow.getState().confirmRequired, true);
  await h.flow.confirmed();
  const state = h.flow.getState();
  assert.equal(state.phase, "scan", "the QR stays up");
  assert.equal(state.code, "", "a used code is cleared");
  assert.match(state.notice ?? "", /enter the code your app shows now/i);
  assert.deepEqual(h.calls, ["begin", "verify:050471"], "a code is never re-sent on its own");
});

test("each refusal is a plain sentence, never a machine reason", async () => {
  const cases: [VerifyResult, RegExp, string][] = [
    [{ ok: false, reason: "invalid_code" }, /didn't match/, "scan"],
    [{ ok: false, reason: "too_many_attempts" }, /Too many incorrect codes/, "scan"],
    [{ ok: false, reason: "no_enrolment" }, /expired/, "idle"],
  ];
  for (const [result, copy, phase] of cases) {
    const h = harness([{ ok: true, secret: SECRET, qr: QR }], [result]);
    await h.flow.start();
    h.flow.setCode("123456");
    await h.flow.submit();
    const state = h.flow.getState();
    assert.match(state.error ?? "", copy);
    assert.doesNotMatch(state.error ?? "", /_/);
    assert.equal(state.phase, phase);
  }
  const busy = harness([{ ok: true, secret: SECRET, qr: QR }]);
  busy.flow.setCode("12");
  await busy.flow.start();
  busy.flow.setCode("12");
  await busy.flow.submit();
  assert.match(busy.flow.getState().error ?? "", /six-digit code/);
  assert.deepEqual(busy.calls, ["begin"], "a malformed code is not sent");
});

test("an account that already has an authenticator goes straight back to the page", async () => {
  const h = harness([{ ok: false, reason: "already_enrolled" }]);
  await h.flow.start();
  assert.equal(h.done(), 1);
});

test("a second tap while a request is running is ignored", async () => {
  const h = harness([{ ok: true, secret: SECRET, qr: QR }, { ok: true, secret: SECRET, qr: QR }]);
  await Promise.all([h.flow.start(), h.flow.start()]);
  assert.deepEqual(h.calls, ["begin"]);
});

test("Cancel hides the set-up on this screen only", async () => {
  const h = harness([{ ok: true, secret: SECRET, qr: QR }]);
  await h.flow.start();
  h.flow.cancel();
  assert.equal(h.flow.getState().phase, "idle");
  assert.equal(h.flow.getState().secret, undefined);
});

test("the idle control explains the set-up and offers one button", () => {
  const markup = renderToStaticMarkup(
    <AddAuthenticator begin={async () => ({ ok: false, reason: "unavailable" })} verify={async () => ({ ok: true })} passkey />,
  );
  assert.match(markup, />Set up an authenticator app</);
  assert.match(markup, /six-digit code/);
});
