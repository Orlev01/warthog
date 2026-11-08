// The DCR (RFC 7591) `/oauth/register` endpoint's testable handler. The App-Router
// `route.ts` may export ONLY the known route keys (the HTTP verbs + config) or
// `next build` rejects it (OBS-025), so the injection seam that lets the handler be
// unit-tested with an explicit `db` lives HERE, in a sibling module; `route.ts`
// imports `createRegisterHandler`, wires the real db, and exports only `POST`.
//
// A dynamic client registers by POSTing its redirect URIs; the server mints the
// `client_id` (the caller never chooses it) and stores the client as a `dcr`
// registration. Input is validated at the HTTP boundary (`parseBody` — INV-102:
// validate-and-parameterize) before any query runs, and every redirect URI must
// satisfy the shared redirect rule, else the whole request is refused and nothing is
// stored.
//
// Review fix A5 — the endpoint is unauthenticated, so it is bounded: at most ten redirect
// URIs of at most 2048 characters each, and at most `maxRegistrationsPerWindow` DCR
// registrations per hour across all callers (counted in the database in the same
// statement that inserts, so the cap holds across restarts and parallel requests). Past
// the cap it answers 429 with Retry-After and stores nothing.

import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { Db } from "../../../server/db/index";
import { HttpError, parseBody } from "../../../server/http/validate";
import { createClientWithinCap } from "../../../server/oauth/store";
import { isAllowedRedirectUri } from "../../../server/oauth/clients";
import { systemClock, type Clock } from "../../../server/seams/clock";

// A real client registers one or two callbacks; ten is ample, and each is a URL.
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2048;

// How many DCR registrations are accepted per window, across all callers. Generous for
// real agent platforms (each registers once per set-up), while bounding how fast an
// anonymous caller can grow the table.
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MAX_REGISTRATIONS_PER_WINDOW = 100;

// A registration body carries at least the redirect URIs; other RFC 7591 client
// metadata fields are accepted and ignored (unknown keys are stripped, not rejected).
const registerSchema = z.object({
  redirect_uris: z
    .array(z.string().max(MAX_REDIRECT_URI_LENGTH))
    .min(1)
    .max(MAX_REDIRECT_URIS),
});

// A registration body is small (a handful of URLs); cap it well below the global
// default so an oversized body is refused at the boundary before it is parsed.
const MAX_BODY_BYTES = 16 * 1024;

// RFC 7591 error body: a machine-readable `error` code plus a human description.
function errorResponse(status: number, error: string, description: string): Response {
  return Response.json({ error, error_description: description }, { status });
}

export function createRegisterHandler({
  db,
  clock = systemClock,
  maxRegistrationsPerWindow = DEFAULT_MAX_REGISTRATIONS_PER_WINDOW,
}: {
  db: Db;
  clock?: Clock;
  maxRegistrationsPerWindow?: number;
}): (request: Request) => Promise<Response> {
  return async function register(request: Request): Promise<Response> {
    let body: z.infer<typeof registerSchema>;
    try {
      body = await parseBody(registerSchema, request, { maxBytes: MAX_BODY_BYTES });
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResponse(err.status, "invalid_client_metadata", err.message);
      }
      throw err;
    }

    // All-or-nothing: any disallowed redirect URI refuses the whole request, before
    // any query runs — nothing is stored.
    if (!body.redirect_uris.every(isAllowedRedirectUri)) {
      return errorResponse(
        400,
        "invalid_redirect_uri",
        "Redirect URIs must be https, or http://localhost or http://127.0.0.1 on any port",
      );
    }

    const now = clock.now();
    const client = await createClientWithinCap(
      db,
      { clientId: randomUUID(), registration: "dcr", redirectUris: body.redirect_uris },
      {
        since: new Date(now.getTime() - REGISTRATION_WINDOW_MS),
        max: maxRegistrationsPerWindow,
        createdAt: now,
      },
    );
    if (client == null) {
      const response = errorResponse(
        429,
        "too_many_requests",
        "Too many client registrations right now; try again later",
      );
      response.headers.set("retry-after", String(Math.ceil(REGISTRATION_WINDOW_MS / 1000)));
      return response;
    }

    // Echo the registered metadata (RFC 7591 §3.2.1), including that this is a PUBLIC
    // client — no secret, PKCE instead — so a client never falls back to the default
    // client_secret_basic it has no secret for.
    return Response.json(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(now.getTime() / 1000),
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      { status: 201 },
    );
  };
}
