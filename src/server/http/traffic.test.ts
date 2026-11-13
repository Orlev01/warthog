// Traffic counting (src/server/http/traffic.ts; docs/design/admin-portal.md §4): routes are
// classified from a fixed prefix table (never stored as paths), navigations are told from
// other requests, the counter accumulates and drains, and the flush writes one guarded
// metric per label — nothing when there is nothing.
import { test } from "node:test";
import assert from "node:assert/strict";

import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import { queryMetrics } from "../db/metrics";
import { classifyRoute, createTrafficCounter, flushTraffic, requestKind } from "./traffic";
import { ADMIN_PREFIX } from "./admin-routing";

test("route classes come from path prefixes at segment boundaries, never the path", () => {
  const cases: Record<string, string> = {
    "/": "public", "/help": "public", "/help/compatibility": "public", "/privacy": "public", "/terms": "public",
    "/signin": "auth", "/signup": "auth", "/recover": "auth", "/reset/setup": "auth", "/device": "auth", "/api/auth/signin/begin": "auth",
    "/home": "portal", "/agents/abc": "portal", "/settings/security": "portal", "/a/token": "portal", "/household/join/x": "portal", "/life-admin": "portal",
    "/api/receipts/1": "api", "/api/vault/unlock-method": "api", "/api/data/import": "api",
    "/mcp": "mcp", "/.well-known/oauth-authorization-server": "mcp",
    "/oauth/authorize": "oauth", "/oauth/token": "oauth", "/connect/callback": "oauth",
    [ADMIN_PREFIX]: "admin", [`${ADMIN_PREFIX}/handoff`]: "admin", "/admin": "other", "/admin/usage": "other",
    "/api/health": "health", "/api/health/live": "health",
    "/dev/outbox": "other", "/homework": "other", "/signinx": "other", "/apis": "other",
  };
  for (const [path, expected] of Object.entries(cases)) assert.equal(classifyRoute(path), expected, path);
});

test("a document navigation is told from other requests and from a rate-limited refusal", () => {
  assert.equal(requestKind(new Headers({ "sec-fetch-dest": "document" }), false), "document");
  assert.equal(requestKind(new Headers({ "sec-fetch-mode": "navigate" }), false), "document");
  assert.equal(requestKind(new Headers({ "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" }), false), "fetch");
  assert.equal(requestKind(new Headers(), false), "fetch");
  assert.equal(requestKind(new Headers({ "sec-fetch-dest": "document" }), true), "limited");
});

test("the counter accumulates per label and drains to zero", () => {
  const counter = createTrafficCounter();
  counter.count("app", "portal", "document");
  counter.count("app", "portal", "document");
  counter.count("admin", "admin", "fetch");
  assert.deepEqual(counter.drain(), [{ label: "app.portal.document", count: 2 }, { label: "admin.admin.fetch", count: 1 }]);
  assert.deepEqual(counter.drain(), [], "drained");
});

test("flushing records one http.requests event per label with the count as its value, and nothing when empty", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(new Date("2026-11-13T01:02:03Z"));
    const counter = createTrafficCounter();
    assert.equal(await flushTraffic(db, clock, counter), 0);
    counter.count("app", "public", "document");
    counter.count("app", "public", "document");
    counter.count("app", "auth", "limited");
    assert.equal(await flushTraffic(db, clock, counter), 2);
    const events = await queryMetrics(db, { name: "http.requests", from: "2026-11-13T00:00:00Z", to: "2026-11-14T00:00:00Z" });
    assert.deepEqual(events.map((e) => [e.outcome, e.value, e.recordedAt]), [
      ["app.public.document", 2, "2026-11-13T01:02:03.000Z"],
      ["app.auth.limited", 1, "2026-11-13T01:02:03.000Z"],
    ]);
    assert.equal(await flushTraffic(db, clock, counter), 0, "the flush reset the counter");
  } finally {
    await db.close();
  }
});
