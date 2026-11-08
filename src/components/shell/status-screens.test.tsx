// Review fix G7 — the app's fallback screens: an error boundary (src/app/error.tsx and
// the root src/app/global-error.tsx), the 404 page (src/app/not-found.tsx) and the
// route-level loading state (src/app/loading.tsx). Before this fix none existed, so a
// thrown error showed Next's unstyled default and a bad URL its bare 404 — with no way
// back into the app. Each screen is styled with the design tokens and offers a way back.
//
// global-error.tsx imports the global stylesheet (it replaces the root layout), which
// only loads under Next's bundler, so its body is the shared <ErrorScreen/> pinned here.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { ErrorScreen } from "./status-screens";
import AppError from "../../app/error";
import NotFound from "../../app/not-found";
import Loading from "../../app/loading";

function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();
}

test("the error boundary explains plainly, offers Try again and a link Home, and never shows the raw error", () => {
  const error = Object.assign(new Error("relation \"users\" does not exist at db.query"), { digest: "abc123" });
  const markup = renderToStaticMarkup(<AppError error={error} reset={() => {}} />);
  assert.match(text(markup), /something went wrong/i);
  assert.match(markup, /<button\b[^>]*>[\s\S]*?Try again/);
  assert.match(markup, /<a\b[^>]*href="\/home"/);
  assert.ok(!markup.includes("relation"), "the raw error message never reaches the screen");
  assert.ok(text(markup).includes("abc123"), "the support reference (digest) is shown");
  assert.match(markup, /<h1\b/, "the screen has a heading");
});

test("ErrorScreen renders without a reset (global error) and still links Home", () => {
  const markup = renderToStaticMarkup(<ErrorScreen />);
  assert.match(markup, /<a\b[^>]*href="\/home"/);
  assert.ok(!/<button/.test(markup));
});

test("the 404 page says the page wasn't found and links back Home", () => {
  const markup = renderToStaticMarkup(<NotFound />);
  assert.match(text(markup), /couldn't find|can't find|not found/i);
  assert.match(markup, /<a\b[^>]*href="\/home"/);
  assert.match(markup, /<h1\b/);
});

test("the loading state is announced to assistive technology", () => {
  const markup = renderToStaticMarkup(<Loading />);
  assert.match(markup, /role="status"/);
  assert.match(text(markup), /loading/i);
});

test("the fallback screens use design tokens, never a raw hex colour", () => {
  for (const markup of [
    renderToStaticMarkup(<ErrorScreen reset={() => {}} />),
    renderToStaticMarkup(<NotFound />),
    renderToStaticMarkup(<Loading />),
  ]) {
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(markup));
  }
});
