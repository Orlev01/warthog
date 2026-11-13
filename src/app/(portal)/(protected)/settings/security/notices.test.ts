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

// Review fix G3 — a step-up refusal is no longer a dead end: the notice asks the screen to
// mount the inline "Confirm it's you" control, and never tells the person to sign out and
// back in.
test("the step-up notice offers the inline confirm instead of sign-out-and-back-in advice", () => {
  const notice = securityNotice("step_up_required");
  assert.equal(notice?.offerConfirm, true);
  assert.doesNotMatch(notice!.text, /sign (out|back in)/i);
  assert.match(notice!.text, /confirm it.s you/i);
  assert.ok(!securityNotice("passkey_removed")?.offerConfirm, "a success notice offers no confirm");
});

// Sign-in audit: removing the authenticator app reuses the server's last_sign_in_method
// reason, renamed for the screen so the copy talks about the app, not a passkey.
test("an authenticator refusal can be renamed to its own notice", () => {
  const rename = { last_sign_in_method: "authenticator_last_sign_in_method" };
  assert.equal(
    noticeLocation("authenticator_removed", { ok: false, reason: "last_sign_in_method" }, rename),
    "/settings/security?notice=authenticator_last_sign_in_method",
  );
  assert.equal(noticeLocation("authenticator_removed", { ok: true }, rename), "/settings/security?notice=authenticator_removed");
  assert.equal(
    noticeLocation("authenticator_removed", { ok: false, reason: "step_up_required" }, rename),
    "/settings/security?notice=step_up_required",
  );
});
