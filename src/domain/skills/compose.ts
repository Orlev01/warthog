// How a Warthog skill's text is put together (docs/adr/editable-builtin-skills.md): its guidance
// (Warthog's, or the person's own edit), then Warthog's ground rules for it, which the person
// can't change, then anything Warthog generates for this person and agent (record kinds,
// searches, what the agent can read). Only the guidance can be edited, so an edit can neither
// weaken a rule nor break what save_record checks against.
//
// Pure domain module: no DB, no fetch, no process.env.

export const RULES_HEADING = "Always (Warthog's rules: they apply whatever this skill says)";

export interface SkillParts {
  readonly guidance: string;
  readonly rules: readonly string[];
  readonly reference?: string;
}

export function composeSkillText(parts: SkillParts): string {
  const sections = [parts.guidance.trim()];
  if (parts.rules.length > 0) sections.push([RULES_HEADING, ...parts.rules.map((rule) => `- ${rule}`)].join("\n"));
  if (parts.reference && parts.reference.trim()) sections.push(parts.reference.trim());
  return sections.filter(Boolean).join("\n\n");
}
