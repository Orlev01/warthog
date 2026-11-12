import { z } from "zod";
import { readAgentSpending } from "@/server/spending/agent-spending";
import { formatAccountTime } from "@/server/display-time";
import { relativeDayTime } from "@/domain/display-time";
import { timeZoneFor } from "@/server/spending/time-zone";
// E10-S11 — Agents list page loader + disconnect wiring (the injectable, unit-testable
// seam the thin `page.tsx` loader + its `use server` disconnect wrapper compose, the
// convention's `createXActions(deps)` factory — as `[id]/actions.ts`, `access-key/
// actions.ts`, `settings/security/actions.ts` and `home/actions.ts` do). A Next entry
// file may export only its framework fields, so the flow logic lives here and the entry
// stays thin (OBS-025).
//
// The Agents screen (brief "Agents screen"; design §6.1; CLAUDE.md vocabulary — an
// *agent* is a connected AI client, ONE ROW PER CONNECTION) lists EVERY one of the
// person's agents and, on each, mounts the one-click Disconnect control (E10-S09) and a
// per-agent link. `load` assembles the view's props (an already-formatted
// AgentListItem per agent); `disconnect` drives the real one-click disconnect operation
// (src/server/agents/disconnect — its own exhaustive test).
//
// Security (each a reviewer veto):
//   • Every read/write is member-scoped by `session.userId` — never a client value
//     (CLAUDE.md). `load` reads the LIST-ALL primitive `listAgentsForUser` bound to the
//     session's id, so another person's agents can never appear; `disconnect` delegates
//     to `disconnectAgent`, which resolves the agent by (session.userId, agentId) FIRST,
//     so another person's agent id is refused with their agent left wholly working.
//   • Input is validated at the boundary: `disconnectAgent` shape-guards the agent id
//     (zod uuid → a 4xx `HttpError`) BEFORE any query, so a malformed / oversized /
//     SQL-shaped id is refused before it can reach `WHERE id = $1` as a cast (OBS-049,
//     INV-102). Every id travels bound as a query parameter, so a SQL-shaped id is data,
//     never statement text.
//   • This module reads no `process.env` and holds no secret (INV-103): the db, clock,
//     release store and per-user DEK lookup are all INJECTED, so no ambient env value can
//     leak into the loaded list or the recorded disconnection.

import { getAgentById, listAgentsForUser, type Agent } from "@/server/db/agents";
import { getConnectionPermissions, type ConnectionPermissions } from "@/server/db/agent-permissions";
import { disconnectAgent } from "@/server/agents/disconnect";
import { hasAccessKey } from "@/server/agents/access-key-state";
import type { AgentListItem } from "@/components/agents/agent-list-view";
import type { Db } from "@/server/db/index";
import type { Clock } from "@/server/seams/clock";
import type { ReleaseStore } from "@/server/crypto/release-store";
import type { Session } from "@/server/auth/session";

// Every seam injected — no process.env, no secret (INV-103).
export interface AgentsActionsDeps {
  // The one db handle every read/write runs through.
  readonly db: Db;
  // Supplies the one-click disconnect's decided-at / occurred-at instants (never SQL
  // now()); passed through to `disconnectAgent`.
  readonly clock: Clock;
  // The in-memory release store whose uncollected release the disconnect cancels.
  readonly releaseStore: ReleaseStore;
  // The acting person's already-unwrapped DEK (the disconnect's activity write + approval
  // denial consume it); injected, so this module holds no key.
  readonly dekFor: (userId: string) => Promise<Uint8Array>;
}

// The outcome of a disconnect: success, or a refusal naming its reason (the agent is not
// this person's / does not exist). Never a silent success.
export type DisconnectActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

// The agents-list actions the thin loader + its `use server` disconnect wrapper drive.
export interface AgentsActions {
  // Assemble the Agents screen's props for the SESSION user's own agents — the view's
  // props object (an `agents` array of already-formatted AgentListItem). The page adds the
  // bound disconnect action when it mounts <AgentListView/>.
  load(session: Session): Promise<{ agents: ReadonlyArray<AgentListItem> }>;
  // Disconnect ONE of the session user's own agents (composing the one-click disconnect
  // operation). A malformed / oversized / SQL-shaped id throws a 4xx `HttpError` at the
  // boundary before any query; another person's agent id is refused ({ ok: false }).
  disconnect(session: Session, agentId: string): Promise<DisconnectActionResult>;
}

