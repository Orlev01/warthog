// The host routing matrix (src/server/http/admin-routing.ts; docs/design/admin-portal.md §1).
import { test } from "node:test";
import assert from "node:assert/strict";

import { routeForHost } from "./admin-routing";

const ADMIN = "admin.example.test";

test("on the admin host every page path is rewritten under /admin, including the root and the exchange route", () => {
  assert.deepEqual(routeForHost(ADMIN, ADMIN, "/"), { kind: "admin", rewriteTo: "/admin" });
  assert.deepEqual(routeForHost(ADMIN, ADMIN, "/usage"), { kind: "admin", rewriteTo: "/admin/usage" });
  assert.deepEqual(routeForHost(ADMIN, ADMIN, "/session"), { kind: "admin", rewriteTo: "/admin/session" });
  assert.deepEqual(routeForHost(ADMIN, ADMIN, "/signout"), { kind: "admin", rewriteTo: "/admin/signout" });
  // The member app, auth, OAuth, MCP and dev routes land under /admin/… where nothing serves them.
  for (const path of ["/home", "/signin", "/api/auth/signin/begin", "/oauth/authorize", "/mcp", "/.well-known/oauth-authorization-server", "/dev/outbox", "/connect/callback", "/a/token", "/api/health"]) {
    assert.deepEqual(routeForHost(ADMIN, ADMIN, path), { kind: "admin", rewriteTo: `/admin${path}` }, path);
  }
});

test("on the admin host assets pass through and an explicit /admin path is refused", () => {
  for (const path of ["/_next/static/chunk.js", "/icons/icon-192.png", "/brands/gmail.svg", "/brand/warthog-logo.png", "/fonts/inter/latin.woff2", "/favicon.ico", "/manifest.webmanifest", "/sw.js", "/robots.txt"]) {
    assert.deepEqual(routeForHost(ADMIN, ADMIN, path), { kind: "passthrough" }, path);
  }
  assert.deepEqual(routeForHost(ADMIN, ADMIN, "/admin"), { kind: "not-found" });
  assert.deepEqual(routeForHost(ADMIN, ADMIN, "/admin/usage"), { kind: "not-found" });
  assert.deepEqual(routeForHost(ADMIN, ADMIN, "/administer"), { kind: "admin", rewriteTo: "/admin/administer" }, "a lookalike is not the prefix");
});

test("on the app host, an unknown host, or with no admin host configured, /admin is an ordinary unknown page and the app is unchanged", () => {
  for (const [host, admin] of [["app.example.test", ADMIN], ["evil.example.test", ADMIN], [ADMIN, null], [null, ADMIN]] as const) {
    assert.deepEqual(routeForHost(host, admin, "/admin"), { kind: "unknown-page" }, `${host} ${admin}`);
    assert.deepEqual(routeForHost(host, admin, "/admin/session?handoff=x".split("?")[0]!), { kind: "unknown-page" });
    assert.deepEqual(routeForHost(host, admin, "/home"), { kind: "app" });
    assert.deepEqual(routeForHost(host, admin, "/"), { kind: "app" });
    assert.deepEqual(routeForHost(host, admin, "/administer"), { kind: "app" });
  }
});
