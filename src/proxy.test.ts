import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { proxy as middleware } from "./proxy";
import { ADMIN_PREFIX as P, APP_HANDOFF_PATH } from "./server/http/admin-routing";

test("middleware replaces supplied nonces and gives Next and the browser the same fresh policy", () => {
  const saved = process.env.NODE_ENV;
  try {
    (process.env as Record<string, string>).NODE_ENV = "production";
    const request = () => new NextRequest("https://app.example.test/signin", { headers: {
      "x-nonce": "attacker", "content-security-policy": "script-src 'unsafe-inline'",
    } });
    const a = middleware(request()), b = middleware(request());
    const policy = a.headers.get("content-security-policy")!;
    assert.match(policy, /nonce-[A-Za-z0-9+/]{32}/);
    assert.ok(!policy.includes("attacker") && !policy.includes("unsafe-eval"));
    assert.equal(a.headers.get("x-middleware-request-content-security-policy"), policy);
    assert.ok(policy.includes(`'nonce-${a.headers.get("x-middleware-request-x-nonce")}'`));
    assert.notEqual(b.headers.get("content-security-policy"), policy);
    assert.equal(a.headers.get("cache-control"), "private, no-store");
  } finally {
    if (saved === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
    else (process.env as Record<string, string>).NODE_ENV = saved;
  }
});


test("oversized declared multipart uploads receive 413 before framework actions", async () => {
  for (const path of ["/life-admin", "/settings/data"]) {
    for (const size of [26 * 1024 * 1024, 26 * 1024 * 1024 + 1]) {
      const response = middleware(new NextRequest("https://app.example.test" + path, {
        method: "POST", headers: { "content-type": "multipart/form-data; boundary=synthetic", "content-length": String(size) },
      }));
      assert.equal(response.status, size > 26 * 1024 * 1024 ? 413 : 200);
      if (response.status === 413) assert.match((await response.json()).error, /too large/i);
    }
  }
});

// --- Admin host routing (docs/design/admin-portal.md §1) -----------------------------------
import { ADMIN_PATH_HEADER } from "./proxy";
import { getTrafficCounter } from "./server/http/traffic";

function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete (process.env as Record<string, string | undefined>)[key];
    else (process.env as Record<string, string>)[key] = env[key]!;
  }
  try {
    return run();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete (process.env as Record<string, string | undefined>)[key];
      else (process.env as Record<string, string>)[key] = saved[key]!;
    }
  }
}

const PROD = { NODE_ENV: "production", PUBLIC_BASE_URL: "https://app.example.test", ADMIN_BASE_URL: undefined };

