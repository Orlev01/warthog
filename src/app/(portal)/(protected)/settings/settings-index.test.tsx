// E18-S15 — Settings index page (replaces the /settings placeholder in the
// (portal)/(protected) group with an index that links the three settings screens).
//
// RED-first: the view this task introduces — `@/components/settings/settings-index`,
// exporting `SettingsIndex` — does NOT exist yet, so the top-level import throws and
// every test in this file is red until the builder adds it. That absence is the
// whole point of test-first: do NOT implement anything to make these pass.
//
// WHY a sibling view (not `page.tsx`): a Next `page.tsx` entry file may export ONLY
// its framework fields (its default page component), so it cannot carry a
// render-testable seam without breaking `next build`. The thin `page.tsx` loader
// sits inside the already-guarded `(protected)` route group (whose layout delegates
// the admit/redirect to `requireSession`) and renders this plain, synchronously-
// renderable view — exactly as the sibling `/more` page renders the render-tested
// `@/components/more/more-menu` behind its thin loader. There is no per-request data
// to load (the index is a static menu of three links), so the view is propless.
// These tests drive the VIEW directly with `react-dom/server` (no DOM/jsdom — React
// component / E2E testing is a per-job ADR) and the GUARD seam directly against an
// isolated in-memory PGlite with the real migrations, so nothing touches the network
// or Azure, and nothing asserts on the source text of any module.
//
// ─── The contract this task defines (the builder implements exactly this) ───────────
//
//   SettingsIndex(): React.ReactElement
//     • Takes NO props — it renders the Settings index directly from the one source
//       of truth, the portal IA (`@/components/shell/nav`, the "settings" node's
//       children). This task hard-codes no parallel list of destinations.
//     • Renders EACH settings child (Security, Notifications, Data & privacy) as a
//       navigable link (an <a href>) pointing at that child's IA route, in IA order.
//     • Each link shows BOTH the child's word label AND a one-line plain-English
//       description of that screen (so the destinations are self-explaining, not bare
//       labels). The IA carries no descriptions, so the view supplies them.
//     • Built on the design tokens (globals.css), never a raw hex colour.
//
// ─── Acceptance criteria → tests ────────────────────────────────────────────────────
//   AC1  a signed-in GET /settings returns 200 with links to /settings/security,
//        /settings/notifications and /settings/data, each with its label and a
//        one-line description. The 200 body is exactly the <SettingsIndex> the page
//        mounts; the guard the route sits behind admits a valid session (the 200 path).
//   AC2  an unauthenticated GET /settings redirects to /signin — /settings is inside
//        the `(protected)` group whose layout delegates to `requireSession`; these
//        exercise that same guard, the one the newly-mounted route sits behind.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { SettingsIndex } from "@/components/settings/settings-index";

import { PORTAL_NAV } from "@/components/shell/nav";
import { requireSession } from "@/server/auth/guard";
import { createSession } from "@/server/auth/session";
import { createUser } from "@/server/db/users";
import { fixedClock, type Clock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

// ─── the canonical IA this page re-presents ─────────────────────────────────────────
// The settings sub-pages come from the ONE source of truth (nav.ts): the "settings"
// node (under "more") carries them as its children. The test derives its expectations
// from there so a deliberate IA change (reworded label, a new sub-page) moves the page
// and the test together, while a DROPPED or REORDERED destination fails.
const MORE_NODE = PORTAL_NAV.find((n) => n.key === "more");
const SETTINGS_NODE = MORE_NODE?.children?.find((c) => c.key === "settings");
const SETTINGS_CHILDREN = SETTINGS_NODE?.children ?? [];

// The three destinations the acceptance criterion enumerates, with their routes. A
// ground-truth guard so this suite can never pass vacuously (e.g. if the IA ever lost
// the settings children): each AC-named destination must still be present in the IA
// the page reads, pointing at its documented route.
const EXPECTED: readonly { readonly label: string; readonly href: string }[] = [
  { label: "Security", href: "/settings/security" },
  { label: "Notifications", href: "/settings/notifications" },
  { label: "Data & privacy", href: "/settings/data" },
];

// ─── tiny markup helpers (no DOM), mirrored from more-menu.test.tsx ──────────────────

// Visible text of an HTML fragment with tags stripped: exactly the words a sighted
// reader sees (a decorative <svg> icon contributes none). Decodes the entities that
// matter (notably &amp; from "Data & privacy").
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
    });
  }
  return anchors;
}

// Case/space-insensitive "does this text contain that label".
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
function showsLabel(text: string, label: string): boolean {
  return norm(text).includes(norm(label));
}

// The description a link carries for a destination: the link's visible text with its
// label removed. "each with its label AND a one-line description" means the link shows
// descriptive prose beyond the bare label — this is that remainder.
function descriptionOf(linkText: string, label: string): string {
  const text = norm(linkText);
  const lbl = norm(label);
  const i = text.indexOf(lbl);
  if (i < 0) return text; // label not found verbatim — caller's label check fails first
  return (text.slice(0, i) + " " + text.slice(i + lbl.length)).replace(/\s+/g, " ").trim();
}

// Render the index once and pull its links out.
function renderIndex(): { markup: string; links: Anchor[] } {
  const markup = renderToStaticMarkup(<SettingsIndex />);
  return { markup, links: parseAnchors(markup) };
}

// The one link pointing at a given route (asserts exactly one — no duplicate or
// missing link to that settings screen).
function linkTo(links: Anchor[], href: string): Anchor {
  const matches = links.filter((l) => l.href === href);
  assert.equal(
    matches.length,
    1,
    `the Settings index must carry exactly one link to ${href}, found ${matches.length}: ` +
      JSON.stringify(links.map((l) => l.href)),
  );
  return matches[0]!;
}

