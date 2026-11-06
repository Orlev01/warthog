// E13-S06 — Skills and preferences read for the page (list-all) (brief "Skills,
// preferences and shared memory"; design §4.1).
//
// ONE owner-scoped list-ALL read for the Skills page: every skill the person has
// written — ENABLED and DISABLED — each carrying its scope (all agents or a chosen
// set) and its on/off state, PLUS the person's preferences profile, PLUS a note of
// Warthog's own house skill, which is ALWAYS included for every agent and is not one
// of the person's skills (it cannot be switched off or scoped out).
//
// A composition, not a re-implementation: it reuses the already-built, tested storage
// primitives (`listSkillsForUser`, `getPreferences`) and the pure domain constant
// (`HOUSE_SKILL`) — it re-runs no SQL, re-implements no decryption and hard-codes no
// house-skill wording. The content is PERSONAL CONTENT stored DEK-encrypted by those
// stores, so this read decrypts it under the INJECTED per-person `dek`: it holds no
// key and reads no `process.env` (INV-103). Member-scoped by the `userId` the caller
// passes — the session's id, never a client value — so another person's skills or
// preferences are never returned; the user id is bound as a parameter by the stores
// (INV-102).

import { listSkillsForUser } from "../db/skills";
import type { SkillScope } from "../db/skills";
import { getPreferences } from "../db/preferences";
import type { PreferencesProfile } from "../db/preferences";
import { HOUSE_SKILL } from "../../domain/skills/index";
import type { Db } from "../db/index";

// One of the person's own skills as the Skills page shows it: its id, its decrypted
// title + "use this when" line, its scope (+ chosen agent ids) and its on/off state.
// The full instruction text is not part of the list view, so it is not carried here.
export interface SkillsPageItem {
  readonly id: string;
  readonly title: string;
  readonly useThisWhen: string;
  readonly scope: SkillScope; // "all" | "chosen"
  readonly scopedAgentIds: string[];
  readonly enabled: boolean;
}

// Warthog's own house skill, ALWAYS included for every agent — not one of the
// person's skills, so it is carried separately and marked always-included, with its
// wording taken from the canonical `HOUSE_SKILL` constant.
export interface HouseSkillMarker {
  readonly title: string;
  readonly useThisWhen: string;
  readonly alwaysIncluded: true;
}

// The whole read the Skills page consumes.
export interface SkillsPageData {
  readonly skills: SkillsPageItem[]; // ALL of the owner's skills (on and off)
  readonly preferences: PreferencesProfile | null; // the owner's profile, or null if unset
  readonly houseSkill: HouseSkillMarker; // the always-included house skill
}

// List ALL of `userId`'s skills (enabled AND disabled) each decrypted under the
// injected `dek` and carrying its scope + enabled state, read the owner's preferences
// profile (null when unset), and note the always-included house skill. Member-scoped
// by `userId`; the user id is bound as a parameter by the stores. A wrong DEK fails
// the GCM tag inside the stores and rejects.
export async function skillsPageData(
  db: Db,
  userId: string,
  dek: Uint8Array,
): Promise<SkillsPageData> {
  const owned = await listSkillsForUser(db, userId, dek);
  const preferences = await getPreferences(db, userId, dek);

  const skills: SkillsPageItem[] = owned.map((s) => ({
    id: s.id,
    title: s.title,
    useThisWhen: s.useThisWhen,
    scope: s.scope,
    scopedAgentIds: s.scopedAgentIds,
    enabled: s.enabled,
  }));

  return {
    skills,
    preferences,
    houseSkill: {
      title: HOUSE_SKILL.title,
      useThisWhen: HOUSE_SKILL.useThisWhen,
      alwaysIncluded: true,
    },
  };
}
