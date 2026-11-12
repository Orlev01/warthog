import * as React from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { COPY_TOAST_DURATION, CopyButton, copyToastDuration, createCopyController } from "./copy-button";
import { Toast } from "./toast";

test("copy reports success only after the clipboard accepts the value", async () => {
  const values: string[] = [];
  let finish!: () => void;
  const copy = createCopyController({ writeText: (value) => {
    values.push(value);
    return new Promise<void>((resolve) => { finish = resolve; });
  } });
  const pending = copy.copy("private-value");
  assert.equal(copy.getState(), "copying");
  await copy.copy("duplicate");
  assert.deepEqual(values, ["private-value"]);
  finish();
  await pending;
  assert.equal(copy.getState(), "copied");
  copy.dismiss();
  assert.equal(copy.getState(), "idle");
});

test("unavailable and rejected clipboard attempts produce a recoverable failure", async () => {
  for (const writeText of [undefined, async () => { throw new Error("denied"); }]) {
    const copy = createCopyController({ writeText });
    await copy.copy("private-value");
    assert.equal(copy.getState(), "failed");
  }
  let attempts = 0;
  const copy = createCopyController({ writeText: async () => {
    if (++attempts === 1) throw new Error("denied");
  } });
  await copy.copy("private-value");
  assert.equal(copy.getState(), "failed");
  await copy.copy("private-value");
  assert.equal(copy.getState(), "copied");
});

test("reset prevents an obsolete clipboard completion from announcing success", async () => {
  let finish!: () => void;
  const copy = createCopyController({ writeText: () => new Promise<void>((resolve) => { finish = resolve; }) });
  const pending = copy.copy("previous-value");
  copy.dismiss();
  finish();
  await pending;
  assert.equal(copy.getState(), "idle");
});

test("copy feedback starts with an empty mounted polite announcer and never renders its value", () => {
  const markup = renderToStaticMarkup(<CopyButton value="private-value" />);
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/);
  assert.doesNotMatch(markup, /private-value/);
  assert.match(markup, />Copy<\/button>/);
});

test("success toast exposes an explicit dismissal without assertive announcements", () => {
  const markup = renderToStaticMarkup(<Toast message="Copied to clipboard." onDismiss={() => {}} />);
  assert.match(markup, /Copied to clipboard\./);
  assert.match(markup, /aria-label="Dismiss notification"/);
  assert.doesNotMatch(markup, /role="alert"|autoFocus|autofocus/);
});

// ─── UI/UX pass: the copy toast never parks over the page (interaction-10, a11y-03) ─────

test("a routine copy confirmation clears itself; a custom message with instructions stays", () => {
  assert.equal(copyToastDuration(undefined, undefined), COPY_TOAST_DURATION);
  assert.equal(copyToastDuration("Copied to clipboard.", undefined), COPY_TOAST_DURATION);
  assert.equal(copyToastDuration("Access key copied. Paste it into your agent, then clear your clipboard.", undefined), null);
  assert.equal(copyToastDuration(undefined, null), null, "a caller can keep it");
  assert.equal(copyToastDuration("Custom", 2000), 2000, "or choose its lifetime");
});

test("the copy button names what it copies without echoing the value or changing its visible label", () => {
  const markup = renderToStaticMarkup(<CopyButton value="https://warthog.example/mcp" label="Warthog address" />);
  assert.match(markup, /Copy<span class="sr-only"> Warthog address<\/span><\/button>/);
  assert.doesNotMatch(markup, /warthog\.example/);
});

test("the toast marks itself for page clearance and keeps a 44px dismiss control", () => {
  const markup = renderToStaticMarkup(<Toast message="Copied to clipboard." onDismiss={() => {}} dismissAfter={4000} />);
  assert.match(markup, /data-wh-toast=""/);
  assert.match(markup, /aria-label="Dismiss notification"[^>]*class="[^"]*min-h-11 min-w-11/);
  assert.doesNotMatch(renderToStaticMarkup(<Toast message={null} onDismiss={() => {}} />), /data-wh-toast/);
});
