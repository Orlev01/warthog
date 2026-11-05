// E04-S38 — Sign out: the 'Sign out' control in the portal chrome
// (src/components/shell/portal-chrome.tsx).
//
// RED-first: PortalChrome does not yet render a sign-out control, so these tests fail
// until the builder adds one. That absence is the point of test-first — do not implement
// anything to make these pass.
//
// WHY: a signed-in person currently has no way to sign out of the device they are using.
// The fix adds POST /api/auth/signout (its own tests live beside the handler/route) and a
// 'Sign out' control in the portal chrome that posts to it; the handler ends the session
// and redirects to /signin. This file pins the ONE new behaviour the chrome adds: it
// renders a working 'Sign out' control that POSTs to the sign-out endpoint.
//
// These tests pin BEHAVIOUR — what PortalChrome RENDERS — never the source text of
// portal-chrome.tsx, so a later behaviour-preserving refactor (different wrapper
// elements, classes, or exactly where the control sits) stays green. We render with
// `react-dom/server` (no DOM/jsdom — React component / E2E testing is a per-job ADR) and
// read the emitted markup, exactly as portal-chrome.test.tsx does. We assert the control
// is PRESENT and POSTs to the right endpoint; we do NOT assert which responsive surface
// (desktop sidebar footer vs mobile More menu) shows it, since that is CSS the static
// markup cannot evaluate and pinning it would lock the builder's layout.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { PortalChrome } from "./portal-chrome";

// The endpoint the control must post to (the sign-out route; its tests live beside it).
const SIGNOUT_ACTION = "/api/auth/signout";

// --- tiny markup helpers (no DOM), mirrored from portal-chrome.test.tsx -------------

function strip(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Read one double-quoted attribute off an element's attribute string.
function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

type Form = {
  action: string | null;
  method: string; // lower-cased; "" when absent
  inner: string; // raw inner markup
};

// Every <form> in the markup, with its action/method and inner markup. Forms do not nest
// here, so the non-greedy match to the first </form> is correct.
function parseForms(markup: string): Form[] {
  const forms: Form[] = [];
  for (const m of markup.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    forms.push({
      action: attr(m[1], "action"),
      method: (attr(m[1], "method") ?? "").toLowerCase(),
      inner: m[2],
    });
  }
  return forms;
}

// Does this form's inner markup contain a submit-capable control (a <button> — whose
// default type inside a form is submit — or an <input type="submit">)?
function hasSubmitControl(inner: string): boolean {
  if (/<button\b/i.test(inner)) return true;
  for (const m of inner.matchAll(/<input\b([^>]*)>/gi)) {
    if ((attr(m[1], "type") ?? "").toLowerCase() === "submit") return true;
  }
  return false;
}

// The accessible label of a form's control: its visible text, else a submit input's
// value, else a button/anything's aria-label.
function controlLabel(inner: string): string {
  const visible = strip(inner);
  if (visible.length > 0) return visible;
  for (const m of inner.matchAll(/<input\b([^>]*)>/gi)) {
    const value = attr(m[1], "value");
    if (value) return value;
  }
  const label = inner.match(/aria-label="([^"]*)"/i);
  return label ? label[1] : "";
}

// Render the signed-in chrome for a normal portal page. (The page content and nav
// surfaces are covered by portal-chrome.test.tsx; here we only care about the control.)
function render(pathname = "/home"): string {
  return renderToStaticMarkup(
    <PortalChrome pathname={pathname}>
      <span data-x="1" />
    </PortalChrome>,
  );
}

// The sign-out forms in the chrome: a <form> that POSTs to the sign-out endpoint and
// carries a submit-capable control labelled "Sign out".
function signoutForms(markup: string): Form[] {
  return parseForms(markup).filter(
    (f) =>
      f.method === "post" &&
      f.action != null &&
      f.action.includes(SIGNOUT_ACTION) &&
      hasSubmitControl(f.inner) &&
      /sign\s*out/i.test(controlLabel(f.inner)),
  );
}

// =====================================================================================
// AC — the portal chrome shows a 'Sign out' control that posts to POST /api/auth/signout.
// =====================================================================================

test("the portal chrome renders a 'Sign out' control", () => {
  const markup = render("/home");
  const label = /sign\s*out/i;
  assert.ok(
    label.test(strip(markup)),
    `the portal chrome must show a 'Sign out' control, got: ${strip(markup)}`,
  );
});

test("the 'Sign out' control POSTs to the sign-out endpoint (so it ends the session and lands on /signin)", () => {
  const markup = render("/home");
  const forms = signoutForms(markup);
  assert.ok(
    forms.length >= 1,
    `the chrome must contain a form that POSTs to ${SIGNOUT_ACTION} with a 'Sign out' submit control, ` +
      `got forms: ${JSON.stringify(parseForms(markup).map((f) => ({ action: f.action, method: f.method })))}`,
  );
  for (const form of forms) {
    assert.equal(form.method, "post", "the sign-out control must POST (not GET)");
    assert.ok(
      form.action != null && form.action.includes(SIGNOUT_ACTION),
      `the sign-out form must target ${SIGNOUT_ACTION}, got ${JSON.stringify(form.action)}`,
    );
  }
});

test("the sign-out control still renders in the layout's propless mount", () => {
  // The (protected) layout mounts <PortalChrome> with no pathname prop; the control must
  // render there too (it is chrome, not page content).
  let markup = "";
  assert.doesNotThrow(() => {
    markup = renderToStaticMarkup(
      <PortalChrome>
        <span data-x="1" />
      </PortalChrome>,
    );
  }, "a propless PortalChrome must render");
  assert.ok(
    signoutForms(markup).length >= 1,
    "the 'Sign out' control must render in the propless mount too",
  );
});
