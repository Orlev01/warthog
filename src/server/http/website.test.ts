// The website host (src/server/http/website.ts; docs/adr/website-root-domain.md).
import { test } from "node:test";
import assert from "node:assert/strict";

import { ADMIN_PREFIX, APP_HANDOFF_PATH } from "./admin-routing";
import { RELATIVE_LINKS, isWebsitePath, publicLinksFor, redirectTarget, routeForWebsite, websiteFor } from "./website";

const SITE = websiteFor("https://app.warthog.example")!;

test("an app. public base URL gives the website its parent domain, with a www. name and the app origin", () => {
  assert.deepEqual(SITE, {
    origin: "https://warthog.example",
    host: "warthog.example",
    wwwHost: "www.warthog.example",
    appOrigin: "https://app.warthog.example",
  });
  assert.deepEqual(websiteFor("http://APP.localhost:3107/"), {
    origin: "http://localhost:3107", host: "localhost", wwwHost: "www.localhost", appOrigin: "http://app.localhost:3107",
  }, "scheme and port carry over; case folds");
});

test("any other public base URL has no separate website, so the app's root keeps the front door", () => {
  for (const url of ["http://localhost:3000", "https://warthog.example", "https://my.app.warthog.example", "https://application.example", "https://app.single", "ftp://app.warthog.example", "garbage", ""]) {
    assert.equal(websiteFor(url), null, url);
  }
});

test("the website serves the front door, Help, Connect your agents, Privacy and Terms, and nothing else", () => {
  for (const path of ["/", "/help", "/help/compatibility", "/privacy", "/terms"]) assert.equal(isWebsitePath(path), true, path);
  for (const path of ["/signin", "/signup", "/home", "/helpful", "/privacy/x", "/terms.txt", "/api/health", "/mcp", "/admin", ADMIN_PREFIX]) {
    assert.equal(isWebsitePath(path), false, path);
  }
});

test("on the website host its pages are served, assets pass through and every other path forwards to the app", () => {
  for (const path of ["/", "/help", "/help/compatibility", "/privacy", "/terms"]) {
    assert.deepEqual(routeForWebsite("warthog.example", SITE, path), { kind: "website" }, path);
  }
  for (const path of ["/_next/static/chunk.js", "/brand/warthog-logo.png", "/brands/gmail.svg", "/fonts/inter/latin.woff2", "/icons/icon-192.png", "/manifest.webmanifest", "/sw.js", "/robots.txt", "/__nextjs_original-stack-frame"]) {
    assert.deepEqual(routeForWebsite("warthog.example", SITE, path), { kind: "passthrough" }, path);
  }
  // Sign-in, the workspace, the API, agents and the portal's internal paths all live on the app.
  for (const path of ["/signin", "/signup", "/recover", "/home", "/api/auth/signin/begin", "/mcp", "/.well-known/oauth-authorization-server", "/oauth/authorize", "/admin", APP_HANDOFF_PATH, "/helpful"]) {
    assert.deepEqual(routeForWebsite("warthog.example", SITE, path), { kind: "redirect", origin: "https://app.warthog.example" }, path);
  }
});

test("the www. name forwards every path to the website; other hosts are not the website's concern", () => {
  for (const path of ["/", "/help", "/signin", "/_next/static/chunk.js"]) {
    assert.deepEqual(routeForWebsite("www.warthog.example", SITE, path), { kind: "redirect", origin: "https://warthog.example" }, path);
  }
  for (const host of ["app.warthog.example", "admin.warthog.example", "warthog.example.evil.test", "evil.test", null]) {
    assert.deepEqual(routeForWebsite(host, SITE, "/"), { kind: "elsewhere" }, String(host));
  }
  assert.deepEqual(routeForWebsite("warthog.example", null, "/"), { kind: "elsewhere" }, "no website configured");
});

test("a redirect keeps the path and query on the configured origin and cannot be turned into another host", () => {
  assert.equal(redirectTarget("https://app.warthog.example", "/signin", "?next=%2Fhome").href, "https://app.warthog.example/signin?next=%2Fhome");
  assert.equal(redirectTarget("https://warthog.example", "/", "").href, "https://warthog.example/");
  for (const path of ["//evil.test/x", "/\\evil.test", "/%2F%2Fevil.test", "//evil.test:443@x"]) {
    assert.equal(redirectTarget("https://app.warthog.example", path, "").host, "app.warthog.example", path);
  }
});

test("public links point at the website and the app only when the website has its own host", () => {
  assert.deepEqual(publicLinksFor(SITE), { home: "https://warthog.example/", account: "https://app.warthog.example" });
  assert.deepEqual(publicLinksFor(null), RELATIVE_LINKS);
  assert.deepEqual(RELATIVE_LINKS, { home: "/", account: "" });
});
