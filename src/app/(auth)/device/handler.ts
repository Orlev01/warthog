// E04-S31 — New-device sign-in handler (the injectable seam the thin `actions.ts` /
// route verbs wrap). The new-device module exists but nothing serves it, so a person
// cannot add a device by approving it from one they already use. This handler is that
// front door for the approval handshake (design §5: "New-device sign-in: … approval
// from a signed-in device via push + step-up"; §18 "Approvals only inside the signed-in
// app").
//
// The handshake is three steps, each its own request:
//   • requestApproval — the NEW device: { email, code, deviceLabel }. Verifies the email
//     one-time code (the first factor), records a pending request and sends ONE approval
//     push naming the device, returning 200 { requestId } — the requesting device's own
//     collection handle. No session is minted.
//   • approve — an EXISTING signed-in device: { requestId }. The approver's identity comes
//     ONLY from the `__Host-wh_session` cookie (member-scoped: the userId is the session's,
//     never a client value). Accepted only when that session passes a fresh step-up AND the
//     request belongs to the approver's OWN account; marks the request approved and returns
//     NO session to the approver.
//   • collect — the NEW device: { requestId }. Before approval, for an unknown handle, or a
//     second time → a 4xx with no session. Once approved it mints the new device's session
//     exactly once, host-locked in the `__Host-wh_session` cookie (single use — the handle
//     is dropped on a successful collect).
//
// Why a sibling `handler.ts` (not `actions.ts` or `page.tsx`): a Next "use server" actions
// file may export only async server actions, and a `page.tsx` entry file only its framework
// fields — neither can carry an injectable, unit-testable factory without breaking
// `next build` (OBS-025). So the testable seam lives here (the convention's
// `createXHandler({ db })` factory); the thin entries wrap it.
//
// The pending-request state, the email-code first factor, the step-up judgement and the
// session minting all live in the REAL sibling modules (new-device, email-code, session);
// this handler only turns an HTTP Request into a call into them and shapes the Response.
//
// Security (each a reviewer veto): every step checks the request `Origin` against the
// configured `publicOrigin` FIRST — a missing or foreign Origin is 403 and changes nothing
// (design §5). Every body is validated at the boundary through the shared `parseBody`
// (malformed / oversized / mis-shaped → a 4xx, never a 500; INV-102). Every query the
// steps reach runs through the `Db` seam bound as parameters, so a SQL-shaped value is
// looked up as data and cannot alter a statement (INV-102).

import { z } from "zod";

import { parseBody, HttpError } from "../../../server/http/validate";
import {
  requestNewDeviceApproval,
  approveNewDeviceRequest,
  collectNewDeviceApproval,
} from "../../../server/auth/new-device";
import { COOKIE_NAME, verifySession } from "../../../server/auth/session";
import { deviceCookieFor } from "../../../server/auth/device-recognition";
import type { Clock } from "../../../server/seams/clock";
import type { Random } from "../../../server/seams/random";
import type { EmailSender, PushSender } from "../../../server/notify/senders";
import type { Db } from "../../../server/db/index";

// The dependency bundle. Each step reads only the subset it needs; the superset is
// structurally assignable to each new-device deps shape. `emailSender` carries the
// email-code first factor's throttle alert; `pushSender` sends the one approval push;
// `publicOrigin` is the origin every step checks the request against.
export interface DeviceHandlerDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  readonly hmacKey: Uint8Array;
  readonly emailSender: EmailSender;
  readonly pushSender: PushSender;
  readonly publicOrigin: string;
}

// The three steps the thin `actions.ts` / route verbs call.
export interface DeviceHandler {
  requestApproval(request: Request): Promise<Response>;
  approve(request: Request): Promise<Response>;
  collect(request: Request): Promise<Response>;
}

// A grossly oversized body is rejected before any work; a real device-handshake body
// (an email, a code, a short device label, or a request handle) is far under this.
const MAX_BODY_BYTES = 64 * 1024;

// requestApproval: the new device's email, its one-time code, and the label shown in the
// approval push. Each is a bounded string, so a non-string / oversized field is a 4xx at
// the boundary, never a cast that reaches a query.
const requestApprovalSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(320), // normalised (users.normaliseEmail)
  code: z.string().min(1).max(100),
  deviceLabel: z.string().min(1).max(200),
});

// approve / collect: the pending request's collection handle alone.
const requestIdSchema = z.object({
  requestId: z.string().min(1).max(200),
});

