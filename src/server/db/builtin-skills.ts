// The person's own settings for Warthog's skills (db/migrations/0126_builtin_skills.sql,
// docs/adr/editable-builtin-skills.md). Every read and write is member-scoped by the session's
// user id; the person's wording is stored only as envelopes under their data key.
import { randomUUID } from "node:crypto";

import { decrypt, encrypt } from "../crypto/envelope";
import type { Db, Row } from "./index";

const TABLE = "builtin_skills";

export type BuiltinSkillState = "on" | "off" | "removed";

export type BuiltinSkillScope = { readonly type: "all_agents" } | { readonly type: "agents"; readonly agentIds: readonly string[] };

// One row: what the person changed about one of Warthog's skills.
export interface BuiltinSkillSetting {
  readonly key: string;
  readonly state: BuiltinSkillState;
  readonly scope: BuiltinSkillScope;
  // Their wording, or null for Warthog's.
  readonly useThisWhen: string | null;
  readonly guidance: string | null;
  readonly basedOnVersion: number | null;
}

// What a change sets. Left out, a field keeps its stored value (or Warthog's default).
export interface BuiltinSkillChange {
  readonly state?: BuiltinSkillState;
  readonly scope?: BuiltinSkillScope;
  // null puts Warthog's wording back.
  readonly useThisWhen?: string | null;
  readonly guidance?: string | null;
  readonly basedOnVersion?: number | null;
}

function scopeOf(row: Row): BuiltinSkillScope {
  if (row.scope === "chosen") {
    const ids = Array.isArray(row.scoped_agent_ids) ? row.scoped_agent_ids.filter((id): id is string => typeof id === "string") : [];
    return { type: "agents", agentIds: ids };
  }
  return { type: "all_agents" };
}

async function settingOf(row: Row, dek: Uint8Array): Promise<BuiltinSkillSetting> {
  const id = row.id as string;
  return {
    key: row.builtin_key as string,
    state: row.state as BuiltinSkillState,
    scope: scopeOf(row),
    useThisWhen: row.use_this_when ? await decrypt(dek, TABLE, "use_this_when", id, row.use_this_when as string) : null,
    guidance: row.guidance ? await decrypt(dek, TABLE, "guidance", id, row.guidance as string) : null,
    basedOnVersion: (row.based_on_version as number | null) ?? null,
  };
}

// Every setting the person has, by key.
export async function listBuiltinSkillSettings(db: Db, userId: string, dek: Uint8Array): Promise<Map<string, BuiltinSkillSetting>> {
  const { rows } = await db.query(
    `SELECT id, builtin_key, state, scope, scoped_agent_ids, use_this_when, guidance, based_on_version
       FROM builtin_skills WHERE user_id = $1`,
    [userId],
  );
  const settings = new Map<string, BuiltinSkillSetting>();
  for (const row of rows) {
    const setting = await settingOf(row, dek);
    settings.set(setting.key, setting);
  }
  return settings;
}

// Change one of Warthog's skills for this person, creating their row on the first change.
// `defaults` is Warthog's state for a skill with no row (on, or off for an opt-in pack).
export async function changeBuiltinSkill(
  db: Db,
  userId: string,
  key: string,
  change: BuiltinSkillChange,
  defaults: { readonly state: BuiltinSkillState },
  dek: Uint8Array,
): Promise<void> {
  const existing = await db.query(`SELECT id FROM builtin_skills WHERE user_id = $1 AND builtin_key = $2`, [userId, key]);
  const id = (existing.rows[0]?.id as string | undefined) ?? randomUUID();
  const current = existing.rows.length ? (await listBuiltinSkillSettings(db, userId, dek)).get(key) : undefined;
  const next = {
    state: change.state ?? current?.state ?? defaults.state,
    scope: change.scope ?? current?.scope ?? ({ type: "all_agents" } as const),
    useThisWhen: change.useThisWhen === undefined ? current?.useThisWhen ?? null : change.useThisWhen,
    guidance: change.guidance === undefined ? current?.guidance ?? null : change.guidance,
    basedOnVersion: change.basedOnVersion === undefined ? current?.basedOnVersion ?? null : change.basedOnVersion,
  };
  const edited = next.useThisWhen !== null || next.guidance !== null;
  const params = [
    id,
    userId,
    key,
    next.state,
    next.scope.type === "agents" ? "chosen" : "all",
    JSON.stringify(next.scope.type === "agents" ? next.scope.agentIds : []),
    next.useThisWhen === null ? null : await encrypt(dek, TABLE, "use_this_when", id, next.useThisWhen),
    next.guidance === null ? null : await encrypt(dek, TABLE, "guidance", id, next.guidance),
    edited ? next.basedOnVersion : null,
  ];
  await db.query(
    `INSERT INTO builtin_skills (id, user_id, builtin_key, state, scope, scoped_agent_ids, use_this_when, guidance, based_on_version)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     ON CONFLICT (user_id, builtin_key) DO UPDATE
       SET state = EXCLUDED.state, scope = EXCLUDED.scope, scoped_agent_ids = EXCLUDED.scoped_agent_ids,
           use_this_when = EXCLUDED.use_this_when, guidance = EXCLUDED.guidance,
           based_on_version = EXCLUDED.based_on_version, updated_at = now()`,
    params,
  );
}

// Back to Warthog's version, its default state and all agents: the row goes.
export async function restoreBuiltinSkill(db: Db, userId: string, key: string): Promise<void> {
  await db.query(`DELETE FROM builtin_skills WHERE user_id = $1 AND builtin_key = $2`, [userId, key]);
}
