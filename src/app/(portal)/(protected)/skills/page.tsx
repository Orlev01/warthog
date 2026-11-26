import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { verifySession, type Session } from "@/server/auth/session";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { systemClock } from "@/server/seams/clock";
import { HttpError } from "@/server/http/validate";
import type { Db } from "@/server/db/index";
import { createSkillsActions, type SkillsActions } from "./actions";
import { warthogNotice, warthogReturn, warthogSkillChange, type WarthogNotice } from "./warthog-form";
import { SkillsView } from "@/components/skills/skills-view";
import { PageContainer } from "@/components/shell/page-container";
import { listPackageSummaries } from "@/server/db/skill-packages";
import { listAgentsForUser } from "@/server/db/agents";
import { getUserById } from "@/server/db/users";

// E13-S08 — Skills page (the thin protected-page loader + action wiring over the tested
// `createSkillsActions` seam, `./actions`). It reads the signed-in session from the
// host-locked `__Host-wh_session` cookie, turns it (via the seam's `load`) into the
// person's own skills + preferences — skill content decrypted, the profile decrypted or
// null, plus Warthog's own skills as they stand for them — and mounts the already-render-tested
// <SkillsView/> with each control BOUND to a `use server` wrapper over the SAME seam:
// Save profile (savePreferences), Create / Edit / Duplicate / Switch / Delete skill, and every
// change to one of Warthog's skills (changeWarthogSkill, one action read by ./warthog-form).
// Every wrapper re-derives the verified session (never trusting a client value for
// identity), takes its input from the submitted form, persists member-scoped through the
// seam, and redirects back with a `?notice=` the page renders in plain words — a refusal
// (another person's id, a foreign agent) or a 4xx from the boundary is reported as a
// plain problem, never swallowed (no dead controls, no silent failure).
//
// Thin by design (the server-composition-roots addendum): per-request data (the search
// params) is read BEFORE `getServerDb()` so `next build` marks the page dynamic and never
// prerenders it or opens the database at build time; config is read INSIDE the handler
// (`loadConfig()`), never at module load; the database comes from the process-wide
// `getServerDb()`, never `createDb`, and the shared handle is never closed. The
// `(protected)` layout already guards every page in the app shell. Config and secrets
// flow only through `loadConfig()` (INV-103) — this entry reads no `process.env` of its
// own, and the seam holds no secret (db + KeyWrapper are injected).

const SESSION_COOKIE = "__Host-wh_session";

// Resolve the signed-in session from the cookie (or null), re-derived wherever it is
// needed so no handler trusts a client value for identity (design §5).
async function resolveSession(db: Db): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// Build the skills actions with the real seams. The KeyWrapper (local AES outside
// production, Key Vault in production) lets the seam unwrap the session person's own DEK
// to decrypt/encrypt their skills + preferences content.
function buildActions(db: Db): SkillsActions {
  const config = loadConfig();
  const keyWrapper = selectKeyWrapper({
    nodeEnv: config.nodeEnv,
    localKek: config.devKek,
  });
  return createSkillsActions({ db, keyWrapper });
}

function str(formData: FormData, name: string): string {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : "";
}

// The scope chooser only offers "all" / "chosen"; anything else is normalised to "all".
function scopeOf(formData: FormData): "all" | "chosen" {
  return str(formData, "scope") === "chosen" ? "chosen" : "all";
}