// A JSON response with a status.
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Pull one cookie's value out of the request's Cookie header, or null when absent (so the
// handler reads the right value out of a real `a=…; __Host-wh_session=…; b=…` header
// rather than assuming the whole header is the token).
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header == null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function createDeviceHandler(deps: DeviceHandlerDeps): DeviceHandler {
  const { db, clock, random, hmacKey, emailSender, pushSender, publicOrigin } = deps;

  // The request is same-origin only when it carries exactly the configured Origin. A
  // missing header (`null`) or a foreign one cannot be proven same-origin → refused.
  function sameOrigin(request: Request): boolean {
    return request.headers.get("origin") === publicOrigin;
  }

  // Map the validation boundary's 4xx to a Response; let anything unexpected surface (a
  // genuine server fault is a 5xx, not a handled 4xx).
  function handleError(error: unknown): Response {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    throw error;
  }

  // Resolve the signed-in person's session from the cookie, re-hashing the presented token
  // the SAME way create/verify do (bound as its hash, parameterized, INV-102). No cookie,
  // or an unknown/expired/tampered token, yields null — no identity to act on.
  async function currentSession(request: Request) {
    const token = readCookie(request, COOKIE_NAME);
    if (token == null) return null;
    return verifySession(db, token, { clock });
  }

  // Step 1 — the new device starts the approval request. Origin gate first (a missing or
  // foreign Origin is 403 and starts nothing — no push). The body { email, code,
  // deviceLabel } is validated at the boundary, then the email code is verified and the
  // person resolved (bound as parameters, INV-102). A failed code / unknown email starts
  // nothing (4xx, no push); success records the pending request, sends ONE push and hands
  // back the collection handle. No session is minted.
  async function requestApproval(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { email, code, deviceLabel } = await parseBody(requestApprovalSchema, request, {
        maxBytes: MAX_BODY_BYTES,
      });

      const result = await requestNewDeviceApproval(
        db,
        { email, code, deviceLabel },
        { clock, hmacKey, emailSender, random, pushSender },
      );
      if (!result.ok) return json(400, { error: result.reason });

      return json(200, { requestId: result.requestId });
    } catch (error) {
      return handleError(error);
    }
  }

  // Step 2 — an existing signed-in device approves. Origin gate first. The approver's
  // identity comes ONLY from the session cookie (never the body): no session → 401 and
  // nothing is approved. The body { requestId } is validated at the boundary, then the
  // request is approved only when the session passes a fresh step-up AND it belongs to the
  // approver's OWN account (member-scoped by the session's userId). Any refusal → 4xx and
  // nothing changes. Success returns NO session to the approver.
  async function approve(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });

    const session = await currentSession(request);
    if (!session) return json(401, { error: "unauthenticated" });

    try {
      const { requestId } = await parseBody(requestIdSchema, request, { maxBytes: MAX_BODY_BYTES });

      const result = await approveNewDeviceRequest(
        db,
        { requestId, approvingSession: session },
        { clock },
      );
      if (!result.ok) return json(400, { error: result.reason });

      return json(200, { ok: true });
    } catch (error) {
      return handleError(error);
    }
  }

  // Step 3 — the new device collects its session. Origin gate first (a missing or foreign
  // Origin is 403 and does NOT consume the one-shot handle). The body { requestId } is
  // validated at the boundary. Before approval, for an unknown handle, or a second time →
  // 4xx with no session cookie. Once approved, a session is minted exactly once and carried
  // host-locked in the `__Host-wh_session` cookie; the handle is dropped so a second
  // collect yields nothing.
  async function collect(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { requestId } = await parseBody(requestIdSchema, request, { maxBytes: MAX_BODY_BYTES });

      const result = await collectNewDeviceApproval(db, { requestId }, { clock, random, emailSender });
      if (!result.ok) return json(400, { error: result.reason });

      // The session cookie, plus the device cookie that marks this browser as one the
      // person signs in on, so its next sign-in raises no new-device alert (review fix B7).
      const headers = new Headers({ location: "/home" });
      headers.append("set-cookie", result.cookie);
      headers.append("set-cookie", deviceCookieFor(result.session.userId, { hmacKey, random }));
      return new Response(null, { status: 303, headers });
    } catch (error) {
      return handleError(error);
    }
  }

  return { requestApproval, approve, collect };
}
