import { test } from "node:test";
import assert from "node:assert/strict";
import { contentSecurityPolicy, createAuthIpLimiter, ingressClientIp } from "./production-policy";

test("authentication IP limits use the last trusted ingress hop, ignore spoofed prefixes and bound memory", () => {
  assert.equal(ingressClientIp("1.2.3.4, 203.0.113.8"), "203.0.113.8");
  assert.equal(ingressClientIp("bad, [2001:db8::1]:1234"), "2001:db8::1");
  assert.equal(ingressClientIp("not-an-ip"), "unknown");
  const limiter = createAuthIpLimiter({ requests: 2, windowMs: 60_000, maxClients: 2 });
  assert.equal(limiter.allow("1.2.3.4, 203.0.113.8", 1000), true);
  assert.equal(limiter.allow("5.6.7.8, 203.0.113.8", 1001), true);
  assert.equal(limiter.allow("9.0.1.2, 203.0.113.8", 1002), false);
  assert.equal(limiter.allow("203.0.113.9", 1003), true);
  assert.equal(limiter.allow("203.0.113.10", 1004), false);
  assert.equal(limiter.allow("203.0.113.10", 61_005), true);
});

test("production script policy requires an unpredictable request nonce, while retaining the fetch and frame restrictions", () => {
  const csp = contentSecurityPolicy("request-nonce", false);
  assert.match(csp, /script-src 'self' 'nonce-request-nonce'/);
  assert.ok(!csp.split(";").find((x) => x.includes("script-src"))!.includes("unsafe-inline"));
  assert.ok(!csp.includes("unsafe-eval"));
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(contentSecurityPolicy("request-nonce", true), /unsafe-eval/);
});
