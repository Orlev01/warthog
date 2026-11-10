import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Notice as InlineNotice } from "@/components/ui/notice";

import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { verifySession, type Session } from "@/server/auth/session";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { selectBlobStore } from "@/server/storage/blob";
import { systemClock } from "@/server/seams/clock";
import { HttpError } from "@/server/http/validate";
import type { Db } from "@/server/db/index";
import { createLifeAdminActions, type LifeAdminActions } from "./actions";
import { LifeAdminView } from "@/components/life-admin/life-admin-view";
import { TasksView } from "@/components/life-admin/tasks-view";

// E14-S13 — Life Admin page (the thin protected-page loader + action wiring over the
// tested `createLifeAdminActions` seam, `./actions`). It reads the signed-in session
// from the host-locked `__Host-wh_session` cookie, turns it (via the seam's `load`) into
// the person's own records, moving checklist and tasks — content decrypted, each task's
// assignee + note authors resolved to agent names — and mounts the already-render-tested
// <LifeAdminView/> and <TasksView/> as two tabs (chosen by the `?view=` query param so a
// server page needs no client state). Every control is BOUND to a `use server` wrapper
// over the SAME seam; each wrapper re-derives the verified session (never trusting a
// client value for identity), takes its input from the submitted form, persists
// member-scoped through the seam, and redirects back with a `?notice=` the page renders
// in plain words — a refusal (another person's id, a foreign agent) or a 4xx from the
// boundary is reported as a plain problem, never swallowed (no dead controls).
//
// Thin by design (the server-composition-roots addendum): per-request data (the search
// params) is read BEFORE `getServerDb()` so `next build` marks the page dynamic and
// never prerenders it or opens the database at build time; config is read INSIDE the
// handler (`loadConfig()`), never at module load; the database comes from the
// process-wide `getServerDb()`, never `createDb`, and the shared handle is never closed.
// The `(protected)` layout already guards every page. Config and secrets flow only
// through `loadConfig()` (INV-103) — this entry reads no `process.env` of its own, and
// the seam holds no secret (db, KeyWrapper, clock and blob are injected).

const SESSION_COOKIE = "__Host-wh_session";

// Resolve the signed-in session from the cookie (or null), re-derived wherever it is
// needed so no handler trusts a client value for identity (design §5).
async function resolveSession(db: Db): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// Build the life-admin actions with the real seams. The KeyWrapper (local AES outside
// production, Key Vault in production) unwraps the session person's own DEK; the blob
// store (in-memory outside production, Azure in production) holds receipt ciphertext;
// the system clock supplies `now` to the moving-checklist builder.
function buildActions(db: Db): LifeAdminActions {
  const config = loadConfig();
  const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  const blob = selectBlobStore({
    nodeEnv: config.nodeEnv,
    account: config.blob.account,
    container: config.blob.container,
  });
  return createLifeAdminActions({ db, keyWrapper, clock: systemClock, blob });
}

function str(formData: FormData, name: string): string {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : "";
}

// Every decrypted field the Edit form resubmits (named by its field key), minus the
// reserved control fields — the fields blob `updateRecord` re-encrypts.
function fieldsOf(formData: FormData): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key === "recordId" || key === "setting") continue;
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}

// The comma-separated "days before" the reminder control submits, parsed to a number
// list (a non-numeric entry is dropped; the boundary caps and validates the rest).
function offsetsOf(raw: string): number[] {
  return raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
}

// Run one mutation against the seam under the verified session and redirect back with a
// notice naming the outcome. A reported refusal ({ ok: false }) or a 4xx `HttpError`
// from the validation boundary becomes `problem` — shown in plain words, never
// swallowed; a genuine fault rethrows.
async function run(
  success: Notice,
  mutate: (actions: LifeAdminActions, session: Session) => Promise<{ ok: boolean }>,
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
    notice = error.status === 413 ? "file_too_large" : "problem";
  }
  revalidatePath("/life-admin");
  redirect(`/life-admin?notice=${notice}`);
}

async function addRecordAction(formData: FormData): Promise<void> {
  "use server";
  await run("saved", (actions, session) =>
    actions.saveRecord(session, {
      kind: str(formData, "kind") as "subscription" | "receipt_warranty" | "renewal_appointment",
      fields: { name: str(formData, "title") },
    }),
  );
}

async function editRecordAction(formData: FormData): Promise<void> {
  "use server";
  if (str(formData, "setting") === "reminder") {
    await run("reminded", (actions, session) =>
      actions.setRecordReminders(session, {
        id: str(formData, "recordId"),
        reminderOffsets: offsetsOf(str(formData, "reminderOffsets")),
      }),
    );
    return;
  }
  await run("updated", (actions, session) =>
    actions.updateRecord(session, { id: str(formData, "recordId"), fields: fieldsOf(formData) }),
  );
}

async function attachFileAction(formData: FormData): Promise<void> {
  "use server";
  await run("attached", (actions, session) =>
    actions.attachReceiptFile(session, { recordId: str(formData, "recordId"), file: formData.get("file") }),
  );
}

async function deleteRecordAction(formData: FormData): Promise<void> {
  "use server";
  await run("deleted", (actions, session) => actions.deleteRecord(session, { id: str(formData, "recordId") }));
}

async function tickOffAction(formData: FormData): Promise<void> {
  "use server";
  await run("ticked", (actions, session) =>
    actions.toggleChecklistItem(session, { id: str(formData, "itemId") }),
  );
}

