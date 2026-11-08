// The HTTP input-validation boundary. Every route handler validates external
// input HERE before it reaches a query or a render (constitution:
// validate-and-parameterize-input, INV-102 — the VALIDATE half; the PARAMETERIZE
// half lives on the db seam, which binds values rather than concatenating them).
//
// The boundary throws exactly one error type — `HttpError`, always carrying a 4xx
// status — so a route's catch-all maps a rejection to a 4xx Response and NEVER
// lets a raw `SyntaxError` (malformed JSON) or a zod failure escape as an
// uncontrolled 500. A mis-shaped id is rejected here, never cast at `WHERE id = $1`
// (OBS-049). This module reads no `process.env` and holds no secret: config flows
// from `src/server/config.ts` alone (INV-103), so no env value can leak into a
// parsed result or an error message.

import { z } from "zod";

// A grossly oversized body is rejected even without a caller-supplied cap, so the
// 2-arg form of `parseBody` is never left unprotected. A tighter per-route cap is
// supplied through `opts.maxBytes`.
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB

// The one error the boundary throws. `status` is always in the 4xx range, so a
// catch-all mapping it to a Response yields a client error, never a 500.
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export interface ParseBodyOptions {
  // Maximum size of the request body in bytes; a larger body is rejected with a
  // 4xx before it is parsed. Defaults to `DEFAULT_MAX_BYTES`.
  readonly maxBytes?: number;
}

// Read the request's JSON body and validate it against `schema`. Rejects with a
// 4xx `HttpError` for an oversized body, malformed JSON, or a schema violation;
// returns the parsed, typed value for a well-formed body.
export async function parseBody<S extends z.ZodType>(
  schema: S,
  request: Request,
  opts?: ParseBodyOptions,
): Promise<z.infer<S>> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;

  const raw = await readTextCapped(request, maxBytes);

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // Turn the driver's SyntaxError into the boundary's own 4xx so a catch-all
    // never maps it to a 500.
    throw new HttpError(400, "Malformed JSON in request body");
  }

  return parse(schema, json, "Invalid request body");
}

// Read an untrusted request body as UTF-8 text, enforcing `maxBytes` WHILE reading: a declared
// Content-Length over the cap is refused before a single byte is read, and a streamed body is
// cancelled as soon as the running byte count crosses the cap, so an oversized (or lying)
// request is never buffered whole. Rejects with a 413 `HttpError`. Every route that reads a raw
// body (JSON through `parseBody`, form-encoded OAuth endpoints directly) goes through here —
// never `request.text()` on untrusted input.
export async function readTextCapped(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new HttpError(413, "Request body too large");
  }

  const reader = request.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "Request body too large");
    }
    chunks.push(value);
  }
  // Decode once over the whole body so a multi-byte character split across chunks survives.
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Validate already-materialised path params (e.g. `{ id }`) against their declared
// shape. A non-conforming value throws a 4xx `HttpError` and never returns a cast
// value that could reach a query (OBS-049).
export function parseParams<S extends z.ZodType>(schema: S, params: unknown): z.infer<S> {
  return parse(schema, params, "Invalid request parameters");
}

// Run a zod schema over already-decoded input, turning any failure into the
// boundary's own 4xx. The message is a fixed string (never zod's detail), so no
// input or ambient value can leak through it.
function parse<S extends z.ZodType>(schema: S, input: unknown, message: string): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new HttpError(400, message);
  }
  return result.data;
}
