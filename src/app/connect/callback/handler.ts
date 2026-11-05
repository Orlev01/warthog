// E09-S18 — Provider OAuth callback handler (design §7 connector engine; constitution
// 15/16; INV-101 admin-auth-required, INV-102 validate-and-parameterize-input,
// INV-103 secrets-from-env).
//
// A provider sign-in connection (Google, Microsoft, …) sends the person back to Warthog
// after consent, landing here as a GET with `?code=…&state=…`. This is a SERVER AUTH
// BOUNDARY: it verifies the signed-in session, validates the CSRF `state` against the
// pending flow connect-start stashed FOR THAT PERSON, exchanges the authorization code
// through the OAuth connector client, and stores the connection — always bound to the
// SESSION user, never a value from the request.
//
// A Next App-Router `route.ts` may export ONLY the known route keys (the HTTP verbs +
// framework config) or `next build` rejects it (OBS-025), so the injectable factory lives
// HERE, in the sibling module; `route.ts` imports it and exports only `GET`. Every seam is
// optional with a production default, so the sibling entry can compose it with no wiring
// and the tests can drive the route's own job (auth gate + state validation +
// orchestration) without the composition root. Config and the database are resolved
// LAZILY per request (never at construction/import), so importing the entry never boots a
// database and `next build` never evaluates runtime config.

import { z } from "zod";

import { loadConfig, type Config } from "../../../server/config";
import { getServerDb } from "../../../server/db/server";
import { verifySession, COOKIE_NAME, type Session } from "../../../server/auth/session";
import { systemClock } from "../../../server/seams/clock";
import type { Connection } from "../../../server/db/connections";

// The connect-start secrets stashed for a pending provider sign-in — NOT the user id (the
// lookup is already scoped by the session user, so the flow needn't carry it).
export interface PendingConnectFlow {
  readonly connectorId: string;
  readonly accountLabel: string;
  readonly codeVerifier: string;
}

// What the callback hands the exchange/store step. `userId` is ALWAYS the session's.
export interface CompleteConnectionInput {
  readonly userId: string;
  readonly connectorId: string;
  readonly accountLabel: string;
  readonly code: string;
  readonly codeVerifier: string;
}

// The injectable seams, each optional with a production default (below).
export interface ConnectCallbackSeams {
  readonly resolveSession?: (request: Request) => Promise<Session | null>;
  readonly takePendingFlow?: (userId: string, state: string) => Promise<PendingConnectFlow | null>;
  readonly completeConnection?: (input: CompleteConnectionInput) => Promise<Connection>;
  readonly config?: Config;
}

// The provider redirect carries two short opaque values. Both are required (the CSRF
// `state` is mandatory), each capped so an oversized value is a bad request, never a 500
// (INV-102). Content is NOT interpreted here — the state travels verbatim into the
// pending-flow lookup as a bound value.
const MAX_FIELD = 4096;
const callbackQuerySchema = z.object({
  code: z.string().min(1).max(MAX_FIELD),
  state: z.string().min(1).max(MAX_FIELD),
});

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

// The real session resolver: read the host-locked session cookie and verify it server-side
// over the process-wide database (never trusting any other client value — INV-101). The
// database is taken lazily, per request, so importing this module boots nothing.
async function defaultResolveSession(request: Request): Promise<Session | null> {
  const token = readCookie(request, COOKIE_NAME);
  if (token == null) return null;
  const db = await getServerDb();
  return verifySession(db, token, { clock: systemClock });
}

// No pending-flow store is composed yet (connect-start, which stashes a flow under
// (userId, state), is a sibling task). Until it wires a real `takePendingFlow`, a callback
// matches no flow for its session user and is cleanly rejected — never a false success.
async function defaultTakePendingFlow(): Promise<PendingConnectFlow | null> {
  return null;
}

// The exchange/store step is driven by the connector engine's composition (the catalogue
// entry for the host, the operator OAuth client, and the person's data key), wired when
// connect-start lands. The default is unreachable in the default composition (no flow is
// ever found above), and fails loudly rather than silently if ever reached.
async function defaultCompleteConnection(): Promise<Connection> {
  throw new Error("connect-callback: completeConnection seam is not composed");
}

// --- responses ----------------------------------------------------------------------

function appUrl(config: Config, path: string): string {
  return new URL(path, config.publicBaseUrl).href;
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

function badRequest(message: string): Response {
  return new Response(message, {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

// --- the handler --------------------------------------------------------------------

export function createConnectCallbackHandler(
  seams: ConnectCallbackSeams = {},
): { GET(request: Request): Promise<Response> } {
  const resolveSession = seams.resolveSession ?? defaultResolveSession;
  const takePendingFlow = seams.takePendingFlow ?? defaultTakePendingFlow;
  const completeConnection = seams.completeConnection ?? defaultCompleteConnection;

  async function GET(request: Request): Promise<Response> {
    const config = seams.config ?? loadConfig();

    // 1. Auth boundary (INV-101): a server-verified session, or nothing happens — no flow
    //    lookup, no exchange. An unauthenticated request is sent to sign in.
    const session = await resolveSession(request);
    if (session == null) {
      return redirect(appUrl(config, "/signin"));
    }

    // 2. Validate the provider's redirect query (INV-102): a missing or oversized value is
    //    a bad request, never a 500, before any flow lookup or exchange.
    const parsed = callbackQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success) {
      return badRequest("This sign-in link is missing a value or is malformed.");
    }
    const { code, state } = parsed.data;

    // 3. Validate the CSRF state against the flow THIS session user stashed at
    //    connect-start — looked up by (SESSION userId, state), never the state alone. A
    //    state that maps to no flow for this user (missing, expired, forged, or another
    //    person's) completes nothing.
    const flow = await takePendingFlow(session.userId, state);
    if (flow == null) {
      return badRequest("This sign-in link has expired or is invalid. Please try connecting again.");
    }

    // 4. Exchange the code and store the connection, bound to the SESSION user: the
    //    connector/label/verifier come from the stashed flow, the code from the query.
    await completeConnection({
      userId: session.userId,
      connectorId: flow.connectorId,
      accountLabel: flow.accountLabel,
      code,
      codeVerifier: flow.codeVerifier,
    });

    // Land the person back in the app — never bounced to the provider.
    return redirect(appUrl(config, "/connectors"));
  }

  return { GET };
}
