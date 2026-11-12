// Settings › Security view (UI/UX pass, lane G): one heading band and one panel per task;
// passkeys and sessions are named divider rows; removing a passkey always asks first and
// says plainly when it's the last one (interaction-05); the authenticator status is no dead
// end (content-43); the current session isn't labelled "This device" twice (interaction-24).
// Rendered with react-dom/server — no DOM, no network.
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { SecuritySettings } from "./security-view";
import { removePasskeyCopy } from "./remove-passkey";
import type { SecurityView } from "@/app/(portal)/(protected)/settings/security/actions";
import { securityNotice } from "@/app/(portal)/(protected)/settings/security/notices";

const ZONE = "Australia/Sydney";
const CURRENT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

function view(overrides: Partial<SecurityView> = {}): SecurityView {
  return {
    authenticatorEnabled: false,
    passkeys: [{ id: "10000000-0000-4000-8000-000000000001", createdAt: new Date("2026-11-12T07:17:00Z") }],
    sessions: [
      { id: CURRENT, createdAt: new Date("2026-11-12T07:10:00Z"), lastSeenAt: new Date("2026-11-12T07:17:00Z") },
      { id: OTHER, createdAt: new Date("2026-11-10T01:00:00Z"), lastSeenAt: new Date("2026-11-11T02:00:00Z") },
    ],
    ...overrides,
  };
}

const noop = async () => undefined;
function render(v: SecurityView, notice: ReturnType<typeof securityNotice> = null): string {
  return renderToStaticMarkup(
    <SecuritySettings
      view={v}
      currentSessionId={CURRENT}
      notice={notice}
      timeZone={ZONE}
      removePasskey={noop}
      signOutSession={noop}
      beginAddPasskey={async () => ({ ok: false, reason: "step_up_required" })}
      finishAddPasskey={async () => ({ ok: true })}
      regenerateRecovery={async () => ({ ok: false, reason: "step_up_required" })}
    />,
  );
}

function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

test("the page is a heading band plus one panel per task, with no hand-rolled header", () => {
  const markup = render(view());
  assert.match(markup, /<header class="wh-page-heading">[\s\S]*<h1>Security<\/h1>/);
  for (const title of ["How you sign in", "Where you&#x27;re signed in", "Make a change"]) {
    assert.match(markup, new RegExp(`<section[^>]*class="wh-panel"[\\s\\S]*?<h2[^>]*>${title}</h2>`), title);
  }
  assert.doesNotMatch(markup, /text-2xl/);
});

test("Remove opens a confirmation first: the row's button is not a submit, the dialog's is", () => {
  const markup = render(view());
  const trigger = /<button[^>]*aria-label="Remove Passkey 1"[^>]*>/.exec(markup)?.[0] ?? "";
  assert.match(trigger, /type="button"/, "the row's Remove never posts on its own");
  assert.match(trigger, /aria-haspopup="dialog"/);
  const dialog = /<dialog\b[\s\S]*?<\/dialog>/.exec(markup)?.[0] ?? "";
  assert.match(dialog, /type="submit"[^>]*>Remove passkey/);
  assert.match(text(dialog), /Keep passkey/);
  assert.match(markup, /<input type="hidden" name="passkeyId" value="10000000-0000-4000-8000-000000000001"\/>/);
});

test("removing the only passkey says so plainly, and what you'd need to get back in", () => {
  const dialog = text(/<dialog\b[\s\S]*?<\/dialog>/.exec(render(view()))?.[0] ?? "");
  assert.match(dialog, /Remove your only passkey\?/);
  assert.match(dialog, /can't sign in or confirm it's you on any device/);
  assert.match(dialog, /recovery code/);
  assert.match(dialog, /add the new one first/);
});

test("the confirmation copy fits the situation", () => {
  const many = removePasskeyCopy({ name: "Passkey 2", added: "12 Nov 2026, 6:17 pm", onlyPasskey: false, authenticatorEnabled: false });
  assert.equal(many.title, "Remove Passkey 2?");
  assert.match(many.body.join(" "), /added 12 Nov 2026, 6:17 pm/);
  assert.match(many.body.join(" "), /other passkeys keep working/);
  const withApp = removePasskeyCopy({ name: "Passkey 1", added: "x", onlyPasskey: true, authenticatorEnabled: true });
  assert.match(withApp.body.join(" "), /email and authenticator app/);
  assert.doesNotMatch(withApp.body.join(" "), /can't sign in/);
  for (const copy of [many, withApp]) assert.match(copy.body.join(" "), /vault recovery phrase/);
});

test("passkeys are named rows, and an empty list says what to do next", () => {
  const two = view({
    passkeys: [
      { id: "10000000-0000-4000-8000-000000000001", createdAt: new Date("2026-11-01T00:00:00Z") },
      { id: "10000000-0000-4000-8000-000000000002", createdAt: new Date("2026-11-12T07:17:00Z") },
    ],
  });
  const markup = render(two);
  assert.match(text(markup), /Passkey 1 Added 1 Nov 2026/);
  assert.match(text(markup), /Passkey 2 Added 12 Nov 2026, 6:17 pm/);
  assert.doesNotMatch(markup, /Australia\/Sydney/, "times carry no raw zone suffix");
  const none = text(render(view({ passkeys: [] })));
  assert.match(none, /You don't have any passkeys yet\. Add one under Make a change/);
});

test("the current session is 'This device' once; other sessions get a named Sign out", () => {
  const markup = render(view());
  assert.equal(text(markup).match(/This device/g)?.length, 1);
  assert.match(markup, /aria-label="Sign out the device signed in 10 Nov 2026, 12:00 pm"/);
  assert.match(text(markup), /Times are Sydney time\./);
});

test("the authenticator section is no dead end, in sentence case", () => {
  const off = text(render(view()));
  assert.match(off, /Authenticator app Not set up|Not set up/);
  assert.match(off, /only add one when you create an account/);
  assert.doesNotMatch(off, /Authenticator App/);
  const on = text(render(view({ authenticatorEnabled: true })));
  assert.match(on, /Set up/);
  assert.match(on, /email and a code from your authenticator app/);
});

test("a step-up refusal is said inside Confirm it's you, offering only the member's factors", () => {
  const markup = render(view({ passkeys: [], authenticatorEnabled: true }), securityNotice("step_up_required"));
  const confirm = /<div[^>]*class="wh-confirm-its-you[\s\S]*?<\/form>/.exec(markup)?.[0] ?? "";
  assert.match(text(confirm), /Nothing was changed\. For your security, confirm it's you first/);
  assert.doesNotMatch(confirm, />Confirm it&#x27;s you</, "no passkey button without a passkey");
  assert.match(confirm, /Authenticator app code/);
  assert.doesNotMatch(markup, /wh-page-notice/, "no second notice repeating the refusal");
  const done = render(view(), securityNotice("passkey_removed"));
  assert.match(done, /wh-page-notice[\s\S]*Passkey removed\./);
});
