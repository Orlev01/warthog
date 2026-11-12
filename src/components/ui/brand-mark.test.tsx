// Brand marks for services and agents (`./brand-mark`, `@/domain/brands`): the founder asked
// for known brands such as Gmail and Claude to show their actual icon and colours. Marks are
// decorative static images beside the visible name; unknown brands get a neutral initial.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentMark, ServiceMark } from "./brand-mark";
import { agentBrand, brandInitial, serviceBrand } from "@/domain/brands";
import { BRAND_MARKS } from "@/domain/brand-registry";

test("known services and agent platforms resolve to their own marks", () => {
  assert.equal(serviceBrand("google-gmail")?.src, "/brands/google-gmail.svg");
  assert.equal(serviceBrand("microsoft-outlook-mail")?.title, "Outlook Mail");
  assert.equal(agentBrand("Claude")?.src, "/brands/agent-claude.svg");
  assert.equal(agentBrand("Other", "Claude on my laptop")?.title, "Claude", "a named Claude is still Claude");
  assert.equal(agentBrand("Dots (OpenAI)")?.title, "ChatGPT");
  assert.equal(agentBrand("Other", "Household helper"), undefined);
  assert.equal(serviceBrand("not-a-service"), undefined);
});

test("a mark is a decorative same-origin image on a tile; an unknown brand shows its initial", () => {
  const gmail = renderToStaticMarkup(<ServiceMark id="google-gmail" name="Gmail" />);
  assert.match(gmail, /<span aria-hidden="true" data-size="md" class="wh-brand-tile"[^>]*><img src="\/brands\/google-gmail.svg" alt=""/);
  const unknown = renderToStaticMarkup(<AgentMark platform="Other" name="household helper" size="sm" />);
  assert.match(unknown, /wh-brand-initial[^>]*>H<\/span>/);
  assert.doesNotMatch(gmail + unknown, /#[0-9a-f]{3,6}\b/i, "no raw colour in markup");
  assert.equal(brandInitial("  monday.com"), "M");
});

test("every registered mark exists as a sanitised static SVG", () => {
  for (const [key, mark] of Object.entries(BRAND_MARKS)) {
    const file = join(process.cwd(), "public", mark.src);
    assert.ok(existsSync(file), `${key} has its file`);
    const svg = readFileSync(file, "utf8");
    assert.match(svg, /^<svg[\s>]/, `${key} is a bare svg`);
    assert.doesNotMatch(svg, /<script|on[a-z]+\s*=|javascript:|<foreignObject|href="(?!#)/i, `${key} is inert`);
  }
});
