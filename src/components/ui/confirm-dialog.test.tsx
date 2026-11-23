// UI/UX audit 2026-11-23 W-40 / W-16 — the shared confirmation dialog (src/components/ui/confirm-dialog.tsx).
// Rendered with react-dom/server (no DOM); these pin what it renders, not how.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ConfirmDialog } from "./confirm-dialog";

function render(props: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}): string {
  return renderToStaticMarkup(
    <ConfirmDialog
      open={true}
      title="Leave without saving?"
      description="Your changes to Claude's access aren't saved yet."
      confirmLabel="Leave without saving"
      cancelLabel="Keep editing"
      onConfirm={() => {}}
      onCancel={() => {}}
      {...props}
    />,
  );
}

test("the dialog is a native dialog named by its title and described by its consequence", () => {
  const html = render();
  assert.match(html, /<dialog\b[^>]*aria-labelledby="([^"]+)"[^>]*aria-describedby="([^"]+)"/);
  const [, titleId, bodyId] = html.match(/aria-labelledby="([^"]+)"[^>]*aria-describedby="([^"]+)"/)!;
  assert.ok(html.includes(`id="${titleId}"`) && html.includes("Leave without saving?</h2>"), "the title names the dialog");
  assert.ok(html.indexOf(`id="${bodyId}"`) > -1 && html.indexOf("saved yet") > html.indexOf(`id="${bodyId}"`), "the consequence is the description");
});

test("the safe choice comes first, so it is focused first and read first", () => {
  const html = render();
  const keep = html.indexOf("Keep editing");
  const leave = html.lastIndexOf("Leave without saving");
  assert.ok(keep > -1 && leave > keep, "Keep editing precedes the risky choice in the DOM (and in Tab order)");
  assert.doesNotMatch(html, /flex-col-reverse/, "visual order matches Tab order on phones (no reversed column)");
});

test("a danger confirmation uses the danger style; a neutral one doesn't", () => {
  assert.match(render({ tone: "danger" }), /bg-danger|danger/);
  const neutral = render({ tone: "neutral" });
  const confirmButton = neutral.slice(neutral.lastIndexOf("<button"));
  assert.doesNotMatch(confirmButton, /bg-danger/);
});

test("closed, the dialog renders nothing visible", () => {
  assert.doesNotMatch(render({ open: false }), /Leave without saving\?/);
});
