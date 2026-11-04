// Operator fix (E04-S15 review veto): the security screen must never fail silently. Every
// server action's outcome — success, a refusal (e.g. step-up required) or a malformed request —
// becomes a notice the screen shows in plain words.
import { test } from "node:test";
import assert from "node:assert/strict";

import { HttpError } from "../../../../../server/http/validate";
import { noticeLocation, securityNotice } from "./notices";

test("a successful change redirects back with its done notice", () => {
  assert.equal(noticeLocation("passkey_removed", { ok: true }), "/settings/security?notice=passkey_removed");
  assert.equal(noticeLocation("session_signed_out", { ok: true }), "/settings/security?notice=session_signed_out");
});

test("a refusal redirects back naming its reason, never as a success", () => {
  assert.equal(
    noticeLocation("passkey_removed", { ok: false, reason: "step_up_required" }),
    "/settings/security?notice=step_up_required",
  );
  assert.equal(
    noticeLocation("session_signed_out", { ok: false, reason: "not_found" }),
    "/settings/security?notice=not_found",
  );
});

test("a malformed request (the boundary's HttpError) redirects with invalid_request; other errors still throw", () => {
  assert.equal(noticeLocation("passkey_removed", new HttpError(400, "bad id")), "/settings/security?notice=invalid_request");
  assert.throws(() => noticeLocation("passkey_removed", new Error("db down")), /db down/);
});

test("every notice has plain copy; unknown or absent codes show nothing", () => {
  for (const code of ["passkey_removed", "session_signed_out", "step_up_required", "not_found", "invalid_request"]) {
    const notice = securityNotice(code);
    assert.ok(notice && notice.text.length > 0, `copy for ${code}`);
    assert.doesNotMatch(notice.text, /step[_-]?up|token|session id|HttpError/i, `no jargon in ${code}`);
  }
  assert.equal(securityNotice("step_up_required")?.tone, "problem");
  assert.equal(securityNotice("passkey_removed")?.tone, "done");
  assert.equal(securityNotice(undefined), null);
  assert.equal(securityNotice("<script>"), null);
});
