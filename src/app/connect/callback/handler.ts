import type { ProviderFlow } from "../../../server/connectors/provider-runtime";
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
import { pendingConnects } from "../../../server/connectors/pending";
import { createConnectorRuntime } from "../../../server/connectors/runtime";

// The connect-start secrets stashed for a pending provider sign-in — NOT the user id (the
// lookup is already scoped by the session user, so the flow needn't carry it).
export interface PendingConnectFlow {
  readonly providerState?:ProviderFlow["providerState"];
  readonly reconnectId?:string;
  readonly connectorId: string;
  readonly accountLabel: string;
  readonly codeVerifier: string;
}

// What the callback hands the exchange/store step. `userId` is ALWAYS the session's.
export interface CompleteConnectionInput extends PendingConnectFlow {
  readonly iss?:string;
  readonly state: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly accountLabel: string;
  readonly code: string;
  readonly codeVerifier: string;
}

// The injectable seams, each optional with a production default (below).
export interface ConnectCallbackSeams {
  readonly resolveSession?: (request: Request) => Promise<Session | null>;
  readonly takePendingFlow?: (userId: string, state: string, sessionId?: string) => Promise<PendingConnectFlow | null>;
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
  iss: z.string().min(1).max(MAX_FIELD).optional(),
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

// Consume a session-bound single-use flow, including durable provider MCP state.
async function defaultTakePendingFlow(userId: string, state: string, sessionId?: string): Promise<PendingConnectFlow | null> {
  if (!sessionId) return null;
  return pendingConnects().take(userId,sessionId,state) ?? await createConnectorRuntime({config:loadConfig(),db:await getServerDb()}).takeProvider(userId,sessionId,state);
}

// Exchange and persist through the connector runtime after the state check.
async function defaultCompleteConnection(input: CompleteConnectionInput, config: Config): Promise<Connection> {
  return createConnectorRuntime({ config, db: await getServerDb() }).complete(input);
}

// --- responses ----------------------------------------------------------------------

function appUrl(config: Config, path: string): string {
  return new URL(path, config.publicBaseUrl).href;
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

function badRequest(message: string): Response {
  return new Response(message, {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

// --- the handler --------------------------------------------------------------------

export function createConnectCallbackHandler(
  seams: ConnectCallbackSeams = {},
): { GET(request: Request): Promise<Response> } {
  const resolveSession = seams.resolveSession ?? defaultResolveSession;
  const takePendingFlow = seams.takePendingFlow ?? defaultTakePendingFlow;
  const completeConnection = seams.completeConnection;

  async function GET(request: Request): Promise<Response> {
    const config = seams.config ?? loadConfig();

    // 1. Auth boundary (INV-101): a server-verified session, or nothing happens — no flow
    //    lookup, no exchange. An unauthenticated request is sent to sign in.
    const session = await resolveSession(request);
    if (session == null) {
      return redirect(appUrl(config, "/signin"));
    }

    const query = new URL(request.url).searchParams;
    if (query.has("error")) {
      const state = query.get("state");
      if (!state || state.length > MAX_FIELD || !(await takePendingFlow(session.userId, state, session.id))) return badRequest("This sign-in link has expired or is invalid.");
      return redirect(appUrl(config, "/connectors?notice=connection-declined"));
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
    const flow = await takePendingFlow(session.userId, state, session.id);
    if (flow == null) {
      return badRequest("This sign-in link has expired or is invalid. Please try connecting again.");
    }

    // 4. Exchange the code and store the connection, bound to the SESSION user: the
    //    connector/label/verifier come from the stashed flow, the code from the query.
    const input = {
      userId: session.userId,
      state,
      connectorId: flow.connectorId,
      accountLabel: flow.accountLabel,
      code,
      codeVerifier: flow.codeVerifier,
      ...(flow.providerState ? {providerState:flow.providerState,reconnectId:flow.reconnectId} : {}),
      ...(parsed.data.iss ? {iss:parsed.data.iss} : {}),
    };
    if (completeConnection) await completeConnection(input);
    else {
      try { await defaultCompleteConnection(input, config); }
      catch { return redirect(appUrl(config, "/connectors?notice=problem")); }
    }

    // Land the person back in the app — never bounced to the provider.
    return redirect(appUrl(config, "/connectors"));
  }

  return { GET };
}
