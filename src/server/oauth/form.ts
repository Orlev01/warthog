// The form-urlencoded body of the unauthenticated OAuth endpoints (/oauth/token RFC 6749
// §3.2, /oauth/revoke RFC 7009 §2.1), read under a streaming size cap (review fix F2):
// `request.text()` buffered whatever an anonymous caller sent before anything checked
// its size. Every legitimate request is a few hundred bytes, so 16 KiB is generous.

import { HttpError, readTextCapped } from "../http/validate";

export const OAUTH_FORM_MAX_BYTES = 16 * 1024;

// The parsed params, or the 413 response to return as-is when the body is too large.
export async function readOAuthForm(request: Request): Promise<URLSearchParams | Response> {
  try {
    return new URLSearchParams(await readTextCapped(request, OAUTH_FORM_MAX_BYTES));
  } catch (error) {
    if (error instanceof HttpError) {
      return new Response(JSON.stringify({ error: "invalid_request" }), {
        status: error.status,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    throw error;
  }
}
