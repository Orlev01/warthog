// E08-S10 — Activity screen outcome notices (`src/app/(portal)/(protected)/activity/notices.ts`).
//
// The /activity page's Dispute and Undo controls post inline `use server` wrappers that
// re-derive the session, call disputeEntry / undoEntry, and redirect back with a
// `?notice=` code the page turns into plain words — exactly the sibling SECURITY screen's
// pattern (`settings/security/notices.ts`). A server action never fails silently (design
// §server-composition-roots; constitution "No dead controls / never fail silently"): its
// result — success, a refusal, or a malformed request rejected at the validation boundary
// — becomes a notice code, and the screen renders that code's plain-words copy. Unknown
// codes render nothing, so the query string can never inject copy onto the screen.

import { HttpError } from "@/server/http/validate";

const SCREEN = "/activity";

// A finished action's outcome: a success, a reported refusal naming a STABLE reason code
// (never a passed-through sentence), or a thrown error. disputeEntry / undoEntry translate
// their sub-services' English reasons into the stable codes this module knows.
type ActionOutcome = { ok: true } | { ok: false; reason: string };

// Where a finished server action sends the person: back to the screen with the success
// code on `{ ok: true }`, the refusal's reason code on `{ ok: false, reason }`, or
// `invalid_request` for a 4xx boundary `HttpError`. Anything else is a genuine server
// fault and is RE-THROWN, never dressed up as a notice.
export function noticeLocation(successCode: string, outcome: ActionOutcome | unknown): string {
  if (outcome instanceof HttpError) return `${SCREEN}?notice=invalid_request`;
  if (outcome instanceof Error) throw outcome;
  const result = outcome as ActionOutcome;
  const code = result.ok ? successCode : result.reason;
  return `${SCREEN}?notice=${encodeURIComponent(code)}`;
}

export type ActivityNotice = { tone: "done" | "problem" | "waiting"; text: string; action?: { href: string; label: string } };

// The plain-words copy (and tone) for every code a finished wrapper can emit: the two
// success codes, the boundary's invalid_request, and the stable refusal codes
// disputeEntry / undoEntry report. Plain Australian English, no protocol jargon.
const NOTICES: Record<string, ActivityNotice> = {
  dispute_filed: { tone: "done", text: "Your dispute has been recorded against that activity." },
  undo_done: { tone: "done", text: "That action has been undone." },
  undo_pending: { tone: "waiting", text: "Undo is waiting for your approval. The action has not been undone.",
    action: { href: "/inbox", label: "Review approval" } },
  undo_failed: { tone: "problem", text: "The service couldn't complete the undo. Check the activity and service before trying again." },
  dispute_refused: { tone: "problem", text: "That activity entry can't be disputed." },
  undo_refused: { tone: "problem", text: "That action couldn't be undone." },
  invalid_request: { tone: "problem", text: "Nothing was changed: that request wasn't valid. Please try again." },
};

// The copy for a notice code, or null for an absent or unknown code (so a crafted
// `?notice=` value can never inject copy onto the screen).
export function activityNotice(code: string | undefined): ActivityNotice | null {
  return (code !== undefined && Object.hasOwn(NOTICES, code) && NOTICES[code]) || null;
}
