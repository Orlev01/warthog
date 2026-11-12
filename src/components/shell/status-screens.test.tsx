// Review fix G7 — the app's fallback screens: an error boundary (src/app/error.tsx and
// the root src/app/global-error.tsx), the 404 page (src/app/not-found.tsx) and the
// route-level loading state (src/app/(portal)/(protected)/loading.tsx). Before this fix none existed, so a
// thrown error showed Next's unstyled default and a bad URL its bare 404 — with no way
// back into the app. Each screen is styled with the design tokens and offers a way back.
//
// global-error.tsx imports the global stylesheet (it replaces the root layout), which
// only loads under Next's bundler, so its body is the shared <ErrorScreen/> pinned here.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { ErrorScreen, NotFoundScreen } from "./status-screens";
import AppError from "../../app/error";
import ProtectedNotFound from "../../app/(portal)/(protected)/not-found";
import Loading from "../../app/(portal)/(protected)/loading";

function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();
}

test("the error boundary explains plainly, offers Try again and a way back, and never shows the raw error", () => {
  const error = Object.assign(new Error("relation \"users\" does not exist at db.query"), { digest: "abc123" });
  const markup = renderToStaticMarkup(<AppError error={error} reset={() => {}} />);
  assert.match(text(markup), /something went wrong/i);
  assert.match(markup, /<button\b[^>]*>[\s\S]*?Try again/);
  // Outside the shell the way back is "/", which sends a signed-in member on to /home and
  // shows a signed-out visitor the landing page instead of a sign-in form.
  assert.match(markup, /<a\b[^>]*href="\/"[^>]*>[\s\S]*?Go to Warthog/);
  assert.ok(!markup.includes("relation"), "the raw error message never reaches the screen");
  assert.ok(text(markup).includes("abc123"), "the support reference (digest) is shown");
  assert.match(markup, /<h1\b/, "the screen has a heading");
});

test("ErrorScreen renders without a reset (global error) and still offers the way back", () => {
  const markup = renderToStaticMarkup(<ErrorScreen />);
  assert.match(markup, /<a\b[^>]*href="\/"/);
  assert.ok(!/<button/.test(markup));
});

test("public status screens are a bounded, branded panel with a header and footer", () => {
  for (const markup of [renderToStaticMarkup(<ErrorScreen />), renderToStaticMarkup(<NotFoundScreen />)]) {
    assert.match(markup, /<header class="wh-status-bar">[\s\S]*Warthog[\s\S]*<\/header>/);
    assert.match(markup, /<main class="wh-status-main"><section aria-labelledby="[^"]+" class="wh-status-panel">/);
    assert.match(markup, /<footer class="wh-status-bar wh-status-footer">[\s\S]*href="\/privacy"/);
  }
});

test("the public 404 says the page wasn't found, without assuming an account", () => {
  const markup = renderToStaticMarkup(<NotFoundScreen />);
  assert.match(text(markup), /couldn't find that page/i);
  assert.match(markup, /<a\b[^>]*href="\/"[^>]*>[\s\S]*?Go to Warthog/);
  assert.match(markup, /href="\/help"/);
  assert.doesNotMatch(text(markup), /where you left it/);
  assert.match(markup, /<h1\b/);
});

test("inside the workspace the 404 is a panel in the page container, with Home and Your agents", () => {
  const markup = renderToStaticMarkup(<ProtectedNotFound />);
  assert.match(markup, /^<div class="wh-page wh-status-page-body"><section [^>]*class="wh-status-panel">/);
  assert.doesNotMatch(markup, /<main\b/, "the shell already owns <main>");
  assert.match(markup, /href="\/home"[^>]*>[\s\S]*?Go to Home/);
  assert.match(markup, /href="\/agents"[^>]*>[\s\S]*?Your agents/);
});

test("the loading state is announced to assistive technology", () => {
  const markup = renderToStaticMarkup(<Loading />);
  assert.match(markup, /role="status"/);
  assert.match(text(markup), /loading/i);
});

test("the fallback screens use design tokens, never a raw hex colour", () => {
  for (const markup of [
    renderToStaticMarkup(<ErrorScreen reset={() => {}} />),
    renderToStaticMarkup(<NotFoundScreen />),
    renderToStaticMarkup(<NotFoundScreen variant="workspace" />),
    renderToStaticMarkup(<Loading />),
  ]) {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(markup));
  }
});
