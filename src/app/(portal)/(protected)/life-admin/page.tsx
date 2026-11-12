import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { PageNotice } from "@/components/ui/notice";

import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { verifySession, type Session } from "@/server/auth/session";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { selectBlobStore } from "@/server/storage/blob";
import { systemClock } from "@/server/seams/clock";
import { HttpError } from "@/server/http/validate";
import type { Db } from "@/server/db/index";
import { createLifeAdminActions, type LifeAdminActions } from "./actions";
import { LifeAdminScreen } from "@/components/life-admin/life-admin-screen";
import { resolveAssigneeFilter } from "@/components/life-admin/task-groups";
import { firstParam } from "@/lib/href";
import { recordFields, recordDate, recordReturnPath, recordOffsets, recordStatus, recordTitle, taskReturnPath } from "./form-inputs";

// E14-S13 — Life Admin page (the thin protected-page loader + action wiring over the
// tested `createLifeAdminActions` seam, `./actions`). It reads the signed-in session
// from the host-locked `__Host-wh_session` cookie, turns it (via the seam's `load`) into
// the person's own records, moving checklist and tasks — content decrypted, each task's
// assignee + note authors resolved to agent names — and mounts the already-render-tested
// <LifeAdminView/> and <TasksView/> as the two in-page views of <LifeAdminScreen/> (the
// `?view=` query param picks the first one shown; both stay mounted, so switching keeps a
// half-typed record or task). Every control is BOUND to a `use server` wrapper
// over the SAME seam; each wrapper re-derives the verified session (never trusting a
// client value for identity), takes its input from the submitted form, persists
// member-scoped through the seam, and redirects back with a `?notice=` the page renders
// in plain words — a refusal (another person's id, a foreign agent) or a 4xx from the
// boundary is reported as a plain problem, never swallowed (no dead controls). The Tasks
// view's `?assignee=` filter is validated against the person's own agents here (anything
// else shows every task), and task actions return to the filter they were submitted under.
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

// Run one mutation against the seam under the verified session and redirect back with a
// notice naming the outcome. A reported refusal ({ ok: false }) or a 4xx `HttpError`
// from the validation boundary becomes `problem` — shown in plain words, never
// swallowed; a genuine fault rethrows.
async function run(
  success: Notice,
  mutate: (actions: LifeAdminActions, session: Session) => Promise<{ ok: boolean }>,
  returnPath = "/life-admin",
  invalidNotice: Notice = "invalid_input",
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
    notice = error.status === 413 ? "file_too_large" : error.status === 400 || error.status === 422 ? invalidNotice : "problem";
  }
  revalidatePath("/life-admin");
  redirect(`${returnPath}${returnPath.includes("?") ? "&" : "?"}notice=${notice}`);
}

async function addRecordAction(formData: FormData): Promise<void> {
  "use server";
  // A name made only of spaces is refused with a notice that names the field.
  const title = recordTitle(formData);
  if (title === null) redirect(`${recordReturnPath(formData)}&notice=record_title_missing`);
  await run("saved", (actions, session) =>
    actions.saveRecord(session, {
      kind: str(formData, "kind") as "subscription" | "receipt_warranty" | "renewal_appointment",
      fields: { name: title },
      dueDate: recordDate(formData),
      status: recordStatus(formData),
    }),
    recordReturnPath(formData),
  );
}

async function editRecordAction(formData: FormData): Promise<void> {
  "use server";
  if (str(formData, "setting") === "reminder") {
    await run("reminded", (actions, session) =>
      actions.setRecordReminders(session, {
        id: str(formData, "recordId"),
        reminderOffsets: recordOffsets(str(formData, "reminderOffsets")),
      }),
      recordReturnPath(formData),
      "invalid_reminders",
    );
    return;
  }
  await run("updated", (actions, session) =>
    actions.updateRecord(session, { id: str(formData, "recordId"), fields: recordFields(formData),
      dueDate: recordDate(formData), status: recordStatus(formData) }),
    recordReturnPath(formData),
  );
}

async function attachFileAction(formData: FormData): Promise<void> {
  "use server";
  await run("attached", (actions, session) =>
    actions.attachReceiptFile(session, { recordId: str(formData, "recordId"), file: formData.get("file") }),
    recordReturnPath(formData),
  );
}

async function deleteRecordAction(formData: FormData): Promise<void> {
  "use server";
  await run("deleted", (actions, session) => actions.deleteRecord(session, { id: str(formData, "recordId") }), recordReturnPath(formData));
}

async function tickOffAction(formData: FormData): Promise<void> {
  "use server";
  await run("ticked", (actions, session) =>
    actions.toggleChecklistItem(session, { id: str(formData, "itemId") }),
    "/life-admin?view=life&tab=checklist",
  );
}

