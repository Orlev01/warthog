import { withTransaction } from "@/server/db/index";
import { effectiveSkillAudiences } from "@/server/agents/skill-access";
// E13-S08 — Skills page loader + actions (the injectable, unit-testable seam the
// thin `page.tsx` composes — the convention's `createXActions(deps)` factory, as
// `vault/actions.ts`, `connectors/actions.ts`, `agents/[id]/actions.ts` and
// `settings/security/actions.ts` do). A Next entry file may export only its
// framework fields, so the skills-triad logic lives here and the entry stays thin
// (OBS-025).
//
// The skills triad is the "Skills, preferences and shared memory" surface (brief
// §"Skills, preferences and shared memory"; design §4.1). `load` reads the SESSION
// person's skills + preferences server-side — the skill content DECRYPTED under
// their own DEK, the preferences profile decrypted or null — and shapes them into
// the props the already-render-tested <SkillsView/> (E13-S07) is mounted over, plus
// Warthog's own skills as they stand for this person.
// The actions upsert the ONE communication-style profile and create / edit /
// duplicate / switch / delete the person's skills.
//
// Security (each a reviewer veto; CLAUDE.md + the safety invariants):
//   • Every read/write is member-scoped by `session.userId` — the session's verified
//     id, NEVER a userId smuggled in the input. `load` reads only the session person;
//     every mutation is scoped `WHERE … AND user_id = $N` (or refused up front when
//     the row/agent is not theirs), so another person's skill or profile is never
//     read, changed or removed by id (a safe refusal, never a silent write).
//   • A skill scoped to 'chosen' may name ONLY the session person's OWN agents (brief
//     §4.1); a foreign or nonexistent agent id is refused and nothing is stored.
//   • Input is validated at the boundary (INV-102): a malformed / oversized / unknown
//     shape is refused with a 4xx `HttpError` BEFORE any query, so nothing is written.
//     A malformed skill id is rejected at the boundary (OBS-049) before it can reach
//     `WHERE id = $1` as a cast. Every value reaches storage bound as a query
//     parameter (and the content is additionally DEK-encrypted first), so a value
//     shaped like SQL is stored as data and cannot alter a query.
//   • This module reads no `process.env` and holds no secret (INV-103): the db and the
//     KeyWrapper are INJECTED seams, so no ambient env value can surface in the loaded
//     screen or a stored row.

import { z } from "zod";
import { isPackagedSkill } from "@/server/db/skill-packages";

import { parseParams } from "@/server/http/validate";
import type { Db } from "@/server/db/index";
import { getUserById } from "@/server/db/users";
import { getAgentById } from "@/server/db/agents";
import {
  createSkill as createSkillRow,
  editSkill as editSkillRow,
  duplicateSkill as duplicateSkillRow,
  deleteSkill as deleteSkillRow,
  listSkillsForUser,
  type Skill,
  type SkillScope,
} from "@/server/db/skills";
import {
  savePreferences as savePreferencesRow,
  getPreferences,
  type PreferencesProfile,
} from "@/server/db/preferences";
import { builtinByKey, isReservedSkillTitle, type BuiltinGroup, type EffectiveBuiltin } from "@/domain/skills/builtins";
import type { SkillGate } from "@/domain/skills/gates";
import { changeBuiltinSkill, restoreBuiltinSkill, type BuiltinSkillChange } from "@/server/db/builtin-skills";
import { builtinSkillsFor } from "@/server/skills/builtin-skills";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { Session } from "@/server/auth/session";

// The injected seams — no process.env, no secret (INV-103). `db` is the
// parameterizing database seam; `keyWrapper` unwraps the session person's own DEK
// (from users.wrapped_dek) so skill + profile content can be decrypted and encrypted.
export interface SkillsActionsDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
}

// What `load` returns — the owner's skills + preferences shaped into the props
// <SkillsView/> is mounted over: the person's skills (content decrypted), the
// preferences profile (decrypted or null) and Warthog's own skills.
export interface SkillsPageData {
  readonly skills: Skill[];
  readonly preferences: PreferencesProfile | null;
  // Warthog's own skills as they stand for this person (docs/adr/editable-builtin-skills.md).
  readonly warthogSkills: readonly WarthogSkillView[];
}

// Every mutation reports its outcome — success, or a refusal naming its reason (the
// row/agent is not this person's). Never a silent success (conventions: a server
// action reports success, the refusal reason, or a 4xx).
export type ActionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

