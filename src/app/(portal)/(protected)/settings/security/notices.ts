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

// `offerConfirm` asks the screen to mount the inline "Confirm it's you" control under the
// notice (review fix G3), so a step-up refusal is never a dead end.
export type SecurityNotice = { tone: "done" | "problem"; text: string; offerConfirm?: boolean };

const NOTICES: Record<string, SecurityNotice> = {
  passkey_removed: { tone: "done", text: "Passkey removed." },
  session_signed_out: { tone: "done", text: "Signed out of that device." },
  step_up_required: {
    tone: "problem",
    text: "Nothing was changed. For your security, this needs a fresh confirmation that it's you. Choose “Confirm it's you” below, then make the change again.",
    offerConfirm: true,
  },
  not_found: { tone: "problem", text: "Nothing was changed: that item is no longer on your account." },
  invalid_request: { tone: "problem", text: "Nothing was changed: that request wasn't valid. Please try again." },
};

// The copy for a notice code, or null for an absent or unknown code.
export function securityNotice(code: string | undefined): SecurityNotice | null {
  return (code !== undefined && Object.hasOwn(NOTICES, code) && NOTICES[code]) || null;
}
