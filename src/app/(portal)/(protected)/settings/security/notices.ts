// Outcome notices for the security screen (operator fix for the E04-S15 review veto). A server
// action never fails silently: its result — success, a refusal, or a malformed request rejected
// at the validation boundary — becomes a `?notice=` code on the redirect back to the screen, and
// the screen renders that code's plain-words copy. Unknown codes render nothing, so the query
// string can never inject copy.

import { HttpError } from "../../../../../server/http/validate";
import type { ActionResult } from "./actions";

const SCREEN = "/settings/security";

// Where a finished server action sends the person: back to the screen with the success code,
// the refusal's reason, or `invalid_request` for a boundary 4xx. Anything else is a genuine
// server fault and is rethrown, never dressed up as a notice.
export function noticeLocation(successCode: string, outcome: ActionResult | unknown): string {
  if (outcome instanceof HttpError) return `${SCREEN}?notice=invalid_request`;
  if (outcome instanceof Error) throw outcome;
  const result = outcome as ActionResult;
  const code = result.ok ? successCode : result.reason;
  return `${SCREEN}?notice=${encodeURIComponent(code)}`;
}

// `offerConfirm` asks the screen to mount the inline "Confirm it's you" control with this
// text as its explanation (review fix G3), so a step-up refusal is never a dead end and the
// refusal clears itself once confirmed.
export type SecurityNotice = { tone: "done" | "problem"; text: string; offerConfirm?: boolean };

const NOTICES: Record<string, SecurityNotice> = {
  passkey_removed: { tone: "done", text: "Passkey removed." },
  authenticator_added: {
    tone: "done",
    text: "Your authenticator app is set up. You can now sign in with your email and a code from the app, and use a code to confirm it's you.",
  },
  // Follow-up S2: the server kept the account's last sign-in method.
  last_sign_in_method: {
    tone: "problem",
    text: "Nothing was changed: this passkey is the only way you can sign in. Add another passkey or set up an authenticator app first, then remove it.",
  },
  session_signed_out: { tone: "done", text: "Signed out of that device." },
  step_up_required: {
    tone: "problem",
    text: "Nothing was changed. For your security, confirm it's you first, then make the change again.",
    offerConfirm: true,
  },
  not_found: { tone: "problem", text: "Nothing was changed: that item is no longer on your account." },
  invalid_request: { tone: "problem", text: "Nothing was changed: that request wasn't valid. Please try again." },
};

// The copy for a notice code, or null for an absent or unknown code.
export function securityNotice(code: string | undefined): SecurityNotice | null {
  return (code !== undefined && Object.hasOwn(NOTICES, code) && NOTICES[code]) || null;
}
