import type { Db } from "../db/index";
import { listSkillsForUser } from "../db/skills";

export async function agentSkillChoices(
  db: Db,
  userId: string,
  agentId: string,
  dek: Uint8Array,
) {
  const skills = await listSkillsForUser(db, userId, dek);
  const { rows } = await db.query(
    "SELECT skill_id, allowed FROM agent_skill_access WHERE user_id = $1 AND agent_id = $2",
    [userId, agentId],
  );
  const overrides = new Map(
    rows.map((row) => [String(row.skill_id), Boolean(row.allowed)]),
  );
  return skills
    .filter((skill) => skill.enabled)
    .map((skill) => ({
      id: skill.id,
      name: skill.title,
      granted:
        overrides.get(skill.id) ??
        (skill.scope === "all" || skill.scopedAgentIds.includes(agentId)),
    }));
}

// Caller supplies a transaction for multi-resource updates. Validate the complete
// batch before writing so a forged id cannot partially change the legitimate rows.
export async function setAgentSkillAccess(
  db: Db,
  userId: string,
  agentId: string,
  choices: readonly { id: string; granted: boolean }[],
): Promise<boolean> {
  const agent = await db.query(
    "SELECT id FROM agents WHERE user_id = $1 AND id = $2",
    [userId, agentId],
  );
  if (!agent.rows.length) return false;
  const owned = await db.query(
    "SELECT id FROM skills WHERE user_id = $1 AND id = ANY($2::uuid[])",
    [userId, choices.map((choice) => choice.id)],
  );
  const ids = new Set(owned.rows.map((row) => String(row.id)));
  if (choices.some((choice) => !ids.has(choice.id))) return false;
  for (const choice of choices) {
    await db.query(
      `INSERT INTO agent_skill_access (user_id, agent_id, skill_id, allowed) VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, agent_id, skill_id) DO UPDATE SET allowed = EXCLUDED.allowed`,
      [userId, agentId, choice.id, choice.granted],
    );
  }
  return true;
}