async function handToAgentAction(formData: FormData): Promise<void> {
  "use server";
  await run("handed", (actions, session) =>
    actions.handChecklistItemToAgent(session, { id: str(formData, "itemId") }),
  );
}

async function createTaskAction(formData: FormData): Promise<void> {
  "use server";
  await run("created", (actions, session) => actions.createTask(session, { title: str(formData, "title") }));
}

async function assignAction(formData: FormData): Promise<void> {
  "use server";
  await run("assigned", (actions, session) =>
    actions.assignTask(session, { id: str(formData, "taskId"), assignee: str(formData, "assignee") }),
  );
}

async function addNoteAction(formData: FormData): Promise<void> {
  "use server";
  await run("noted", (actions, session) =>
    actions.addTaskNote(session, { id: str(formData, "taskId"), text: str(formData, "note") }),
  );
}

async function completeAction(formData: FormData): Promise<void> {
  "use server";
  await run("completed", (actions, session) =>
    actions.completeTask(session, { id: str(formData, "taskId") }),
  );
}

type Notice =
  | "deleted"
  | "file_too_large"
  | "saved"
  | "updated"
  | "attached"
  | "reminded"
  | "ticked"
  | "handed"
  | "created"
  | "assigned"
  | "noted"
  | "completed"
  | "problem";

const NOTICES: Record<Notice, { done: boolean; text: string }> = {
  deleted: { done: true, text: "Record and attached files deleted." },
  file_too_large: { done: false, text: "Choose a file of 25 MiB or less." },
  saved: { done: true, text: "Saved." },
  updated: { done: true, text: "Changes saved." },
  attached: { done: true, text: "File attached." },
  reminded: { done: true, text: "Reminders updated." },
  ticked: { done: true, text: "Checklist updated." },
  handed: { done: true, text: "Handed to an agent." },
  created: { done: true, text: "Task created." },
  assigned: { done: true, text: "Task reassigned." },
  noted: { done: true, text: "Note added." },
  completed: { done: true, text: "Task marked done." },
  problem: { done: false, text: "Something went wrong. Please try again." },
};

function toNotice(raw: string | string[] | undefined): Notice | null {
  return typeof raw === "string" && raw in NOTICES ? (raw as Notice) : null;
}

// The outcome of the last action, in words plus an icon (never colour alone). A problem
// is announced immediately (alert); a success politely (status).
function NoticeBanner({ notice }: { notice: Notice }) {
  const { done, text } = NOTICES[notice];
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-8 sm:px-6">
      <InlineNotice tone={done ? "success" : "error"}>{text}</InlineNotice>
    </div>
  );
}

// The two-tab nav over the Life Admin and Tasks surfaces. The chosen tab is carried in
// the URL (`?view=`) so this server page needs no client state; both links are always
// navigable.
type LifeAdminTab = "life" | "tasks";

const TAB_BASE =
  "inline-flex min-h-11 items-center justify-center rounded-card px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const TAB_ACTIVE = `${TAB_BASE} border border-line bg-surface-muted text-fg`;
const TAB_INACTIVE = `${TAB_BASE} text-fg-muted hover:bg-surface-muted`;

function SectionTabs({ active }: { active: LifeAdminTab }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-6 sm:px-6">
      <nav className="flex flex-wrap gap-2" aria-label="Life admin sections">
        <a
          href="/life-admin?view=life"
          aria-current={active === "life" ? "page" : undefined}
          className={active === "life" ? TAB_ACTIVE : TAB_INACTIVE}
        >
          Life admin
        </a>
        <a
          href="/life-admin?view=tasks"
          aria-current={active === "tasks" ? "page" : undefined}
          className={active === "tasks" ? TAB_ACTIVE : TAB_INACTIVE}
        >
          Tasks
        </a>
      </nav>
    </div>
  );
}

export default async function LifeAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const params = await searchParams;
  const notice = toNotice(params.notice);
  const active: LifeAdminTab = params.view === "tasks" ? "tasks" : "life";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }

  // (Re)build the moving checklist from the person's current move before loading, so
  // changing the postal address (in the vault) makes the checklist show here — exactly
  // the brief's "Warthog shows the moving checklist in Life Admin". The builder is
  // idempotent (it never duplicates a source or resets a ticked-off item) and seeds
  // nothing when there is no move on file.
  const actions = buildActions(db);
  await actions.refreshMovingChecklist(session);
  const data = await actions.load(session);

  return (
    <>
      {notice ? <NoticeBanner notice={notice} /> : null}
      <SectionTabs active={active} />
      {active === "tasks" ? (
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
          <TasksView
            tasks={data.tasks}
            agents={data.agents}
            createTaskAction={createTaskAction}
            assignAction={assignAction}
            addNoteAction={addNoteAction}
            completeAction={completeAction}
          />
        </div>
      ) : (
        <LifeAdminView
          subscriptions={data.subscriptions}
          receipts={data.receipts}
          renewals={data.renewals}
          checklist={data.checklist}
          addRecordAction={addRecordAction}
          editRecordAction={editRecordAction}
          attachFileAction={attachFileAction}
          deleteRecordAction={deleteRecordAction}
          tickOffAction={tickOffAction}
          handToAgentAction={handToAgentAction}
        />
      )}
    </>
  );
}