// The six communication-style fields of the ONE profile. The owner is taken from the
// session, never from this input.
export interface SavePreferencesInput {
  readonly tone: string;
  readonly length: string;
  readonly language: string;
  readonly units: string;
  readonly timeZone: string;
  readonly briefing: string;
}

// A NEW skill: its three content fields (DEK-encrypted server-side), its scope and —
// for a 'chosen' scope — the chosen agent ids (which must be the session person's own).
export interface CreateSkillInput {
  readonly title: string;
  readonly useThisWhen: string;
  readonly fullText: string;
  readonly scope: SkillScope;
  readonly scopedAgentIds?: string[];
}

// An edit replaces an owned skill's content + scope in place, so it carries the same
// fields as a create plus the id of the skill to replace.
export interface EditSkillInput extends CreateSkillInput {
  readonly id: string;
}

// Duplicate / delete take only the id of the owned skill to act on.
export interface SkillIdInput {
  readonly id: string;
}

// Toggle switches an owned skill on or off.
export interface ToggleSkillInput {
  readonly id: string;
  readonly enabled: boolean;
}

export interface SkillsActions {
  load(session: Session): Promise<SkillsPageData>;
  savePreferences(
    session: Session,
    input: SavePreferencesInput,
  ): Promise<ActionResult>;
  createSkill(session: Session, input: CreateSkillInput): Promise<ActionResult>;
  editSkill(session: Session, input: EditSkillInput): Promise<ActionResult>;
  duplicateSkill(session: Session, input: SkillIdInput): Promise<ActionResult>;
  toggleSkill(session: Session, input: ToggleSkillInput): Promise<ActionResult>;
  deleteSkill(session: Session, input: SkillIdInput): Promise<ActionResult>;
  changeWarthogSkill(session: Session, input: WarthogSkillChangeInput): Promise<ActionResult>;
}

// One of Warthog's skills as the Skills page shows it: the person's wording or Warthog's,
// Warthog's own for comparison, the rules no one can change, and who gets it.
export interface WarthogSkillView {
  readonly key: string;
  readonly title: string;
  readonly group: BuiltinGroup;
  readonly useThisWhen: string;
  readonly guidance: string;
  readonly warthogUseThisWhen: string;
  readonly warthogGuidance: string;
  readonly rules: readonly string[];
  // What Warthog adds to it for each agent, in words, if anything.
  readonly adds: string | null;
  // Which agents it's for, in words ("Agents that can save to your Life admin"), or null for all.
  readonly needs: string | null;
  readonly state: "on" | "off" | "removed";
  readonly scope: "all" | "chosen";
  readonly scopedAgentIds: readonly string[];
  readonly edited: boolean;
  readonly updateAvailable: boolean;
}

// A change to one of Warthog's skills.
export type WarthogSkillChangeInput =
  | { readonly key: string; readonly action: "on" | "off" | "remove" | "restore" | "use_new" | "keep_mine" }
  | { readonly key: string; readonly action: "edit"; readonly useThisWhen: string; readonly guidance: string }
  | { readonly key: string; readonly action: "scope"; readonly scope: "all" | "chosen"; readonly scopedAgentIds?: readonly string[] };

// ---- boundary validation shapes (INV-102) -----------------------------------------
//
// A skill id is a uuid (skills.id — gen_random_uuid()), shape-guarded so a non-uuid
// (a bare integer, a negative, a decimal, "", whitespace, a SQL-shaped id) never
// reaches `WHERE id = $1` as a cast (OBS-049). The scope is the store's enum; a value
// outside it is refused. Content and profile fields are bounded free text — a grossly
// oversized one is rejected before any write; a chosen agent id must itself be a
// well-formed uuid. A missing or non-string field fails the boundary.
const TITLE_MAX = 200;
const USE_THIS_WHEN_MAX = 500;
const FULL_TEXT_MAX = 20_000;
const PREF_FIELD_MAX = 2_000;
const SCOPED_AGENTS_MAX = 100;

const skillIdSchema = z.uuid();

