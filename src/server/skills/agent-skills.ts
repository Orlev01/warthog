// Skills an agent saves, and the changes it suggests (docs/adr/agent-saved-skills.md).
//
// A person who wrote a skill with ChatGPT, Claude or Gemini asks that agent to save it to
// Warthog. A skill tells every agent that gets it what to do, so one an agent wrote — perhaps
// after reading an email someone else wrote — must not reach any agent before the person has
// read it:
//   • a new skill is saved as a library package, switched off and marked as that agent's, the
//     same as a SKILL.md the person imports;
//   • while the person hasn't turned it on, changed who gets it or saved it themselves, the
//     agent that saved it may replace it outright (it reaches no one either way);
//   • any other revision — of a skill that is on, or one the person wrote — is kept as a
//     suggestion beside the skill, which keeps working as it is until the person uses the
//     suggestion or keeps theirs.
// The person and agent always come from the caller (the session or the agent's connection),
// never from the input.

import { neverKeptMessage, neverKeptRule, tidyKeptText } from "../../domain/content/never-kept";
import { isReservedSkillTitle } from "../../domain/skills/builtins";
import {
  makeSkillFile,
  PackageError,
  parseSkillFile,
  type PackageFile,
} from "../../domain/skills/package";
import { withTransaction, type Db } from "../db/index";
import { getPackage, savePackage, type StoredPackage } from "../db/skill-packages";
import {
  deleteSkillSuggestion,
  getSkillSuggestion,
  listSkillSuggestions,
  saveSkillSuggestion,
} from "../db/skill-suggestions";
import { editSkill, getSkillForUser, skillAvailableToAgent, type Skill } from "../db/skills";

// How many of an agent's saves may wait for the person at once, so a looping agent can't fill
// the library with drafts.
export const AGENT_DRAFT_LIMIT = 20;

// A skill the person wrote on the Skills page holds up to this many characters of instructions
// (the page's own limit), so a suggestion for one can't be longer.
export const STANDALONE_TEXT_MAX = 20_000;

export interface AgentSkillInput {
  // To revise a skill: its id.
  readonly id?: string;
  // The whole SKILL.md, or its three parts.
  readonly skillMd?: string;
  readonly name?: string;
  readonly description?: string;
  readonly instructions?: string;
  // Supporting files, by path inside the skill.
  readonly files?: readonly PackageFile[];
}

export type AgentSkillOutcome =
  // A new skill, switched off, waiting for the person.
  | { readonly status: "saved"; readonly skills: readonly { id: string; title: string }[] }
  // The agent's own draft, replaced; still off and waiting.
  | { readonly status: "replaced"; readonly skills: readonly { id: string; title: string }[] }
  // A change waiting beside a skill the person has.
  | { readonly status: "suggested"; readonly skill: { id: string; title: string } }
  // The suggestion matches the skill as it is.
  | { readonly status: "unchanged"; readonly skill: { id: string; title: string } }
  | { readonly status: "refused"; readonly reason: string };

const NOT_FOUND = "No skill with that id is available to you. To save a new skill, leave out id.";
const FILES_ON_SUGGESTION =
  "Once the person has checked a skill, you can suggest a new SKILL.md for it but not its other files. Leave out files, or ask the person to import the new version on their Skills page.";

function refused(reason: string): AgentSkillOutcome {
  return { status: "refused", reason };
}

// The SKILL.md as the agent sent it, or built from its three parts. A SKILL.md without
// frontmatter takes the name and description sent beside it.
function skillMdOf(input: AgentSkillInput): string | null {
  if (input.skillMd !== undefined) {
    const text = input.skillMd.replace(/^﻿/, "");
    if (/^---[ \t]*\r?\n/.test(text)) return text;
    if (input.name && input.description) return makeSkillFile(input.name, input.description, text);
    return null;
  }
  if (input.name && input.description && input.instructions) return makeSkillFile(input.name, input.description, input.instructions);
  return null;
}

// Every file as Warthog keeps it, or the reason it can't be kept: never a password, tax file
// number or bank account; card numbers masked to their last four.
function keptFiles(input: AgentSkillInput, skillMd: string): PackageFile[] | string {
  const files = [{ path: "SKILL.md", content: skillMd }, ...(input.files ?? [])];
  for (const file of files) {
    const rule = neverKeptRule(file.content);
    if (rule) return `${neverKeptMessage(file.path === "SKILL.md" ? "The skill" : file.path, rule)} Take it out and save again.`;
  }
  return files.map((file) => ({ path: file.path, content: tidyKeptText(file.content) }));
}

// Each skill a package holds, by the id and title agents see.
function savedSkills(pkg: StoredPackage): { id: string; title: string }[] {
  return pkg.skills.flatMap((skill) => {
    const member = pkg.members.find((m) => m.path === skill.path);
    return member ? [{ id: member.skillId, title: pkg.kind === "plugin" ? `${pkg.name} / ${skill.name}` : skill.name }] : [];
  });
}

