// E04-S14 — Recover page entry (src/app/(auth)/recover/page.tsx).
//
// RED-first: today this entry is an operator placeholder (it renders the generic
// "coming soon" panel, which has NO form fields and NO live control), so the
// assertions below FAIL until the builder replaces it with the real thin entry
// that mounts the recovery VIEW (`RecoverView`, E04-S12) at its entry step. That
// absence is the entire point of test-first — do not implement anything to make
// these pass.
//
// What this task is (E04-S14): a THIN page entry that mounts the recovery view —
// the flow that runs email-code plus recovery-code, then a new passkey and a new
// recovery code (RecoverView steps identify → recovery-code → passkey →
// new-recovery). The entry step is `identify`: prove it's you with your email and
// the one-time code. The page is left OUTSIDE any protected route group, so a
// guard can never redirect recovery to itself (recovery must be reachable with no
// existing session).
//
// How these tests stay honest:
//   * They assert BEHAVIOUR — what the page entry's default export RENDERS when a
//     signed-out visitor loads it — never the source text of page.tsx. A later
//     behaviour-preserving refactor (a different client controller, reworded view
//     copy, a moved import) stays green as long as the assembled screen still
//     mounts the recovery view at its identify step with a live control.
//   * They import ONLY the page's framework field (its default export). A Next
//     `page.tsx` may export only its reserved route keys, so the testable wiring
//     seam, if any, lives in a sibling module — this file never demands a
//     non-framework export from the entry, which would lock the builder into an
//     unwinnable conflict with `next build`.
//   * Absence checks (the jargon scan) are scoped to THIS page's own rendered
//     output — the unit under test — so the same word living elsewhere in the app
//     (a help page, the security FAQ) is irrelevant.
//
// We render with `react-dom/server` (no DOM/jsdom — React component testing is a
// per-job ADR) and read the emitted markup, mirroring the view render tests and
// the sibling signup/signin page tests.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import RecoverPage from "./page";
import { RecoverView } from "../../../components/auth/auth-views";

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
    "the recover entry must have a default-exported page component",
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
// "recovery code", "code" and "passkey" are the brief's OWN plain vocabulary and
// are expected on this screen, not jargon, so they are deliberately NOT listed.

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

// AC1 (mount the view at its entry step) — the entry mounts `RecoverView` at the
// `identify` step: the start of the first factor, which collects the email the one-time
// code is sent to through an accessibly-labelled input. (Review fix B2: the code can only
// be typed once it has been emailed, so it is collected on the next, `email-code`, step —
// pinned below — rather than by a dead field on this one.) The operator placeholder
// renders no fields at all, so this is RED until the real view is mounted. The
// `/recover/` copy pin distinguishes it from the look-alike sign-in screens.
test("recover page entry mounts the recovery view's identify step (email, accessibly labelled)", async () => {
  const markup = await renderPage(RecoverPage);

  const labels = labelTextById(markup);
  const entry = inputs(markup).filter((i) => LABELLABLE.has(i.type));
  assert.ok(entry.length >= 1, `the recover entry must collect the email, got ${entry.length}: ${markup}`);
  for (const input of entry) {
    assert.ok(
      inputIsLabelled(input, labels),
      `every recover field must carry an accessible label (a <label for>, aria-label or aria-labelledby), got: ${input.attrs}`,
    );
  }

  const labelBlob = Object.values(labels).join(" ").toLowerCase();
  assert.match(labelBlob, /email/i, `a field must be labelled for the email, got labels: "${labelBlob}"`);

  // The next step collects the emailed one-time code, accessibly labelled.
  const codeStep = renderToStaticMarkup(<RecoverView step="email-code" />);
  const codeLabels = labelTextById(codeStep);
  const codeInputs = inputs(codeStep).filter((i) => LABELLABLE.has(i.type));
  assert.equal(codeInputs.length, 1, `the email-code step collects the code: ${codeStep}`);
  assert.ok(inputIsLabelled(codeInputs[0]!, codeLabels), "the code field carries an accessible label");
  assert.match(Object.values(codeLabels).join(" "), /code/i, "the field is labelled for the code");

  assert.match(
    visibleText(markup),
    /recover/i,
    `the mounted screen must be the recovery flow (its copy names recovering the account), got: "${visibleText(markup)}"`,
  );
});

// AC1 (wire the flow) — the mounted view is a LIVE screen: it offers an actionable,
// named control to proceed (no dead button). A thin entry that forgot to mount the
// view renders the inert placeholder, which has no control at all → RED.
test("recover page entry presents an actionable, named control to proceed (no dead control)", async () => {
  const markup = await renderPage(RecoverPage);
  const live = actionableButtons(markup).filter((b) => b.name.trim().length > 0);
  assert.ok(
    live.length >= 1,
    `the recover entry must mount a live, named control to continue the flow (not a dead/inert screen), got: ${markup}`,
  );
});

// AC2 (outside any guard) — recovery must be reachable by a signed-out visitor: the
// whole point is to get back in WITHOUT an existing session. The thin entry renders
// from props alone and must NOT sit behind a guard that reads a session and
// redirects/throws when none is present. If the builder wrapped it in a protected
// route group (or made the page itself session-guard), rendering here (no request
// scope, no session) would throw — this test catches that.
test("recover page entry renders for a signed-out visitor (not behind a protected guard)", async () => {
  let markup: string;
  try {
    markup = await renderPage(RecoverPage);
  } catch (err) {
    assert.fail(
      "the recover page must render for a signed-out visitor — it must stay outside any protected route group, not behind a guard that redirects or throws without a session: " +
        (err instanceof Error ? err.message : String(err)),
    );
    return;
  }
  assert.ok(
    visibleText(markup).length >= 8,
    `the recover entry must render a real screen for a signed-out visitor, got: "${visibleText(markup)}"`,
  );
});

// Primary-screen copy discipline — no protocol or security jargon on the assembled
// recover screen. Scoped to THIS page's own rendered face text.
test("recover page entry shows no protocol or security jargon", async () => {
  const text = faceText(await renderPage(RecoverPage));
  for (const { label, re } of JARGON) {
    assert.ok(
      !re.test(text),
      `the recover screen must say what happens in plain words — found jargon "${label}" in: "${text}"`,
    );
  }
});
