// E04-S36 — Confirm-it's-you (step-up) endpoints: the injectable step-up handler plus
// the route dispatcher that wraps it (the testable sibling seam of
// `src/app/api/auth/step-up/[step]/route.ts`).
//
// A person already signed in re-confirms with their passkey before a sensitive change,
// without signing out and back in (brief: "Step-up check — a fresh passkey or
// authenticator confirmation within the last 5 minutes"; design §5). This builds the
// PASSKEY step-up: a two-step round trip whose identity comes ONLY from the session
// cookie.
//
//   begin(request)  — issues WebAuthn authentication options for the SIGNED-IN person
//                     (identity resolved from the `__Host-wh_session` cookie).
//   finish(request) — verifies the posted assertion ({ authenticationResponse }) against
//                     that person's OWN passkeys and, on success, records a step-up on
//                     their CURRENT session and rotates its token (the response sets the
//                     new cookie; a copy of the old one no longer verifies).
//
// Two seams live here because a Next App-Router `route.ts` may export ONLY the known
// route keys (the HTTP verbs) or `next build` rejects it (OBS-025):
//   • createStepUpHandler(deps)       — the pure request handler, unit-tested with the
//                                       real session/passkey seams over an in-memory db.
//   • createStepUpStepHandler(seams)  — the dispatcher the thin entry constructs at
//                                       module load; it builds the handler LAZILY from
//                                       the auth composition root on the first request
//                                       and reuses it, so merely importing the entry
//                                       reads no config and opens no database (the
//                                       server-composition-roots addendum).
//
// Security (each a reviewer veto): the request `Origin` is checked against the configured
// `publicOrigin` FIRST — a missing or foreign Origin is 403 and changes nothing, so a
// cross-site request can step up no one (design §5). The identity is NEVER read from the
// request body/query/path — only the session cookie (constitution: member-scoped reads
// take userId from the session). Every body is validated at the boundary through the
// shared `parseBody` (malformed / oversized / mis-shaped → a 4xx, never a 500; INV-102),
// and every query runs through the `Db` seam bound as parameters, so a SQL-shaped value
// is looked up as data and cannot alter a statement (INV-102). The RP ID is `deps.rpId`
// (from config), never hard-coded.

import { z } from "zod";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

import { parseBody, HttpError } from "../http/validate";
import { getStepUpDeps } from "./compose";
import { COOKIE_NAME, verifySession, stepUpAndRotate } from "./session";
import { beginPasskeyAuthentication, finishPasskeyAuthentication } from "./passkey";
import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";
import type { Db } from "../db/index";
import type { TotpSecretStore } from "./totp-store";
import { checkTotpSignIn } from "./totp-attempts";

// The dependency bundle the composition root builds: the shared db, the clock that
// judges session freshness and stamps the recorded step-up, the random source that
// mints the rotated session token, the configured WebAuthn RP
// ID (never hard-coded) and the origin every request's Origin header is checked against
// (also the origin the assertion is verified at).
export interface StepUpHandlerDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  readonly rpId: string;
  readonly publicOrigin: string;
  readonly totpSecrets?: Pick<TotpSecretStore, "get">;
}

// The two methods the thin route dispatcher maps the `[step]` segment to.
export interface StepUpHandler {
  begin(request: Request): Promise<Response>;
  finish(request: Request): Promise<Response>;
  totp(request: Request): Promise<Response>;
}

// A grossly oversized body is rejected before any work; a real WebAuthn assertion is far
// under this.
const MAX_BODY_BYTES = 64 * 1024;

// finish: the WebAuthn assertion. The assertion's minimal shape
// (AuthenticationResponseJSON: ids, type and the three signed response fields) is
// validated HERE, so the later cast narrows rather than bypasses validation — a null or
// mis-shaped assertion is a 4xx at the boundary, never a dereference crash inside the
// verifier. Unknown extra keys pass through (looseObject) untouched for the real
// verifier, which still rejects anything that does not verify.
const authenticationResponseSchema = z.looseObject({
  id: z.string().min(1),
  rawId: z.string().min(1),
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: z.string().min(1),
    authenticatorData: z.string().min(1),
    signature: z.string().min(1),
    userHandle: z.string().optional(),
  }),
  clientExtensionResults: z.looseObject({}).optional(),
});

const finishSchema = z.object({
  authenticationResponse: authenticationResponseSchema,
});
const totpSchema = z.strictObject({ totp: z.string().regex(/^[0-9]{6}$/) });

