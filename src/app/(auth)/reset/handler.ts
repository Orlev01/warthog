// Review fix W3.3 — the account-reset HTTP steps (the injectable seam the thin
// `/api/auth/reset/[step]` route wraps). The reset state machine (request → 7-day wait →
// cancel / complete, `src/server/auth/account-reset.ts`) had no way in. When every passkey
// AND the recovery code are lost, the brief's only way back is a reset by email after a
// 7-day wait, during which every channel is alerted and any signed-in device can cancel.
//
// Three steps, each its own request:
//   1. sendCode — { email }: email the account holder a one-time code (the first factor).
//                 The SAME 200 answers an address with no account, and one whose code
//                 could not be issued just now (the per-address limit), so the step
//                 reveals nothing about which addresses have accounts.
//   2. request  — { email, code }: start the reset (requestAccountReset verifies the code,
//                 records the pending reset, schedules completion and alerts every
//                 channel). A wrong code, or an address with no account, is the same 400.
//                 The answer says when the reset completes.
//   3. cancel   — a signed-in device cancels the person's own pending reset. Identity is
//                 the session cookie ALONE, never a body value (design §5).
//
// Security (each a reviewer veto): every step checks the request `Origin` against the
// configured `publicOrigin` first — a missing or foreign Origin is 403 and changes nothing
// (design §5). Every body is validated at the boundary through the shared `parseBody`
// (malformed / oversized / mis-shaped → a 4xx, never a 500; INV-102), and every query runs
// through the `Db` seam with bound parameters. The one-time code reaches only the email
// it is sent in, and no response carries it.

import { z } from "zod";

import { parseBody, HttpError } from "../../../server/http/validate";
import { issueEmailCode } from "../../../server/auth/email-code";
import {
  requestAccountReset,
  cancelAccountReset,
  RESET_WAIT_MS,
} from "../../../server/auth/account-reset";
import { verifySession } from "../../../server/auth/session";
import { getUserByEmail } from "../../../server/db/users";
import type { Clock } from "../../../server/seams/clock";
import type { Random } from "../../../server/seams/random";
import type { Senders } from "../../../server/notify/senders";
import type { Db } from "../../../server/db/index";

// The dependency bundle. `senders` carries the code email and the reset alerts (push,
// email, SMS); `hmacKey` is the key email codes are stored under; `publicOrigin` is the
// origin every step checks the request against.
export interface ResetHandlerDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  readonly hmacKey: Uint8Array;
  readonly senders: Senders;
  readonly publicOrigin: string;
}

export interface ResetHandler {
  sendCode(request: Request): Promise<Response>;
  request(request: Request): Promise<Response>;
  cancel(request: Request): Promise<Response>;
}

// The host-locked session cookie set by the session module.
const SESSION_COOKIE = "__Host-wh_session";

// A reset body is a few short fields; anything larger is refused before any work.
const MAX_BODY_BYTES = 4 * 1024;

const emailSchema = z.string().trim().toLowerCase().min(1).max(320); // users.normaliseEmail
const sendCodeSchema = z.object({ email: emailSchema });
const requestSchema = z.object({ email: emailSchema, code: z.string().trim().min(1).max(100) });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// One cookie's value from the request's Cookie header, or null when absent.
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

export function createResetHandler(deps: ResetHandlerDeps): ResetHandler {
  const { db, clock, random, hmacKey, senders, publicOrigin } = deps;

  // Same-origin only when the request carries exactly the configured Origin; a missing
  // header or a foreign one cannot be proven same-origin, so it is refused.
  function sameOrigin(request: Request): boolean {
    return request.headers.get("origin") === publicOrigin;
  }

  // The validation boundary's 4xx becomes a Response; anything else is a genuine fault.
  function handleError(error: unknown): Response {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    throw error;
  }

  // Step 1 — email the account holder a one-time code. Only an existing account is
  // emailed; the answer is the same either way, and also when the address's code limit
  // refused a new code (the person can use the code they already have).
  async function sendCode(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { email } = await parseBody(sendCodeSchema, request, { maxBytes: MAX_BODY_BYTES });
      const user = await getUserByEmail(db, email);
      if (user) {
        await issueEmailCode(db, user.email, { clock, random, hmacKey, emailSender: senders.email });
      }
      return json(200, { ok: true });
    } catch (error) {
      return handleError(error);
    }
  }

  // Step 2 — start the reset with the emailed code. A wrong or lapsed code and an address
  // with no account are the same 400; a reset whose alerts reached no channel at all is
  // withdrawn by the state machine and reported as 503 (try again later).
  async function requestReset(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { email, code } = await parseBody(requestSchema, request, { maxBytes: MAX_BODY_BYTES });
      const result = await requestAccountReset(db, { email, code }, { clock, hmacKey, senders });
      if (!result.ok) {
        if (result.reason === "alert_failed") return json(503, { error: "alert_failed" });
        return json(400, { error: "invalid_code" });
      }
      const completesAt = new Date(clock.now().getTime() + RESET_WAIT_MS);
      return json(200, { ok: true, completesAt: completesAt.toISOString() });
    } catch (error) {
      return handleError(error);
    }
  }

  // Step 3 — the signed-in person cancels their own pending reset. The person is the
  // session cookie's; a body (if any) is never read, so no client value picks whose reset
  // is cancelled. No session is 401; nothing pending is 404.
  async function cancel(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    const token = readCookie(request, SESSION_COOKIE);
    const session = token ? await verifySession(db, token, { clock }) : null;
    if (!session) return json(401, { error: "unauthenticated" });
    const result = await cancelAccountReset(db, { userId: session.userId }, {});
    if (!result.ok) return json(404, { error: "no_pending_reset" });
    return json(200, { ok: true });
  }

  return { sendCode, request: requestReset, cancel };
}