async function handToAgentAction(formData: FormData): Promise<void> {
  "use server";
  await run("handed", (actions, session) =>
    actions.handChecklistItemToAgent(session, { id: str(formData, "itemId") }),
    "/life-admin?view=life&tab=checklist",
  );
}

async function createTaskAction(formData: FormData): Promise<void> {
  "use server";
  // The boundary trims the title, so one made only of spaces is refused as a missing title.
  await run("created", (actions, session) => actions.createTask(session, { title: str(formData, "title") }),
    taskReturnPath(formData), "task_title_missing");
}

async function assignAction(formData: FormData): Promise<void> {
  "use server";
  await run("assigned", (actions, session) =>
    actions.assignTask(session, { id: str(formData, "taskId"), assignee: str(formData, "assignee") }),
    taskReturnPath(formData),
  );
}

async function addNoteAction(formData: FormData): Promise<void> {
  "use server";
  await run("noted", (actions, session) =>
    actions.addTaskNote(session, { id: str(formData, "taskId"), text: str(formData, "note") }),
    taskReturnPath(formData),
    "note_missing",
  );
}

async function completeAction(formData: FormData): Promise<void> {
  "use server";
  await run("completed", (actions, session) =>
    actions.completeTask(session, { id: str(formData, "taskId") }),
    taskReturnPath(formData),
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
  | "invalid_input"
  | "invalid_reminders"
  | "record_title_missing"
  | "task_title_missing"
  | "note_missing"
  | "problem";

const NOTICES: Record<Notice, { done: boolean; text: string }> = {
  deleted: { done: true, text: "Record and attached files deleted." },
  file_too_large: { done: false, text: "Nothing was attached: choose a file of 25 MB or less." },
  saved: { done: true, text: "Record added." },
  updated: { done: true, text: "Changes saved." },
  attached: { done: true, text: "File attached." },
  reminded: { done: true, text: "Reminders updated." },
  ticked: { done: true, text: "Checklist updated." },
  handed: { done: true, text: "Handed to an agent." },
  created: { done: true, text: "Task created." },
  assigned: { done: true, text: "Task reassigned." },
  noted: { done: true, text: "Note added." },
  completed: { done: true, text: "Task marked done." },
  invalid_input: { done: false, text: "Nothing was saved. Check the values you entered and try again." },
  invalid_reminders: { done: false, text: "Reminders weren't changed. Enter whole days from 0 to 36500, separated by commas, or leave the field empty to turn reminders off." },
  record_title_missing: { done: false, text: "Nothing was added: give the record a name in \u201cWhat to add\u201d." },
  task_title_missing: { done: false, text: "No task was created: describe what needs doing in a few words." },
  note_missing: { done: false, text: "No note was added: write the note first." },
  problem: { done: false, text: "We couldn't save that change. It may have been removed already, so refresh the page and try again." },
};

function toNotice(raw: string | string[] | undefined): Notice | null {
  return typeof raw === "string" && Object.hasOwn(NOTICES, raw) ? (raw as Notice) : null;
}

// The outcome of the last action, in words plus an icon (never colour alone), as the page's
// one notice slot under the heading band. A problem is announced immediately (alert); a
// success politely (status). It removes `?notice=` from the address once shown.
function OutcomeNotice({ notice }: { notice: Notice }) {
  const { done, text } = NOTICES[notice];
  return <PageNotice tone={done ? "success" : "error"}>{text}</PageNotice>;
}

// Which of the two views opens first. The chosen view is carried in the URL (`?view=`).
type LifeAdminTab = "life" | "tasks";

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

  // Both views are rendered (and stay mounted); `active` only picks the one shown first.
  return (
    <div className="wh-page">
      <LifeAdminScreen
        initialView={active}
        notice={notice ? <OutcomeNotice notice={notice} /> : null}
        records={{
          today: data.today,
          initialTab: params.tab === "receipts" || params.tab === "renewals" || params.tab === "checklist" ? params.tab : "subscriptions",
          subscriptions: data.subscriptions,
          receipts: data.receipts,
          renewals: data.renewals,
          checklist: data.checklist,
          addRecordAction,
          editRecordAction,
          attachFileAction,
          deleteRecordAction,
          tickOffAction,
          handToAgentAction,
        }}
        tasks={{
          tasks: data.tasks,
          agents: data.agents,
          assignee: resolveAssigneeFilter(firstParam(params.assignee), data.agents),
          createTaskAction,
          assignAction,
          addNoteAction,
          completeAction,
        }}
      />
    </div>
  );
}
