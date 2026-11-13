// The admin origin is derived from the public base URL (docs/design/admin-portal.md §1):
// `app.` becomes `admin.`, anything else gains an `admin.` label; scheme and port carry
// over. Request-host resolution prefers the ingress's x-forwarded-host and compares by
// hostname alone, case-insensitively, ignoring a port.
import { test } from "node:test";
import assert from "node:assert/strict";

import { adminOriginFor, hostnameOf, requestHostname } from "./origin";

test("app.<domain> becomes admin.<domain>; other hosts gain an admin. label; scheme and port carry over", () => {
  assert.equal(adminOriginFor("https://app.warthog.com.au"), "https://admin.warthog.com.au");
  assert.equal(adminOriginFor("https://app.warthog.com.au/"), "https://admin.warthog.com.au");
  assert.equal(adminOriginFor("http://localhost:3000"), "http://admin.localhost:3000");
  assert.equal(adminOriginFor("https://warthog.example.test"), "https://admin.warthog.example.test");
  assert.equal(adminOriginFor("https://App.Warthog.com.au"), "https://admin.warthog.com.au");
});

test("an invalid public base URL derives nothing rather than throwing", () => {
  assert.equal(adminOriginFor("not a url"), null);
  assert.equal(adminOriginFor(""), null);
});

test("hostnames compare without scheme, port or case", () => {
  assert.equal(hostnameOf("https://admin.warthog.com.au"), "admin.warthog.com.au");
  assert.equal(hostnameOf("http://Admin.Localhost:3000"), "admin.localhost");
  assert.equal(hostnameOf("garbage"), null);
});

test("the request host comes from x-forwarded-host first, then host, lower-cased with the port stripped", () => {
  assert.equal(requestHostname(new Headers({ host: "APP.warthog.com.au:443" })), "app.warthog.com.au");
  assert.equal(requestHostname(new Headers({ host: "app.warthog.com.au", "x-forwarded-host": "Admin.Warthog.com.au" })), "admin.warthog.com.au");
  assert.equal(requestHostname(new Headers({ "x-forwarded-host": "admin.warthog.com.au, proxy.internal" })), "admin.warthog.com.au");
  assert.equal(requestHostname(new Headers({ host: "[::1]:3000" })), "[::1]");
  assert.equal(requestHostname(new Headers()), null);
});
