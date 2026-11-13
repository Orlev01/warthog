import { test } from "node:test";
import assert from "node:assert/strict";

import { APP_HANDOFF_PATH } from "../http/admin-routing";
import { safeReturnPath } from "../auth/return-path";
import { handoffSignInUrl } from "./entry";

test("the admin host's sign-in link goes through the app's ordinary sign-in and back to the handoff", () => {
  const url = new URL(handoffSignInUrl("https://app.example.test"));
  assert.equal(url.origin + url.pathname, "https://app.example.test/signin");
  assert.equal(url.searchParams.get("next"), APP_HANDOFF_PATH);
  assert.equal(safeReturnPath(url.searchParams.get("next")), APP_HANDOFF_PATH, "sign-in accepts it as a return path");
  assert.doesNotMatch(url.href, /admin/i, "the link names no admin anything");
});
