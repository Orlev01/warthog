// E18-S18 — Shared page container for every portal page
// (src/components/shell/page-container.tsx).
//
// RED-first: the component does NOT exist yet, so importing `./page-container`
// throws (and reddens `tsc`) and every test here fails until the builder adds it.
// That absence is the entire point of test-first — do NOT implement anything to make
// these pass; the builder writes <PageContainer> afterwards as the minimum code that
// turns these green, and wires vault/page.tsx + skills/page.tsx to wrap their content
// in it (the task's touches).
//
// WHY this component exists (the task): Vault and Skills render flush against the
// sidebar while Home, Rules and Security sit in a centred content container. This
// task introduces ONE shared <PageContainer> the pages wrap their content in —
// centred (mx-auto), max-w-2xl, with px-4 sm:px-6 py-8 — so every
// (portal)/(protected) page is consistent, and NO page double-wraps (a container on
// top of an existing one).
//
// These tests pin BEHAVIOUR — what <PageContainer> RENDERS, and that wrapping the
// real Vault/Skills page VIEWS in it yields exactly one container (no double nesting)
// with the view's content inside — never the source text of any module, so a
// behaviour-preserving refactor stays green. We render with react-dom/server (no
// DOM/jsdom — React component / E2E testing is a per-job ADR), exactly as the sibling
// shell/view tests do.
//
// Why we drive the VIEWS, not the page entries: a Next `page.tsx` is an async server
// component that reads the session cookie + the process-wide database, so it can't be
// rendered under the plain `node --import tsx --test` runner. Following every sibling
// page test, we compose <PageContainer> with the render-testable views the Vault and
// Skills pages mount (IdentityView, SkillsView) — the acceptance criterion's "render
// each page entry's view inside it [and] inspect the rendered wrapper classes".

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { PageContainer } from "./page-container";
import { IdentityView } from "@/components/vault/identity-view";
import { SkillsView } from "@/components/skills/skills-view";

// --- tiny markup helpers (no DOM), mirrored from the sibling shell tests ------------

// Visible text of an HTML fragment with tags stripped and whitespace collapsed.
function strip(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// Every class="…" value, in render order.
function classAttrs(markup: string): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/\bclass="([^"]*)"/gi)) out.push(m[1]!);
  return out;
}

function tokens(cls: string): string[] {
  return cls.split(/\s+/).filter(Boolean);
}

// A "page container" element: horizontally centred (mx-auto) AND width-capped (some
// max-w-* token) on the same element — the signature every existing portal container
// (Home / Rules / Security) uses, independent of the other classes around it.
function isPageContainer(cls: string): boolean {
  const t = tokens(cls);
  return t.includes("mx-auto") && t.some((x) => x.startsWith("max-w-"));
}

function pageContainers(markup: string): string[] {
  return classAttrs(markup).filter(isPageContainer);
}

// The class on the first (root) opening tag, or "".
function rootClass(markup: string): string {
  const open = markup.match(/^\s*<[a-zA-Z][\w-]*\b([^>]*)>/);
  if (!open) return "";
  const cls = open[1]!.match(/\bclass="([^"]*)"/i);
  return cls ? cls[1]! : "";
}

// Minimal props for the two views the touched pages mount (an empty vault / a fresh
// skills screen) — enough to render; the fixtures carry no page container of their own.
const VAULT_PROPS = { lowTierFields: [], highTierFields: [] } as const;
const HOUSE_SKILL = {
  title: "Warthog house skill",
  useThisWhen: "always",
  alwaysIncluded: true,
} as const;

// =====================================================================================
// The shared container: it wraps its children in ONE centred, width-capped content
// box (mx-auto max-w-2xl px-4 sm:px-6 py-8).
// =====================================================================================

test("PageContainer renders its children", () => {
  const markup = renderToStaticMarkup(
    <PageContainer>
      <p>sentinel-child-content</p>
    </PageContainer>,
  );
  assert.ok(
    strip(markup).includes("sentinel-child-content"),
    "the children render inside the container",
  );
});

test("PageContainer centres its content in the shared max-w-2xl container with px-4 sm:px-6 py-8", () => {
  const markup = renderToStaticMarkup(
    <PageContainer>
      <p>x</p>
    </PageContainer>,
  );
  const containers = pageContainers(markup);
  assert.equal(containers.length, 1, "exactly one centred, width-capped container is rendered");
  const t = tokens(containers[0]!);
  // The task's parenthetical spec: centred, max-w-2xl, px-4 sm:px-6, py-8.
  for (const cls of ["mx-auto", "max-w-2xl", "px-4", "sm:px-6", "py-8"]) {
    assert.ok(t.includes(cls), `the container carries "${cls}" (classes: "${containers[0]}")`);
  }
});

test("the container is the outermost wrapper, so content nests inside it", () => {
  const markup = renderToStaticMarkup(
    <PageContainer>
      <p>inside</p>
    </PageContainer>,
  );
  assert.ok(
    isPageContainer(rootClass(markup)),
    `the root element is the page container (root classes: "${rootClass(markup)}")`,
  );
});

// =====================================================================================
// No double nesting — wrapping each touched page's view in <PageContainer> yields
// exactly ONE page container, with the view's content inside it. (If a view already
// carried its own centred container, wrapping it would produce two — the exact defect
// the "no page renders two nested page containers" acceptance criterion forbids.)
// =====================================================================================

test("the Vault page view wraps in exactly one PageContainer, with its content inside", () => {
  const viewOnly = renderToStaticMarkup(<IdentityView {...VAULT_PROPS} />);
  const wrapped = renderToStaticMarkup(
    <PageContainer>
      <IdentityView {...VAULT_PROPS} />
    </PageContainer>,
  );
  assert.equal(
    pageContainers(wrapped).length,
    1,
    "the vault view sits in exactly one page container — not two nested ones",
  );
  assert.ok(isPageContainer(rootClass(wrapped)), "the container is the outer wrapper");
  assert.ok(
    strip(wrapped).includes(strip(viewOnly)),
    "the vault view's content renders inside the container unchanged",
  );
});

test("the Skills page view wraps in exactly one PageContainer, with its content inside", () => {
  const viewOnly = renderToStaticMarkup(
    <SkillsView skills={[]} preferences={null} houseSkill={HOUSE_SKILL} />,
  );
  const wrapped = renderToStaticMarkup(
    <PageContainer>
      <SkillsView skills={[]} preferences={null} houseSkill={HOUSE_SKILL} />
    </PageContainer>,
  );
  assert.equal(
    pageContainers(wrapped).length,
    1,
    "the skills view sits in exactly one page container — not two nested ones",
  );
  assert.ok(isPageContainer(rootClass(wrapped)), "the container is the outer wrapper");
  assert.ok(
    strip(wrapped).includes(strip(viewOnly)),
    "the skills view's content renders inside the container unchanged",
  );
});
