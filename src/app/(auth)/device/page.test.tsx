// E04-S14 — Device page entry (src/app/(auth)/device/page.tsx).
//
// RED-first: today this entry is an operator placeholder (it renders the generic
// "coming soon" panel, which has NO form fields and NO live control), so the
// assertions below FAIL until the builder replaces it with the real thin entry
// that mounts the add-a-device VIEW (`DeviceView`, E04-S12) at its entry step. That
// absence is the entire point of test-first — do not implement anything to make
// these pass.
//
// What this task is (E04-S14): a THIN page entry that mounts the new-device view —
// the flow that signs a NEW device in to an existing account (DeviceView steps
// code → confirm: enter the one-time code we emailed, then approve/confirm with a
// passkey on a device already set up). The entry step is `code`: enter the emailed
// one-time code. The page is left OUTSIDE any protected route group, so a new
// device with no session yet can still reach it.
//
// How these tests stay honest:
//   * They assert BEHAVIOUR — what the page entry's default export RENDERS when a
//     signed-out visitor loads it — never the source text of page.tsx. A later
//     behaviour-preserving refactor (a different client controller, reworded view
//     copy, a moved import) stays green as long as the assembled screen still
//     mounts the new-device view at its code step with a live control.
//   * They import ONLY the page's framework field (its default export). A Next
//     `page.tsx` may export only its reserved route keys, so the testable wiring
//     seam, if any, lives in a sibling module — this file never demands a
//     non-framework export from the entry, which would lock the builder into an
//     unwinnable conflict with `next build`.
//   * Absence checks (the jargon scan) are scoped to THIS page's own rendered
//     output — the unit under test — so the same word living elsewhere in the app
//     is irrelevant.
//
// We render with `react-dom/server` (no DOM/jsdom — React component testing is a
// per-job ADR) and read the emitted markup, mirroring the view render tests and
// the sibling signup/signin page tests.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import DevicePage from "./page";

// --- tiny markup helpers (no DOM) ------------------------------------------

function decode(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ");
}

// Visible text of an HTML fragment with tags stripped and entities decoded.
function visibleText(markup: string): string {
  return decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// All human-facing text: the visible copy PLUS the words a screen reader announces
// from the attributes that carry them. The jargon scan runs over this.
function faceText(markup: string): string {
  const parts = [visibleText(markup)];
  for (const re of [
    /aria-label="([^"]*)"/gi,
    /placeholder="([^"]*)"/gi,
    /\btitle="([^"]*)"/gi,
    /\balt="([^"]*)"/gi,
  ]) {
    for (const m of markup.matchAll(re)) parts.push(decode(m[1]));
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

type El = { attrs: string; inner: string };

function findAll(markup: string, tag: string): El[] {
  const out: El[] = [];
  for (const m of markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, "gi"))) {
    out.push({ attrs: m[1], inner: m[2] });
  }
  return out;
}

// Void <input> elements (React self-closes them): just their attributes.
function inputs(markup: string): { attrs: string; type: string; id: string | null }[] {
  const out: { attrs: string; type: string; id: string | null }[] = [];
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    out.push({ attrs, type: (attr(attrs, "type") ?? "text").toLowerCase(), id: attr(attrs, "id") });
  }
  return out;
}

// id → the visible text of the <label for=id> that targets it.
function labelTextById(markup: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const l of findAll(markup, "label")) {
    const f = attr(l.attrs, "for");
    if (f) map[f] = visibleText(l.inner);
  }
  return map;
}

// Input types that MUST carry an accessible label for WCAG 2.2 AA.
const LABELLABLE = new Set(["text", "email", "tel", "number", "password", "search", "url"]);

// Does this input have a programmatic accessible label — an associated <label for>,
// an aria-label, or an aria-labelledby?
function inputIsLabelled(
  input: { attrs: string; id: string | null },
  labels: Record<string, string>,
): boolean {
  if (input.id && labels[input.id] && labels[input.id].length > 0) return true;
  const al = attr(input.attrs, "aria-label");
  if (al && al.trim().length > 0) return true;
  const alb = attr(input.attrs, "aria-labelledby");
  if (alb && alb.trim().length > 0) return true;
  return false;
}

// An actionable native <button> is one not carrying the native `disabled` attribute
// (React renders a truthy boolean `disabled` prop as `disabled=""`). Matching the
// ATTRIBUTE (never a Tailwind `disabled:` class) proves a genuinely live control.
function actionableButtons(markup: string): { name: string; attrs: string }[] {
  return findAll(markup, "button")
    .filter((b) => !/\bdisabled=""/i.test(b.attrs))
    .map((b) => ({ name: visibleText(b.inner) || attr(b.attrs, "aria-label") || "", attrs: b.attrs }));
}

