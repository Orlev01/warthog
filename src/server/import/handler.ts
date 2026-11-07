// E16-S05 — Import endpoint: the injectable sibling handler, the HTTP boundary over the
// import service (`./import`). INV-101 admin-auth (a session is required), INV-102
// validate-and-parameterize-input, INV-103 secrets-from-env.
//
// A person uploads their export file; this endpoint is the server half. It:
//   1. resolves the session (INV-101) — identity is the session's user id, never a value
//      read from the uploaded file; no session → it writes nothing (401);
//   2. rejects an oversized body, malformed JSON, or a document that fails the E16-S01
//      schema (e.g. the wrong version) with a 4xx, never an uncontrolled 500 (INV-102);
//   3. unwraps the person's DEK and calls the import service for the SESSION user, so a
//      SQL-shaped value in an input field is bound as data, never woven into a query.
//
// A Next App-Router `route.ts` may export ONLY the known route keys (OBS-025), so the
// injectable factory lives HERE; a later story's `route.ts` imports it and exports only
// `POST`. Every seam is optional with a production default resolved LAZILY per request
// (never at construction / import), so importing the entry boots no database and
// `next build` evaluates no runtime config. The handler reads no `process.env` directly —
// config flows through the injected seams, or in production through `loadConfig()` /
// `getServerDb()` at request time (INV-103).

import { parseBody, HttpError } from "../http/validate";
import { loadConfig } from "../config";
import { getServerDb } from "../db/server";
import { verifySession, COOKIE_NAME, type Session } from "../auth/session";
import { getUserById } from "../db/users";
import { selectKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { systemClock, type Clock } from "../seams/clock";
import { exportDocumentSchema } from "../export/schema";
import { importExportDocument } from "./import";
import type { Db } from "../db/index";

// A generous default upload cap — an export legitimately carries a whole account's
// content and its activity history. An oversized body is refused at the byte boundary
// before it is parsed (INV-102); a tighter per-call cap can be injected.
const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024; // 16 MiB

// The injectable seams, each optional with a production default resolved lazily below.
export interface ImportHandlerSeams {
  // Resolve the session from the request (server-verified; INV-101). Production reads the
  // host-locked cookie and verifies it over the shared database.
  readonly resolveSession?: (request: Request) => Promise<Session | null>;
  // The shared database (every query parameter-bound; INV-102).
  readonly db?: Db;
  // The created-at the dated stores stamp during the restore.
  readonly clock?: Clock;
  // Unwraps the person's wrapped DEK to encrypt the restored content.
  readonly keyWrapper?: KeyWrapper;
  // The upload size cap; an oversized body is a 4xx before parsing.
  readonly maxBodyBytes?: number;
}

// --- production defaults ------------------------------------------------------------

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

// The real session resolver: read the host-locked session cookie and verify it
// server-side over the process-wide database (never trusting any other client value —
// INV-101). The database is taken lazily, per request, so importing this module boots
// nothing.
async function defaultResolveSession(request: Request): Promise<Session | null> {
  const token = readCookie(request, COOKIE_NAME);
  if (token == null) return null;
  const db = await getServerDb();
  return verifySession(db, token, { clock: systemClock });
}

// The KeyWrapper from validated config (local AES-256 outside production; Key Vault in
// production). Read at request time, never at module load (`next build` has no runtime
// config), and only when no wrapper is injected — so tests reading no config never touch
// `process.env`.
function defaultKeyWrapper(): KeyWrapper {
  const config = loadConfig();
  return selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
}

// --- responses ----------------------------------------------------------------------

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// --- the handler --------------------------------------------------------------------

export function createImportHandler(
  seams: ImportHandlerSeams = {},
): { POST(request: Request): Promise<Response> } {
  const resolveSession = seams.resolveSession ?? defaultResolveSession;

  async function POST(request: Request): Promise<Response> {
    const clock = seams.clock ?? systemClock;

    try {
      // 1. Auth boundary (INV-101): a server-verified session, or nothing happens —
      //    identity is the session's user id, never a client value.
      const session = await resolveSession(request);
      if (session == null) {
        return json(401, { error: "unauthenticated" });
      }

      // 2. Validate the body against the E16-S01 schema: an oversized body, malformed
      //    JSON, or a wrong-version / mis-shaped document is a 4xx before any write
      //    (INV-102).
      const document = await parseBody(exportDocumentSchema, request, {
        maxBytes: seams.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      });

      const db = seams.db ?? (await getServerDb());
      const keyWrapper = seams.keyWrapper ?? defaultKeyWrapper();

      // Resolve the person's unwrapped DEK (member-scoped by the session user): read their
      // wrapped DEK and unwrap it through the KeyWrapper seam. It encrypts the restored
      // content.
      const user = await getUserById(db, session.userId);
      if (user == null) {
        return json(401, { error: "unauthenticated" });
      }
      const dek = await keyWrapper.unwrap(user.wrappedDek);

      // 3. Write the document into the SESSION user's account via the import service.
      await importExportDocument(db, session.userId, document, dek, clock);

      return json(200, { status: "imported" });
    } catch (error) {
      // The input boundary throws exactly HttpError (always a 4xx), so a malformed /
      // oversized / wrong-version body maps to a client error, never an uncontrolled 500.
      if (error instanceof HttpError) {
        return json(error.status, { error: "invalid_request" });
      }
      throw error;
    }
  }

  return { POST };
}
