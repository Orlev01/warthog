// E18-S02 — Portal group guard and app-shell layout (src/components/shell/portal-chrome.tsx).
//
// RED-first: src/components/shell/portal-chrome.tsx does NOT exist yet, so importing
// `./portal-chrome` throws and every test here fails until the builder adds the
// component. That absence is the whole point of test-first — do not implement
// anything to make these pass.
//
// WHY this component exists: the (portal)/(protected) layout is the single mount
// point that wraps every signed-in page in the shared navigation. A `layout.tsx` is
// an awkward unit-test target (reserved Next props, it is a server component that
// reads cookies/redirects), so — like DocumentShell for the root layout — it renders
// a plain, render-testable client component, PortalChrome, which turns the CURRENT
// PATH into the lit navigation section and wraps the page in the app shell. The
// guard/identity legs (AC: unauthenticated → /signin; identity from the session
// cookie only; public routes stay 200 — [obligation:admin-auth-required]) are the
// job of the already-built, already-tested session guard the layout delegates to
// (`requireSession`, src/server/auth/guard.ts — see src/server/auth/guard.test.ts);
// re-asserting them here would be green-on-arrival duplication, so this file pins the
// NEW behaviour this task adds: PortalChrome's path → active-section → shell render.
//
// These tests pin BEHAVIOUR — what PortalChrome RENDERS for a given path — never the
// source text of portal-chrome.tsx, so a later behaviour-preserving refactor
// (different wrapper elements, reworded labels, different classes) stays green. We
// render with `react-dom/server` (no DOM/jsdom — React component / E2E testing is a
// per-job ADR) and read the emitted markup, exactly as app-shell.test.tsx does.
//
// The contract the builder implements (exactly this):
//
//   PortalChrome({ pathname?, children }): the signed-in app chrome.
//     • A client component ("use client") the (protected) layout mounts to wrap every
//       portal page: <PortalChrome>{children}</PortalChrome>.
//     • Resolves the current path: the `pathname` prop when it is given (the
//       render-test / SSR override), otherwise the live path from usePathname()
//       (next/navigation). `pathname` is OPTIONAL — the layout mounts PortalChrome
//       with NO prop, so a propless render must work (it reads usePathname at
//       runtime), and the tests that need to control the path pass `pathname`.
//     • Derives the active section with activeSectionForPath(path) (from ./nav) and
//       renders the shared app shell — BOTH the mobile bottom nav and the desktop
//       sidebar — with that section marked current, the full IA linked to its real
//       routes, and the page content rendered inside the <main> content region.
//
// The section KEYS and the routes come from the one canonical IA (PORTAL_NAV /
// activeSectionForPath in ./nav, already built and tested in nav.test.ts). These
// tests derive their expectations FROM that IA so they cannot drift from it: the
// point is that PortalChrome lights the section the resolver names and links every
// destination to its real route.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { PortalChrome } from "./portal-chrome";
import { PORTAL_NAV, activeSectionForPath } from "./nav";

// --- the IA, read structurally so the tests compile against any compatible shape ---

type NavNode = {
  key: string;
  label: string;
  href?: string;
  children?: readonly NavNode[];
};

const PRIMARY = PORTAL_NAV as readonly NavNode[];
const MORE_NODE = PRIMARY.find((n) => n.key === "more");
const MORE_CHILDREN = (MORE_NODE?.children ?? []) as readonly NavNode[];
// Every navigable destination the chrome must link to: the five primary sections
// (all carry an href, "More" included) plus the ten "More" children.
const DESTINATIONS = [...PRIMARY, ...MORE_CHILDREN].filter((n) => typeof n.href === "string");
// A flat key → node view, for turning a resolved section key into its IA label.
const FLAT: readonly NavNode[] = [...PRIMARY, ...MORE_CHILDREN];

function labelForKey(key: string): string | undefined {
  return FLAT.find((n) => n.key === key)?.label;
}

// --- tiny markup helpers (no DOM), mirrored from app-shell.test.tsx -----------------

