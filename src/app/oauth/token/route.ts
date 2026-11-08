// The App-Router entry for `/oauth/token`: thin by design. The token endpoint is a
// POST with a form-urlencoded body (RFC 6749 §3.2), so this takes the process-wide db
// (`getServerDb()`), parses the body
// into params under a streaming size cap (`readOAuthForm`) and delegates the grant
// logic to the tested `exchangeToken` seam. A `route.ts` may export ONLY the known
// route keys, so the testable logic stays in the sibling server module
// `src/server/oauth/token.ts` (OBS-025); this file exports just `POST`.

import { loadConfig } from "../../../server/config";
import { getServerDb } from "../../../server/db/server";
import { readOAuthForm } from "../../../server/oauth/form";
import { exchangeToken } from "../../../server/oauth/token";
import { systemClock } from "../../../server/seams/clock";
import { systemRandom } from "../../../server/seams/random";

// Token responses must not be cached — they carry bearer credentials (RFC 6749 §5.1).
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store" };

export async function POST(request: Request): Promise<Response> {
  const params = await readOAuthForm(request);
  if (params instanceof Response) return params;
  const db = await getServerDb();

  const result = await exchangeToken(
    { params },
    { db, clock: systemClock, random: systemRandom, hmacKey: loadConfig().hmacKey },
  );

  if (result.ok) {
    return new Response(JSON.stringify(result.body), { status: 200, headers: JSON_HEADERS });
  }
  return new Response(JSON.stringify({ error: result.error }), {
    status: 400,
    headers: JSON_HEADERS,
  });
}
