// The admin portal's shell (src/components/admin/admin-chrome.tsx): the admin IA in both
// navigation surfaces, the current section lit from the forwarded original path, the two ways
// out in both footers, no help link, no raw colour.
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminChrome } from "./admin-chrome";

const render = (pathname: string) =>
  renderToStaticMarkup(<AdminChrome pathname={pathname} appOrigin="https://app.example.test"><p>page</p></AdminChrome>);

test("lists every admin destination in both navigation surfaces and lights the section for the original path", () => {
  const html = render("/usage");
  for (const href of ["/signups", "/usage", "/accounts", "/reliability", "/traffic", "/system"]) {
    assert.equal((html.match(new RegExp(`href="${href}"`, "g")) ?? []).length, 2, href);
  }
  const current = [...html.matchAll(/<a href="[^"]*" aria-current="page"/g)];
  assert.equal(current.length, 2, "desktop and drawer each light exactly one destination");
  assert.match(html, /href="\/usage" aria-current="page"/);
  assert.match(html, /<span>Admin<\/span>/);
  assert.match(html, /data-measure="wide"/);
  assert.match(html, /class="wh-crumb-group">Product</);
});

test("the root is Overview, Accounts reads at the narrower measure, and an unknown path lights nothing", () => {
  assert.match(render("/"), /href="\/" aria-current="page"/);
  assert.match(render("/accounts"), /data-measure="reading"/);
  assert.doesNotMatch(render("/nowhere"), /<a href="[^"]*" aria-current="page"/);
});

test("both footers offer Back to Warthog and Sign out of admin; there is no help link and no raw colour", () => {
  const html = render("/");
  assert.equal((html.match(/Back to Warthog/g) ?? []).length, 2);
  assert.equal((html.match(/Sign out of admin/g) ?? []).length, 2);
  assert.match(html, /href="https:\/\/app\.example\.test\/home"/);
  assert.match(html, /<form action="\/signout" method="post">/);
  assert.doesNotMatch(html, /aria-label="Help and support"/);
  assert.doesNotMatch(html, /#[0-9a-fA-F]{3,8}\b/);
  assert.match(html, /<p>page<\/p>/);
});
