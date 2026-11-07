// E17-S10 — Dev fake agent console: the provisioning seam the thin `page.tsx` loader
// composes (design §12 dev tools; INV-102 validate-and-parameterize-input, INV-103
// secrets-from-env; constitution 16 per-agent access keys, constitution 21 public address
// from config).
//
// Behind the dev-tools guard (enforced in `page.tsx`) it "mints or reads a dev access key"
// and names the `/mcp` endpoint the console POSTs tool calls to.
//
// Why a sibling `actions.ts` (not `page.tsx`): a Next App-Router `page.tsx` entry may
// export ONLY its framework fields, so an injectable, unit-testable seam cannot live on the
// entry without breaking `next build` (OBS-025). The loader builds this factory from
// `getServerDb()` + `loadConfig()` at request time (the convention's `createXActions(deps)`
// pattern, as the sibling sign-in-as handler does).
//
// The key reuses the SAME credential path `/mcp` verifies — a genuine `wh_ak_` bearer
// minted through `issueAccessKey`, stored ONLY as its SHA-256 hash in `oauth_access_keys`
// and bound to one connection id, so it resolves through `verifyAccessKey` / `verifyBearer`
// exactly as any agent's key does (AC3) — NOT a parallel credential path. The raw key is
// runtime entropy from the injected `random` seam (INV-103: never a source literal), and
// the endpoint is built from the configured public base URL (constitution 21), never a code
// literal.

import { randomUUID } from "node:crypto";

import { issueAccessKey } from "../../../server/oauth/access-key";
import type { Config } from "../../../server/config";
import type { Clock } from "../../../server/seams/clock";
import type { Random } from "../../../server/seams/random";
import type { Db } from "../../../server/db/index";

// Every seam a real injected value, so the loader can build this from `getServerDb()`,
// the system clock/random and `loadConfig()` (the ONE env reader; INV-103).
export interface AgentConsoleActionsDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  readonly config: Config;
}

export interface AgentConsoleActions {
  load(): Promise<{ accessKey: string; endpoint: string }>;
}

// The `/mcp` agent endpoint, built from the configured public base URL (trailing slash
// stripped) — the public address comes from configuration, never a code literal
// (constitution 21).
function mcpEndpoint(config: Config): string {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/mcp`;
}

export function createAgentConsoleActions(deps: AgentConsoleActionsDeps): AgentConsoleActions {
  const { db, random, config } = deps;

  async function load(): Promise<{ accessKey: string; endpoint: string }> {
    // Mint a dev access key through the REAL per-agent access-key mechanism: a fresh
    // connection id bound to a genuine `wh_ak_` bearer whose hash lands in the real
    // `oauth_access_keys` table, so it verifies through `verifyAccessKey` / `verifyBearer`
    // exactly as an agent's key does — not a parallel dev-only store.
    const connectionId = randomUUID();
    const { key } = await issueAccessKey(db, { connectionId }, { random });
    return { accessKey: key, endpoint: mcpEndpoint(config) };
  }

  return { load };
}
