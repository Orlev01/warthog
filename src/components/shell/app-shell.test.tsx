import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AppShell } from "./app-shell";
import { NAV_GROUPS } from "./workspace-navigation";
const render = (active = "home") =>
  renderToStaticMarkup(
    <AppShell activeSection={active} sidebarFooter={<button>Sign out</button>}>
      <p>Page content</p>
    </AppShell>,
  );
const navs = (html: string) =>
  [...html.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/g)].map((m) => m[1]!);

test("desktop and mobile expose the same grouped destinations", () => {
  const navigation = navs(render());
  assert.equal(navigation.length, 2);
  for (const nav of navigation)
    for (const group of NAV_GROUPS) {
      assert.ok(nav.includes(group.label));
      for (const item of group.items)
        assert.ok(nav.includes(`href="${item.href}"`), item.key);
    }
});
test("each navigation marks only the current destination", () => {
  for (const section of [
    "home",
    "inbox",
    "agents",
    "activity",
    "skills",
    "vault",
    "settings",
  ])
    for (const nav of navs(render(section))) {
      const current = [
        ...nav.matchAll(
          /<a\b([^>]*)aria-current="page"([^>]*)>([\s\S]*?)<\/a>/g,
        ),
      ];
      assert.equal(current.length, 1);
      assert.ok(current[0]![1]!.includes(`href="/${section}"`));
    }
  for (const nav of navs(render("unknown")))
    assert.doesNotMatch(nav, /aria-current/);
});
test("mobile navigation starts closed with a named trigger and dismiss control", () => {
  const html = render();
  assert.match(html, /<dialog [^>]*aria-label="Workspace navigation"/);
  assert.doesNotMatch(html, /<dialog [^>]*\bopen(?:=|\s|>)/);
  assert.match(
    html,
    /aria-label="Open navigation" aria-expanded="false" aria-controls=/,
  );
  assert.match(html, /aria-label="Close navigation"/);
});
test("page content has a skip target and navigation does not reorder keyboard focus", () => {
  const html = render();
  assert.match(html, /href="#workspace-content"/);
  assert.match(
    html,
    /<main id="workspace-content"[^>]*>[\s\S]*Page content[\s\S]*<\/main>/,
  );
  for (const m of html.matchAll(/tabindex="(-?\d+)"/g))
    assert.ok(Number(m[1]) <= 0);
});
test("both navigation surfaces retain the footer and use semantic tokens", () => {
  const html = render();
  assert.equal((html.match(/Sign out/g) ?? []).length, 2);
  assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}\b/);
});
