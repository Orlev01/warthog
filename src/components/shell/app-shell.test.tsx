// E02-S05 — App shell navigation (src/components/shell/app-shell.tsx).
//
// RED-first: src/components/shell/app-shell.tsx does NOT exist yet, so importing
// `./app-shell` throws and every test here fails until the builder adds the
// component. That absence is the whole point of test-first — do not implement
// anything to make these pass.
//
// These tests pin BEHAVIOUR — what the shell RENDERS — never the source text of
// app-shell.tsx, so a later behaviour-preserving refactor (different wrapper
// elements, reworded aria-labels, different CSS classes, icon-only vs labelled
// bottom items) stays green. We render with `react-dom/server` (no DOM/jsdom —
// React component / E2E testing is a per-job ADR) and read the emitted markup.
//
// The information architecture is fixed by the brief (design_ux.feel) and the
// design doc §12: everything is reachable in two taps from a fixed navigation —
//   • mobile bottom nav: exactly Home, Inbox, Activity, Agents, More
//   • desktop sidebar:   the same sections PLUS the "More" children —
//     Vault, Connectors, Rules & budgets, Spending, Skills, Memory, Life admin,
//     Household, Settings, Help.
//
// The contract the builder implements (exactly this):
//
//   AppShell({ activeSection, children }): a prop-driven app shell.
//     • activeSection: which navigation section is current (e.g. "home",
//       "inbox", "activity", "agents", ...). Both navigation surfaces mark the
//       matching item with aria-current.
//     • children: the page content, rendered inside a <main> landmark.
//     • Renders TWO navigation landmarks that share one IA: a bottom nav (the
//       five top-level sections, in order) and a sidebar (the five sections plus
//       every "More" child, each child a navigable link).
//     • Keyboard tab order follows visual order — items sit in DOM order, no
//       positive tabindex reorders them.
//     • Uses the design tokens (globals.css), never a raw hex colour.
//
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { AppShell } from "./app-shell";

// --- the fixed IA (brief design_ux.feel) -----------------------------------

// The five top-level sections, in their documented left-to-right order.
const TOP: readonly string[] = ["Home", "Inbox", "Activity", "Agents", "More"];

// A distinctive stem for each "More" child (matched case-insensitively as a
// substring, so reworded copy — "Rules & budgets", "Rules and budgets" — and
// HTML-escaped "&" stay green as long as the child is still named).
const CHILDREN: readonly string[] = [
  "Vault",
  "Connectors",
  "Rules",
  "Spending",
  "Skills",
  "Memory",
  "Life admin",
  "Household",
  "Settings",
  "Help",
];

// --- tiny markup helpers (no DOM) ------------------------------------------

// Visible text of an HTML fragment with tags stripped: exactly the words a
// sighted reader sees (an <svg> icon contributes none). Decodes the one entity
// that matters here (&amp; from "Rules & budgets").
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

type NavItem = {
  tag: string; // "a" | "button"
  attrs: string;
  name: string; // accessible name: visible text, else aria-label
  href: string | null;
  current: boolean; // carries a truthy aria-current (present, not "false")
};

type Nav = {
  attrs: string;
  inner: string;
  items: NavItem[];
  text: string; // visible text + item aria-labels, for content checks
};

// Accessible name of an interactive item: its visible text, or — for an
// icon-only control — its aria-label.
function accessibleName(attrs: string, inner: string): string {
  const visible = strip(inner);
  if (visible.length > 0) return visible;
  return attr(attrs, "aria-label") ?? "";
}

