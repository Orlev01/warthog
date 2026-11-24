// Home's "Build your profile" block (docs/adr/profile-build.md): where the person stands with
// having their agent build their profile, worked out from live data on every load. Pure types and
// one pure choice, shared by the Home loader and the view.

export type ProfileBuildView =
  // No agent connected yet: step 1's own block leads.
  | { readonly state: "no_agent" }
  // An agent is connected, but none can save to Life admin.
  | { readonly state: "no_records"; readonly agentName: string; readonly agentHref: string }
  // An agent can save to Life admin, but can't read email, calendar or files through Warthog.
  | { readonly state: "no_sources"; readonly agentName: string; readonly agentHref: string }
  // Ready: this agent can read these services and save what it finds.
  | { readonly state: "ready"; readonly agentName: string; readonly sources: readonly string[] }
  // An agent found things that wait for the person to check.
  | { readonly state: "waiting"; readonly records: number; readonly aboutYou: number };

// One of the person's agents, as the Home loader sees it for this step.
export interface ProfileBuildAgent {
  readonly id: string;
  readonly name: string;
  readonly savesRecords: boolean;
  // The services it can read through Warthog's own connectors, by name ("Gmail").
  readonly sources: readonly string[];
}

/**
 * What the block shows, or null when the step is done. Waiting comes first (there's something to
 * check); otherwise the first agent (most recently active) that can both read and save is named,
 * else what's missing for the most recently active agent.
 */
export function profileBuildView(
  input: { readonly done: boolean; readonly agents: readonly ProfileBuildAgent[]; readonly waitingRecords: number; readonly waitingAboutYou: number },
): ProfileBuildView | null {
  if (input.done) return null;
  if (input.waitingRecords + input.waitingAboutYou > 0) return { state: "waiting", records: input.waitingRecords, aboutYou: input.waitingAboutYou };
  const [first] = input.agents;
  if (!first) return { state: "no_agent" };
  const ready = input.agents.find((agent) => agent.savesRecords && agent.sources.length > 0);
  if (ready) return { state: "ready", agentName: ready.name, sources: ready.sources };
  const saver = input.agents.find((agent) => agent.savesRecords);
  if (saver) return { state: "no_sources", agentName: saver.name, agentHref: `/agents/${encodeURIComponent(saver.id)}?section=connectors` };
  return { state: "no_records", agentName: first.name, agentHref: `/agents/${encodeURIComponent(first.id)}?section=settings` };
}