// Render the page entry's default export (the route's screen). The thin entry mounts
// a view from props alone, so it renders without a live request scope. `searchParams`
// / `params` are supplied as resolved promises (the Next 15 shape) so an entry that
// reads them sees an empty, fresh-GET request; an entry that ignores them is
// unaffected. The result may be sync JSX or an async server component — await either.
async function renderPage(Page: unknown): Promise<string> {
  assert.equal(
    typeof Page,
    "function",
    "the device entry must have a default-exported page component",
  );
  const element = await Promise.resolve(
    (Page as (props: unknown) => unknown)({
      searchParams: Promise.resolve({}),
      params: Promise.resolve({}),
    }),
  );
  return renderToStaticMarkup(element as React.ReactElement);
}

// --- the forbidden vocabulary (brief design_ux.copy; design §5; INV-22) -----
// "code" and "passkey" are the brief's OWN plain vocabulary and are expected on
// this screen, not jargon, so they are deliberately NOT listed.

const JARGON: { label: string; re: RegExp }[] = [
  { label: "OAuth", re: /\boauth\b/i },
  { label: "MCP", re: /\bmcp\b/i },
  { label: "PRF", re: /\bprf\b/i },
  { label: "token", re: /\btokens?\b/i },
  { label: "WebAuthn", re: /\bwebauthn\b/i },
  { label: "FIDO", re: /\bfido\b/i },
  { label: "TOTP", re: /\btotp\b/i },
  { label: "HMAC", re: /\bhmac\b/i },
  { label: "JWT", re: /\bjwt\b/i },
  { label: "attestation", re: /\battestation\b/i },
  { label: "assertion", re: /\bassertion\b/i },
  { label: "encryption key", re: /\bencryption key\b/i },
  { label: "RP ID", re: /\brp id\b/i },
];

// ===========================================================================

// AC1 (mount the view at its entry step) — the entry mounts `DeviceView` at the
// `code` step: the first factor of the new-device flow, which collects the one-time
// code emailed to the person through an accessibly-labelled input. The operator
// placeholder renders no field at all, so this is RED until the real view is
// mounted. The `/device/` copy pin distinguishes it from the look-alike sign-up
// "check your email" code screen (which also collects a single code), so this test
// fails if the WRONG code screen is mounted, not only when none is.
test("device page entry mounts the new-device view's code step (one-time code, accessibly labelled)", async () => {
  const markup = await renderPage(DevicePage);

  const labels = labelTextById(markup);
  const entry = inputs(markup).filter((i) => LABELLABLE.has(i.type));
  assert.ok(
    entry.length >= 1,
    `the device entry must mount the code step collecting the emailed one-time code (a field), got ${entry.length}: ${markup}`,
  );
  for (const input of entry) {
    assert.ok(
      inputIsLabelled(input, labels),
      `every device field must carry an accessible label (a <label for>, aria-label or aria-labelledby), got: ${input.attrs}`,
    );
  }

  const labelBlob = Object.values(labels).join(" ").toLowerCase();
  assert.match(labelBlob, /code/i, `a field must be labelled for the one-time code, got labels: "${labelBlob}"`);

  assert.match(
    visibleText(markup),
    /device/i,
    `the mounted screen must be the new-device flow (its copy names adding the device), got: "${visibleText(markup)}"`,
  );
});

// AC1 (wire the flow) — the mounted view is a LIVE screen: it offers an actionable,
// named control to proceed (no dead button). A thin entry that forgot to mount the
// view renders the inert placeholder, which has no control at all → RED.
test("device page entry presents an actionable, named control to proceed (no dead control)", async () => {
  const markup = await renderPage(DevicePage);
  const live = actionableButtons(markup).filter((b) => b.name.trim().length > 0);
  assert.ok(
    live.length >= 1,
    `the device entry must mount a live, named control to continue the flow (not a dead/inert screen), got: ${markup}`,
  );
});

// AC2 (outside any guard) — the new-device flow must be reachable by a signed-out
// visitor: a brand-new device has no session yet and must still reach it. The thin
// entry renders from props alone and must NOT sit behind a guard that reads a
// session and redirects/throws when none is present. If the builder wrapped it in a
// protected route group (or made the page itself session-guard), rendering here (no
// request scope, no session) would throw — this test catches that.
test("device page entry renders for a signed-out visitor (not behind a protected guard)", async () => {
  let markup: string;
  try {
    markup = await renderPage(DevicePage);
  } catch (err) {
    assert.fail(
      "the device page must render for a signed-out visitor — it must stay outside any protected route group, not behind a guard that redirects or throws without a session: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  assert.ok(
    visibleText(markup).length >= 8,
    `the device entry must render a real screen for a signed-out visitor, got: "${visibleText(markup)}"`,
  );
});

// Primary-screen copy discipline — no protocol or security jargon on the assembled
// device screen. Scoped to THIS page's own rendered face text.
test("device page entry shows no protocol or security jargon", async () => {
  const text = faceText(await renderPage(DevicePage));
  for (const { label, re } of JARGON) {
    assert.ok(
      !re.test(text),
      `the device screen must say what happens in plain words — found jargon "${label}" in: "${text}"`,
    );
  }
});