// A refusal from the package checks, with what the agent can do about it.
function packageRefusal(error: PackageError): AgentSkillOutcome {
  const name = /already exists/.test(error.message);
  return refused(name ? `${error.message} To change a skill you can see in get_context, pass its id.` : error.message);
}

interface SkillPlace {
  readonly skill: Skill;
  readonly packageId: string | null;
  readonly savedByAgentId: string | null;
  readonly awaitingCheck: boolean;
}

async function skillPlace(db: Db, userId: string, skillId: string, dek: Uint8Array): Promise<SkillPlace | null> {
  const skill = await getSkillForUser(db, userId, skillId, dek);
  if (!skill) return null;
  const rows = await db.query(
    `SELECT p.id, p.saved_by_agent_id, p.awaiting_check FROM skill_package_members m
       JOIN skill_packages p ON p.id = m.package_id AND p.user_id = m.user_id
      WHERE m.skill_id = $1 AND m.user_id = $2`,
    [skillId, userId],
  );
  const row = rows.rows[0];
  return {
    skill,
    packageId: (row?.id as string | undefined) ?? null,
    savedByAgentId: (row?.saved_by_agent_id as string | null | undefined) ?? null,
    awaitingCheck: row?.awaiting_check === true,
  };
}

// The skill as it reads now, by its SKILL.md parts: a packaged skill's own name (without its
// plugin's), description and instructions.
export interface SkillParts {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

async function currentParts(db: Db, userId: string, place: SkillPlace, dek: Uint8Array): Promise<{ parts: SkillParts; pkg: StoredPackage | null; path: string | null }> {
  if (place.packageId) {
    const pkg = await getPackage(db, userId, place.packageId, dek);
    const member = pkg?.members.find((m) => m.skillId === place.skill.id);
    const skill = member ? pkg!.skills.find((s) => s.path === member.path) : undefined;
    if (pkg && member && skill) return { parts: { name: skill.name, description: skill.description, body: skill.body }, pkg, path: member.path };
  }
  return { parts: { name: place.skill.title, description: place.skill.useThisWhen, body: place.skill.fullText }, pkg: null, path: null };
}

const same = (a: SkillParts, b: SkillParts) =>
  a.name.trim() === b.name.trim() && a.description.trim() === b.description.trim() && a.body.trim() === b.body.trim();

/** An agent's save_skill: a new skill, a replaced draft, or a suggested change. */
export async function saveSkillFromAgent(
  db: Db,
  caller: { readonly userId: string; readonly agentId: string; readonly now: Date },
  input: AgentSkillInput,
  dek: Uint8Array,
): Promise<AgentSkillOutcome> {
  const skillMd = skillMdOf(input);
  if (skillMd === null) {
    return refused("Send skill_md starting with frontmatter (name and description), or send name, description and instructions.");
  }
  const files = keptFiles(input, skillMd);
  if (typeof files === "string") return refused(files);
  const { userId, agentId } = caller;
  try {
    return await withTransaction(db, async (tx) => {
      // One change at a time to this person's library, as on the Skills page.
      await tx.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      if (input.id === undefined) {
        const waiting = await tx.query(
          "SELECT count(*)::int AS n FROM skill_packages WHERE user_id = $1 AND saved_by_agent_id = $2 AND awaiting_check",
          [userId, agentId],
        );
        if (Number(waiting.rows[0]?.n ?? 0) >= AGENT_DRAFT_LIMIT) {
          return refused(`${AGENT_DRAFT_LIMIT} skills you saved are already waiting for the person to check. Ask them to check those on their Skills page first.`);
        }
        const pkg = await savePackage(tx, userId, { files }, dek, { refuseNewReservedNames: true, savedByAgent: agentId });
        return { status: "saved", skills: savedSkills(pkg) };
      }

      const place = await skillPlace(tx, userId, input.id, dek);
      if (!place) return refused(NOT_FOUND);
      const own = place.savedByAgentId === agentId;
      if (place.packageId && own && place.awaitingCheck) {
        const current = await getPackage(tx, userId, place.packageId, dek);
        if (!current) return refused(NOT_FOUND);
        const pkg = await savePackage(tx, userId, { id: current.id, revision: current.revision, files }, dek, { refuseNewReservedNames: true, savedByAgent: agentId });
        return { status: "replaced", skills: savedSkills(pkg) };
      }
      if (!own && !(await skillAvailableToAgent(tx, userId, agentId, input.id))) return refused(NOT_FOUND);
      if (input.files?.length) return refused(FILES_ON_SUGGESTION);

      const suggested = parseSkillFile(files[0]!);
      const { parts } = await currentParts(tx, userId, place, dek);
      const skill = { id: place.skill.id, title: place.skill.title };
      if (!place.packageId && suggested.body.length > STANDALONE_TEXT_MAX) {
        return refused(`This skill holds up to ${STANDALONE_TEXT_MAX.toLocaleString("en-AU")} characters of instructions. Shorten them and suggest again.`);
      }
      if (isReservedSkillTitle(suggested.name) && suggested.name.trim().toLowerCase() !== parts.name.trim().toLowerCase()) {
        return refused(`${suggested.name} is the name of one of Warthog's skills. Choose another name.`);
      }
      if (same(suggested, parts)) return { status: "unchanged", skill };
      await saveSkillSuggestion(tx, { userId, skillId: place.skill.id, agentId, skillMd: files[0]!.content, now: caller.now }, dek);
      return { status: "suggested", skill };
    });
  } catch (error) {
    if (error instanceof PackageError) return packageRefusal(error);
    throw error;
  }
}

/** A suggestion as the Skills page shows it: the skill now, and as the agent suggests. */
export interface SkillSuggestionView {
  readonly id: string;
  readonly skillId: string;
  readonly agentId: string;
  readonly createdAt: string;
  readonly title: string;
  readonly current: SkillParts;
  readonly suggested: SkillParts;
}

/** The person's waiting suggestions, each beside the skill as it reads now. */
export async function skillSuggestionsFor(db: Db, userId: string, dek: Uint8Array): Promise<SkillSuggestionView[]> {
  const views: SkillSuggestionView[] = [];
  for (const suggestion of await listSkillSuggestions(db, userId, dek)) {
    const place = await skillPlace(db, userId, suggestion.skillId, dek);
    if (!place) continue;
    let suggested: SkillParts;
    try {
      suggested = parseSkillFile({ path: "SKILL.md", content: suggestion.skillMd });
    } catch {
      continue;
    }
    const { parts } = await currentParts(db, userId, place, dek);
    views.push({
      id: suggestion.id,
      skillId: suggestion.skillId,
      agentId: suggestion.agentId,
      createdAt: suggestion.createdAt.toISOString(),
      title: place.skill.title,
      current: parts,
      suggested: { name: suggested.name, description: suggested.description, body: suggested.body },
    });
  }
  return views;
}

export type SuggestionResult = { readonly ok: true } | { readonly ok: false; readonly reason: "not_found" | "problem"; readonly message?: string };

/** The person uses an agent's suggestion: the skill takes the suggested SKILL.md, keeping who gets it. */
export async function useSkillSuggestion(db: Db, userId: string, suggestionId: string, dek: Uint8Array): Promise<SuggestionResult> {
  try {
    return await withTransaction(db, async (tx) => {
      await tx.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
      const suggestion = await getSkillSuggestion(tx, userId, suggestionId, dek);
      if (!suggestion) return { ok: false, reason: "not_found" };
      const place = await skillPlace(tx, userId, suggestion.skillId, dek);
      if (!place) return { ok: false, reason: "not_found" };
      const parsed = parseSkillFile({ path: "SKILL.md", content: suggestion.skillMd });
      const { parts, pkg, path } = await currentParts(tx, userId, place, dek);
      if (isReservedSkillTitle(parsed.name) && parsed.name.trim().toLowerCase() !== parts.name.trim().toLowerCase()) {
        return { ok: false, reason: "problem", message: `${parsed.name} is the name of one of Warthog's skills, so this suggestion can't be used.` };
      }
      if (pkg && path) {
        const files = pkg.files.map((file) => (file.path === path ? { ...file, content: suggestion.skillMd } : file));
        await savePackage(tx, userId, { id: pkg.id, revision: pkg.revision, name: pkg.name, files }, dek, { refuseNewReservedNames: true });
      } else {
        if (parsed.body.length > STANDALONE_TEXT_MAX) return { ok: false, reason: "problem", message: "The suggested instructions are too long for this skill." };
        await editSkill(tx, userId, place.skill.id, {
          title: parsed.name,
          useThisWhen: parsed.description,
          fullText: parsed.body,
          scope: place.skill.scope,
          scopedAgentIds: place.skill.scopedAgentIds,
        }, dek);
      }
      await deleteSkillSuggestion(tx, userId, suggestionId);
      return { ok: true };
    });
  } catch (error) {
    if (error instanceof PackageError) return { ok: false, reason: "problem", message: error.message };
    throw error;
  }
}

/** The person keeps their skill as it is: the suggestion is removed. */
export async function dismissSkillSuggestion(db: Db, userId: string, suggestionId: string): Promise<SuggestionResult> {
  return (await deleteSkillSuggestion(db, userId, suggestionId)) ? { ok: true } : { ok: false, reason: "not_found" };
}