// A JSON response with a status.
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Pull one cookie's value out of the request's Cookie header, or null when absent (so
// the handler reads the right value out of a real `a=…; __Host-wh_session=…; b=…` header
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

// Build the step-up handler. Both methods resolve identity ONLY from the session cookie
// (never the body), check Origin first, and parameter-bind every query through the real
// session/passkey seams.
export function createStepUpHandler(deps: StepUpHandlerDeps): StepUpHandler {
  const { db, clock, random, rpId, publicOrigin } = deps;

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

  // Resolve the signed-in person's session from the cookie, re-hashing the presented
  // token the SAME way create/verify do (bound as its hash, parameterized, INV-102). No
  // cookie, or an unknown/expired/tampered token, yields null — no identity to act on.
  async function currentSession(request: Request) {
    const token = readCookie(request, COOKIE_NAME);
    if (token == null) return null;
    const session = await verifySession(db, token, { clock });
    return session ? { ...session, token } : null;
  }

  // A confirmed step-up: stamp it and rotate the session token in one write, so a copy of
  // the cookie this request presented cannot use the fresh step-up, and hand the
  // confirming browser its new cookie. A session that vanished meanwhile is a 401.
  async function confirmed(presentedToken: string): Promise<Response> {
    const rotated = await stepUpAndRotate(db, presentedToken, { clock, random });
    if (!rotated) return json(401, { error: "unauthenticated" });
    const response = json(200, { ok: true });
    response.headers.set("set-cookie", rotated.cookie);
    return response;
  }

  // Step 1 — issue a WebAuthn authentication challenge (carrying the configured RP ID)
  // for the signed-in person and persist it, so finish can verify against the challenge
  // WE sent. No session → 4xx: there is no identity to issue a challenge for.
  async function begin(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });

    const session = await currentSession(request);
    if (!session) return json(401, { error: "unauthenticated" });

    // A step-up challenge is its own purpose: a sign-in assertion can never satisfy it.
    const options = await beginPasskeyAuthentication(
      db,
      { userId: session.userId, purpose: "step_up" },
      { rpId, clock },
    );
    return json(200, { options });
  }

  // Step 2 — verify the assertion against the signed-in person's OWN registered passkey
  // and the challenge begin issued (the real verifier). An assertion that is not that
  // person's own (the ownership lookup finds nothing) or otherwise fails to verify →
  // 4xx and NO step-up. On success: record a step-up on their CURRENT session.
  async function finish(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });

    const session = await currentSession(request);
    if (!session) return json(401, { error: "unauthenticated" });

    try {
      const { authenticationResponse } = await parseBody(finishSchema, request, {
        maxBytes: MAX_BODY_BYTES,
      });

      const result = await finishPasskeyAuthentication(
        db,
        {
          userId: session.userId,
          response: authenticationResponse as AuthenticationResponseJSON,
          purpose: "step_up",
        },
        { rpId, origin: publicOrigin, clock },
      );
      if (!result.ok) return json(401, { error: "invalid_assertion" });

      return await confirmed(session.token);
    } catch (error) {
      return handleError(error);
    }
  }

  async function totp(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    const session = await currentSession(request);
    if (!session) return json(401, { error: "unauthenticated" });
    try {
      const { totp: code } = await parseBody(totpSchema, request, { maxBytes: MAX_BODY_BYTES });
      const secret = await deps.totpSecrets?.get(session.userId);
      if (!secret) return json(401, { error: "invalid_code" });
      // The same account-wide counter and accepted step used by signin: neither
      // parallel guesses nor switching endpoints permits extra attempts or replay.
      const result = await checkTotpSignIn(db, { userId: session.userId, secret, code }, { clock });
      if (!result.ok) {
        if (result.reason === "throttled") {
          const response = json(429, { error: "too_many_attempts" });
          response.headers.set("retry-after", String(Math.ceil(result.retryAfterMs / 1000)));
          return response;
        }
        return json(401, { error: "invalid_code" });
      }
      return await confirmed(session.token);
    } catch (error) { return handleError(error); }
  }

  return { begin, finish, totp };
}

// The step -> handler-method contract this route implements. A Map is exact-match and
// carries no inherited keys, so a step like "constructor" cannot resolve to a method.
const STEP_METHOD = new Map<string, keyof StepUpHandler>([
  ["begin", "begin"],
  ["finish", "finish"],
  ["totp", "totp"],
]);

// The injection seams the route entry leaves at their defaults: the composition root
// that produces the deps, and the handler factory that consumes them.
export interface StepUpStepSeams {
  readonly getDeps?: () => Promise<StepUpHandlerDeps>;
  readonly createHandler?: (deps: StepUpHandlerDeps) => StepUpHandler;
}

// Build the route dispatcher. Constructing it touches no config or database: the handler
// is built on the FIRST request (so the entry stays importable under `next build`) and
// then reused for every later request. An unknown `[step]` reaches no handler method and
// is a 404.
export function createStepUpStepHandler(
  seams: StepUpStepSeams = {},
): (request: Request, step: string) => Promise<Response> {
  const getDeps = seams.getDeps ?? getStepUpDeps;
  const createHandler = seams.createHandler ?? createStepUpHandler;

  // Build the handler once, lazily, on the first request and reuse it. Kept as a promise
  // so the first request awaits bring-up and later ones reuse the handler; a failed
  // bring-up forgets the rejected promise so the next request retries.
  let handlerPromise: Promise<StepUpHandler> | undefined;
  function getHandler(): Promise<StepUpHandler> {
    if (!handlerPromise) {
      handlerPromise = (async () => createHandler(await getDeps()))();
      handlerPromise.catch(() => {
        handlerPromise = undefined;
      });
    }
    return handlerPromise;
  }

  return async function dispatch(request: Request, step: string): Promise<Response> {
    const method = STEP_METHOD.get(step);
    if (!method) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const handler = await getHandler();
    return handler[method](request);
  };
}