test("on the admin host pages are rewritten under the internal prefix with the original path forwarded, noindex and the same CSP discipline", () => {
  withEnv(PROD, () => {
    for (const [path, target] of [["/", P], ["/usage?range=30d", `${P}/usage?range=30d`], ["/session?handoff=abc", `${P}/session?handoff=abc`]]) {
      const response = middleware(new NextRequest(`https://admin.example.test${path}`, { headers: { host: "admin.example.test" } }));
      assert.equal(response.status, 200, path);
      assert.equal(new URL(response.headers.get("x-middleware-rewrite")!).pathname + new URL(response.headers.get("x-middleware-rewrite")!).search, target, path);
      assert.equal(response.headers.get("x-middleware-request-" + ADMIN_PATH_HEADER), path!.split("?")[0]);
      assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
      assert.match(response.headers.get("content-security-policy")!, /nonce-/);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
    // The ingress's forwarded host wins over a differing Host header.
    const forwarded = middleware(new NextRequest("https://app.example.test/usage", { headers: { host: "app.example.test", "x-forwarded-host": "admin.example.test" } }));
    assert.equal(new URL(forwarded.headers.get("x-middleware-rewrite")!).pathname, `${P}/usage`);
  });
});

test("the member app, auth, OAuth, MCP and dev routes do not exist on the admin host; assets pass through; the prefix itself is refused", () => {
  withEnv(PROD, () => {
    for (const path of ["/home", "/api/auth/signin/begin", "/oauth/authorize", "/mcp", "/.well-known/oauth-protected-resource", "/dev/outbox"]) {
      const response = middleware(new NextRequest(`https://admin.example.test${path}`, { headers: { host: "admin.example.test" } }));
      assert.equal(new URL(response.headers.get("x-middleware-rewrite")!).pathname, `${P}${path}`, `${path} lands where nothing serves it`);
    }
    const asset = middleware(new NextRequest("https://admin.example.test/brands/gmail.svg", { headers: { host: "admin.example.test" } }));
    assert.equal(asset.headers.get("x-middleware-rewrite"), null);
    assert.equal(asset.status, 200);
    for (const path of [P, `${P}/usage`]) {
      const refused = middleware(new NextRequest(`https://admin.example.test${path}`, { headers: { host: "admin.example.test" } }));
      assert.equal(refused.status, 404, path);
      assert.equal(refused.headers.get("cache-control"), "no-store");
    }
  });
});

test("on the app host /admin is an ordinary path with nothing to tell it apart; the internal prefix is refused except the handoff", () => {
  withEnv(PROD, () => {
    for (const path of ["/admin", "/admin/usage", "/handoff", "/home", APP_HANDOFF_PATH]) {
      // Passed to Next unchanged: no rewrite, no portal header, the app's own CSP and caching.
      const response = middleware(new NextRequest(`https://app.example.test${path}`, { headers: { host: "app.example.test" } }));
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("x-middleware-rewrite"), null, path);
      assert.equal(response.headers.get("x-robots-tag"), null, path);
      assert.equal(response.headers.get("x-middleware-request-x-admin-pathname"), null, path);
      assert.match(response.headers.get("content-security-policy")!, /nonce-/);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
    }
    for (const path of [P, `${P}/usage`, `${P}/session?handoff=x`]) {
      assert.equal(middleware(new NextRequest(`https://app.example.test${path}`, { headers: { host: "app.example.test" } })).status, 404, path);
    }
  });
  withEnv({ NODE_ENV: "production", PUBLIC_BASE_URL: undefined, ADMIN_BASE_URL: undefined }, () => {
    assert.equal(middleware(new NextRequest("https://admin.example.test/usage", { headers: { host: "admin.example.test" } })).headers.get("x-middleware-rewrite"), null);
    assert.equal(middleware(new NextRequest("https://app.example.test/admin", { headers: { host: "app.example.test" } })).headers.get("x-middleware-rewrite"), null);
    assert.equal(middleware(new NextRequest(`https://app.example.test${P}/usage`, { headers: { host: "app.example.test" } })).status, 404);
  });
});

test("the handoff exchange shares the auth limiter and every request is counted by host and route class only", () => {
  withEnv(PROD, () => {
    getTrafficCounter().drain();
    const exchange = () => middleware(new NextRequest("https://admin.example.test/session?handoff=x", { headers: { host: "admin.example.test", "x-forwarded-for": "203.0.113.77", "sec-fetch-dest": "document" } }));
    let limited = 0;
    for (let i = 0; i < 70; i++) if (exchange().status === 429) limited++;
    assert.ok(limited > 0, "a flood of exchanges is refused");
    middleware(new NextRequest("https://app.example.test/home", { headers: { host: "app.example.test", "sec-fetch-dest": "document" } }));
    middleware(new NextRequest(`https://app.example.test${P}/usage`, { headers: { host: "app.example.test" } }));
    const drained = Object.fromEntries(getTrafficCounter().drain().map((e) => [e.label, e.count]));
    assert.equal(drained["admin.admin.document"] + drained["admin.admin.limited"], 70);
    assert.equal(drained["admin.admin.limited"], limited);
    assert.equal(drained["app.portal.document"], 1);
    assert.equal(drained["app.admin.fetch"], 1);
    assert.ok(!Object.keys(drained).some((label) => label.includes("handoff") || label.includes("203.0")), "no path, query or address in a label");
  });
});
