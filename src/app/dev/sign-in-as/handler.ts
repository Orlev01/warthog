// E17-S09 — Dev "sign in as" (the injectable seam the thin `route.ts` wraps; design
// §12 dev tools). Behind the dev-tools guard it mints a session for a chosen account
// and marks it freshly stepped-up, so the acceptance walkthrough can become a signed-in,
// step-up-satisfied person over plain HTTP without a real passkey — it stands in for a
// dev passkey and is safe ONLY because it is gated (and production refuses to start with
// the flag set, `assertProductionSafe` in `src/server/config.ts`).
//
// Why a sibling `handler.ts` (not `route.ts`): a Next App-Router `route.ts` may export
// ONLY the known route keys (the HTTP verb(s) + framework config) or `next build` rejects
// it (OBS-025). So this injectable, unit-testable factory lives here and `route.ts`
// imports it and re-exports only `POST`.
//
// A route handler is NOT wrapped by the `/dev/layout.tsx` guard the way a page is — Next
// layouts wrap pages, not route handlers — so this handler re-derives the dev-tools gate
// ITSELF, reusing the same `requireDevTools` seam the layout does (one source of truth):
// when dev tools are off the request is a Next not-found and nothing is created.
//
// Every seam is optional with a real default so `route.ts` can call
// `createSignInAsHandler()` with no args. Config and the db are resolved at REQUEST time
// (never at module load — `next build` evaluates route modules with runtime config
// absent), and the gate's decision derives ONLY from the config the config module parsed
// from the environment, never from a value read inside this handler (INV-103
// secrets-from-env). Every body is validated at the boundary through the shared
// `parseBody` (malformed / oversized / mis-shaped → a 4xx, never a 500; INV-102), and the
// chosen account is resolved through the parameter-binding `getUserByEmail`, so a
// SQL-shaped email is looked up as data and cannot alter the statement (INV-102).

import { z } from "zod";

import { parseBody, HttpError } from "../../../server/http/validate";
import { requireDevTools } from "../../../server/dev/guard";
import { createSession, recordStepUp } from "../../../server/auth/session";
import { getUserByEmail } from "../../../server/db/users";
import { loadConfig, type Config } from "../../../server/config";
import { getServerDb } from "../../../server/db/server";
import { systemClock, type Clock } from "../../../server/seams/clock";
import { systemRandom, type Random } from "../../../server/seams/random";
import type { Db } from "../../../server/db/index";

// Every seam optional with a real default, so `route.ts` builds the handler with no args.
export interface SignInAsSeams {
  readonly db?: Db;
  readonly clock?: Clock;
  readonly random?: Random;
  readonly config?: Config;
}

export interface SignInAsHandler {
  POST(request: Request): Promise<Response>;
}

// A grossly oversized body is rejected before any work; the only field is an email, far
// under this.
const MAX_BODY_BYTES = 64 * 1024;

// The body the acceptance walk posts: the email naming the chosen account. Not
// `.email()`-validated on purpose — the value reaches `getUserByEmail` bound as a
// parameter, so a SQL-shaped email is looked up as data (and matches no account), which
// is exactly the INV-102 property this route demonstrates.
const signInAsSchema = z.object({
  email: z.string().min(1).max(320),
});

// A JSON response with a status.
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createSignInAsHandler(seams: SignInAsSeams = {}): SignInAsHandler {
  const clock = seams.clock ?? systemClock;
  const random = seams.random ?? systemRandom;

  // Map the validation boundary's 4xx to a Response; let anything unexpected surface (a
  // genuine server fault is a 5xx, not a handled 4xx).
  function handleError(error: unknown): Response {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    throw error;
  }

  async function POST(request: Request): Promise<Response> {
    // Dev-tools gate FIRST (outside the try, so the not-found propagates): config is read
    // at request time from the injected seam or the config module, never a value baked in
    // here. With dev tools off this is a Next not-found and creates nothing.
    const config = seams.config ?? loadConfig();
    requireDevTools(config);

    try {
      const { email } = await parseBody(signInAsSchema, request, { maxBytes: MAX_BODY_BYTES });

      const db = seams.db ?? (await getServerDb());

      // Resolve the chosen account (parameter-bound). A well-formed but unknown email
      // mints nothing.
      const user = await getUserByEmail(db, email);
      if (!user) return json(404, { error: "unknown_account" });

      // Mint a session for the chosen account and mark it freshly stepped-up (sign-in-as
      // stands in for a passkey/step-up check), so the walk reaches guarded and sensitive
      // screens. Redirect to /home carrying the host-locked `__Host-wh_session` cookie.
      const created = await createSession(db, user.id, { clock, random });
      await recordStepUp(db, created.session.id, { clock });
      return new Response(null, {
        status: 303,
        headers: { location: "/home", "set-cookie": created.cookie },
      });
    } catch (error) {
      return handleError(error);
    }
  }

  return { POST };
}
