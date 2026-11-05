// E18-S14 — More menu page (the mobile "More" menu that replaces the /more
// placeholder in the (portal)/(protected) group).
//
// RED-first: the view this task introduces — `@/components/more/more-menu`,
// exporting `MoreMenu` — does NOT exist yet, so the top-level import throws and
// every test in this file is red until the builder adds it. That absence is the
// whole point of test-first: do NOT implement anything to make these pass.
//
// WHY a sibling view (not `page.tsx`): a Next `page.tsx` entry file may export
// ONLY its framework fields (its default page component), so it cannot carry a
// render-testable seam without breaking `next build`. The thin `page.tsx` loader
// sits inside the already-guarded `(protected)` route group (whose layout
// delegates the admit/redirect to `requireSession`) and renders this plain,
// synchronously-renderable view — exactly as the home page renders the
// render-tested `@/components/home/dashboard-view` behind its thin loader. These
// tests drive the VIEW directly with `react-dom/server` (no DOM/jsdom — React
// component / E2E testing is a per-job ADR) and the GUARD seam directly against an
// isolated in-memory PGlite with the real migrations, so nothing touches the
// network or Azure, and nothing asserts on the source text of any module.
//
// ─── The contract this task defines (the builder implements exactly this) ───────────
//
//   MoreMenu(): React.ReactElement
//     • Takes NO props — it renders the canonical "More" menu directly from the
//       one source of truth, the portal IA (`@/components/shell/nav`,
//       `PORTAL_NAV` → the "more" node's children). This task hard-codes no
//       parallel list of destinations.
//     • Renders EVERY "More" child as a full-width navigable link (an <a href>)
//       pointing at that child's IA route, in IA order.
//     • Each link shows BOTH an icon (a decorative <svg>) and the child's word
//       label, and is a comfortable touch target (≥ 44px tall).
//     • Built on the design tokens (globals.css), never a raw hex colour.
//
// ─── Acceptance criteria → tests ────────────────────────────────────────────────────
//   AC1  a signed-in GET /more returns 200 LISTING every More child from the
//        navigation IA (Vault, Connectors, Rules & budgets, Spending, Skills,
//        Memory, Life admin, Household, Settings, Help), each a link to its IA
//        route. The 200 body is exactly the <MoreMenu> the page mounts; the guard
//        the route sits behind admits a valid session (the 200 path).
//   AC2  each link is ≥ 44px tall, shows its icon and its word label, and the links
//        follow the IA order in both visual (DOM) and keyboard (no positive
//        tabindex) tab order.
//   AC3  an unauthenticated GET /more redirects to /signin — /more is inside the
//        `(protected)` group whose layout delegates to `requireSession`; these
//        exercise that same guard, the one the newly-mounted route sits behind.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { MoreMenu } from "@/components/more/more-menu";

