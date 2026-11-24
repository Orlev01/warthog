// What an agent must be allowed before a Warthog skill is listed for it (docs/adr/editable-builtin-skills.md).
// A skill about paying is no use to an agent that can't ask for a card, and listing it would
// only suggest it could. Worked out from the agent's permissions on every get_context and
// get_skill, so a gate can't be edited away with the skill's text.
//
// Pure domain module: no DB, no fetch, no process.env.

export type SkillGate =
  | "records_read" // may read Life admin
  | "records_write" // may save to Life admin
  | "tasks" // may use the person's tasks
  | "mail_read" // can read at least one connected mail account
  | "calendar_read" // can read at least one connected calendar
  | "cards" // may ask for a card
  | "profile" // may read About you
  | "high_tier" // may ask for a protected detail from the Vault
  | "memory"; // may read shared memory

// The gates an agent passes, from its permissions and what it can read.
export interface AgentGates {
  readonly passes: ReadonlySet<SkillGate>;
}

export function gatesMet(requires: readonly SkillGate[], gates: AgentGates): boolean {
  return requires.every((gate) => gates.passes.has(gate));
}
