import * as React from "react";
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CopyButton, createCopyController } from "./copy-button";
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
