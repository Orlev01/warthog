// E11-S18 — Vault unlock endpoints: the injectable HTTP handlers over the already-built
// server `createVaultUnlockActions` (design §4.2 "Device-held vault"; brief "Vault unlock
// methods"). INV-101 (admin-auth-required — these are authenticated routes),
// INV-102 (validate-and-parameterize-input), INV-103 (secrets-from-env).
//
// The inbox release (E11-S17) and vault setup fetch `/api/vault/unlock-material/<method>`
// and POST `/api/vault/unlock-method`; these handlers are the HTTP surface over the vault
// unlock actions, adding no SQL and no crypto of their own:
//   GET  getMaterial(request, method)  (method ∈ { passkey_prf, passphrase, recovery })
//        → { wrapped, params, options }:
//          • passphrase  — the person's wrapped VK envelope (null when none is set) and the
//            method's public params; no assertion options.
//          • passkey_prf — the wrapped VK plus WebAuthn authentication `options` whose PRF
//            extension EVALUATES the person's stored PRF salt (base64url, what
//            @simplewebauthn/browser decodes at unlock time) so the browser derives the
//            same wrapping key locally. No assertion is verified here — the derivation is
//            entirely client-side — so no challenge is persisted.
//          • recovery    — the vault recovery phrase's envelope (null when none is set);
//            the phrase itself never reaches the server.
//   POST saveMethod(request)
//        → saves a wrapped VK (+ public params) for the signed-in person's method. Adding a
//          method needs the session; replacing an existing one needs a fresh step-up
//          (otherwise 403 step_up_required and nothing changes).
//
// A Next App-Router `route.ts` may export ONLY the known route keys (OBS-025), so the
// injectable factory lives HERE; each thin `route.ts` imports it and exports only its verb.
// Every seam is optional with a production default resolved LAZILY, per request — so merely
// constructing the handlers (as the route entry does at import) reads no config and opens no
// database (the server-composition-roots addendum; `next build` evaluates no runtime config).
//
// Security (each a reviewer veto): identity is the SESSION's user id, never a client value
// (constitution: member-scoped reads/writes take userId from the session) — a body-supplied
// userId is stripped and ignored. On a write the request `Origin` is checked against the
// configured `publicOrigin` FIRST — a missing or foreign Origin is 403 and stores nothing
// (design §5); a read is NOT Origin-gated (browsers omit Origin on a same-origin GET). Every
// body is validated at the boundary through the shared `parseBody` (malformed / oversized /
// mis-shaped → a 4xx, never a 500; INV-102), and every value travels bound as a parameter
// through the db seam, so a SQL-shaped value is stored as data and cannot alter a statement.
// The RP ID is config-driven (`deps.rpId`), never hard-coded. This module reads no
// `process.env` directly — config flows through the injected seams, or in production through
// `loadConfig()` / `getServerDb()` at request time (INV-103).

import { z } from "zod";
import { generateAuthenticationOptions } from "@simplewebauthn/server";

import { parseBody, HttpError } from "../http/validate";
import { loadConfig } from "../config";
import { getServerDb } from "../db/server";
import { COOKIE_NAME, verifySession, type Session } from "../auth/session";
import { requireStepUp } from "../auth/step-up";
import { systemClock, type Clock } from "../seams/clock";
import { systemRandom, type Random } from "../seams/random";
import { createVaultUnlockActions, STEP_UP_REQUIRED } from "./unlock";
import type { UnlockMethod } from "../db/vault-unlock-methods";
import type { Db } from "../db/index";

// The methods this endpoint serves: every store method. `recovery` is the vault recovery
// phrase's envelope (review fix W1): the browser generates the phrase, wraps VK under a key
// derived from it and saves the envelope here; the server never sees the phrase, and the
// envelope is useless without it (the phrase carries 160 random bits), so serving it to the
// signed-in person is safe. An unknown method is a 404.
const SERVED_METHODS = ["passkey_prf", "passphrase", "recovery"] as const;
type ServedMethod = (typeof SERVED_METHODS)[number];

function isServedMethod(method: string): method is ServedMethod {
  return (SERVED_METHODS as readonly string[]).includes(method);
}

// A real wrapped-VK envelope is a short opaque string; anything far larger is malformed
// input. The per-field cap and the whole-body byte cap each reject the rest with a 4xx
// before any store (INV-102), rather than letting it reach a query.
const MAX_WRAPPED_LENGTH = 64 * 1024;
const MAX_BODY_BYTES = 128 * 1024;

// The save body's shape: a served method, a non-empty bounded opaque wrapped VK, and
// optional public params (salts, iteration counts — never a secret). z.object STRIPS
// unknown keys, so a smuggled `userId` / `user_id` is dropped and the write stays scoped to
// the session user. A violation throws a 4xx `HttpError`, so nothing is persisted.
const saveBodySchema = z.object({
  method: z.enum(SERVED_METHODS),
  wrapped: z.string().min(1).max(MAX_WRAPPED_LENGTH),
  params: z.record(z.string(), z.unknown()).optional(),
});

// The injectable seams, each optional with a production default resolved lazily per request.
export interface VaultUnlockHttpSeams {
  // Resolve the session from the request (server-verified; INV-101). Production reads the
  // host-locked cookie and verifies it over the shared database.
  readonly resolveSession?: (request: Request) => Promise<Session | null>;
  // The shared database (every query parameter-bound; INV-102).
  readonly db?: Db;
  // Entropy for the fixed per-person PRF salt (drawn by the unlock actions).
  readonly random?: Random;
  // The configured WebAuthn RP ID (never hard-coded).
  readonly rpId?: string;
  // The origin a POST's Origin header is checked against.
  readonly publicOrigin?: string;
  // The clock a session's step-up freshness is judged against.
  readonly clock?: Clock;
}