import { PORTAL_NAV } from "@/components/shell/nav";
import { requireSession } from "@/server/auth/guard";
import { createSession } from "@/server/auth/session";
import { createUser } from "@/server/db/users";
import { fixedClock, type Clock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

// ─── the canonical IA this page re-presents ─────────────────────────────────────────
// The "More" children come from the ONE source of truth (nav.ts); the test derives
// its expectations from there so a deliberate IA change (reworded copy, a new child)
// moves the page and the test together, while a DROPPED or REORDERED child fails.
const MORE_CHILDREN = PORTAL_NAV.find((n) => n.key === "more")?.children ?? [];

// The ten destinations the acceptance criterion enumerates. A ground-truth guard so
// this suite can never pass vacuously (e.g. if the IA ever lost its children): each
// AC-named child must still be present in the IA the page reads.
const EXPECTED_LABELS: readonly string[] = [
  "Vault",
  "Connectors",
  "Rules & budgets",
  "Spending",
  "Skills",
  "Memory",
  "Life admin",
  "Household",
  "Settings",
  "Help",
];

// ─── tiny markup helpers (no DOM), mirrored from app-shell.test.tsx ──────────────────

// Visible text of an HTML fragment with tags stripped: exactly the words a sighted
// reader sees (a decorative <svg> icon contributes none). Decodes the entities that
// matter (notably &amp; from "Rules & budgets").
function strip(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Read one double-quoted attribute off an element's attribute string.
function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

type Anchor = {
  attrs: string;
  inner: string;
  href: string | null;
  cls: string;
  name: string; // visible text (the accessible name of a text link)
  hasIcon: boolean; // carries an inline <svg> icon
};

// Every <a> in the markup, in DOM order (anchors do not nest here).
function parseAnchors(markup: string): Anchor[] {
  const anchors: Anchor[] = [];
  for (const m of markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1]!;
    const inner = m[2]!;
    anchors.push({
      attrs,
      inner,
      href: attr(attrs, "href"),
      cls: attr(attrs, "class") ?? "",
      name: strip(inner),
      hasIcon: /<svg\b/i.test(inner),
    });
  }
  return anchors;
}

// The guaranteed-minimum height a class string encodes, in px, or 0 if none. Tailwind
// spacing unit = 0.25rem = 4px, so `min-h-11`/`h-11` = 44px; arbitrary `min-h-[44px]`
// and `min-h-[2.75rem]` are honoured too. A leading `(?<![\w-])` keeps `max-h-*` (a
// CAP, not a floor) from counting as a satisfied minimum.
function minHeightPx(cls: string): number {
  let px = 0;
  for (const m of cls.matchAll(/(?<![\w-])(?:min-)?h-(\d+)\b/g)) {
    px = Math.max(px, Number(m[1]) * 4);
  }
  for (const m of cls.matchAll(/(?<![\w-])(?:min-)?h-\[(\d+(?:\.\d+)?)px\]/g)) {
    px = Math.max(px, Number(m[1]));
  }
  for (const m of cls.matchAll(/(?<![\w-])(?:min-)?h-\[(\d+(?:\.\d+)?)rem\]/g)) {
    px = Math.max(px, Number(m[1]) * 16);
  }
  return px;
}

// Case/space-insensitive "does the visible text contain this label".
function showsLabel(text: string, label: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return norm(text).includes(norm(label));
}

// Render the menu once and pull its links out.
function renderMenu(): { markup: string; links: Anchor[] } {
  const markup = renderToStaticMarkup(<MoreMenu />);
  return { markup, links: parseAnchors(markup) };
}

// ─── auth helpers (the guard /more sits behind), mirrored from the home page test ────

// A frozen instant: a session created and read at T0 is comfortably inside its
// expiry window, with no wall-clock dependence.
const T0 = new Date("2026-06-01T00:00:00.000Z");
const clock: Clock = fixedClock(T0);

// Seed a signed-in person: a real account plus a live session, returning the raw
// cookie token the guard would receive and the person's own user id.
async function seedSignedIn(db: Db, email: string): Promise<{ userId: string; token: string }> {
  const user = await createUser(db, {
    email,
    wrappedDek: Buffer.from(`wrapped-dek-${email}`).toString("base64"),
  });
  const created = await createSession(db, user.id, { clock, random: systemRandom });
  return { userId: user.id, token: created.token };
}

// ===========================================================================
// Ground-truth guard — the IA the page reads still carries the AC's ten children
// ===========================================================================

test("the navigation IA still carries every 'More' child the page must list", () => {
  assert.ok(MORE_CHILDREN.length > 0, "the 'More' node of the IA must carry children");
  for (const label of EXPECTED_LABELS) {
    assert.ok(
      MORE_CHILDREN.some((c) => c.label === label),
      `the navigation IA must carry a 'More' child labelled "${label}"`,
    );
  }
  for (const child of MORE_CHILDREN) {
    assert.ok(
      typeof child.href === "string" && child.href.length > 0,
      `each 'More' child must carry an IA route, but "${child.label}" has none`,
    );
  }
});

// ===========================================================================
// AC1 — a signed-in /more lists every More child, each a link to its IA route
// ===========================================================================

// The 200 body: the <MoreMenu> the page mounts renders exactly the IA's "More"
// children — the same children, each pointing at its own IA route, in IA order and
// with no extras. Pinned by comparing the rendered anchors to the canonical IA by
// index, so a dropped, added or reordered destination fails, and Settings stays a
// single link to /settings (never expanded into its sub-pages).
test("lists every 'More' child from the IA as a link to its IA route, in IA order", () => {
  const { links } = renderMenu();

  assert.equal(
    links.length,
    MORE_CHILDREN.length,
    `the menu must render exactly one link per 'More' child (${MORE_CHILDREN.length}), got ${links.length}: ` +
      JSON.stringify(links.map((l) => l.href)),
  );

  MORE_CHILDREN.forEach((child, i) => {
    const link = links[i]!;
    assert.equal(
      link.href,
      child.href,
      `link #${i + 1} must point at the IA route for "${child.label}" (${child.href}), got ${link.href}`,
    );
    assert.ok(
      showsLabel(link.name, child.label),
      `link #${i + 1} must show the word label "${child.label}", got visible text "${link.name}"`,
    );
  });
});

// ===========================================================================
// AC2 — each link shows its icon AND its label, ≥44px, in visual + keyboard order
// ===========================================================================

// Each link shows BOTH an icon and a word label — never an icon with no label, nor
// a label with no icon.
test("each 'More' link renders an icon (an <svg>) alongside its word label", () => {
  const { links } = renderMenu();
  MORE_CHILDREN.forEach((child, i) => {
    const link = links[i]!;
    assert.ok(
      link.hasIcon,
      `the "${child.label}" link must render its icon (an inline <svg>)`,
    );
    assert.ok(
      link.name.length > 0 && showsLabel(link.name, child.label),
      `the "${child.label}" link must show its word label beside the icon, got "${link.name}"`,
    );
  });
});

// Each link is a comfortable touch target — at least 44px tall (brief design_ux:
// "Touch targets ≥ 44px"; the app shell already encodes this as min-h-11).
test("each 'More' link is at least 44px tall (a comfortable touch target)", () => {
  const { links } = renderMenu();
  MORE_CHILDREN.forEach((child, i) => {
    const link = links[i]!;
    assert.ok(
      minHeightPx(link.cls) >= 44,
      `the "${child.label}" link must be ≥44px tall; its classes guarantee ${minHeightPx(link.cls)}px ("${link.cls}")`,
    );
  });
});

// Keyboard tab order follows visual order. The links sit in DOM order = IA order
// (pinned by the ordered AC1 check above); here we pin the other half: no positive
// tabindex anywhere reorders that natural (DOM = visual = keyboard) sequence.
test("no positive tabindex is used, so keyboard tab order follows visual (IA) order", () => {
  const { markup } = renderMenu();
  const tabindexes = [...markup.matchAll(/tabindex="(-?\d+)"/gi)].map((m) => Number(m[1]));
  for (const t of tabindexes) {
    assert.ok(
      t <= 0,
      `a positive tabindex (${t}) breaks visual tab order; use DOM order (tabindex 0 or none)`,
    );
  }
});

// Design system — colour comes from tokens, never a raw hex literal. The view takes
// no props, so any hex in its output could only be a hard-coded colour.
test("the More menu uses design tokens, never a raw hex colour", () => {
  const { markup } = renderMenu();
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(markup),
    `no raw hex colour may appear in the More menu markup, got: ${markup}`,
  );
});

