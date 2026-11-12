// E17-S11 — Dev agent console provisions a REAL agent for the signed-in person (design
// §12 dev tools; INV-102 validate-and-parameterize-input, INV-103 secrets-from-env;
// constitution 16 per-agent access keys, constitution 21 public address from config).
//
// Supersedes E17-S10: the console used to mint a bare `wh_ak_` key for a RANDOM connection
// with NO agent behind it, so every `tools/call` was refused "This agent is not connected."
// It now PROVISIONS a real dev agent FOR THE SIGNED-IN PERSON through the already-built
// per-agent access-key mechanism (`createAccessKeyActions.create`, with sensible default
// permissions), ONCE per person and then REUSED on reload.
//
// Why a sibling `actions.ts` (not `page.tsx`): a Next App-Router `page.tsx` entry may
// export ONLY its framework fields, so an injectable, unit-testable seam cannot live on the
// entry without breaking `next build` (OBS-025). The thin loader reads the process-wide
// database (`getServerDb()`), the signed-in session (from the `__Host-wh_session` cookie)
// and config at request time, then builds this factory and renders the view.
//
// The provisioned key reuses the SAME credential path `/mcp` verifies — a genuine `wh_ak_`
// bearer stored ONLY as its SHA-256 hash in `oauth_access_keys` and bound to the one
// connection of a real, CONNECTED agent OWNED BY the person — so it resolves through
// `verifyAccessKey` / `verifyBearer` exactly as any agent's key does, NOT a parallel
// credential path. The raw key is runtime entropy from the injected `random` seam (INV-103:
// never a source literal), and the endpoint is built from the configured public base URL
// (constitution 21), never a code literal.

import { randomBytes } from "node:crypto";

import { createAccessKeyActions } from "../../(portal)/(protected)/agents/access-key/actions";
import { listAgentsForUser } from "../../../server/db/agents";
import { createUser, getUserByEmail } from "../../../server/db/users";
import { selectKeyWrapper } from "../../../server/crypto/key-wrapper";
import type { Config } from "../../../server/config";
import type { Clock } from "../../../server/seams/clock";
import type { Random } from "../../../server/seams/random";
import type { Db } from "../../../server/db/index";
import type { Session } from "../../../server/auth/session";

// Every seam a real injected value, so the loader can build this from `getServerDb()`,
// the system clock/random and `loadConfig()` (the ONE env reader; INV-103).
export interface AgentConsoleActionsDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly random: Random;
  readonly config: Config;
}

export interface AgentConsoleActions {
  load(session: Session | null): Promise<{ accessKey: string; endpoint: string }>;
}

// The dev agent the console provisions is marked by this platform label, so a reload finds
// and reuses it rather than minting another. Its display name is the one the person sees in
// their Agents list.
const DEV_AGENT_NAME = "Dev console";
const DEV_AGENT_PLATFORM = "dev-console";

// "Sensible default permissions": the Standard template — which grants memory (so the
// console's `remember` stores a note the person then sees on /memory) and the low-tier
// profile, while keeping high-tier, card and learning-sharing off.
const DEV_AGENT_TEMPLATE = "standard";

// The self-contained dev fallback person, used when nobody is signed in (session == null —
// how the guarded page renders when there is no session). Keyed by a stable email so a
// reload reuses the SAME dev person and its one dev agent rather than piling up new ones.
const DEV_FALLBACK_EMAIL = "dev-console@warthog.local";

// The `/mcp` agent endpoint, built from the configured public base URL (trailing slash
// stripped) — the public address comes from configuration, never a code literal
// (constitution 21).
function mcpEndpoint(config: Config): string {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/mcp`;
}

export function createAgentConsoleActions(deps: AgentConsoleActionsDeps): AgentConsoleActions {
  const { db, clock, random, config } = deps;

  // The dev fallback person for a session-less load: the one with the stable dev email, or
  // a freshly created one with a DEK wrapped under the SAME KEK the MCP dispatch derives
  // from config (so its personal content encrypts/decrypts member-scoped just like a real
  // person's). Idempotent — a reload finds the existing person rather than creating another.
  async function fallbackSession(): Promise<Session> {
    let user = await getUserByEmail(db, DEV_FALLBACK_EMAIL);
    if (!user) {
      const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
      const wrappedDek = await keyWrapper.wrap(randomBytes(32));
      user = await createUser(db, { email: DEV_FALLBACK_EMAIL, wrappedDek });
    }
    const now = clock.now();
    return { id: `dev-console-${user.id}`, userId: user.id, createdAt: now, lastSeenAt: now, steppedUpAt: null };
  }

  // Provision (once per person) or reuse the signed-in person's dev agent, handing back a
  // working bearer for it. For a signed-in person the agent is OWNED BY `session.userId`;
  // with no session it is the self-contained dev fallback. Either way the agent and its key
  // go through the REAL per-agent access-key mechanism (`createAccessKeyActions`), so the
  // key verifies at `/mcp` and a tool call executes rather than being refused.
  async function load(session: Session | null): Promise<{ accessKey: string; endpoint: string }> {
    const owner = session ?? (await fallbackSession());
    const accessKeys = createAccessKeyActions({ db, clock, random, keyWrapper: selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek }) });

    // Reuse the one dev agent already provisioned for this person (marked by its platform),
    // re-issuing its key; otherwise create it with sensible default permissions.
    const existing = (await listAgentsForUser(db, owner.userId)).find(
      (agent) => agent.platform === DEV_AGENT_PLATFORM,
    );

    let accessKey: string;
    if (existing) {
      const replaced = await accessKeys.replace(owner, existing.id);
      if (!replaced.ok) {
        throw new Error(`agent-console: could not reuse the dev agent (${replaced.reason})`);
      }
      accessKey = replaced.key;
    } else {
      const created = await accessKeys.create(owner, {
        name: DEV_AGENT_NAME,
        platform: DEV_AGENT_PLATFORM,
        template: DEV_AGENT_TEMPLATE,
      });
      if (!created.ok) {
        throw new Error(`agent-console: could not provision the dev agent (${created.reason})`);
      }
      accessKey = created.key;
    }

    return { accessKey, endpoint: mcpEndpoint(config) };
  }

  return { load };
}
