// Settings › Security › Sign-in requests (follow-up S3; docs/adr/security-followups-2026-11.md)
// — the testable seam the thin `page.tsx` and its server actions compose.
//
// A new device signing in with "Approve from another device" leaves a pending request (the
// new-device module, process memory, ten minutes). This screen lists the signed-in member's
// OWN waiting requests and answers them:
//   • approve — needs a fresh "confirm it's you"; marks the request approved so the new device
//     can collect its session. The approver is handed nothing to sign in with.
//   • deny    — discards the request; the new device can no longer collect it.
// Every method takes the verified Session and scopes by `session.userId` (never a client
// value). The id handed back from the page is the request's APPROVAL id: it is validated here
// before it reaches the store, and it is never the new device's collection handle.

import {
  approveDeviceSignInRequest,
  denyDeviceSignInRequest,
  listDeviceSignInRequests,
  type DeviceSignInRequest,
} from "../../../../../../server/auth/new-device";
import type { Session } from "../../../../../../server/auth/session";
import type { Clock } from "../../../../../../server/seams/clock";
import type { Db } from "../../../../../../server/db/index";

export type SignInRequestResult = { ok: true } | { ok: false; reason: string };

export interface SignInRequestActions {
  load(session: Session): DeviceSignInRequest[];
  // Which ways the member can "confirm it's you" (enrolment metadata only, never a secret).
  factors(session: Session): Promise<{ passkey: boolean; authenticator: boolean }>;
  approve(session: Session, approvalId: string): Promise<SignInRequestResult>;
  deny(session: Session, approvalId: string): SignInRequestResult;
}

// An approval id is 16 random bytes in hex. Anything else (including a 64-character
// collection handle) is refused before it is looked up.
const APPROVAL_ID = /^[0-9a-f]{32}$/;

export function createSignInRequestActions(deps: { db: Db; clock: Clock }): SignInRequestActions {
  const { db, clock } = deps;
  return {
    load: (session) => listDeviceSignInRequests(session, { clock }),
    async factors(session) {
      const result = await db.query(
        `SELECT EXISTS (SELECT 1 FROM passkeys WHERE user_id = $1) AS passkey,
                EXISTS (SELECT 1 FROM totp_secrets WHERE user_id = $1) AS authenticator`,
        [session.userId],
      );
      const row = result.rows[0];
      return { passkey: row?.passkey === true, authenticator: row?.authenticator === true };
    },
    async approve(session, approvalId) {
      if (!APPROVAL_ID.test(approvalId)) return { ok: false, reason: "invalid_request" };
      return approveDeviceSignInRequest({ approvalId, approvingSession: session }, { clock });
    },
    deny(session, approvalId) {
      if (!APPROVAL_ID.test(approvalId)) return { ok: false, reason: "invalid_request" };
      return denyDeviceSignInRequest({ approvalId, session }, { clock });
    },
  };
}

// The screen's outcome notices (the `?notice=` pattern of the Security screen): a finished
// answer reloads the screen with one of these codes. Unknown codes render nothing, so the
// query string can never inject copy.
export type SignInRequestNotice = { tone: "done" | "problem"; text: string };

const NOTICES: Record<string, SignInRequestNotice> = {
  approved: {
    tone: "done",
    text: "Approved. Your other device will finish signing in within a few seconds. Nothing changed on this device.",
  },
  denied: { tone: "done", text: "Request denied. That device can't sign in with it." },
  not_found: { tone: "problem", text: "That request has expired or was already answered. Nothing was changed." },
  invalid_request: { tone: "problem", text: "Nothing was changed: that request wasn't valid. Please try again." },
};

export function signInRequestNotice(code: string | undefined): SignInRequestNotice | null {
  return (code !== undefined && Object.hasOwn(NOTICES, code) && NOTICES[code]) || null;
}
