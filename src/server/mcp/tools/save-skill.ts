// The `save_skill` core tool (docs/adr/agent-saved-skills.md; brief "Agent tool set", amended
// 26 November 2026). A person who wrote a skill with an agent — a SKILL.md made in ChatGPT,
// Claude or Gemini — asks that agent to save it to Warthog. It is saved to their Skills switched
// off, so no agent uses it until the person has read it and turned it on; a revision of a skill
// they have already checked waits for them beside the skill (../../skills/agent-skills).
//
// Refused for an agent the person has stopped saving skills (its permissions' "Let it save
// skills"). The person and agent come from the connection, never the input. Built from its
// injected seams; reads no `process.env` (INV-103). The input is validated at the boundary
// (zod → a 4xx before any db access, INV-102).

import { z } from "zod";

import { parseParams } from "../../http/validate";
import { getConnectionPermissions } from "../../db/agent-permissions";
import { getUserById } from "../../db/users";
import { PACKAGE_LIMITS } from "../../../domain/skills/package";
import { saveSkillFromAgent, type AgentSkillOutcome } from "../../skills/agent-skills";
import type { KeyWrapper } from "../../crypto/key-wrapper";
import type { Clock } from "../../seams/clock";
import type { AgentConnection } from "../context";
import type { Db } from "../../db/index";

const MAX_REASON = 2000;

export const saveSkillSchema = z
  .object({
    skill_md: z
      .string()
      .min(1)
      .max(PACKAGE_LIMITS.fileBytes)
      .optional()
      .describe("The whole SKILL.md: frontmatter with name and description, then the instructions."),
    name: z.string().trim().min(1).max(150).optional().describe("The skill's name, if you don't send skill_md."),
    description: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe("One line saying when to use it, if you don't send skill_md."),
    instructions: z
      .string()
      .trim()
      .min(1)
      .max(100_000)
      .optional()
      .describe("The instructions, if you don't send skill_md."),
    files: z
      .array(z.object({ path: z.string().min(1).max(300), content: z.string().max(PACKAGE_LIMITS.fileBytes) }))
      .max(PACKAGE_LIMITS.files - 1)
      .optional()
      .describe("Supporting text files, by their path inside the skill (for example references/forms.md)."),
    id: z
      .uuid()
      .optional()
      .describe("To revise a skill, its id from an earlier save_skill or from get_context. Leave out to save a new skill."),
    reason: z.string().max(MAX_REASON).optional(),
  })
  .refine((v) => v.skill_md !== undefined || (v.name !== undefined && v.description !== undefined && v.instructions !== undefined), {
    message: "Send skill_md, or name, description and instructions.",
  });

export type SaveSkillResult =
  | (Exclude<AgentSkillOutcome, { status: "refused" }> & { readonly message: string; readonly skills_page: string })
  | { readonly status: "refused"; readonly reason: string };

export interface SaveSkillTool {
  readonly name: string;
  readonly inputSchema: z.ZodType;
  handle(input: unknown, connection: AgentConnection): Promise<SaveSkillResult>;
}

export interface SaveSkillDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  readonly clock: Clock;
  // The person's Skills page, for the agent to point them to.
  readonly skillsPage: string;
}

const NO_PERMISSION =
  "This agent isn't allowed to save skills. The person can turn on \"Let it save skills\" in this agent's permissions in Warthog.";

// What the agent should tell the person, per outcome.
const MESSAGES: Record<Exclude<AgentSkillOutcome["status"], "refused">, string> = {
  saved: "Saved to the person's Warthog Skills, switched off. No agent uses it until they check it and turn it on. Tell them it's waiting on their Skills page.",
  replaced: "Your earlier version was replaced. It's still switched off until the person checks it and turns it on on their Skills page.",
  suggested: "Your changes are waiting for the person on their Skills page. Until they use them, the skill stays as it was.",
  unchanged: "That matches the skill as it is, so nothing was saved.",
};

export function createSaveSkillTool(deps: SaveSkillDeps): SaveSkillTool {
  const { db, keyWrapper, clock, skillsPage } = deps;
  return {
    name: "save_skill",
    inputSchema: saveSkillSchema,
    async handle(input, connection) {
      const parsed = parseParams(saveSkillSchema, input);
      const permissions = await getConnectionPermissions(db, connection.userId, connection.connectionId);
      if (!permissions || permissions.resourceControls?.skillsWrite === false) return { status: "refused", reason: NO_PERMISSION };
      const user = await getUserById(db, connection.userId);
      if (!user) throw new Error("save_skill: no data key for this user");
      const outcome = await saveSkillFromAgent(
        db,
        { userId: connection.userId, agentId: connection.agentId, now: clock.now() },
        {
          id: parsed.id,
          skillMd: parsed.skill_md,
          name: parsed.name,
          description: parsed.description,
          instructions: parsed.instructions,
          files: parsed.files,
        },
        await keyWrapper.unwrap(user.wrappedDek),
      );
      if (outcome.status === "refused") return outcome;
      return { ...outcome, message: MESSAGES[outcome.status], skills_page: skillsPage };
    },
  };
}
