// Review fix G1 — the Vault area's own navigation (src/components/vault/vault-nav.tsx).
// Before this fix nothing on the Vault page linked to /vault/cards, so once the Home
// set-up checklist was done the Cards page was unreachable.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { VaultNav } from "./vault-nav";

function links(markup: string): Array<{ href: string; current: boolean; text: string }> {
  return [...markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    href: /href="([^"]*)"/.exec(m[1])?.[1] ?? "",
    current: /aria-current="page"/.test(m[1]),
    text: m[2].replace(/<[^>]*>/g, "").trim(),
  }));
}

test("the Vault nav links both About you and Cards, marking the current page with aria-current", () => {
  const onIdentity = links(renderToStaticMarkup(<VaultNav current="identity" />));
  assert.deepEqual(
    onIdentity.map((l) => [l.href, l.text, l.current]),
    [
      ["/vault", "About you", true],
      ["/vault/cards", "Cards", false],
    ],
  );
  const onCards = links(renderToStaticMarkup(<VaultNav current="cards" />));
  assert.deepEqual(onCards.map((l) => l.current), [false, true]);
});

test("the current Vault page is marked by more than colour (an underline/weight cue)", () => {
  const markup = renderToStaticMarkup(<VaultNav current="cards" />);
  const current = /<a\b[^>]*aria-current="page"[^>]*>/.exec(markup)?.[0] ?? "";
  assert.match(current, /underline|border-b/, "the active link carries a non-colour indicator");
});
