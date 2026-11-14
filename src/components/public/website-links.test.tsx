// Where the public screens' brand and account links point (docs/adr/website-root-domain.md):
// at the website and the app when the front door has its own host, relative otherwise.
import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { AuthScreen } from "../auth/auth-screen";
import { Help } from "./help";
import { Landing } from "./landing";
import { Privacy } from "./privacy";
import { Terms } from "./terms";
import { WebsiteHome } from "./website-home";
import HelpPage from "../../app/help/page";
import { publicLinksFor, websiteFor } from "../../server/http/website";

const LINKS = publicLinksFor(websiteFor("https://app.warthog.example"));
const APP = "https://app.warthog.example";

function hrefs(markup: string): string[] {
  return [...markup.matchAll(/<a\b[^>]*\bhref="([^"]*)"/gi)].map((m) => m[1]!);
}

function accountLinks(markup: string): string[] {
  return hrefs(markup).filter((href) => /\/(signin|signup|recover|reset)$/.test(href));
}

test("the front door sends every sign-in and sign-up link to the app and keeps its brand on the website", () => {
  const markup = renderToStaticMarkup(<Landing links={LINKS} />);
  const account = accountLinks(markup);
  assert.ok(account.length >= 4, "header, hero, closing and footer links");
  assert.ok(account.every((href) => href.startsWith(`${APP}/`)), account.join(" "));
  assert.deepEqual([...new Set(hrefs(markup).filter((href) => href.includes("warthog.example/") && !href.startsWith(APP)))], ["https://warthog.example/"]);
  // Pages the website serves itself stay relative.
  assert.ok(hrefs(markup).includes("/help/compatibility"));
  assert.ok(hrefs(markup).includes("/privacy"));
});

test("Help, Connect your agents, Privacy and Terms point their bars at the website and the app", () => {
  for (const [name, element] of [
    ["privacy", <Privacy links={LINKS} />],
    ["terms", <Terms links={LINKS} />],
    ["compatibility", <Help connectorAddress={`${APP}/mcp`} links={LINKS} />],
  ] as const) {
    const markup = renderToStaticMarkup(element);
    assert.ok(hrefs(markup).includes("https://warthog.example/"), `${name}: brand`);
    assert.deepEqual([...new Set(accountLinks(markup))].sort(), [`${APP}/signin`, `${APP}/signup`], `${name}: account links`);
    assert.ok(hrefs(markup).includes("/help"), `${name}: Help stays on the same host`);
  }
});

test("the Help page's recover and reset actions go to the app when the website has its own host", () => {
  const saved = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = APP;
  try {
    const markup = renderToStaticMarkup(<HelpPage />);
    for (const path of ["/signin", "/signup", "/recover", "/reset"]) assert.ok(hrefs(markup).includes(`${APP}${path}`), path);
    assert.ok(hrefs(markup).includes("/help/compatibility"));
  } finally {
    if (saved === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = saved;
  }
});

test("without a website host every public link stays relative, as before", () => {
  for (const element of [<Landing />, <Privacy />, <Terms />]) {
    const markup = renderToStaticMarkup(element);
    const own = hrefs(markup).filter((href) => /warthog/i.test(href) && !href.startsWith("mailto:"));
    assert.ok(!own.some((href) => /^https?:/.test(href)), own.join(" "));
    assert.ok(hrefs(markup).includes("/signin") && hrefs(markup).includes("/"));
  }
});

test("the account screens' brand and Back to home lead to the website when it has its own host", () => {
  const inside = renderToStaticMarkup(
    <WebsiteHome href="https://warthog.example/"><AuthScreen title="Sign in">form</AuthScreen></WebsiteHome>,
  );
  assert.equal(hrefs(inside).filter((href) => href === "https://warthog.example/").length, 2);
  const alone = renderToStaticMarkup(<AuthScreen title="Sign in">form</AuthScreen>);
  assert.equal(hrefs(alone).filter((href) => href === "/").length, 2);
});
