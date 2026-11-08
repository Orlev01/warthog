// Review fix G8 — every portal page has its own <title> (WCAG 2.2 SC 2.4.2 Page Titled).
//
// The root layout's title template ("%s · Warthog") was the only metadata in the app, so
// every page — Inbox, Vault, Settings, … — was titled just "Warthog". Navigation is a full
// page load, so the title is what a screen reader announces on arrival and what a tab
// shows; with one title for everything a person could not tell where they were.
//
// Each portal page now names itself: through its own `metadata` export, or (for a page
// whose file belongs to another package) a metadata-only segment `layout.tsx` beside it.
// This test imports every page under (portal)/(protected) and resolves its title the way
// Next does — the page's own metadata first, else the nearest segment layout's — and
// requires a distinct, non-empty title for each.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const PROTECTED = join(process.cwd(), "src", "app", "(portal)", "(protected)");

function pagesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pagesUnder(path);
    return name === "page.tsx" ? [path] : [];
  });
}

function titleOf(metadata: unknown): string | null {
  const title = (metadata as { title?: unknown } | undefined)?.title;
  if (typeof title === "string") return title;
  if (title && typeof title === "object" && typeof (title as { absolute?: unknown }).absolute === "string") {
    return (title as { absolute: string }).absolute;
  }
  return null;
}

// The page's own title, else the nearest segment layout's between the page and the
// (protected) group (whose own layout is the shared app shell, not a page title).
async function resolveTitle(pagePath: string): Promise<string | null> {
  const own = titleOf((await import(pagePath)).metadata);
  if (own) return own;
  for (let dir = dirname(pagePath); dir.startsWith(PROTECTED) && dir !== PROTECTED; dir = dirname(dir)) {
    const layout = join(dir, "layout.tsx");
    if (existsSync(layout)) {
      const fromLayout = titleOf((await import(layout)).metadata);
      if (fromLayout) return fromLayout;
    }
  }
  return null;
}

test("every portal page has its own distinct, non-empty title", async () => {
  const titles = new Map<string, string>();
  const missing: string[] = [];
  for (const page of pagesUnder(PROTECTED)) {
    const route = "/" + relative(PROTECTED, dirname(page));
    const title = await resolveTitle(page);
    if (!title || title.trim().length === 0 || /^warthog$/i.test(title.trim())) {
      missing.push(route);
      continue;
    }
    titles.set(route, title);
  }
  assert.deepEqual(missing, [], `pages without their own title: ${missing.join(", ")}`);
  const seen = new Map<string, string>();
  for (const [route, title] of titles) {
    assert.ok(!seen.has(title), `"${title}" is used by both ${seen.get(title)} and ${route}`);
    seen.set(title, route);
  }
});

test("a few titles read as the person would name the screen", async () => {
  const expectations: Array<[string, string]> = [
    ["inbox", "Inbox"],
    ["vault", "About you"],
    ["vault/cards", "Cards"],
    ["settings/data", "Data & privacy"],
    ["activity", "Activity"],
  ];
  for (const [route, expected] of expectations) {
    assert.equal(await resolveTitle(join(PROTECTED, route, "page.tsx")), expected, route);
  }
});

test("the public Help, Compatibility and Privacy pages are titled too", async () => {
  for (const [route, expected] of [
    ["help", "Help"],
    ["help/compatibility", "Compatibility"],
    ["privacy", "Privacy"],
  ] as const) {
    const layout = await import(join(process.cwd(), "src", "app", route, "layout.tsx"));
    assert.equal(titleOf(layout.metadata), expected, route);
  }
});