// The chosen agent ids carried through the form (hidden fields the edit form preserves).
function agentIdsOf(formData: FormData): string[] {
  return formData
    .getAll("scopedAgentIds")
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

// The content the create / edit forms submit (title, use-this-when, full text, scope and
// the carried-through chosen agent ids).
function skillContentOf(formData: FormData) {
  return {
    title: str(formData, "title"),
    useThisWhen: str(formData, "useThisWhen"),
    fullText: str(formData, "fullText"),
    scope: scopeOf(formData),
    scopedAgentIds: agentIdsOf(formData),
  };
}

// Run one mutation against the seam under the verified session and redirect back with a
// notice naming the outcome. A reported refusal ({ ok: false }) or a 4xx `HttpError` from
// the validation boundary becomes `problem` — shown in plain words, never swallowed; a
// genuine fault rethrows. `query` adds to the address it returns to (already encoded).
async function run(
  success: Notice,
  mutate: (
    actions: SkillsActions,
    session: Session,
  ) => Promise<{ ok: boolean }>,
  query = "",
): Promise<never> {
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let notice: Notice = success;
  try {
    const result = await mutate(buildActions(db), session);
    if (!result.ok) {
      const reason = (result as { reason?: string }).reason;
      notice = reason === "reserved_title" || reason === "unknown_agent" || reason === "suggestion_gone" || reason === "suggestion_problem" ? reason : "problem";
    }
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }
    notice = error.status === 409 ? "storage_full" : "problem";
  }
  revalidatePath("/skills");
  redirect(`/skills?notice=${notice}${success === "saved" ? "&view=preferences" : ""}${query}`);
}

async function saveProfileAction(formData: FormData): Promise<void> {
  "use server";
  await run("saved", (actions, session) =>
    actions.savePreferences(session, {
      tone: str(formData, "tone"),
      length: str(formData, "length"),
      language: str(formData, "language"),
      units: str(formData, "units"),
      timeZone: str(formData, "timeZone"),
      briefing: str(formData, "briefing"),
    }),
  );
}

async function createSkillAction(formData: FormData): Promise<void> {
  "use server";
  await run("created", (actions, session) =>
    actions.createSkill(session, skillContentOf(formData)),
  );
}

async function editSkillAction(formData: FormData): Promise<void> {
  "use server";
  await run("updated", (actions, session) =>
    actions.editSkill(session, {
      id: str(formData, "id"),
      ...skillContentOf(formData),
    }),
  );
}

async function duplicateSkillAction(formData: FormData): Promise<void> {
  "use server";
  await run("duplicated", (actions, session) =>
    actions.duplicateSkill(session, { id: str(formData, "id") }),
  );
}

async function toggleSkillAction(formData: FormData): Promise<void> {
  "use server";
  await run("switched", (actions, session) =>
    actions.toggleSkill(session, {
      id: str(formData, "id"),
      enabled: str(formData, "enabled") === "true",
    }),
  );
}

async function deleteSkillAction(formData: FormData): Promise<void> {
  "use server";
  await run("deleted", (actions, session) =>
    actions.deleteSkill(session, { id: str(formData, "id") }),
  );
}

// One of Warthog's skills: switch, edit, choose who gets it, remove, restore, or take or
// decline Warthog's newer version. The page comes back with that skill's card open.
async function changeWarthogSkillAction(formData: FormData): Promise<void> {
  "use server";
  const change = warthogSkillChange(formData);
  await run(
    change ? warthogNotice(change.action) : "problem",
    async (actions, session) => (change ? actions.changeWarthogSkill(session, change) : { ok: false }),
    change ? warthogReturn(change.key) : "",
  );
}

// An agent's suggested change to one of the person's skills (docs/adr/agent-saved-skills.md).
async function useSuggestionAction(formData: FormData): Promise<void> {
  "use server";
  await run("suggestion_used", (actions, session) =>
    actions.useSkillSuggestion(session, { id: str(formData, "id") }),
  );
}

async function keepSkillAction(formData: FormData): Promise<void> {
  "use server";
  await run("suggestion_kept", (actions, session) =>
    actions.keepSkill(session, { id: str(formData, "id") }),
  );
}

type Notice =
  | WarthogNotice
  | "suggestion_used"
  | "suggestion_kept"
  | "suggestion_gone"
  | "suggestion_problem"
  | "saved"
  | "created"
  | "updated"
  | "duplicated"
  | "switched"
  | "deleted"
  | "problem"
  | "reserved_title"
  | "unknown_agent"
  | "storage_full";