const warthogKeySchema = z.string().refine((key) => builtinByKey(key) !== undefined, "Not one of Warthog's skills.");
const warthogSkillChangeSchema = z.discriminatedUnion("action", [
  z.object({ key: warthogKeySchema, action: z.enum(["on", "off", "remove", "restore", "use_new", "keep_mine"]) }),
  z.object({
    key: warthogKeySchema,
    action: z.literal("edit"),
    useThisWhen: z.string().trim().min(1).max(USE_THIS_WHEN_MAX),
    guidance: z.string().trim().min(1).max(FULL_TEXT_MAX),
  }),
  z.object({ key: warthogKeySchema, action: z.literal("scope"), scope: z.enum(["all", "chosen"]), scopedAgentIds: z.array(z.uuid()).max(SCOPED_AGENTS_MAX).optional() }),
]);

// Which agents a Warthog skill is for, in the person's words.
const GATE_WORDS: Record<SkillGate, string> = {
  records_read: "can read your Life admin",
  records_write: "can save to your Life admin",
  tasks: "can use your tasks",
  mail_read: "can read your email",
  calendar_read: "can read your calendar",
  cards: "can ask for a card",
  profile: "can see About you",
  high_tier: "can ask for details from your Vault",
  memory: "can read shared memory",
};
const ADDS: Record<string, string> = {
  life_admin: "Warthog adds the email searches, your own categories and every record kind, kept up to date for you.",
  profile: "Warthog adds the order to go through your categories, what each agent can read, and whether it can suggest About you details.",
};

export function warthogSkillView(skill: EffectiveBuiltin): WarthogSkillView {
  const gates = skill.def.requires.filter((gate) => !(gate === "records_read" && skill.def.requires.includes("records_write")));
  return {
    key: skill.def.key,
    title: skill.def.title,
    group: skill.def.group,
    useThisWhen: skill.useThisWhen,
    guidance: skill.guidance,
    warthogUseThisWhen: skill.def.useThisWhen,
    warthogGuidance: skill.def.guidance,
    rules: skill.def.rules,
    adds: skill.def.reference ? ADDS[skill.def.reference]! : null,
    needs: gates.length ? `Agents that ${gates.map((gate) => GATE_WORDS[gate]).join(" and ")}` : null,
    state: skill.state,
    scope: skill.scope.type === "agents" ? "chosen" : "all",
    scopedAgentIds: skill.scope.type === "agents" ? skill.scope.agentIds : [],
    edited: skill.edited,
    updateAvailable: skill.updateAvailable,
  };
}
const scopeSchema = z.enum(["all", "chosen"]);

// Text fields are trimmed before they're checked, so a value of only spaces is refused like
// an empty one (interaction-02).
const skillContentShape = {
  title: z.string().trim().min(1).max(TITLE_MAX),
  useThisWhen: z.string().trim().min(1).max(USE_THIS_WHEN_MAX),
  fullText: z.string().trim().min(1).max(FULL_TEXT_MAX),
  scope: scopeSchema,
  scopedAgentIds: z.array(z.uuid()).max(SCOPED_AGENTS_MAX).optional(),
};

const createSkillSchema = z.object(skillContentShape);
const editSkillSchema = z.object({ id: skillIdSchema, ...skillContentShape });
const skillIdInputSchema = z.object({ id: skillIdSchema });
const toggleSkillSchema = z.object({ id: skillIdSchema, enabled: z.boolean() });

const prefField = z.string().trim().min(1).max(PREF_FIELD_MAX);
const savePreferencesSchema = z.object({
  tone: prefField,
  length: prefField,
  language: prefField,
  units: prefField,
  timeZone: prefField,
  briefing: prefField,
});

