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

import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { Db } from "../../../server/db/index";
import { HttpError, parseBody } from "../../../server/http/validate";
import { createClient } from "../../../server/oauth/store";
import { isAllowedRedirectUri } from "../../../server/oauth/clients";

// A registration body carries at least the redirect URIs; other RFC 7591 client
// metadata fields are accepted and ignored (unknown keys are stripped, not rejected).
const registerSchema = z.object({
  redirect_uris: z.array(z.string()).min(1),
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
}: {
  db: Db;
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

    const client = await createClient(db, {
      clientId: randomUUID(),
      registration: "dcr",
      redirectUris: body.redirect_uris,
    });

    return Response.json(
      { client_id: client.clientId, redirect_uris: client.redirectUris },
      { status: 201 },
    );
  };
}