const NOTICES: Record<Notice, { done: boolean; text: string }> = {
  saved: { done: true, text: "Your preferences were saved." },
  created: { done: true, text: "Skill created." },
  updated: { done: true, text: "Skill updated." },
  duplicated: { done: true, text: "Skill duplicated." },
  switched: { done: true, text: "Skill updated." },
  deleted: { done: true, text: "Skill deleted." },
  problem: { done: false, text: "We couldn't save that change. Check every field is filled in, then try again." },
  reserved_title: { done: false, text: "That's the name of one of Warthog's skills. Choose another name, or change Warthog's skill instead." },
  unknown_agent: { done: false, text: "We couldn't find one of the agents you chose. Refresh the page and choose again." },
  warthog_on: { done: true, text: "Skill switched on." },
  warthog_off: { done: true, text: "Skill switched off. Your agents won't get it until you switch it back on." },
  warthog_removed: { done: true, text: "Skill removed. It's under Removed if you want it back." },
  warthog_restored: { done: true, text: "Skill restored to Warthog's version." },
  warthog_new: { done: true, text: "You're now using Warthog's new version." },
  warthog_kept: { done: true, text: "Kept your version." },
  warthog_scope: { done: true, text: "Saved who gets this skill." },
  suggestion_used: { done: true, text: "Changes used. Agents that get this skill now get the new version." },
  suggestion_kept: { done: true, text: "Kept your version. The suggested changes were removed." },
  suggestion_gone: { done: false, text: "Those changes are no longer waiting. Refresh the page to see the latest." },
  suggestion_problem: {
    done: false,
    text: "We couldn't use those changes. Another skill may already have that name. Keep yours, or edit the skill yourself.",
  },
  storage_full: {
    done: false,
    text: "Storage limit reached. Remove unused items or reduce their size before saving.",
  },
};

function toNotice(raw: string | string[] | undefined): Notice | null {
  return typeof raw === "string" && raw in NOTICES ? (raw as Notice) : null;
}

// The outcome of the last action, in words plus an icon (never colour alone). A problem
// is announced immediately (alert); a success politely (status).
export default async function SkillsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const params = await searchParams;
  const notice = toNotice(params.notice);
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }

  const data = await buildActions(db).load(session);
  const config = loadConfig();
  const user = await getUserById(db, session.userId);
  if (!user) redirect("/signin");
  const dek = await selectKeyWrapper({
    nodeEnv: config.nodeEnv,
    localKek: config.devKek,
  }).unwrap(user.wrappedDek);
  const packages = await listPackageSummaries(db, session.userId, dek);
  const packagedIds = new Set(
    packages.flatMap((p) => p.members.map((m) => m.skillId)),
  );
  const agents = await listAgentsForUser(db, session.userId);

  return (
    <PageContainer>
      <SkillsView
        notice={notice ? { tone: NOTICES[notice].done ? "success" : "error", text: NOTICES[notice].text } : null}
        initialView={typeof params.view === "string" ? params.view : undefined}
        skills={data.skills.map((s) =>
          packagedIds.has(s.id) ? { ...s, fullText: undefined } : s,
        )}
        packages={packages}
        agents={agents.map((a) => ({
          id: a.id,
          displayName: a.displayName,
          status: a.status,
        }))}
        preferences={data.preferences}
        warthogSkills={data.warthogSkills}
        suggestions={data.suggestions}
        useSuggestionAction={useSuggestionAction}
        keepSkillAction={keepSkillAction}
        openWarthogSkill={typeof params.skill === "string" ? params.skill : undefined}
        saveProfileAction={saveProfileAction}
        createSkillAction={createSkillAction}
        editSkillAction={editSkillAction}
        duplicateSkillAction={duplicateSkillAction}
        toggleSkillAction={toggleSkillAction}
        deleteSkillAction={deleteSkillAction}
        changeWarthogSkillAction={changeWarthogSkillAction}
      />
    </PageContainer>
  );
}
