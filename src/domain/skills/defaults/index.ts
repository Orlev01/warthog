// Warthog's default skills (docs/adr/editable-builtin-skills.md): the everyday ones every person
// starts with, and the opt-in packs that start switched off.
import { EVERYDAY_SKILLS } from "./everyday";
import { PACK_SKILLS, SECOND_WAVE_SKILLS } from "./more";
import type { DefaultSkillText } from "./types";

export const EVERYDAY_DEFAULTS: readonly DefaultSkillText[] = [...EVERYDAY_SKILLS, ...SECOND_WAVE_SKILLS];
export const PACK_DEFAULTS: readonly DefaultSkillText[] = [...PACK_SKILLS];
