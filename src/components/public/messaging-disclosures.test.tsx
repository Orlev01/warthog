import * as React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Terms } from "./terms";
import { Privacy } from "./privacy";
import { NotificationsView } from "../settings/notifications-view";

test("both SMS choices show program disclosures and separate public policy links; alerts start off", () => {
  const html = renderToStaticMarkup(<NotificationsView devices={[]} numbers={[]} />);
  assert.equal((html.match(/href="\/terms"/g) ?? []).length, 2);
  assert.equal((html.match(/href="\/privacy"/g) ?? []).length, 2);
  assert.match(html, /HELP/);
  assert.match(html, /STOP/);
  assert.match(html, /frequency varies/i);
  assert.match(html, /message and data rates may apply/i);
  const checkbox = html.match(/<input[^>]*name="smsFallback"[^>]*>/)?.[0];
  assert.ok(checkbox);
  assert.doesNotMatch(checkbox, /checked/);
});

test("public Terms and privacy identify the operator and support route without claiming global SMS coverage", () => {
  for (const component of [<Terms key="terms" />, <Privacy key="privacy" />]) {
    const html = renderToStaticMarkup(component);
    assert.match(html, /RPR technologies pty ltd/);
    assert.match(html, /mailto:oren@nava-co.com/);
    assert.match(html, /href="\/(privacy|terms)"/);
  }
  assert.match(renderToStaticMarkup(<Terms />), /enabled destinations/);
  assert.match(renderToStaticMarkup(<Privacy />), /do not sell.*SMS consent/i);
});
