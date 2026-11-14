// E04-S13 — Sign-up page entry (src/app/(auth)/signup/page.tsx).
//
// RED-first: today this entry is an operator placeholder (it renders the generic
// "coming soon" panel), so the assertions below FAIL until the builder replaces it
// with the real thin entry that mounts the sign-up VIEW (E04-S12) and wires its
// actions (the E04-S10 sign-up handler, surfaced as server actions in the sibling
// `actions.ts`). That absence is the entire point of test-first — do not implement
// anything to make these pass.
//
// What this task is (E04-S13): a THIN page entry that (1) mounts `SignupView` and
// (2) wires its actions, left OUTSIDE any protected route group so a guard can never
// redirect sign-up to itself.
//
// How these tests stay honest:
//   * They assert BEHAVIOUR — what the page entry's default export RENDERS when a
//     signed-out visitor loads it — never the source text of page.tsx. A later
//     behaviour-preserving refactor (a different client controller, reworded view
//     copy, a moved import) stays green as long as the assembled screen still mounts
//     the sign-up view at its entry step with a live control.
//   * They import ONLY the page's framework field (its default export). A Next
//     `page.tsx` may export only its reserved route keys, so the testable wiring
//     seam lives in the sibling `actions.ts` / `handler.ts` (already tested in
//     handler.test.ts) — this file never demands a non-framework export from the
//     entry, which would lock the builder into an unwinnable conflict with
//     `next build`.
//   * Absence checks (the jargon scan) are scoped to THIS page's own rendered output
//     — the unit under test — so the same word living elsewhere in the app (a help
//     page, the security FAQ) is irrelevant.
//
// We render with `react-dom/server` (no DOM/jsdom — React component testing is a
// per-job ADR) and read the emitted markup, mirroring the view render tests.

import { withPageRequest } from "@/test/page-request";
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import SignupPage from "./page";

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

// Render the page entry's default export (the route's screen) in an anonymous request, with
// no cookie or database (a signed-in visitor is sent on; src/app/public-entry.test.tsx). `searchParams`
// / `params` are supplied as resolved promises (the Next 15 shape) so an entry that
// reads them sees an empty, fresh-GET request; an entry that ignores them is
// unaffected. The result may be sync JSX or an async server component — await either.
async function renderPage(Page: unknown): Promise<string> {
  assert.equal(
    typeof Page,
    "function",
    "the sign-up entry must have a default-exported page component",
  );
  const element = await withPageRequest("/signup", undefined, () =>
    Promise.resolve(
      (Page as (props: unknown) => unknown)({
        searchParams: Promise.resolve({}),
        params: Promise.resolve({}),
      }),
    ),
  );
  return renderToStaticMarkup(element as React.ReactElement);
}

// --- the forbidden vocabulary (brief design_ux.copy; design §5; INV-22) -----

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

// AC1 (mount the view) — the entry mounts `SignupView` at its entry step: the
// sign-up details form that collects the person's name and email through
// accessibly-labelled inputs. The operator placeholder renders neither field, so
// this is RED until the real view is mounted.
test("sign-up page entry mounts the sign-up view's details step (name + email, accessibly labelled)", async () => {
  const markup = await renderPage(SignupPage);

  const labels = labelTextById(markup);
  const entry = inputs(markup).filter((i) => LABELLABLE.has(i.type));
  assert.ok(
    entry.length >= 2,
    `the sign-up entry must mount the details form collecting at least name and email (two fields), got ${entry.length}: ${markup}`,
  );
  for (const input of entry) {
    assert.ok(
      inputIsLabelled(input, labels),
      `every sign-up field must carry an accessible label (a <label for>, aria-label or aria-labelledby), got: ${input.attrs}`,
    );
  }

  const labelBlob = Object.values(labels).join(" ").toLowerCase();
  assert.match(labelBlob, /name/i, `a field must be labelled for the person's name, got labels: "${labelBlob}"`);
  assert.match(labelBlob, /email/i, `a field must be labelled for the email, got labels: "${labelBlob}"`);
});

// AC1 (wire the actions) — the mounted view is a LIVE screen: it offers an
// actionable, named control to proceed (no dead button). A thin entry that forgot to
// wire the view renders the inert placeholder, which has no control at all → RED.
test("sign-up page entry presents an actionable, named control to proceed (no dead control)", async () => {
  const markup = await renderPage(SignupPage);
  const live = actionableButtons(markup).filter((b) => b.name.trim().length > 0);
  assert.ok(
    live.length >= 1,
    `the sign-up entry must mount a live, named control to continue the flow (not a dead/inert screen), got: ${markup}`,
  );
});

// AC2 (outside any guard) — sign-up must be reachable by a signed-out visitor: the
// thin entry renders from props alone and must NOT sit behind a guard that reads a
// session and redirects/throws when none is present. If the builder wrapped it in a
// protected route group, rendering here (no request scope, no session) would throw —
// this test catches that.
test("sign-up page entry renders for a signed-out visitor (not behind a protected guard)", async () => {
  let markup: string;
  try {
    markup = await renderPage(SignupPage);
  } catch (err) {
    assert.fail(
      "the sign-up page must render for a signed-out visitor — it must stay outside any protected route group, not behind a guard that redirects or throws without a session: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  assert.ok(
    visibleText(markup).length >= 8,
    `the sign-up entry must render a real screen for a signed-out visitor, got: "${visibleText(markup)}"`,
  );
});

// Primary-screen copy discipline — no protocol or security jargon on the assembled
// sign-up screen. Scoped to THIS page's own rendered face text.
test("sign-up page entry shows no protocol or security jargon", async () => {
  const text = faceText(await renderPage(SignupPage));
  for (const { label, re } of JARGON) {
    assert.ok(
      !re.test(text),
      `the sign-up screen must say what happens in plain words — found jargon "${label}" in: "${text}"`,
    );
  }
});
