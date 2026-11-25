// The Now view (docs/adr/agent-runs.md, amendment of 25 November 2026): the person's recent
// conversations across every agent, grouped by provider and agent. Pure: no I/O.
//
// Everything here comes from calls agents made to Warthog. "Active" means a conversation
// called Warthog recently, never that the app is running or what it does elsewhere.
//
// The order is fixed so a refresh never moves rows: providers in a set order, agents by name,
// conversations by when they started.

import { agentProvider } from "../brands";

// The conversations the view lists: those that called Warthog in the last day.
export const NOW_WINDOW_MS = 24 * 60 * 60_000;
// A conversation that called Warthog within this long is marked active.
export const ACTIVE_WINDOW_MS = 15 * 60_000;

// The providers most people use come first, in this order; any other provider follows by
// name, and agents that name none come last.
const PROVIDER_ORDER = ["claude", "chatgpt", "gemini"];

export interface NowAgent {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly status: "connected" | "disconnected";
}

export interface NowRun {
  readonly id: string;
  readonly agentId: string;
  readonly startedAt: string;
  readonly lastSeenAt: string;
}

// An agent's actions in the window that weren't in any conversation.
export interface NowUnlinked {
  readonly agentId: string;
  readonly count: number;
  readonly lastAt: string;
}

export interface NowAgentGroup<R extends NowRun> {
  readonly agent: NowAgent;
  readonly conversations: readonly { readonly run: R; readonly active: boolean }[];
  readonly unlinked: (NowUnlinked & { readonly active: boolean }) | null;
}

export interface NowProviderGroup<R extends NowRun> {
  readonly key: string;
  readonly label: string;
  readonly agents: readonly NowAgentGroup<R>[];
}

export interface NowGrouping<R extends NowRun> {
  readonly providers: readonly NowProviderGroup<R>[];
  // Connected agents with nothing in the window, so every agent is accounted for.
  readonly quiet: readonly NowAgent[];
  readonly activeCount: number;
}

const byName = (a: NowAgent, b: NowAgent) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id);

function providerRank(key: string): number {
  const at = PROVIDER_ORDER.indexOf(key);
  if (at >= 0) return at;
  return key === "other" ? PROVIDER_ORDER.length + 1 : PROVIDER_ORDER.length;
}

/** The person's agents, their conversations and loose actions, grouped for the Now view. */
export function groupNow<R extends NowRun>(
  agents: readonly NowAgent[],
  runs: readonly R[],
  unlinked: readonly NowUnlinked[],
  now: Date,
): NowGrouping<R> {
  const active = (at: string) => now.getTime() - new Date(at).getTime() <= ACTIVE_WINDOW_MS;
  const providers = new Map<string, { key: string; label: string; agents: NowAgentGroup<R>[] }>();
  const quiet: NowAgent[] = [];
  let activeCount = 0;

  for (const agent of [...agents].sort(byName)) {
    const conversations = runs
      .filter((run) => run.agentId === agent.id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id))
      .map((run) => ({ run, active: active(run.lastSeenAt) }));
    const loose = unlinked.find((item) => item.agentId === agent.id && item.count > 0);
    if (conversations.length === 0 && !loose) {
      if (agent.status === "connected") quiet.push(agent);
      continue;
    }
    activeCount += conversations.filter((conversation) => conversation.active).length;
    const provider = agentProvider(agent.platform, agent.name);
    const group = providers.get(provider.key) ?? { ...provider, agents: [] };
    group.agents.push({ agent, conversations, unlinked: loose ? { ...loose, active: active(loose.lastAt) } : null });
    providers.set(provider.key, group);
  }

  const ordered = [...providers.values()].sort((a, b) => providerRank(a.key) - providerRank(b.key) || a.label.localeCompare(b.label, "en"));
  return { providers: ordered, quiet, activeCount };
}