// ─── auth helpers (the guard /settings sits behind), mirrored from more-menu.test ────

// A frozen instant: a session created and read at T0 is comfortably inside its expiry
// window, with no wall-clock dependence.
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
// Ground-truth guard — the IA the page reads still carries the AC's three screens
// ===========================================================================

test("the navigation IA still carries every settings screen the index must link", () => {
  assert.ok(
    SETTINGS_CHILDREN.length > 0,
    "the 'settings' node of the IA must carry its sub-page children",
  );
  for (const expected of EXPECTED) {
    const child = SETTINGS_CHILDREN.find((c) => c.label === expected.label);
    assert.ok(child, `the navigation IA must carry a settings child labelled "${expected.label}"`);
    assert.equal(
      child!.href,
      expected.href,
      `the "${expected.label}" settings child must route to ${expected.href}`,
    );
  }
});

// ===========================================================================
// AC1 — a signed-in /settings lists the three screens, each a labelled, described link
// ===========================================================================

// The 200 body: the <SettingsIndex> the page mounts links each settings sub-page from
// the IA, pointing at its own route.
test("links each settings screen to its IA route (Security, Notifications, Data & privacy)", () => {
  const { links } = renderIndex();
  for (const child of SETTINGS_CHILDREN) {
    const link = linkTo(links, child.href!);
    assert.ok(
      showsLabel(link.name, child.label),
      `the link to ${child.href} must show the word label "${child.label}", got visible text "${link.name}"`,
    );
  }
});

// The three settings links appear in IA order (security → notifications → data), the
// order the AC and the IA both document. Scoped to the settings links so an unrelated
// anchor elsewhere on the page (e.g. a heading) does not perturb the check.
test("the settings links follow IA order (security, notifications, data)", () => {
  const { links } = renderIndex();
  const settingsHrefs = new Set(SETTINGS_CHILDREN.map((c) => c.href));
  const rendered = links.map((l) => l.href).filter((h) => h !== null && settingsHrefs.has(h));
  assert.deepEqual(
    rendered,
    SETTINGS_CHILDREN.map((c) => c.href),
    "the settings links must appear in IA order with none dropped or reordered",
  );
});

// Each link carries a one-line plain-English description beyond its bare label — the
// AC's "each with its label and a one-line description". The remainder (visible text
// minus the label) must be real descriptive prose: several words, not an empty string
// or a stray character.
test("each settings link shows a one-line description, not just its label", () => {
  const { links } = renderIndex();
  for (const child of SETTINGS_CHILDREN) {
    const link = linkTo(links, child.href!);
    const description = descriptionOf(link.name, child.label);
    assert.ok(
      description.length >= 12 && description.split(" ").filter(Boolean).length >= 3,
      `the link to ${child.href} must show a one-line description beside "${child.label}", ` +
        `got description "${description}" (from visible text "${link.name}")`,
    );
  }
});

// The descriptions are per-screen, not one boilerplate line repeated — Security,
// Notifications and Data & privacy are different screens, so each explains itself.
test("each settings screen gets its own distinct description", () => {
  const { links } = renderIndex();
  const descriptions = SETTINGS_CHILDREN.map((child) =>
    descriptionOf(linkTo(links, child.href!).name, child.label),
  );
  assert.equal(
    new Set(descriptions).size,
    descriptions.length,
    `each settings screen must get its own description, got: ${JSON.stringify(descriptions)}`,
  );
});

// Design system — colour comes from tokens, never a raw hex literal. The view takes no
// props, so any hex in its output could only be a hard-coded colour.
test("the Settings index uses design tokens, never a raw hex colour", () => {
  const { markup } = renderIndex();
  assert.ok(
    !/#[0-9a-fA-F]{3,8}\b/.test(markup),
    `no raw hex colour may appear in the Settings index markup, got: ${markup}`,
  );
});

// ===========================================================================
// AC2 [obligation:admin-auth-required] — /settings is behind the central guard
// ===========================================================================
//
// /settings lives inside the `(protected)` route group, whose layout delegates the
// admit/redirect to `requireSession`. These exercise that same guard — the one the
// newly-mounted route sits behind — rather than re-deriving a parallel check.

test("an unauthenticated GET /settings (no session cookie) is redirected to /signin [admin-auth-required]", async () => {
  const db = await freshDb();
  try {
    const result = await requireSession(null, { db, clock });
    assert.equal(result.ok, false, "an absent session must not be admitted to /settings");
    assert.match(
      result.ok ? "" : result.redirectTo,
      /signin/,
      "an unauthenticated request to /settings must be sent to sign in",
    );
  } finally {
    await db.close();
  }
});

test("an unknown token is sent to sign-in; a valid session reaches /settings as the 200 path [admin-auth-required]", async () => {
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
    assert.equal(admitted.ok, true, "a valid session must be admitted to /settings (the 200 path)");
    assert.equal(
      admitted.ok && admitted.session.userId,
      userId,
      "the admitted session must carry the person's own user id (identity from the session, not the client)",
    );
  } finally {
    await db.close();
  }
});

// The member app gives no sign that an admin portal exists (founder, 13 November 2026):
// Settings has no admin panel, link or notice for anyone, the operator included. The only
// way in is typing the admin host's address (docs/design/admin-portal.md §2).
test("Settings carries no admin entry, link or notice", () => {
  const html = renderToStaticMarkup(<SettingsIndex />);
  assert.doesNotMatch(html, /admin/i);
  assert.doesNotMatch(html, /handoff/i);
});
