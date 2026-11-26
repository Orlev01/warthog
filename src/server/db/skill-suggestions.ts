// The changes an agent suggests to one of the person's skills (docs/adr/agent-saved-skills.md,
// migration 0128). A suggestion is the whole SKILL.md the agent proposes; the skill as it is keeps
// working until the person uses the suggestion or keeps theirs. One waits per skill: a newer
// suggestion replaces the older one.
//
// The SKILL.md is personal content, so it is stored only as an envelope under the person's data
// key, bound to (skill_suggestions, content, row id); a replacement gets a new row id. Every
// statement is parameterized and member-scoped by the user id the caller passes (the session's,
// never a client value). The DEK is injected; this module reads no `process.env`.

import { randomUUID } from "node:crypto";

import { decrypt, encrypt } from "../crypto/envelope";
import type { Db } from "./index";

const TABLE = "skill_suggestions";

export interface SkillSuggestion {
  readonly id: string;
  readonly skillId: string;
  readonly agentId: string;
  readonly createdAt: Date;
  // The SKILL.md as the agent suggested it.
  readonly skillMd: string;
}

/** Save `skillMd` as the waiting suggestion for `skillId`, replacing any earlier one. */
export async function saveSkillSuggestion(
  db: Db,
  input: { userId: string; skillId: string; agentId: string; skillMd: string; now: Date },
  dek: Uint8Array,
): Promise<SkillSuggestion> {
  const id = randomUUID();
  const content = await encrypt(dek, TABLE, "content", id, JSON.stringify({ skillMd: input.skillMd }));
  await db.query("DELETE FROM skill_suggestions WHERE user_id = $1 AND skill_id = $2", [input.userId, input.skillId]);
  await db.query(
    "INSERT INTO skill_suggestions (id, user_id, skill_id, agent_id, content, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, input.userId, input.skillId, input.agentId, content, input.now],
  );
  return { id, skillId: input.skillId, agentId: input.agentId, createdAt: input.now, skillMd: input.skillMd };
}

async function fromRow(dek: Uint8Array, row: Record<string, unknown>): Promise<SkillSuggestion> {
  const id = row.id as string;
  const content = JSON.parse(await decrypt(dek, TABLE, "content", id, row.content as string)) as { skillMd: string };
  return {
    id,
    skillId: row.skill_id as string,
    agentId: row.agent_id as string,
    createdAt: new Date(row.created_at as string | Date),
    skillMd: content.skillMd,
  };
}

/** The person's waiting suggestions, newest first. */
export async function listSkillSuggestions(db: Db, userId: string, dek: Uint8Array): Promise<SkillSuggestion[]> {
  const rows = await db.query(
    "SELECT id, skill_id, agent_id, content, created_at FROM skill_suggestions WHERE user_id = $1 ORDER BY created_at DESC, id",
    [userId],
  );
  return Promise.all(rows.rows.map((row) => fromRow(dek, row)));
}

/** One of the person's waiting suggestions, or null. */
export async function getSkillSuggestion(db: Db, userId: string, id: string, dek: Uint8Array): Promise<SkillSuggestion | null> {
  const rows = await db.query(
    "SELECT id, skill_id, agent_id, content, created_at FROM skill_suggestions WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return rows.rows[0] ? fromRow(dek, rows.rows[0]) : null;
}

/** Remove one of the person's suggestions; false when there was none. */
export async function deleteSkillSuggestion(db: Db, userId: string, id: string): Promise<boolean> {
  const result = await db.query("DELETE FROM skill_suggestions WHERE id = $1 AND user_id = $2 RETURNING id", [id, userId]);
  return result.rows.length > 0;
}
