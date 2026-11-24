// Settings › Agent defaults — the "what agents see" choices (`./read-level-choices`,
// docs/adr/read-side-protection.md amendment 24 November 2026).
//
// Pins BEHAVIOUR: three radio choices named `readLevel`, the person's saved level checked, each
// with its one plain line; Standard is marked recommended; choosing Everything shows a short
// plain warning, and no other choice does. Rendered with react-dom/server (no DOM).

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { ReadLevelChoices } from "./read-level-choices";

function visibleText(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function radios(markup: string): { value: string; checked: boolean }[] {
  return [...markup.matchAll(/<input\b([^>]*)>/g)].filter((m) => /type="radio"/.test(m[1]!)).map((m) => ({
    value: /value="([^"]*)"/.exec(m[1]!)![1]!,
    checked: /\bchecked=""/.test(m[1]!),
  }));
}

test("three choices, the saved one checked, each with its plain line", () => {
  const markup = renderToStaticMarkup(<ReadLevelChoices level="standard" />);
  assert.deepEqual(radios(markup), [
    { value: "private", checked: false },
    { value: "standard", checked: true },
    { value: "open", checked: false },
  ]);
  assert.equal([...markup.matchAll(/name="readLevel"/g)].length, 3);
  const text = visibleText(markup);
  assert.match(text, /Private Also hides tax file, Medicare, passport, licence, BSB and account numbers\. Agents can't fill account numbers in for you\./);
  assert.match(text, /Standard \(recommended\) Hides sign-in codes, password-reset links and card numbers\./);
  assert.match(text, /Everything Shows emails and files as written, including sign-in codes and password-reset links\./);
  assert.doesNotMatch(text, /get into one of your accounts/, "no warning unless Everything is chosen");
  assert.ok(!/untrusted|injection|malicious|token|taint/i.test(text));
});

test("Everything shows a short plain warning", () => {
  const markup = renderToStaticMarkup(<ReadLevelChoices level="open" />);
  assert.deepEqual(radios(markup).find((r) => r.checked)?.value, "open");
  assert.match(visibleText(markup), /an agent, or an email written to trick one, could use a sign-in code or password-reset link to get into one of your accounts/);
  assert.match(markup, /data-tone="warning"/);
});
