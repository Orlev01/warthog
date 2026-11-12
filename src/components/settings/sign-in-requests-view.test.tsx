// Settings › Security › Sign-in requests (follow-up S3). The view lists the member's waiting
// requests (device label, when asked, when it expires), says plainly to approve only a
// sign-in you just tried yourself, and never answers on one tap: Approve and Deny each ask
// first in a dialog. Approve's controller handles the fresh "confirm it's you" and resumes;
// every answer reloads the screen with its outcome. Rendered with react-dom/server; the
// controller is driven with fake server actions.
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { SignInRequestsView } from "./sign-in-requests-view";
import { createSignInRequestDecision } from "./sign-in-request-decision";
import { signInRequestNotice } from "@/app/(portal)/(protected)/settings/security/sign-in-requests/actions";

const ID = "0123456789abcdef0123456789abcdef";

function render(requests: Parameters<typeof SignInRequestsView>[0]["requests"], notice: ReturnType<typeof signInRequestNotice> = null) {
  return renderToStaticMarkup(
    <SignInRequestsView
      requests={requests}
      notice={notice}
      timeZone="Australia/Sydney"
      passkey
      authenticator={false}
      approve={async () => ({ ok: true })}
      deny={async () => ({ ok: true })}
    />,
  );
}

function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

const ONE = [{
  id: ID,
  deviceLabel: "Chrome on Mac",
  requestedAt: new Date("2026-11-13T01:00:00Z"),
  expiresAt: new Date("2026-11-13T01:10:00Z"),
}];

test("a waiting request shows its device, when it was asked and when it expires, with the plain warning", () => {
  const markup = render(ONE);
  const t = text(markup);
  assert.match(markup, /<h1>Sign-in requests<\/h1>/);
  assert.match(t, /Chrome on Mac/);
  assert.match(t, /Requested 13 Nov 2026, 12:00 pm/);
  assert.match(t, /Expires 12:10 pm/);
  assert.match(t, /Only approve if you just tried to sign in on that device yourself/);
  assert.match(markup, /<time dateTime="2026-11-13T01:10:00.000Z"/);
  assert.doesNotMatch(markup, /Australia\/Sydney/);
});

test("Approve and Deny each ask first: the row's buttons only open dialogs", () => {
  const markup = render(ONE);
  for (const name of ["Approve sign-in on Chrome on Mac", "Deny sign-in on Chrome on Mac"]) {
    const trigger = new RegExp(`<button[^>]*aria-label="${name}"[^>]*>`).exec(markup)?.[0] ?? "";
    assert.match(trigger, /type="button"/, name);
    assert.match(trigger, /aria-haspopup="dialog"/, name);
  }
  const dialogs = markup.match(/<dialog\b[\s\S]*?<\/dialog>/g) ?? [];
  assert.equal(dialogs.length, 2);
  assert.match(text(dialogs[0]!), /Approve sign-in on Chrome on Mac\?.*Only approve if you just tried to sign in on that device yourself/);
  assert.match(text(dialogs[0]!), /Approve sign-in/);
  assert.match(text(dialogs[1]!), /Deny this sign-in request\?.*Chrome on Mac won't be able to sign in/);
  assert.match(text(dialogs[1]!), /Keep request.*Deny request/);
});

test("no requests is an empty state that says how one gets here", () => {
  const t = text(render([]));
  assert.match(t, /No sign-in requests right now/);
  assert.match(t, /Approve from another device/);
  assert.match(t, /10 minutes/);
});

test("an outcome is one page notice", () => {
  const markup = render([], signInRequestNotice("approved"));
  assert.match(markup, /wh-page-notice[\s\S]*Approved\./);
});

function decision(results: { approve?: { ok: boolean; reason?: string }[]; deny?: { ok: boolean; reason?: string }[] }) {
  const calls: string[] = [];
  const done: string[] = [];
  const flow = createSignInRequestDecision({
    approve: async () => { calls.push("approve"); return (results.approve?.shift() ?? { ok: true }) as never; },
    deny: async () => { calls.push("deny"); return (results.deny?.shift() ?? { ok: true }) as never; },
    onDone: (code) => { done.push(code); },
  });
  return { flow, calls, done };
}

test("approving without a fresh confirmation offers Confirm it's you, then approves once confirmed", async () => {
  const d = decision({ approve: [{ ok: false, reason: "step_up_required" }, { ok: true }] });
  await d.flow.approve();
  assert.equal(d.flow.getState().confirmRequired, true);
  assert.deepEqual(d.done, []);
  await d.flow.confirmed();
  assert.deepEqual(d.calls, ["approve", "approve"]);
  assert.deepEqual(d.done, ["approved"]);
});

test("deny reloads with its outcome; a request that's gone says so", async () => {
  const denied = decision({});
  await denied.flow.deny();
  assert.deepEqual(denied.done, ["denied"]);
  const gone = decision({ approve: [{ ok: false, reason: "not_found" }] });
  await gone.flow.approve();
  assert.deepEqual(gone.done, ["not_found"]);
});

test("a second tap while an answer is in flight is ignored", async () => {
  const d = decision({});
  await Promise.all([d.flow.approve(), d.flow.approve(), d.flow.deny()]);
  assert.deepEqual(d.calls, ["approve"]);
});

test("the server-rendered list reads its copy from a plain module, never from the client component", async () => {
  // A value exported from a "use client" module reaches a server component only as a client
  // reference, so the warning must come from the shared copy module.
  const copy = await import("./sign-in-request-copy");
  assert.match(copy.APPROVE_WARNING, /Only approve if you just tried to sign in on that device yourself/);
  const decision = await import("./sign-in-request-decision");
  assert.equal("APPROVE_WARNING" in decision, false, "the client module exports components and controllers only");
});
