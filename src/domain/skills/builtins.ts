// Warthog's own skills (docs/adr/editable-builtin-skills.md): the house skill, the two Life admin
// skills and the default skills. Warthog writes them; the person can edit each one's guidance,
// switch it off, remove it, choose which agents get it, and restore Warthog's version. Each
// keeps a fixed set of rules and a generated part the person can't change, and a set of gates
// worked out from the agent's permissions.
//
// Pure domain module: no DB, no fetch, no process.env.
import { LIFE_ADMIN_GUIDANCE, LIFE_ADMIN_RULES, LIFE_ADMIN_SKILL } from "../life-admin/skill";
import { PROFILE_GUIDANCE, PROFILE_RULES, PROFILE_SKILL } from "../life-admin/profile-skill";
import { EVERYDAY_DEFAULTS, PACK_DEFAULTS } from "./defaults";
import type { DefaultSkillText } from "./defaults/types";
import { gatesMet, type AgentGates, type SkillGate } from "./gates";
import { HOUSE_GUIDANCE, HOUSE_RULES } from "./house";
import { HOUSE_SKILL } from "./index";

export type BuiltinGroup = "warthog" | "everyday" | "pack";

export interface BuiltinSkillDef {
  readonly key: string;
  readonly title: string;
  readonly useThisWhen: string;
  // Bumped whenever Warthog changes the guidance, so an edit of an older version is offered the new one.
  readonly version: number;
  readonly group: BuiltinGroup;
  // Whether it's on for a person who hasn't changed it: everyday skills are, packs aren't.
  readonly startsOn: boolean;
  readonly requires: readonly SkillGate[];
  readonly rules: readonly string[];
  readonly guidance: string;
  // The part Warthog generates for this person and agent, if any.
  readonly reference?: "life_admin" | "profile";
}

const fromDefault = (skill: DefaultSkillText, group: "everyday" | "pack"): BuiltinSkillDef => ({
  key: skill.key,
  title: skill.title,
  useThisWhen: skill.useThisWhen,
  version: skill.version,
  group,
  startsOn: group === "everyday",
  requires: skill.requires,
  rules: [],
  guidance: skill.guidance,
});

export const HOUSE_KEY = "using_warthog";
export const LIFE_ADMIN_KEY = "life_admin_records";
export const PROFILE_KEY = "building_a_profile";

export const BUILTIN_SKILLS: readonly BuiltinSkillDef[] = [
  // Version 2 (25 Nov 2026): agents update a conversation's working_on when the work changes (docs/adr/agent-runs.md).
  { key: HOUSE_KEY, title: HOUSE_SKILL.title, useThisWhen: HOUSE_SKILL.useThisWhen, version: 2, group: "warthog", startsOn: true, requires: [], rules: HOUSE_RULES, guidance: HOUSE_GUIDANCE },
  { key: LIFE_ADMIN_KEY, title: LIFE_ADMIN_SKILL.title, useThisWhen: LIFE_ADMIN_SKILL.useThisWhen, version: 2, group: "warthog", startsOn: true, requires: ["records_read"], rules: LIFE_ADMIN_RULES, guidance: LIFE_ADMIN_GUIDANCE, reference: "life_admin" },
  { key: PROFILE_KEY, title: PROFILE_SKILL.title, useThisWhen: PROFILE_SKILL.useThisWhen, version: 1, group: "warthog", startsOn: true, requires: ["records_read", "records_write"], rules: PROFILE_RULES, guidance: PROFILE_GUIDANCE, reference: "profile" },
  ...EVERYDAY_DEFAULTS.map((skill) => fromDefault(skill, "everyday")),
  ...PACK_DEFAULTS.map((skill) => fromDefault(skill, "pack")),
];

const normalTitle = (title: string) => title.trim().replace(/\s+/g, " ").toLowerCase();

export function builtinByKey(key: string): BuiltinSkillDef | undefined {
  return BUILTIN_SKILLS.find((skill) => skill.key === key);
}

export function builtinByTitle(title: string): BuiltinSkillDef | undefined {
  const wanted = normalTitle(title);
  return BUILTIN_SKILLS.find((skill) => normalTitle(skill.title) === wanted);
}

// A person's own skill can't take a Warthog skill's title: an agent asking for it by title
// would get one or the other, never both.
export function isReservedSkillTitle(title: string): boolean {
  return builtinByTitle(title) !== undefined;
}

export type BuiltinState = "on" | "off" | "removed";
export type BuiltinScope = { readonly type: "all_agents" } | { readonly type: "agents"; readonly agentIds: readonly string[] };

// What the person changed (their stored row), if anything.
export interface BuiltinSettingInput {
  readonly state: BuiltinState;
  readonly scope: BuiltinScope;
  readonly useThisWhen: string | null;
  readonly guidance: string | null;
  readonly basedOnVersion: number | null;
}

// One of Warthog's skills as it stands for this person.
export interface EffectiveBuiltin {
  readonly def: BuiltinSkillDef;
  readonly state: BuiltinState;
  readonly scope: BuiltinScope;
  readonly useThisWhen: string;
  readonly guidance: string;
  // The person changed its wording.
  readonly edited: boolean;
  // Warthog has changed its text since the person's edit.
  readonly updateAvailable: boolean;
}

export function effectiveBuiltin(def: BuiltinSkillDef, setting?: BuiltinSettingInput): EffectiveBuiltin {
  const edited = Boolean(setting && (setting.useThisWhen !== null || setting.guidance !== null));
  return {
    def,
    state: setting?.state ?? (def.startsOn ? "on" : "off"),
    scope: setting?.scope ?? { type: "all_agents" },
    useThisWhen: setting?.useThisWhen ?? def.useThisWhen,
    guidance: setting?.guidance ?? def.guidance,
    edited,
    updateAvailable: edited && (setting?.basedOnVersion ?? 0) < def.version,
  };
}

// Whether an agent gets this skill: it's on, the agent is in its scope, and the agent passes its gates.
export function builtinAvailableTo(skill: EffectiveBuiltin, agentId: string, gates: AgentGates): boolean {
  if (skill.state !== "on") return false;
  if (skill.scope.type === "agents" && !skill.scope.agentIds.includes(agentId)) return false;
  return gatesMet(skill.def.requires, gates);
}