// Visible text with tags stripped: exactly the words a sighted reader sees (an <svg>
// icon contributes none). Decodes the one entity that matters ("Rules & budgets").
function strip(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function norm(s: string): string {
  return strip(s).toLowerCase();
}

// Read one double-quoted attribute off an element's attribute string.
function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

type Item = {
  tag: string; // "a" | "button"
  name: string; // accessible name: visible text, else aria-label
  href: string | null;
  current: boolean; // carries a truthy aria-current (present, not "false")
};

// Accessible name of an interactive item: its visible text, or — for an icon-only
// control — its aria-label.
function accessibleName(attrs: string, inner: string): string {
  const visible = strip(inner);
  if (visible.length > 0) return visible;
  return attr(attrs, "aria-label") ?? "";
}

// Every interactive item (links and buttons) in the markup, in DOM order (nav items
// do not nest anchors, so the non-greedy match to the first close tag is correct).
function parseItems(markup: string): Item[] {
  const items: Item[] = [];
  for (const m of markup.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const tag = m[1].toLowerCase();
    const itemAttrs = m[2];
    const inner = m[3];
    const ac = attr(itemAttrs, "aria-current");
    items.push({
      tag,
      name: accessibleName(itemAttrs, inner),
      href: attr(itemAttrs, "href"),
      current: ac != null && ac.toLowerCase() !== "false",
    });
  }
  return items;
}

// Render the chrome. With `pathname` undefined we exercise the propless mount the
// layout uses (PortalChrome reads usePathname itself; with no Next router present it
// resolves to null, so the component must default gracefully and not crash).
function render(pathname: string | undefined, children: React.ReactNode = <span data-x="1" />): string {
  const el =
    pathname === undefined ? (
      <PortalChrome>{children}</PortalChrome>
    ) : (
      <PortalChrome pathname={pathname}>{children}</PortalChrome>
    );
  return renderToStaticMarkup(el);
}

// --- the shell wrapping (AC2: the layout renders the page wrapped in the app shell) ---

test("renders the page content inside the app shell's <main> region", () => {
  const marker = "PORTAL_CHROME_CHILD_1a2b3c";
  const markup = render("/home", <p>{marker}</p>);
  const main = markup.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  assert.ok(main, `PortalChrome must render the app shell's <main> content region, got: ${markup}`);
  assert.ok(
    strip(main[1]).includes(marker),
    `the page content must render inside <main>, got: "${strip(main[1])}"`,
  );
});

test("renders both shared navigation surfaces (the mobile bottom nav and the desktop sidebar)", () => {
  const markup = render("/home");
  const navCount = [...markup.matchAll(/<nav\b/gi)].length;
  assert.ok(
    navCount >= 2,
    `PortalChrome must render the two nav surfaces (bottom nav + sidebar), got ${navCount}`,
  );
});

// --- the IA is linked to its real routes (AC3) --------------------------------------

test("every primary section and More child links to its real route from the IA", () => {
  const markup = render("/home");
  const links = parseItems(markup).filter((it) => it.tag === "a" && it.href != null);

  for (const node of DESTINATIONS) {
    const href = node.href!;
    // Settings leads into the /settings area; nav.ts leaves its exact href free
    // (it may be /settings or a first sub-page), so match it by prefix — every
    // other destination links to its exact route.
    const hit =
      node.key === "settings"
        ? links.find((l) => l.href != null && l.href.startsWith("/settings"))
        : links.find((l) => l.href === href);
    assert.ok(
      hit,
      `PortalChrome must render a navigable link to the "${node.key}" section's route (${href})`,
    );
    const stem = node.label.split(/[\s&]+/).filter(Boolean)[0] ?? node.label;
    assert.ok(
      new RegExp(stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(hit!.name),
      `the ${href} link must be labelled "${node.label}", got "${hit!.name}"`,
    );
  }
});

// --- the active section follows the current path via activeSectionForPath (AC3) -----

// Real portal paths (section landings AND sub-paths) that the IA owns; the expected
// lit section is taken from activeSectionForPath itself, so this test proves
// PortalChrome lights exactly the section the resolver names for the path.
const PATH_CASES: readonly string[] = [
  "/home",
  "/inbox",
  "/activity",
  "/agents",
  "/agents/connect", // a sub-path lights its owning section
  "/more",
  "/vault",
  "/vault/cards", // a sub-path lights its owning section
  "/connectors",
  "/rules",
  "/spending",
  "/skills",
  "/memory",
  "/life-admin",
  "/household",
  "/settings",
  "/settings/security", // the whole /settings area lights the single Settings section
  "/settings/notifications",
];

for (const path of PATH_CASES) {
  test(`PortalChrome lights the activeSectionForPath section for ${path}`, () => {
    const key = activeSectionForPath(path);
    assert.ok(
      typeof key === "string" && key.length > 0,
      `precondition: ${path} resolves to a portal section`,
    );
    const label = labelForKey(key as string);
    assert.ok(label, `precondition: the IA has a label for section "${key}"`);
    const stem = label!.split(/[\s&]+/).filter(Boolean)[0] ?? label!;

    const current = parseItems(render(path)).filter((it) => it.current);
    assert.ok(
      current.length >= 1,
      `${path} must light its nav item (expected the "${label}" section), but nothing is marked current`,
    );
    for (const it of current) {
      assert.ok(
        new RegExp(stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(it.name),
        `only the "${label}" section may be current for ${path}, got a current item "${it.name}"`,
      );
    }
  });
}

test("the active state follows the path, not a hard-coded default (Home is not lit on /inbox)", () => {
  const current = parseItems(render("/inbox")).filter((it) => it.current);
  assert.ok(current.length >= 1, "/inbox must light the Inbox section");
  for (const it of current) {
    assert.ok(/inbox/i.test(it.name), `only Inbox may be current for /inbox, got "${it.name}"`);
  }
});

// --- the propless mount the layout actually uses (AC2) ------------------------------

test("renders with no pathname prop (the layout's propless mount) without crashing", () => {
  const marker = "PORTAL_CHROME_PROPLESS_9z8y7x";
  let markup = "";
  assert.doesNotThrow(() => {
    markup = render(undefined, <p>{marker}</p>);
  }, "a propless PortalChrome must render — it reads the path from usePathname at runtime");
  assert.ok(strip(markup).includes(marker), "the page content must still render");
  assert.ok(
    [...markup.matchAll(/<nav\b/gi)].length >= 2,
    "both nav surfaces must still render in the propless mount",
  );
  // With no router the resolved path is nullish → no definite section; the chrome
  // must not light several different sections at once.
  const distinct = new Set(
    parseItems(markup)
      .filter((it) => it.current)
      .map((it) => norm(it.name)),
  );
  assert.ok(
    distinct.size <= 1,
    `a propless mount must not light multiple different sections, got: ${[...distinct].join(", ")}`,
  );
});
