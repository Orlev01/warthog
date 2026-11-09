import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

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