export function createSkillsActions(deps: SkillsActionsDeps): SkillsActions {
  const { db, keyWrapper } = deps;

  // Resolve the session person's unwrapped 256-bit DEK: read their wrapped DEK (bound
  // by userId) and unwrap it through the injected KeyWrapper. Throws when the person
  // has no row (never fails silently) — the page-data idiom shared with the siblings.
  async function dataKeyFor(userId: string): Promise<Uint8Array> {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("createSkillsActions: no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  }

  // Whether EVERY listed agent id is one of this person's OWN agents (member-scoped:
  // getAgentById binds id AND user_id, so a foreign or nonexistent id yields null).
  // An empty list is trivially owned.
  async function allAgentsOwned(
    userId: string,
    agentIds: readonly string[],
  ): Promise<boolean> {
    for (const agentId of agentIds) {
      if (!(await getAgentById(db, userId, agentId))) return false;
    }
    return true;
  }

  // Whether this person owns the skill with this id (member-scoped: id AND user_id
  // bound). Used to refuse a cross-user edit / duplicate up front rather than letting
  // the store throw — so the refusal is a reported { ok: false }, never a raw 500.
  async function ownsSkill(userId: string, id: string): Promise<boolean> {
    const result = await db.query(
      "SELECT id FROM skills WHERE id = $1 AND user_id = $2",
      [id, userId],
    );
    return result.rows.length > 0;
  }

  // Read ONLY the session person's skills + preferences (member-scoped by
  // `session.userId`), decrypted under their own DEK, plus Warthog's own skills as they
  // stand for them. Another person's content never appears.
  async function load(session: Session): Promise<SkillsPageData> {
    const dek = await dataKeyFor(session.userId);
    const skills = await effectiveSkillAudiences(
      db,
      session.userId,
      await listSkillsForUser(db, session.userId, dek, {
        omitPackageText: true,
      }),
    );
    const preferences = await getPreferences(db, session.userId, dek);
    const warthogSkills = (await builtinSkillsFor(db, session.userId, dek)).map(warthogSkillView);
    return { skills, preferences, warthogSkills };
  }

  // Upsert the session person's ONE communication-style profile (one row per person).
  // Validate at the boundary first (a 4xx before any write); the owner is the
  // session's id, so a userId smuggled in the input is ignored.
  async function savePreferences(
    session: Session,
    input: SavePreferencesInput,
  ): Promise<ActionResult> {
    const valid = parseParams(savePreferencesSchema, input);
    const dek = await dataKeyFor(session.userId);
    await savePreferencesRow(db, { userId: session.userId, ...valid }, dek);
    return { ok: true };
  }

  // Create a NEW skill for the session person (content DEK-encrypted by the store).
  // Validate at the boundary first (a 4xx before any write); a 'chosen' scope is
  // refused — storing nothing — unless every named agent is this person's own.
  async function createSkill(
    session: Session,
    input: CreateSkillInput,
  ): Promise<ActionResult> {
    const valid = parseParams(createSkillSchema, input);
    // A Warthog skill's title is its own: an agent asking by title gets Warthog's.
    if (isReservedSkillTitle(valid.title)) return { ok: false, reason: "reserved_title" };
    const scopedAgentIds = valid.scopedAgentIds ?? [];
    if (
      valid.scope === "chosen" &&
      !(await allAgentsOwned(session.userId, scopedAgentIds))
    ) {
      return { ok: false, reason: "unknown_agent" };
    }
    const dek = await dataKeyFor(session.userId);
    await createSkillRow(
      db,
      {
        userId: session.userId,
        title: valid.title,
        useThisWhen: valid.useThisWhen,
        fullText: valid.fullText,
        scope: valid.scope,
        scopedAgentIds,
      },
      dek,
    );
    return { ok: true };
  }

  // Replace an OWNED skill's content + scope. Validate at the boundary first (a
  // malformed id is a 4xx before any query); a 'chosen' scope is refused — leaving the
  // skill unchanged — unless every named agent is this person's own; a skill that is
  // not this person's is refused and left unchanged.
  async function editSkill(
    session: Session,
    input: EditSkillInput,
  ): Promise<ActionResult> {
    const valid = parseParams(editSkillSchema, input);
    if (isReservedSkillTitle(valid.title)) return { ok: false, reason: "reserved_title" };
    if (await isPackagedSkill(db, session.userId, valid.id))
      return { ok: false, reason: "edit_package" };
    const scopedAgentIds = valid.scopedAgentIds ?? [];
    if (
      valid.scope === "chosen" &&
      !(await allAgentsOwned(session.userId, scopedAgentIds))
    ) {
      return { ok: false, reason: "unknown_agent" };
    }
    if (!(await ownsSkill(session.userId, valid.id))) {
      return { ok: false, reason: "not_found" };
    }
    const dek = await dataKeyFor(session.userId);
    await withTransaction(db, async (tx) => {
      await editSkillRow(
        tx,
        session.userId,
        valid.id,
        {
          title: valid.title,
          useThisWhen: valid.useThisWhen,
          fullText: valid.fullText,
          scope: valid.scope,
          scopedAgentIds,
        },
        dek,
      );
      await tx.query(
        "DELETE FROM agent_skill_access WHERE user_id = $1 AND skill_id = $2",
        [session.userId, valid.id],
      );
    });
    return { ok: true };
  }

  // Copy an OWNED skill into a new one. Validate the id at the boundary (a 4xx before
  // any query), refuse up front when the skill is not this person's (so nothing is
  // created), then duplicate through the store (re-encrypting under the new row's id).
  async function duplicateSkill(
    session: Session,
    input: SkillIdInput,
  ): Promise<ActionResult> {
    const valid = parseParams(skillIdInputSchema, input);
    if (await isPackagedSkill(db, session.userId, valid.id))
      return { ok: false, reason: "edit_package" };
    if (!(await ownsSkill(session.userId, valid.id))) {
      return { ok: false, reason: "not_found" };
    }
    const dek = await dataKeyFor(session.userId);
    await duplicateSkillRow(db, session.userId, valid.id, dek);
    return { ok: true };
  }

  // Switch an OWNED skill on/off. Validate at the boundary (a malformed id or a
  // non-boolean is a 4xx before any query), then flip `enabled` member-scoped (id AND
  // user_id bound): a skill that is not this person's matches nothing and is refused.
  async function toggleSkill(
    session: Session,
    input: ToggleSkillInput,
  ): Promise<ActionResult> {
    const valid = parseParams(toggleSkillSchema, input);
    const result = await db.query(
      "UPDATE skills SET enabled = $3 WHERE id = $1 AND user_id = $2 RETURNING id",
      [valid.id, session.userId, valid.enabled],
    );
    return result.rows.length > 0
      ? { ok: true }
      : { ok: false, reason: "not_found" };
  }

  // Delete an OWNED skill. Validate the id at the boundary (a 4xx before any query),
  // then delete member-scoped (id AND user_id bound): a skill that is not this
  // person's removes nothing and is a safe no-op refusal.
  async function deleteSkill(
    session: Session,
    input: SkillIdInput,
  ): Promise<ActionResult> {
    const valid = parseParams(skillIdInputSchema, input);
    if (await isPackagedSkill(db, session.userId, valid.id))
      return { ok: false, reason: "edit_package" };
    const removed = await deleteSkillRow(db, session.userId, valid.id);
    return removed ? { ok: true } : { ok: false, reason: "not_found" };
  }

  // Change one of Warthog's skills for the session person (docs/adr/editable-builtin-skills.md).
  // Their wording is kept only while it differs from Warthog's, with the version it was
  // based on; restore drops their row, so the skill is Warthog's again, in its default state.
  async function changeWarthogSkill(session: Session, input: WarthogSkillChangeInput): Promise<ActionResult> {
    const valid = parseParams(warthogSkillChangeSchema, input);
    const def = builtinByKey(valid.key)!;
    const defaults = { state: def.startsOn ? ("on" as const) : ("off" as const) };
    if (valid.action === "restore") {
      await restoreBuiltinSkill(db, session.userId, def.key);
      return { ok: true };
    }
    const dek = await dataKeyFor(session.userId);
    const change = async (next: BuiltinSkillChange) => changeBuiltinSkill(db, session.userId, def.key, next, defaults, dek);
    switch (valid.action) {
      case "on":
      case "off":
        await change({ state: valid.action });
        break;
      case "remove":
        await change({ state: "removed" });
        break;
      case "use_new":
        await change({ useThisWhen: null, guidance: null });
        break;
      case "keep_mine":
        await change({ basedOnVersion: def.version });
        break;
      case "edit": {
        const useThisWhen = valid.useThisWhen === def.useThisWhen.trim() ? null : valid.useThisWhen;
        const guidance = valid.guidance === def.guidance.trim() ? null : valid.guidance;
        await change({ useThisWhen, guidance, basedOnVersion: def.version });
        break;
      }
      case "scope": {
        const agentIds = valid.scopedAgentIds ?? [];
        if (valid.scope === "chosen" && !(await allAgentsOwned(session.userId, agentIds))) return { ok: false, reason: "unknown_agent" };
        await change({ scope: valid.scope === "chosen" ? { type: "agents", agentIds } : { type: "all_agents" } });
        break;
      }
    }
    return { ok: true };
  }

  return {
    load,
    savePreferences,
    createSkill,
    editSkill,
    duplicateSkill,
    toggleSkill,
    deleteSkill,
    changeWarthogSkill,
  };
}
