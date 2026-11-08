// Review fix (F2 follow-through): /oauth/token and /oauth/revoke are unauthenticated, so
// their form bodies are read under a streaming size cap instead of `request.text()`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { OAUTH_FORM_MAX_BYTES, readOAuthForm } from "./form";

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://warthog.com.au/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
  });
}

test("a form body within the cap parses into params", async () => {
  const result = await readOAuthForm(post("grant_type=authorization_code&code=abc"));
  assert.ok(result instanceof URLSearchParams);
  assert.equal(result.get("grant_type"), "authorization_code");
  assert.equal(result.get("code"), "abc");
});

test("a body over the cap is a 413 with no-store, whatever Content-Length claims", async () => {
  const big = `code=${"x".repeat(OAUTH_FORM_MAX_BYTES + 1)}`;
  for (const req of [post(big), post(big, { "content-length": "10" })]) {
    const result = await readOAuthForm(req);
    assert.ok(result instanceof Response, "refused, not parsed");
    assert.equal(result.status, 413);
    assert.equal(result.headers.get("cache-control"), "no-store");
  }
});
