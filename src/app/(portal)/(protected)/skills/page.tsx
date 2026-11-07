import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { verifySession, type Session } from "@/server/auth/session";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { systemClock } from "@/server/seams/clock";
import { HttpError } from "@/server/http/validate";
import type { Db } from "@/server/db/index";
import { createSkillsActions, type SkillsActions } from "./actions";
import { SkillsView } from "@/components/skills/skills-view";
import { PageContainer } from "@/components/shell/page-container";

// E13-S08 — Skills page (the thin protected-page loader + action wiring over the tested
// `createSkillsActions` seam, `./actions`). It reads the signed-in session from the
// host-locked `__Host-wh_session` cookie, turns it (via the seam's `load`) into the
// person's own skills + preferences — skill content decrypted, the profile decrypted or
// null, plus the always-included house skill — and mounts the already-render-tested
// <SkillsView/> with each control BOUND to a `use server` wrapper over the SAME seam:
// Save profile (savePreferences), Create / Edit / Duplicate / Switch / Delete skill.
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
  const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
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
// genuine fault rethrows.
async function run(
  success: Notice,
  mutate: (actions: SkillsActions, session: Session) => Promise<{ ok: boolean }>,
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
      notice = "problem";
    }
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }
    notice = "problem";
  }
  revalidatePath("/skills");
  redirect(`/skills?notice=${notice}`);
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
  await run("created", (actions, session) => actions.createSkill(session, skillContentOf(formData)));
}

async function editSkillAction(formData: FormData): Promise<void> {
  "use server";
  await run("updated", (actions, session) =>
    actions.editSkill(session, { id: str(formData, "id"), ...skillContentOf(formData) }),
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
    actions.toggleSkill(session, { id: str(formData, "id"), enabled: str(formData, "enabled") === "true" }),
  );
}

async function deleteSkillAction(formData: FormData): Promise<void> {
  "use server";
  await run("deleted", (actions, session) =>
    actions.deleteSkill(session, { id: str(formData, "id") }),
  );
}

type Notice = "saved" | "created" | "updated" | "duplicated" | "switched" | "deleted" | "problem";

const NOTICES: Record<Notice, { done: boolean; text: string }> = {
  saved: { done: true, text: "Your style profile was saved." },
  created: { done: true, text: "Skill created." },
  updated: { done: true, text: "Skill updated." },
  duplicated: { done: true, text: "Skill duplicated." },
  switched: { done: true, text: "Skill updated." },
  deleted: { done: true, text: "Skill deleted." },
  problem: { done: false, text: "Something went wrong. Please try again." },
};

function toNotice(raw: string | string[] | undefined): Notice | null {
  return typeof raw === "string" && raw in NOTICES ? (raw as Notice) : null;
}

// The outcome of the last action, in words plus an icon (never colour alone). A problem
// is announced immediately (alert); a success politely (status).
function NoticeBanner({ notice }: { notice: Notice }) {
  const { done, text } = NOTICES[notice];
  const Icon = done ? CheckCircle2 : AlertTriangle;
  return (
    <div
      role={done ? "status" : "alert"}
      className="mb-8 flex items-start gap-3 rounded-card border border-line bg-surface p-4 text-sm text-fg"
    >
      <Icon aria-hidden={true} className="mt-0.5 h-5 w-5 shrink-0" />
      <p>{text}</p>
    </div>
  );
}

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

  return (
    <PageContainer>
      {notice ? <NoticeBanner notice={notice} /> : null}
      <SkillsView
        skills={data.skills}
        preferences={data.preferences}
        houseSkill={data.houseSkill}
        saveProfileAction={saveProfileAction}
        createSkillAction={createSkillAction}
        editSkillAction={editSkillAction}
        duplicateSkillAction={duplicateSkillAction}
        toggleSkillAction={toggleSkillAction}
        deleteSkillAction={deleteSkillAction}
      />
    </PageContainer>
  );
}