// Every <nav> landmark in the markup (navs do not nest), each parsed into its
// interactive items (links and buttons) in DOM order.
function parseNavs(markup: string): Nav[] {
  const navs: Nav[] = [];
  for (const m of markup.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/gi)) {
    const inner = m[2];
    const items: NavItem[] = [];
    for (const im of inner.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
      const [, tag, itemAttrs, itemInner] = im;
      const ac = attr(itemAttrs, "aria-current");
      items.push({
        tag: tag.toLowerCase(),
        attrs: itemAttrs,
        name: accessibleName(itemAttrs, itemInner),
        href: attr(itemAttrs, "href"),
        current: ac != null && ac.toLowerCase() !== "false",
      });
    }
    const labels = items.map((it) => attr(it.attrs, "aria-label") ?? "").join(" ");
    navs.push({ attrs: m[1], inner, items, text: `${strip(inner)} ${labels}` });
  }
  return navs;
}

// A navigable link whose accessible name contains `label` (case-insensitive).
function hasLink(nav: Nav, label: string): boolean {
  const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  return nav.items.some((it) => it.tag === "a" && !!it.href && re.test(it.name));
}

// Render the shell, parse both navigation surfaces out of the markup.
function buildShell(
  activeSection: string,
  children: React.ReactNode = <span />,
): { markup: string; navs: Nav[]; bottomNav?: Nav; sidebar?: Nav } {
  const markup = renderToStaticMarkup(
    <AppShell activeSection={activeSection}>{children}</AppShell>,
  );
  const navs = parseNavs(markup);
  // The sidebar is the surface that carries the "More" children (the bottom nav
  // never does); the bottom nav is a different surface that carries a "More"
  // item but none of the children. Identify by CONTENT, never by CSS class or
  // aria-label wording, so the test survives restyling/relabelling.
  const sidebar = navs.find((n) => /\bvault\b/i.test(n.text) && /\bconnectors\b/i.test(n.text));
  const bottomNav = navs.find(
    (n) => n !== sidebar && n.items.some((it) => /^more$/i.test(it.name)) && !/\bvault\b/i.test(n.text),
  );
  return { markup, navs, bottomNav, sidebar };
}

// --- tests ------------------------------------------------------------------

// Structure — the shell exposes two distinct navigation landmarks sharing one
// IA: a bottom nav (no children) and a sidebar (with the children).
test("renders two distinct navigation landmarks: a bottom nav and a sidebar", () => {
  const { navs, bottomNav, sidebar } = buildShell("home");
  assert.ok(
    navs.length >= 2,
    `expected at least two <nav> landmarks (bottom nav + sidebar), got ${navs.length}`,
  );
  assert.ok(sidebar, "expected a sidebar nav carrying the \"More\" children (Vault, Connectors, …)");
  assert.ok(bottomNav, "expected a bottom nav carrying the top-level sections but not the children");
  assert.notEqual(bottomNav, sidebar, "the bottom nav and the sidebar must be distinct landmarks");
});

// AC1 — the mobile bottom nav renders EXACTLY Home, Inbox, Activity, Agents,
// More, in that order, and the four destination sections are navigable links.
test("the bottom nav shows exactly Home, Inbox, Activity, Agents, More in order", () => {
  const { bottomNav } = buildShell("home");
  assert.ok(bottomNav, "a bottom nav landmark must be present");
  const names = bottomNav!.items.map((it) => it.name);
  assert.deepEqual(
    names,
    TOP,
    `the bottom nav must contain exactly the five sections in order, got: ${JSON.stringify(names)}`,
  );
  // "Reachable in two taps" — the four leaf sections are real navigable links.
  for (const label of ["Home", "Inbox", "Activity", "Agents"]) {
    assert.ok(
      hasLink(bottomNav!, label),
      `the bottom nav's "${label}" item must be a navigable link (an <a href>)`,
    );
  }
});

