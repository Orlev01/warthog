// The admin portal entry on Settings (src/components/settings/admin-portal-entry.tsx):
// the controller navigates on success, offers the inline step-up when the server asks for
// one and retries after confirmation, turns every refusal into a sentence, and ignores a
// second tap while working. The rendered control is checked with react-dom/server.
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminPortalEntry, createAdminPortalEntry } from "./admin-portal-entry";
import type { HandoffResult } from "@/server/admin/handoff";

function harness(results: HandoffResult[]) {
  const navigated: string[] = [];
  let calls = 0;
  const flow = createAdminPortalEntry({
    startHandoff: async () => { calls++; return results.shift() ?? { ok: false, reason: "not_admin" }; },
    navigate: (url) => { navigated.push(url); },
  });
  return { flow, navigated, calls: () => calls };
}

test("success navigates the browser to the exchange URL", async () => {
  const h = harness([{ ok: true, url: "https://admin.example.test/session?handoff=abc" }]);
  await h.flow.open();
  assert.deepEqual(h.navigated, ["https://admin.example.test/session?handoff=abc"]);
});

test("a stale step-up offers the confirmation and retries once confirmed", async () => {
  const h = harness([{ ok: false, reason: "step_up_required" }, { ok: true, url: "https://admin.example.test/session?handoff=def" }]);
  await h.flow.open();
  assert.equal(h.flow.getState().phase, "step_up");
  await h.flow.open(); // what onConfirmed does
  assert.deepEqual(h.navigated, ["https://admin.example.test/session?handoff=def"]);
  assert.equal(h.calls(), 2);
});

test("refusals are plain sentences and a thrown action never crashes", async () => {
  const signedOut = harness([{ ok: false, reason: "signed_out" }]);
  await signedOut.flow.open();
  assert.deepEqual(signedOut.flow.getState(), { phase: "error", error: "Your session has ended. Sign in again, then open the admin portal." });
  const member = harness([{ ok: false, reason: "not_admin" }]);
  await member.flow.open();
  assert.deepEqual(member.flow.getState(), { phase: "error", error: "This account can't open the admin portal." });
  const broken = createAdminPortalEntry({ startHandoff: async () => { throw new Error("offline"); }, navigate: () => {} });
  await broken.open();
  assert.equal(broken.getState().phase, "error");
});

test("a second tap while working is ignored", async () => {
  let release!: (r: HandoffResult) => void;
  let calls = 0;
  const flow = createAdminPortalEntry({ startHandoff: () => { calls++; return new Promise<HandoffResult>((resolve) => { release = resolve; }); }, navigate: () => {} });
  const first = flow.open();
  await flow.open();
  release({ ok: false, reason: "not_admin" });
  await first;
  assert.equal(calls, 1);
});

test("renders a bounded panel with one primary action and no raw colour", () => {
  const html = renderToStaticMarkup(<AdminPortalEntry startHandoff={async () => ({ ok: false, reason: "not_admin" })} passkey={true} authenticator={false} navigate={() => {}} />);
  assert.match(html, /Admin portal/);
  assert.match(html, /Open admin portal/);
  assert.match(html, /wh-panel/);
  assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}\b/);
});