export interface VaultUnlockHttpHandlers {
  getMaterial(request: Request, method: string): Promise<Response>;
  saveMethod(request: Request): Promise<Response>;
}

// --- production defaults --------------------------------------------------------------

// Read one cookie's value out of the request's Cookie header, or null when absent.
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

// The real session resolver: read the host-locked session cookie and verify it server-side
// over the process-wide database (never trusting any other client value — INV-101). The
// database is taken lazily, per request, so importing this module boots nothing.
async function defaultResolveSession(request: Request): Promise<Session | null> {
  const token = readCookie(request, COOKIE_NAME);
  if (token == null) return null;
  const db = await getServerDb();
  return verifySession(db, token, { clock: systemClock });
}

// --- responses ------------------------------------------------------------------------

// Every response is per-person and sensitive (wrapped keys, PRF salts), so no shared or
// browser cache may keep it.
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// WebAuthn authentication options carrying the configured RP ID and a PRF extension whose
// eval input IS the person's fixed PRF salt (as base64url, what @simplewebauthn/browser
// decodes before calling navigator.credentials.get), so the browser derives the SAME
// wrapping key VK was sealed with. No challenge is persisted: the assertion is never sent
// back to Warthog — the PRF derivation and unwrap happen entirely on the device.
async function prfAuthenticationOptions(rpId: string, prfSaltHex: string) {
  const base = await generateAuthenticationOptions({ rpID: rpId, userVerification: "required" });
  const first = Buffer.from(prfSaltHex, "hex").toString("base64url");
  return { ...base, extensions: { prf: { eval: { first } } } };
}

// --- the handlers ---------------------------------------------------------------------

export function createVaultUnlockHttpHandlers(
  seams: VaultUnlockHttpSeams = {},
): VaultUnlockHttpHandlers {
  const resolveSession = seams.resolveSession ?? defaultResolveSession;

  // Map the validation boundary's 4xx to a Response; let anything unexpected surface (a
  // genuine server fault is a 5xx, not a handled 4xx).
  function handleError(error: unknown): Response {
    if (error instanceof HttpError) return json(error.status, { error: "invalid_request" });
    throw error;
  }

  // GET — serve the signed-in person's non-secret unlock material for `method`.
  async function getMaterial(request: Request, method: string): Promise<Response> {
    // 1. A method outside { passkey_prf, passphrase, recovery } is a 404 (a read is not
    //    Origin-gated).
    if (!isServedMethod(method)) return json(404, { error: "not_found" });

    // 2. A server-verified session, or nothing — identity is the session's user id.
    const session = await resolveSession(request);
    if (session == null) return json(401, { error: "unauthenticated" });

    const db = seams.db ?? (await getServerDb());
    const random = seams.random ?? systemRandom;
    const actions = createVaultUnlockActions({ db, random });

    // 3. Read the material member-scoped by the session user (never a client id).
    const material = await actions.getUnlockMaterial(session.userId, method as UnlockMethod);

    if (method === "passkey_prf") {
      const rpId = seams.rpId ?? loadConfig().webauthnRpId;
      const options = await prfAuthenticationOptions(rpId, material.prfSalt);
      return json(200, { wrapped: material.wrapped, params: material.params, options });
    }

    // passphrase / recovery: the wrapped envelope and public params, no assertion options.
    return json(200, { wrapped: material.wrapped, params: material.params, options: null });
  }

  // POST — save a wrapped vault key for the signed-in person's method.
  async function saveMethod(request: Request): Promise<Response> {
    // 1. Origin FIRST: a missing or foreign Origin is 403 and stores nothing (design §5).
    const publicOrigin = seams.publicOrigin ?? new URL(loadConfig().publicBaseUrl).origin;
    if (request.headers.get("origin") !== publicOrigin) {
      return json(403, { error: "forbidden" });
    }

    // 2. A server-verified session, or nothing — identity is the session's user id.
    const session = await resolveSession(request);
    if (session == null) return json(401, { error: "unauthenticated" });

    try {
      // 3. Validate the body at the boundary (malformed / oversized / mis-shaped → a 4xx,
      //    never a 500; INV-102). A smuggled userId is stripped, so the write stays scoped
      //    to the session user. Every value is bound as a parameter through the store.
      const parsed = await parseBody(saveBodySchema, request, { maxBytes: MAX_BODY_BYTES });
      const db = seams.db ?? (await getServerDb());
      const random = seams.random ?? systemRandom;
      const actions = createVaultUnlockActions({ db, random });

      // 4. Adding a method needs only the session; REPLACING one is a security change, so
      //    it needs a step-up within the last five minutes (review fix W1). Without one the
      //    save is insert-only and an existing method comes back 403 step_up_required —
      //    the stored envelope is untouched, and the browser can offer "Confirm it's you".
      const replace = requireStepUp(session, { clock: seams.clock ?? systemClock });
      const result = await actions.saveUnlockMethod(
        session.userId,
        { method: parsed.method, wrapped: parsed.wrapped, params: parsed.params },
        { replace },
      );
      if (!result.ok && result.reason === STEP_UP_REQUIRED) return json(403, { error: STEP_UP_REQUIRED });
      if (!result.ok) return json(400, { error: result.reason });

      return json(200, { ok: true });
    } catch (error) {
      return handleError(error);
    }
  }

  return { getMaterial, saveMethod };
}
