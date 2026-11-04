// E03-S10 — Skills index and scoping (brief "Skills and preferences").
//
// Each named skill has a title and a one-line "use this when" description, an
// on/off switch, and a scope that is either all agents or a chosen set. An
// agent's context lists ONLY the titles and use-this-when lines of the skills it
// may use — it fetches the full instruction text by title later, so the index
// never carries the body. Warthog's own house skill is ALWAYS included; a
// switched-off or out-of-scope skill is excluded.
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.
// Building the index is a pure function of (the person's skills, the agent).

/**
 * A skill applies either to all agents, or to a chosen set of agents. The chosen
 * form carries a list because a skill may be scoped to several agents at once.
 */
export type SkillScope =
  | { type: "all_agents" }
  | { type: "agents"; agentIds: readonly string[] };

/**
 * One of the person's named skills. `enabled` is the on/off switch; `scope`
 * decides which agents may use it. The full instruction text is NOT part of this
 * module's concern and is NEVER copied into an index entry.
 */
export interface Skill {
  title: string;
  useThisWhen: string;
  enabled: boolean;
  scope: SkillScope;
}

/**
 * What an agent's context lists per skill: ONLY the title and the use-this-when
 * line — nothing else (not the on/off switch, the scope, or the full text).
 */
export interface SkillIndexEntry {
  title: string;
  useThisWhen: string;
}

/**
 * Warthog's own house skill — always present in every agent's index, cannot be
 * switched off or scoped out (it is not one of the person's skills).
 */
export const HOUSE_SKILL: { title: string; useThisWhen: string } = {
  title: "Using Warthog",
  useThisWhen: "when you need to know what you may touch, spend or ask before acting",
};

/** Whether `scope` includes `agentId` — all-agents always does, a chosen list only when it contains it. */
function inScope(scope: SkillScope, agentId: string): boolean {
  return scope.type === "all_agents" || scope.agentIds.includes(agentId);
}

/**
 * The title + use-this-when index an agent sees.
 *  - Includes the house skill, always and exactly once.
 *  - Includes each of the person's skills that is enabled AND scoped to agentId.
 *  - Excludes a switched-off skill (enabled === false), whatever its scope.
 *  - Excludes an out-of-scope skill (a chosen list not containing agentId,
 *    including the empty list).
 *  - Each entry is EXACTLY { title, useThisWhen } — the full text / switch /
 *    scope never leak into agent context.
 *
 * Pure: a fresh array each call, mutating neither the input skills nor the
 * HOUSE_SKILL constant, deterministic for the same inputs.
 */
export function buildSkillIndex(
  skills: readonly Skill[],
  agentId: string,
): SkillIndexEntry[] {
  const index: SkillIndexEntry[] = [
    { title: HOUSE_SKILL.title, useThisWhen: HOUSE_SKILL.useThisWhen },
  ];

  for (const s of skills) {
    if (s.enabled && inScope(s.scope, agentId)) {
      index.push({ title: s.title, useThisWhen: s.useThisWhen });
    }
  }

  return index;
}
