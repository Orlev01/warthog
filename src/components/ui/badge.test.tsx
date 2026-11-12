// Badge, CountBadge (src/components/ui/badge.tsx): one 20px pill for outcomes, markings,
// tags and counts (visual-28). Meaning is in the words; a tone colours the fill and icon.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { CheckCircle2 } from "lucide-react";

import { Badge, CountBadge } from "./badge";

test("a badge is the shared pill with a tone and a decorative icon beside its words", () => {
  const markup = renderToStaticMarkup(<Badge tone="success" icon={CheckCircle2}>Allowed</Badge>);
  assert.match(markup, /^<span class="wh-badge wh-tone-badge wh-tone-success">/);
  assert.match(markup, /<svg[^>]*aria-hidden="true"/);
  assert.ok(markup.replace(/<[^>]*>/g, "").includes("Allowed"));
  assert.match(renderToStaticMarkup(<Badge>Tag</Badge>), /wh-tone-neutral/);
});

test("a count badge can be read with words instead of a bare number", () => {
  assert.equal(renderToStaticMarkup(<CountBadge count={3} />), '<span class="wh-count">3</span>');
  const labelled = renderToStaticMarkup(<CountBadge count={3} label="3 waiting" />);
  assert.match(labelled, /<span aria-hidden="true">3<\/span><span class="sr-only">3 waiting<\/span>/);
});

test("badges use tokens, never a raw hex colour", () => {
  assert.doesNotMatch(renderToStaticMarkup(<Badge tone="danger">Blocked</Badge>), /#[0-9a-fA-F]{3,8}\b/);
});
