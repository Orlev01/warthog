// Review fix B6 — the validated return path sign-in, sign-up, recovery and new-device
// flows go back to (`src/server/auth/return-path.ts`). An agent connection, an approval
// link or a household invite started while signed out sends the person to
// `/signin?next=<where they were>`; after signing in they must land back there — but a
// `next` that points off-site (an open redirect) or at a script must never be followed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { safeReturnPath, withReturnPath, DEFAULT_RETURN_PATH } from "./return-path";

test("the default return path is /home", () => {
  assert.equal(DEFAULT_RETURN_PATH, "/home");
  assert.equal(safeReturnPath(undefined), "/home");
  assert.equal(safeReturnPath(null), "/home");
  assert.equal(safeReturnPath(""), "/home");
  assert.equal(safeReturnPath(42), "/home");
  assert.equal(safeReturnPath(["/inbox"]), "/home", "only a single string is a path");
});

test("same-site relative paths are kept, with their query", () => {
  for (const path of [
    "/oauth/authorize?client_id=a&state=b&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb",
    "/oauth/consent",
    "/a/AbC123_-tok",
    "/household/join/9f3c",
    "/inbox?approval=123",
    "/home",
  ]) {
    assert.equal(safeReturnPath(path), path, `${path} is kept`);
  }
});

test("anything that could leave the site, run a script or smuggle a header falls back to /home", () => {
  for (const hostile of [
    "//evil.example",
    "//evil.example/path",
    "/\\evil.example",
    "\\\\evil.example",
    "https://evil.example",
    "http:/evil.example",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "evil.example",
    "home",
    "/inbox\r\nSet-Cookie: x=1",
    "/inbox\u0000",
    "/a\\b",
    " /home",
    "/" + "a".repeat(2100),
  ]) {
    assert.equal(safeReturnPath(hostile), "/home", `${JSON.stringify(hostile)} must not be followed`);
  }
});

test("a path that only normalises to a protocol-relative URL falls back to /home", () => {
  // Each passes the raw-string checks, but URL parsing collapses its dot segment and
  // the re-serialised pathname would be `//evil.example` — an off-site redirect.
  for (const hostile of [
    "/.//evil.example",
    "/..//evil.example",
    "/%2e//evil.example",
    "/%2E%2E//evil.example",
    "/a/..//evil.example",
    "/a/b/../..//evil.example/path?x=1",
  ]) {
    assert.equal(safeReturnPath(hostile), "/home", `${JSON.stringify(hostile)} must not be followed`);
  }
  assert.equal(safeReturnPath("/a/../inbox"), "/inbox", "a dot segment that stays on-site is kept, normalised");
});

test("a return path back into the auth screens themselves falls back to /home (no loops)", () => {
  for (const loop of ["/signin", "/signin?next=%2Finbox", "/signup", "/recover", "/device", "/signin/"]) {
    assert.equal(safeReturnPath(loop), "/home", `${loop} is not a destination`);
  }
});

test("withReturnPath carries a non-default return path onto an auth link, and leaves the default off", () => {
  assert.equal(withReturnPath("/signup", "/home"), "/signup");
  assert.equal(withReturnPath("/signup", undefined), "/signup");
  assert.equal(
    withReturnPath("/recover", "/oauth/authorize?client_id=a&state=b"),
    "/recover?next=%2Foauth%2Fauthorize%3Fclient_id%3Da%26state%3Db",
  );
  assert.equal(withReturnPath("/device", "//evil.example"), "/device", "an unsafe value is dropped");
});
