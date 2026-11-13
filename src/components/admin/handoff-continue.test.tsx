// The app-side handoff screen (src/components/admin/handoff-continue.tsx), reached only by
// a signed-in admin through the unlinked /handoff route: the controller navigates on
// success, offers the inline step-up when the server asks for one and retries after
// confirmation, turns every refusal into a sentence, and ignores a second start while
// working. The rendered screen is checked with react-dom/server.
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { HandoffContinue, createHandoffContinue } from "./handoff-continue";
import type { HandoffResult } from "@/server/admin/handoff";

function harness(results: HandoffResult[]) {
  const navigated: string[] = [];
  let calls = 0;
  const flow = createHandoffContinue({
    startHandoff: async () => { calls++; return results.shift() ?? { ok: false, reason: "not_admin" }; },
    navigate: (url) => { navigated.push(url); },
  });
  return { flow, navigated, calls: () => calls };
}

test("success navigates the browser to the exchange URL", async () => {
  const h = harness([{ ok: true, url: "https://admin.example.test/session?handoff=abc" }]);
  await h.flow.start();
  assert.deepEqual(h.navigated, ["https://admin.example.test/session?handoff=abc"]);
});

test("a stale step-up offers the confirmation and retries once confirmed", async () => {
  const h = harness([{ ok: false, reason: "step_up_required" }, { ok: true, url: "https://admin.example.test/session?handoff=def" }]);
  await h.flow.start();
  assert.equal(h.flow.getState().phase, "step_up");
  await h.flow.start(); // what onConfirmed does
  assert.deepEqual(h.navigated, ["https://admin.example.test/session?handoff=def"]);
  assert.equal(h.calls(), 2);
});

test("refusals are plain sentences and a thrown action never crashes", async () => {
  const signedOut = harness([{ ok: false, reason: "signed_out" }]);
  await signedOut.flow.start();
  assert.deepEqual(signedOut.flow.getState(), { phase: "error", error: "Your session has ended. Sign in again." });
  const member = harness([{ ok: false, reason: "not_admin" }]);
  await member.flow.start();
  assert.deepEqual(member.flow.getState(), { phase: "error", error: "This account can't continue." });
  const broken = createHandoffContinue({ startHandoff: async () => { throw new Error("offline"); }, navigate: () => {} });
  await broken.start();
  assert.equal(broken.getState().phase, "error");
});

test("a second start while working is ignored (a doubled mount effect mints one handoff)", async () => {
  let release!: (r: HandoffResult) => void;
  let calls = 0;
  const flow = createHandoffContinue({ startHandoff: () => { calls++; return new Promise<HandoffResult>((resolve) => { release = resolve; }); }, navigate: () => {} });
  const first = flow.start();
  await flow.start();
  release({ ok: false, reason: "not_admin" });
  await first;
  assert.equal(calls, 1);
});

test("renders a status screen that is working from the first paint, with no raw colour", () => {
  const html = renderToStaticMarkup(<HandoffContinue startHandoff={async () => ({ ok: false, reason: "not_admin" })} passkey={true} authenticator={false} navigate={() => {}} />);
  assert.match(html, /Opening the admin portal/);
  assert.match(html, /wh-status-panel/);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}\b/);
});