// ===========================================================================
// AC3 [obligation:admin-auth-required] — /more is behind the central guard
// ===========================================================================
//
// /more lives inside the `(protected)` route group, whose layout delegates the
// admit/redirect to `requireSession`. These exercise that same guard — the one the
// newly-mounted route sits behind — rather than re-deriving a parallel check.

test("an unauthenticated GET /more (no session cookie) is redirected to /signin [admin-auth-required]", async () => {
  const db = await freshDb();
  try {
    const result = await requireSession(null, { db, clock });
    assert.equal(result.ok, false, "an absent session must not be admitted to /more");
    assert.match(
      result.ok ? "" : result.redirectTo,
      /signin/,
      "an unauthenticated request to /more must be sent to sign in",
    );
  } finally {
    await db.close();
  }
});

test("an unknown token is sent to sign-in; a valid session reaches /more as the 200 path [admin-auth-required]", async () => {
  const db = await freshDb();
  try {
    const unknown = await requireSession("not-a-real-token", { db, clock });
    assert.equal(unknown.ok, false, "an unknown session token must not be admitted");
    assert.match(
      unknown.ok ? "" : unknown.redirectTo,
      /signin/,
      "an unknown session token must be sent to sign in",
    );

    const { userId, token } = await seedSignedIn(db, "quokkaxylophone@people.example");
    const admitted = await requireSession(token, { db, clock });
    assert.equal(admitted.ok, true, "a valid session must be admitted to /more (the 200 path)");
    assert.equal(
      admitted.ok && admitted.session.userId,
      userId,
      "the admitted session must carry the person's own user id (identity from the session, not the client)",
    );
  } finally {
    await db.close();
  }
});
