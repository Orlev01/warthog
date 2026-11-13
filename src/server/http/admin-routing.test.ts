// The host routing matrix (src/server/http/admin-routing.ts; docs/design/admin-portal.md §1).
import { test } from "node:test";
import assert from "node:assert/strict";

import { ADMIN_PREFIX, APP_HANDOFF_PATH, routeForHost } from "./admin-routing";

const ADMIN = "admin.example.test";
const P = ADMIN_PREFIX;

test("the portal's internal prefix is not a word anyone would guess, and /admin is not it", () => {
  assert.match(P, /^\/[a-z0-9-]{12,}$/);
  assert.doesNotMatch(P, /admin|portal|console|dashboard/i);
  assert.equal(APP_HANDOFF_PATH, `${P}/handoff`);
});

test("on the admin host every page path is rewritten under the internal prefix, including the root and the exchange route", () => {
  assert.deepEqual(routeForHost(ADMIN, ADMIN, "/"), { kind: "admin", rewriteTo: P });
  assert.deepEqual(routeForHost(ADMIN, ADMIN, "/usage"), { kind: "admin", rewriteTo: `${P}/usage` });
  assert.deepEqual(routeForHost(ADMIN, ADMIN, "/session"), { kind: "admin", rewriteTo: `${P}/session` });
  assert.deepEqual(routeForHost(ADMIN, ADMIN, "/signout"), { kind: "admin", rewriteTo: `${P}/signout` });
  assert.deepEqual(routeForHost(ADMIN, ADMIN, "/signin"), { kind: "admin", rewriteTo: `${P}/signin` });
  // The member app, auth, OAuth, MCP and dev routes land under the prefix where nothing serves them.
  for (const path of ["/home", "/api/auth/signin/begin", "/oauth/authorize", "/mcp", "/.well-known/oauth-authorization-server", "/dev/outbox", "/connect/callback", "/a/token", "/api/health", "/admin"]) {
    assert.deepEqual(routeForHost(ADMIN, ADMIN, path), { kind: "admin", rewriteTo: `${P}${path}` }, path);
  }
});

test("on the admin host assets pass through and an explicit internal-prefix path is refused", () => {
  for (const path of ["/_next/static/chunk.js", "/icons/icon-192.png", "/brands/gmail.svg", "/brand/warthog-logo.png", "/fonts/inter/latin.woff2", "/favicon.ico", "/manifest.webmanifest", "/sw.js", "/robots.txt"]) {
    assert.deepEqual(routeForHost(ADMIN, ADMIN, path), { kind: "passthrough" }, path);
  }
  assert.deepEqual(routeForHost(ADMIN, ADMIN, P), { kind: "not-found" });
  assert.deepEqual(routeForHost(ADMIN, ADMIN, `${P}/usage`), { kind: "not-found" });
  assert.deepEqual(routeForHost(ADMIN, ADMIN, `${P}x`), { kind: "admin", rewriteTo: `${P}${P}x` }, "a lookalike is not the prefix");
});

test("on the app host /admin is simply a page the app does not have; the portal's internal paths are refused except the handoff", () => {
  for (const [host, admin] of [["app.example.test", ADMIN], ["evil.example.test", ADMIN], [ADMIN, null], [null, ADMIN]] as const) {
    for (const path of ["/admin", "/admin/usage", "/handoff", "/home", "/", "/administer"]) {
      assert.deepEqual(routeForHost(host, admin, path), { kind: "app" }, `${host} ${admin} ${path}`);
    }
    assert.deepEqual(routeForHost(host, admin, APP_HANDOFF_PATH), { kind: "app" }, "the handoff is served on the app host");
    for (const path of [P, `${P}/usage`, `${P}/session`, `${P}/signin`]) {
      assert.deepEqual(routeForHost(host, admin, path), { kind: "not-found" }, `${host} ${admin} ${path}`);
    }
  }
});
