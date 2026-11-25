// Rename one of the person's agents, from its Settings section (docs/adr/agent-names-and-providers.md).
// The injectable seam the thin `page.tsx` server action composes, as `./actions` and
// `../access-key/actions` are.
//
// The name is the person's own label for the agent: it shows on the Agents list, in Inbox,
// Activity, the agent's rules and what other agents read ("saved by …"). The platform is
// Warthog's record of how the agent connected, so a rename never touches it.
//
// Security (each a reviewer veto):
//   • The acting person is ALWAYS `session.userId`, never a value from the form. The agent
//     is resolved by (session.userId, agentId), so another person's agent id renames nothing.
//   • Input is checked at the boundary first: a malformed agent id is a 4xx `HttpError` before
//     any query, and a name that is empty, too long or holds a private value is refused
//     before anything is written.
//   • The rename, the copy of the name each of the agent's rules keeps, and the "Agent renamed"
//     activity entry commit together (`auditedOwnerChange`): a failed audit write leaves the
//     old name everywhere.

import { z } from "zod";

import { auditedOwnerChange } from "@/server/activity/owner-change";
import { getAgentById, renameAgent } from "@/server/db/agents";
import { renameRuleScopes } from "@/server/db/rules";
import { parseParams } from "@/server/http/validate";
import { normaliseAgentName } from "@/domain/agents/agent-name";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { Clock } from "@/server/seams/clock";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

export interface RenameActionsDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly keyWrapper: KeyWrapper;
}

export type RenameResult =
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly reason: "not_found" | "invalid_name" };

// A grossly oversized form value is refused at the boundary; the name rule then applies the
// real limit (AGENT_NAME_MAX) to the cleaned text.
const MAX_RAW_NAME = 2000;
const inputSchema = z.object({ agentId: z.uuid(), name: z.string().max(MAX_RAW_NAME) });

export function createRenameActions(deps: RenameActionsDeps) {
  const { db } = deps;

  async function rename(session: Session, agentId: string, rawName: string): Promise<RenameResult> {
    const input = parseParams(inputSchema, { agentId, name: rawName });
    const name = normaliseAgentName(input.name);
    if (name === null) return { ok: false, reason: "invalid_name" };
    const agent = await getAgentById(db, session.userId, input.agentId);
    if (agent === null) return { ok: false, reason: "not_found" };

    return auditedOwnerChange(deps, session.userId, async (tx, record): Promise<RenameResult> => {
      // Read the name again under the row lock, so two renames at once each record the name
      // they actually replaced.
      const locked = await tx.query(
        "SELECT display_name FROM agents WHERE user_id = $1 AND id = $2 FOR UPDATE",
        [session.userId, agent.id],
      );
      const row = locked.rows[0];
      if (!row) return { ok: false, reason: "not_found" };
      const from = String(row.display_name);
      if (from === name) return { ok: true, changed: false };
      await renameAgent(tx, session.userId, agent.id, name);
      await renameRuleScopes(tx, session.userId, agent.connectionId, name);
      await record("agent_renamed", { name: { from, to: name } }, agent.id);
      return { ok: true, changed: true };
    });
  }

  return { rename };
}

// What the Settings section says after a rename, keyed by the `?notice=` the page action
// redirects with. Plain words: what happened, and what to do when it didn't.
const NOTICES = {
  renamed: { tone: "success", text: "Name saved. It shows everywhere this agent appears in Warthog." },
  "rename-unchanged": { tone: "info", text: "That's already this agent's name, so nothing changed." },
  "rename-problem": {
    tone: "error",
    text: "We couldn't save that name. Use up to 200 characters, and leave out card numbers, codes and other private details.",
  },
} as const;

export type RenameNotice = (typeof NOTICES)[keyof typeof NOTICES];

/** The notice for a `?notice=` value, or null for anything else. */
export function renameNotice(raw: string | string[] | undefined): RenameNotice | null {
  return typeof raw === "string" && Object.hasOwn(NOTICES, raw) ? NOTICES[raw as keyof typeof NOTICES] : null;
}

/** The `?notice=` value for a rename's outcome. */
export function renameNoticeKey(result: RenameResult | null): keyof typeof NOTICES {
  if (result === null || !result.ok) return "rename-problem";
  return result.changed ? "renamed" : "rename-unchanged";
}
