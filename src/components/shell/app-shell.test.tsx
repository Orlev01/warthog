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
// The two destination lists (desktop sidebar, mobile drawer), not the breadcrumb.
const navs = (html: string) =>
  [
    ...html.matchAll(
      /<nav\b[^>]*aria-label="(?:Primary|Mobile navigation)"[^>]*>([\s\S]*?)<\/nav>/g,
    ),
  ].map((m) => m[1]!);

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
test("group labels name their groups without entering the page's heading outline", () => {
  for (const nav of navs(render())) {
    assert.doesNotMatch(nav, /<h[1-6]\b/, "sidebar group labels are not headings");
    const groups = [...nav.matchAll(/<div role="group" aria-labelledby="([^"]+)"/g)];
    assert.equal(groups.length, NAV_GROUPS.length);
    for (const [, id] of groups) assert.match(nav, new RegExp(`<p id="${id}"`));
  }
  // Group names are distinct, and "Resources" is never the help group's name.
  const labels = NAV_GROUPS.map((g) => g.label);
  assert.equal(new Set(labels).size, labels.length);
  assert.notEqual(NAV_GROUPS.find((g) => g.items.some((i) => i.key === "help"))?.label, "Resources");
});
test("the top bar is a banner before <main>, and route tabs sit with it outside the content", () => {
  const html = renderToStaticMarkup(
    <AppShell
      activeSection="settings"
      page={{ label: "Security", href: "/settings/security" }}
      measure="form"
      sectionNavigation={<nav aria-label="Settings sections">tabs</nav>}
    >
      <p>Page content</p>
    </AppShell>,
  );
  const header = html.indexOf('<header class="wh-workspace-header"');
  const tabs = html.indexOf('aria-label="Settings sections"');
  const main = html.indexOf("<main");
  assert.ok(header > 0 && header < tabs && tabs < main, "header, then route tabs, then main");
  assert.doesNotMatch(html.slice(main), /wh-workspace-header/);
  assert.match(html, /class="wh-main" data-measure="form"/);
  // The breadcrumb names the page and links back to its section.
  assert.match(html, /<nav aria-label="Breadcrumb"/);
  assert.match(html, /<a href="\/settings">Settings<\/a>/);
  assert.match(html, /<span aria-current="page">Security<\/span>/);
});
test("a section's own landing page is the last breadcrumb, not a link", () => {
  const html = renderToStaticMarkup(
    <AppShell activeSection="vault" page={{ label: "About you", href: "/vault" }}>
      <p>x</p>
    </AppShell>,
  );
  assert.match(html, /<span aria-current="page">Vault<\/span>/);
  assert.doesNotMatch(html, /About you<\/span>/);
});
