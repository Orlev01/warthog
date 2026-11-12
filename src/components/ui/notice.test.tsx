import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { Notice, PageNotice } from "./notice";

test("routine notices announce politely and keep their explanation and action visible", () => {
  const html = renderToStaticMarkup(<Notice tone="info">Finish setting up your service. <a href="/connectors">Continue</a></Notice>);
  assert.match(html, /role="status"/);
  assert.match(html, /Finish setting up your service/);
  assert.match(html, /href="\/connectors"/);
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(html, /role="alert"/);
});

test("errors are alerts while success and follow-up guidance remain polite", () => {
  for (const tone of ["success", "warning", "error"] as const) {
    const html = renderToStaticMarkup(<Notice tone={tone}>Outcome in words</Notice>);
    assert.match(html, new RegExp(`role="${tone === "error" ? "alert" : "status"}"`));
    assert.match(html, /Outcome in words/);
  }
});

test("static explanatory notices do not announce as a new outcome", () => {
  const html = renderToStaticMarkup(<Notice announce={false}>Only you can download this file.</Notice>);
  assert.match(html, /Only you can download this file/);
  assert.doesNotMatch(html, /role="(?:status|alert)"|aria-live|aria-atomic/);
});

test("the page notice is the one outcome slot: announced, at page width, and it tidies ?notice= from the URL", () => {
  const html = renderToStaticMarkup(<PageNotice tone="success">Saved.</PageNotice>);
  assert.match(html, /^<div role="status" aria-atomic="true" data-tone="success" class="wh-notice [^"]*wh-page-notice"/);
  assert.match(renderToStaticMarkup(<PageNotice tone="error">Couldn’t save.</PageNotice>), /role="alert"/);
});
