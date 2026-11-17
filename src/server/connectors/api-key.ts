// E09-S07 — API-key connections (design §7 "Connector engine"). Most of the catalogue
// connects with the person's OWN key or personal token (`auth_kind: api_key | basic`).
// This is the save-key path that
//   1. stores the person's key DEK-encrypted on a NEW connection (`../db/connections`,
//      `../crypto/envelope`), owned by the session's `userId`, and
//   2. when the catalogue entry declares an optional `verify` request, RUNS it first — a
//      2xx response marks the connection "connected"; a non-2xx response or a transport
//      failure marks it "error" with a plain, key-free reason — so a key is confirmed to
//      work before it is relied on.
//
// The provider HOST is taken ONLY from the catalogue entry's `base_url` — never a value
// from a caller (CLAUDE.md security: "Connector requests never take a host from the
// caller"). The person's key is injected into the entry's header TEMPLATE
// (`auth.header`, e.g. `Authorization: Bearer {api_key}`) and rides there as an opaque
// value; it never influences where the verify request is sent and never reaches the URL.
//
// The DEK, the clock (connectedAt, never Date.now()) and the HTTP fetch (SSRF-guarded in
// production, recorded in tests) are all injected seams, so this module reads no
// `process.env` and holds no key (INV-103); tests freeze time and record requests without
// touching the network. Every write is parameterized through the `Db` seam (INV-102).

import type { CatalogueEntry } from "../../domain/catalogue/schema";
import {
  createConnection,
  type Connection,
  type ConnectionStatus,
} from "../db/connections";
import type { Db } from "../db/index";
import { pinAgentsToSoleAccount } from "../db/agent-permissions";
import type { Clock } from "../seams/clock";

// The injected seams: the parameterizing data access, the clock (connected-at, never
// Date.now()), and the HTTP fetch (SSRF-guarded in production, recorded in tests).
export interface ApiKeyClientDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly fetch: typeof fetch;
}

// What saving a key needs. `userId` is always the session's id (never a client value);
// the host, header template and optional verify request come only from `entry`.
export interface SaveApiKeyInput {
  readonly entry: CatalogueEntry;
  readonly userId: string;
  readonly accountLabel: string;
  readonly apiKey: string;
  readonly dek: Uint8Array;
}

// The created connection — WITHOUT credentials (that shape is enforced by the store) —
// plus a plain, key-free `reason` present IFF the verify failed (status === "error").
export interface SaveApiKeyResult {
  readonly connection: Connection;
  readonly reason?: string;
}

// The outcome of a verify request: the status the connection lands in, and a plain,
// key-free reason when it failed.
interface VerifyOutcome {
  readonly status: ConnectionStatus;
  readonly reason?: string;
}

// Build the entry's templated auth header with the person's key injected in place of the
// `{api_key}` placeholder. The template is `Name: value` (design §7); split on the first
// colon so a value that itself contains a colon survives. Returns null when the entry
// declares no header template (nothing to inject).
function buildAuthHeader(
  template: string | undefined,
  apiKey: string,
): { name: string; value: string } | null {
  if (!template) return null;
  const colon = template.indexOf(":");
  if (colon < 0) return null;
  const name = template.slice(0, colon).trim();
  const value = template.slice(colon + 1).trim().split("{api_key}").join(apiKey);
  return { name, value };
}

// Run the entry's verify request at the ENTRY's host (host from the entry only) and
// classify the outcome. A 2xx → connected (no reason); a non-2xx or a transport failure →
// error with a plain reason built from the status alone — never the key or the provider's
// raw body, so the key can never leak into the reason.
async function verifyKey(
  entry: CatalogueEntry,
  apiKey: string,
  fetchFn: typeof fetch,
): Promise<VerifyOutcome> {
  const verify = entry.verify!;
  // The host is the entry's `base_url`; `verify.path` only ever sets the path. The key
  // is never part of the URL.
  const url = new URL(verify.path, entry.base_url);
  const method = verify.method ?? "GET";

  const headers: Record<string, string> = {};
  const header = buildAuthHeader(entry.auth.header, apiKey);
  if (header) headers[header.name] = header.value;

  try {
    const response = await fetchFn(url.href, { method, headers });
    if (response.ok) return { status: "connected" };
    return {
      status: "error",
      reason: `The service rejected the key (HTTP ${response.status}).`,
    };
  } catch {
    return { status: "error", reason: "Could not reach the service to verify the key." };
  }
}

// Store the person's key DEK-encrypted on a NEW connection owned by `userId`, running the
// entry's optional verify request first. With no verify request the connection is
// "connected" directly and no outbound call is made; with one, the verify outcome sets the
// status (and a reason on failure). The key is stored either way (so the person can retry
// after an error) and is NEVER returned in the Connection.
export async function saveApiKeyConnection(
  input: SaveApiKeyInput,
  deps: ApiKeyClientDeps,
): Promise<SaveApiKeyResult> {
  const outcome: VerifyOutcome = input.entry.verify
    ? await verifyKey(input.entry, input.apiKey, deps.fetch)
    : { status: "connected" };

  // Agents that use the service keep the account they use today (another account is added).
  await pinAgentsToSoleAccount(deps.db, input.userId, input.entry.id);
  const connection = await createConnection(
    deps.db,
    {
      userId: input.userId,
      connectorId: input.entry.id,
      accountLabel: input.accountLabel,
      credentials: { api_key: input.apiKey },
      status: outcome.status,
    },
    input.dek,
    deps.clock,
  );

  return outcome.reason !== undefined ? { connection, reason: outcome.reason } : { connection };
}