// AC1 — the desktop sidebar shows the same five sections PLUS every "More"
// child, with each child a navigable link (reachable in two taps).
test("the sidebar shows the five sections plus the More children", () => {
  const { sidebar } = buildShell("home");
  assert.ok(sidebar, "a sidebar landmark must be present");

  // The five top-level sections are present (More as a section label/group).
  for (const section of TOP) {
    const re = new RegExp(`\\b${section}\\b`, "i");
    assert.match(
      sidebar!.text,
      re,
      `the sidebar must show the "${section}" section, got text: "${sidebar!.text}"`,
    );
  }
  // The four leaf top-level sections are navigable links in the sidebar too.
  for (const label of ["Home", "Inbox", "Activity", "Agents"]) {
    assert.ok(hasLink(sidebar!, label), `the sidebar's "${label}" section must be a link`);
  }
  // Every "More" child is present as a navigable link.
  for (const child of CHILDREN) {
    assert.ok(
      hasLink(sidebar!, child),
      `the sidebar must render a navigable link for the "${child}" child`,
    );
  }
});

// AC2 — given the active section, the matching item in BOTH surfaces carries a
// truthy aria-current, and it is the ONLY current item in each surface. Driven
// by the prop, not hard-coded: exercised across several top-level sections.
for (const { key, label } of [
  { key: "home", label: "Home" },
  { key: "inbox", label: "Inbox" },
  { key: "agents", label: "Agents" },
]) {
  test(`active section "${key}" marks the ${label} item aria-current in both navs`, () => {
    const { bottomNav, sidebar } = buildShell(key);
    for (const [surface, nav] of [
      ["bottom nav", bottomNav],
      ["sidebar", sidebar],
    ] as const) {
      assert.ok(nav, `the ${surface} must be present`);
      const current = nav!.items.filter((it) => it.current);
      assert.equal(
        current.length,
        1,
        `exactly one ${surface} item must carry aria-current for active "${key}", got ${current.length}`,
      );
      assert.ok(
        new RegExp(`\\b${label}\\b`, "i").test(current[0]!.name),
        `the current ${surface} item must be "${label}", got "${current[0]!.name}"`,
      );
    }
  });
}

// AC2 — a non-active section is never marked current in the bottom nav (the
// active state follows the prop, not a hard-coded default).
test("a section that is not active carries no aria-current", () => {
  const { bottomNav } = buildShell("inbox");
  assert.ok(bottomNav, "a bottom nav landmark must be present");
  const home = bottomNav!.items.find((it) => /^home$/i.test(it.name));
  assert.ok(home, "the Home item must exist");
  assert.equal(
    home!.current,
    false,
    "Home must not be marked aria-current when Inbox is the active section",
  );
});

// AC2 — keyboard tab order follows visual order. The bottom nav's DOM order is
// the visual left-to-right order (asserted above via deepEqual with TOP); here
// we pin the other half: no positive tabindex anywhere reorders the natural
// (DOM = visual) tab sequence.
test("no positive tabindex is used, so tab order follows visual (DOM) order", () => {
  const { markup } = buildShell("home");
  const tabindexes = [...markup.matchAll(/tabindex="(-?\d+)"/gi)].map((m) => Number(m[1]));
  for (const t of tabindexes) {
    assert.ok(
      t <= 0,
      `a positive tabindex (${t}) breaks visual tab order; use DOM order (tabindex 0 or none)`,
    );
  }
});

// The shell wraps page content in a <main> landmark and actually renders it
// (an app shell that drops its children is a dead frame).
test("renders its children inside a <main> landmark", () => {
  const marker = "APP_SHELL_CHILD_MARKER_7f3";
  const { markup } = buildShell("home", <p>{marker}</p>);
  const main = markup.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  assert.ok(main, `the shell must render a <main> landmark, got: ${markup}`);
  assert.ok(
    strip(main![1]).includes(marker),
    `the children must render inside <main>, got: "${strip(main![1])}"`,
  );
});

// Design system — colour comes from tokens, never a raw hex literal. The caller
// passes no "#", so any hex in the output could only be a hard-coded colour.
test("the shell uses design tokens, never a raw hex colour", () => {
  const { markup } = buildShell("home");
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(markup),
    `no raw hex colour may appear in the app shell markup, got: ${markup}`,
  );
});
