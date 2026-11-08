// E04-S11 — Sign-in server actions (the injectable seam the thin `actions.ts` /
// route verbs wrap). A RETURNING person signs in with their second factor and
// gets a session (brief `sign_in_model`; design §5).
//
// Sign-in offers two methods, each its own request:
//   - the passkey (a single, phishing-resistant factor), a two-step round trip:
//       beginPasskey  — { email } -> 200 { options }: resolve the account and
//                       issue a WebAuthn authentication challenge for it.
//       finishPasskey — { email, authenticationResponse } -> verify the assertion
//                       against that person's registered passkey and the challenge
//                       begin issued, then mint a session and redirect to /home.
//   - email plus the authenticator-app code, where passkeys are unavailable:
//       signInWithTotp — { email, totp } -> resolve the account, read its TOTP
//                       secret and verify the 6-digit code, then mint a session
//                       and redirect to /home.
//
// (The email ONE-TIME code is the separate NEW-DEVICE flow, not this
// returning-device sign-in.)
//
// Why a sibling `handler.ts` (not `actions.ts` or `page.tsx`): a Next "use server"
// actions file may export only async server actions, and a `page.tsx` entry file
// only its framework fields — neither can carry an injectable, unit-testable
// factory without breaking `next build`. So the testable seam lives here (the
// convention's `createXHandler({ db })` pattern); the thin `actions.ts` / route
// verbs wrap it.
//
// The TOTP secret has no persistence yet (the vault_unlock_methods store is built
// later, and this task may touch only the sign-in action/handler), so the handler
// reads it through the injected `totpSecrets` seam — the project's "external
// services sit behind interfaces with fakes" rule. The real store is wired when it
// exists.
//
// Security (each a reviewer veto): every method checks the request `Origin` against
// the configured `publicOrigin` first — a missing or foreign Origin is 403 and
// changes nothing, so a cross-site request mints no session (design §5). Every body
// is validated at the boundary through the shared `parseBody` (malformed /
// oversized / mis-shaped → a 4xx, never a 500; INV-102). Every query runs through
// the `Db` seam bound as parameters, so a SQL-shaped value is looked up as data and
// cannot alter a statement (INV-102). The RP ID is `deps.rpId` (from config), never
// hard-coded.

import { z } from "zod";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

import { parseBody, HttpError } from "../../../server/http/validate";
import {
  beginPasskeyAuthentication,
  decoyPasskeyAuthenticationOptions,
  finishPasskeyAuthentication,
} from "../../../server/auth/passkey";
import { verifyTotp } from "../../../server/auth/totp";
import { createSession, recordStepUp } from "../../../server/auth/session";
import { alertNewDeviceSignIn, deliverAlert } from "../../../server/auth/alerts";
import {
  describeDevice,
  deviceCookieFor,
  isRecognisedDevice,
} from "../../../server/auth/device-recognition";
import { getUserByEmail } from "../../../server/db/users";
import type { Clock } from "../../../server/seams/clock";
import type { Random } from "../../../server/seams/random";
import type { EmailSender } from "../../../server/notify/senders";
import type { Db } from "../../../server/db/index";

// The injected store the handler reads a person's base32 TOTP secret through: a
// userId with no enrolled secret returns null. The real store is wired when the
// vault_unlock_methods persistence exists; the shape matches the test's fake.
export interface TotpSecretStore {
  get(userId: string): Promise<string | null>;
}

// The dependency bundle. Each method reads the subset it needs; the superset is
// structurally assignable to each. `rpId` is the WebAuthn RP ID (from config, never
// hard-coded); `publicOrigin` is the origin every method checks the request against.
// `hmacKey` binds the new-device cookie and `emailSender` carries the new-device alert.
export interface SigninHandlerDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  readonly hmacKey: Uint8Array;
  readonly emailSender: EmailSender;
  readonly rpId: string;
  readonly publicOrigin: string;
  readonly totpSecrets: TotpSecretStore;
}

// The three methods the thin `actions.ts` / route verbs call.
export interface SigninHandler {
  beginPasskey(request: Request): Promise<Response>;
  finishPasskey(request: Request): Promise<Response>;
  signInWithTotp(request: Request): Promise<Response>;
}

// A grossly oversized body is rejected before any work; a real sign-in body (even a
// WebAuthn assertion) is far under this.
const MAX_BODY_BYTES = 64 * 1024;

// beginPasskey: the email naming the account to issue a challenge for.
const beginPasskeySchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(320), // normalised (users.normaliseEmail)
});

// finishPasskey: the email + the WebAuthn assertion. The assertion's minimal shape
// (AuthenticationResponseJSON: ids, type and the three signed response fields) is
// validated HERE, so the later cast narrows rather than bypasses validation — a
// null or mis-shaped assertion is a 4xx at the boundary, never a dereference crash
// inside the verifier. Unknown extra keys pass through (looseObject) untouched for
// the real verifier, which still rejects anything that does not verify.
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

const finishPasskeySchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(320), // normalised (users.normaliseEmail)
  authenticationResponse: authenticationResponseSchema,
});

// signInWithTotp: the email + the authenticator-app code. `verifyTotp` itself
// rejects anything that is not exactly six digits.
const totpSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(320), // normalised (users.normaliseEmail)
  totp: z.string().min(1).max(100),
});

// A JSON response with a status.
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createSigninHandler(deps: SigninHandlerDeps): SigninHandler {
  const { db, clock, random, hmacKey, emailSender, rpId, publicOrigin, totpSecrets } = deps;

  // The request is same-origin only when it carries exactly the configured Origin. A
  // missing header (`null`) or a foreign one cannot be proven same-origin → refused.
  function sameOrigin(request: Request): boolean {
    return request.headers.get("origin") === publicOrigin;
  }

  // Map the validation boundary's 4xx to a Response; let anything unexpected surface
  // (a genuine server fault is a 5xx, not a handled 4xx).
  function handleError(error: unknown): Response {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    throw error;
  }

  // Mint a session for the signed-in person and redirect to /home carrying the
  // host-locked `__Host-wh_session` cookie (the signed-in home). A sign-in IS a
  // passkey/TOTP check, so record a step-up on the new session (design §5): the
  // next sensitive change is allowed for the following five minutes.
  //
  // A sign-in from a browser this person has not signed in on before emails them the
  // brief's new-device alert (best effort: a failed send never fails the sign-in) and
  // marks the browser with a device cookie, so later sign-ins from it stay quiet.
  async function mintSession(userId: string, request: Request): Promise<Response> {
    const created = await createSession(db, userId, { clock, random });
    await recordStepUp(db, created.session.id, { clock });
    const headers = new Headers({ location: "/home" });
    headers.append("set-cookie", created.cookie);
    if (!isRecognisedDevice(request, userId, hmacKey)) {
      const deviceLabel = describeDevice(request.headers.get("user-agent"));
      await deliverAlert("new-device-sign-in", () =>
        alertNewDeviceSignIn(db, { userId, deviceLabel }, { emailSender }),
      );
      headers.append("set-cookie", deviceCookieFor(userId, { hmacKey, random }));
    }
    return new Response(null, { status: 303, headers });
  }

  // Passkey step 1 — issue a WebAuthn authentication challenge (carrying the configured
  // RP ID). A registered account gets a real challenge, persisted so finish can verify
  // against it; an email with no account gets indistinguishable DECOY options (same
  // shape, same RP ID, a fresh string challenge) with nothing persisted — so begin
  // reveals nothing about whether the account exists (E04-S19). No session either way.
  async function beginPasskey(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { email } = await parseBody(beginPasskeySchema, request, {
        maxBytes: MAX_BODY_BYTES,
      });

      const user = await getUserByEmail(db, email);
      const options = user
        ? await beginPasskeyAuthentication(db, { userId: user.id, purpose: "signin" }, { rpId, clock })
        : await decoyPasskeyAuthenticationOptions({ rpId });
      return json(200, { options });
    } catch (error) {
      return handleError(error);
    }
  }

  // Passkey step 2 — verify the assertion against the claimed person's registered
  // passkey and the challenge begin issued (the real verifier). An assertion that is
  // not that person's own (or otherwise fails to verify) → 4xx and NO session. On
  // success: mint a session and redirect to /home.
  async function finishPasskey(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { email, authenticationResponse } = await parseBody(finishPasskeySchema, request, {
        maxBytes: MAX_BODY_BYTES,
      });

      const user = await getUserByEmail(db, email);
      if (!user) return json(401, { error: "invalid_assertion" });

      const result = await finishPasskeyAuthentication(
        db,
        {
          userId: user.id,
          response: authenticationResponse as AuthenticationResponseJSON,
          purpose: "signin",
        },
        { rpId, origin: publicOrigin, clock },
      );
      if (!result.ok) return json(401, { error: "invalid_assertion" });

      return await mintSession(user.id, request);
    } catch (error) {
      return handleError(error);
    }
  }

  // Email + authenticator code — resolve the account, read its TOTP secret (the
  // injected seam) and verify the code for the current 30-second step (±1). A wrong /
  // out-of-window code, or no enrolled secret → 4xx and NO session. On success: mint
  // a session and redirect to /home.
  async function signInWithTotp(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return json(403, { error: "forbidden" });
    try {
      const { email, totp } = await parseBody(totpSchema, request, {
        maxBytes: MAX_BODY_BYTES,
      });

      const user = await getUserByEmail(db, email);
      if (!user) return json(401, { error: "invalid_code" });

      const secret = await totpSecrets.get(user.id);
      if (!secret) return json(401, { error: "invalid_code" });
      if (!verifyTotp(secret, totp, { clock })) return json(401, { error: "invalid_code" });

      return await mintSession(user.id, request);
    } catch (error) {
      return handleError(error);
    }
  }

  return { beginPasskey, finishPasskey, signInWithTotp };
}
