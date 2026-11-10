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