// The agent store's status vs. the UI's StatusKey: a connected agent reads "Connected"; a
// disconnected one reads "Disconnected". It is not "Reconnect needed": an agent connection
// has no renewal (the store knows only these two states), and "Connect it again" makes a
// new connection rather than reviving this one.
function toStatusKey(status: Agent["status"]): AgentListItem["status"] {
  return status === "connected" ? "connected" : "disconnected";
}


// Build the view's props for one agent from its plaintext metadata and its stored grants
// (for the budget). An agent with no grants row is NOT dropped — its budget simply reads
// as none yet.
function toListItem(agent: Agent, grants: ConnectionPermissions | null, timeZone: string, now: Date): AgentListItem {
  const lastActive = agent.lastActiveAt != null ? new Date(agent.lastActiveAt) : null;
  return {
    id: agent.id,
    name: agent.displayName,
    platform: agent.platform,
    status: toStatusKey(agent.status),
    connectedAt: formatAccountTime(agent.connectedAt, timeZone, { dateOnly: true }),
    // "Today, 6:17 pm", the same wording Home uses for "last active" (content-05).
    lastActiveAt: lastActive != null && Number.isFinite(lastActive.getTime()) ? relativeDayTime(lastActive.toISOString(), timeZone, now) : null,
    requestCount: agent.requestCount,
    spendThisPeriod: 0,
    budget: grants?.cardBudget?.amount ?? 0,
    budgetPeriod: grants?.cardBudget?.period ?? "month",
    // The per-agent link carries THIS agent's row id, distinct per agent — the agent's
    // own permissions page (`[id]/page.tsx`).
    activityHref: `/activity?agent=${agent.id}`,
    currency: grants?.cardBudget?.currency ?? "AUD",
    hasBudget: grants?.cardBudget != null,
  };
}

export function createAgentsActions(deps: AgentsActionsDeps): AgentsActions {
  const { db, clock, releaseStore, dekFor } = deps;

  // Load: read the session user's OWN agents (the list-all primitive, member-scoped by
  // session.userId — never a client value) and format each for the view, reading its
  // stored grants for the budget.
  async function load(session: Session): Promise<{ agents: ReadonlyArray<AgentListItem> }> {
    const timeZone = await timeZoneFor(db, session.userId, await dekFor(session.userId));
    const agents = await listAgentsForUser(db, session.userId);
    const items: AgentListItem[] = [];
    for (const agent of agents) {
      const grants = await getConnectionPermissions(db, session.userId, agent.connectionId);
      const spend = grants?.cardBudget ? await readAgentSpending(db, session.userId, agent.connectionId, grants.cardBudget, clock.now(), timeZone) : null;
      // Whether it holds a working access key (only checked for presence), so Disconnect's
      // confirmation can point to replacing the key instead.
      const accessKey = agent.status === "connected" && (await hasAccessKey(db, agent.connectionId));
      items.push({ ...toListItem(agent, grants, timeZone, clock.now()), spendThisPeriod: spend?.total ?? 0, spendIncomplete: (spend?.unconverted.length ?? 0) > 0, accessKey });
    }
    return { agents: items };
  }

  // Disconnect: delegate to the real one-click disconnect operation. It validates the id
  // at the boundary (a 4xx before any query), resolves the agent member-scoped (another
  // person's id is refused), and on success disconnects it in one transaction. Drop the
  // echoed agent id from its confirmation — the screen only needs ok / the reason.
  async function disconnect(session: Session, agentId: string): Promise<DisconnectActionResult> {
    // An agent that is already disconnected is reported as such, never as a fresh success
    // (interaction-08: a stale page's second Disconnect said "Agent disconnected." again).
    // A malformed id skips this read and is refused by disconnectAgent's own boundary.
    if (z.uuid().safeParse(agentId).success) {
      const existing = await getAgentById(db, session.userId, agentId);
      if (existing && existing.status !== "connected") return { ok: false, reason: "not_connected" };
    }
    const result = await disconnectAgent({ db, clock, releaseStore, dekFor }, session, agentId);
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  return { load, disconnect };
}
