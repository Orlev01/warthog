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
import { createLifeAdminActions, type ActionResult, type LifeAdminActions } from "./actions";
import { LifeAdminScreen } from "@/components/life-admin/life-admin-screen";
import { resolveAssigneeFilter } from "@/components/life-admin/task-groups";
import { firstParam } from "@/lib/href";
import { recordType } from "@/domain/life-admin/record-types";
import type { IdentifierRule } from "@/domain/life-admin/identifiers";
import {
  noticeField,
  recordDate,
  recordFields,
  recordIds,
  recordOffsets,
  recordParent,
  recordReturnPath,
  recordStatus,
  recordTab,
  recordTypeId,
  taskReturnPath,
} from "./form-inputs";

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

// What a finished action reports back in the address: its notice, the field a refusal names
// (`&field=`, a label, never a value), and the record to land on (`#record-<id>`).
type Outcome = { readonly notice: Notice; readonly field?: string; readonly recordId?: string };

const THINGS = "/life-admin?view=life&tab=things";

// Run one mutation against the seam under the verified session and redirect back with a
// notice naming the outcome. `success` is the notice for a success, or works one out from
// the result (a save that matched an existing record, a save that left details out). A
// refusal ({ ok: false }) becomes a plain problem: an identifier Warthog never keeps names
// its rule and field, a form with nothing in it says so. A 4xx `HttpError` from the
// validation boundary becomes `invalidNotice`; a genuine fault rethrows. A refusal returns
// to `failurePath` (the form it came from) when one is given.
async function run(
  success: Notice | ((result: Extract<ActionResult, { ok: true }>) => Outcome),
  mutate: (actions: LifeAdminActions, session: Session) => Promise<ActionResult>,
  returnPath = "/life-admin",
  invalidNotice: Notice = "invalid_input",
  failurePath = returnPath,
): Promise<never> {
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  let outcome: Outcome = { notice: typeof success === "string" ? success : "problem" };
  let path = returnPath;
  try {
    const result = await mutate(buildActions(db), session);
    if (result.ok) {
      outcome = typeof success === "string" ? { notice: success } : success(result);
    } else {
      path = failurePath;
      outcome = result.refusal
        ? { notice: FORBIDDEN_NOTICES[result.refusal.rule], field: result.refusal.field }
        : { notice: result.reason === "empty" ? "record_empty" : "problem" };
    }
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }
    path = failurePath;
    outcome = { notice: error.status === 413 ? "file_too_large" : error.status === 400 || error.status === 422 ? invalidNotice : "problem" };
  }
  revalidatePath("/life-admin");
  const field = outcome.field && noticeField(outcome.field) ? `&field=${encodeURIComponent(outcome.field)}` : "";
  const hash = outcome.recordId ? `#record-${encodeURIComponent(outcome.recordId)}` : "";
  redirect(`${path}${path.includes("?") ? "&" : "?"}notice=${outcome.notice}${field}${hash}`);
}

// A save lands on the record it saved, unless something was left out: then the notice at the
// top says what to check.
function savedOutcome(result: Extract<ActionResult, { ok: true }>): Outcome {
  if (result.problems?.length) return { notice: "saved_partly" };
  const notice: Notice = result.outcome === "updated" ? "saved_matched" : result.outcome === "unchanged" ? "saved_unchanged" : "saved";
  return { notice, recordId: result.recordId };
}

function updatedOutcome(result: Extract<ActionResult, { ok: true }>): Outcome {
  if (result.problems?.length) return { notice: "updated_partly" };
  const notice: Notice = result.outcome === "confirmed" ? "confirmed" : result.outcome === "unchanged" ? "unchanged" : "updated";
  return { notice, recordId: result.recordId };
}

async function addRecordAction(formData: FormData): Promise<void> {
  "use server";
  const type = recordTypeId(formData);
  if (!recordType(type)) redirect(`${THINGS}&notice=record_type_missing#new-record`);
  await run(savedOutcome, (actions, session) =>
    actions.saveRecord(session, {
      type,
      fields: recordFields(formData),
      dueDate: recordDate(formData),
      status: recordStatus(formData),
      parentId: recordParent(formData),
    }),
    THINGS,
    "invalid_input",
    `${THINGS}&add=${encodeURIComponent(type)}`,
  );
}

async function editRecordAction(formData: FormData): Promise<void> {
  "use server";
  const recordId = str(formData, "recordId");
  if (str(formData, "setting") === "reminder") {
    await run(() => ({ notice: "reminded", recordId }), (actions, session) =>
      actions.setRecordReminders(session, {
        id: recordId,
        reminderOffsets: recordOffsets(str(formData, "reminderOffsets")),
      }),
      recordReturnPath(formData),
      "invalid_reminders",
    );
    return;
  }
  await run(updatedOutcome, (actions, session) =>
    actions.updateRecord(session, {
      id: recordId,
      fields: recordFields(formData),
      dueDate: recordDate(formData),
      status: recordStatus(formData),
      parentId: recordParent(formData),
    }),
    recordReturnPath(formData),
  );
}

async function attachFileAction(formData: FormData): Promise<void> {
  "use server";
  const recordId = str(formData, "recordId");
  await run(() => ({ notice: "attached", recordId }), (actions, session) =>
    actions.attachReceiptFile(session, { recordId, file: formData.get("file") }),
    recordReturnPath(formData),
  );
}

async function deleteRecordAction(formData: FormData): Promise<void> {
  "use server";
  await run("deleted", (actions, session) => actions.deleteRecord(session, { id: str(formData, "recordId") }), recordReturnPath(formData));
}

async function confirmRecordAction(formData: FormData): Promise<void> {
  "use server";
  await run("confirmed", (actions, session) => actions.confirmRecord(session, { id: str(formData, "recordId") }), THINGS);
}

async function confirmAllAction(formData: FormData): Promise<void> {
  "use server";
  await run("confirmed_all", (actions, session) => actions.confirmAll(session, { ids: recordIds(formData) }), THINGS);
}

async function dismissRecordAction(formData: FormData): Promise<void> {
  "use server";
  await run("dismissed", (actions, session) => actions.dismissRecord(session, { id: str(formData, "recordId") }), THINGS);
}

async function acceptPendingAction(formData: FormData): Promise<void> {
  "use server";
  const recordId = str(formData, "recordId");
  await run(() => ({ notice: "accepted", recordId }), (actions, session) => actions.acceptPending(session, { id: recordId }), THINGS);
}

async function declinePendingAction(formData: FormData): Promise<void> {
  "use server";
  const recordId = str(formData, "recordId");
  await run(() => ({ notice: "declined", recordId }), (actions, session) => actions.declinePending(session, { id: recordId }), THINGS);
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
  | "saved_matched"
  | "saved_unchanged"
  | "saved_partly"
  | "updated"
  | "updated_partly"
  | "unchanged"
  | "attached"
  | "reminded"
  | "confirmed"
  | "confirmed_all"
  | "dismissed"
  | "accepted"
  | "declined"
  | "ticked"
  | "handed"
  | "created"
  | "assigned"
  | "noted"
  | "completed"
  | "invalid_input"
  | "invalid_reminders"
  | "record_empty"
  | "record_type_missing"
  | "task_title_missing"
  | "note_missing"
  | "problem"
  | ForbiddenNotice;

// One notice per identifier rule (domain/life-admin/identifiers.ts), so the refusal says what
// the value looked like and what to do instead; the field is named, never its value.
type ForbiddenNotice = `forbidden_${IdentifierRule}`;
const FORBIDDEN_NOTICES: Record<IdentifierRule, ForbiddenNotice> = {
  tax_file_number: "forbidden_tax_file_number",
  secret: "forbidden_secret",
  bank_account: "forbidden_bank_account",
  government_id: "forbidden_government_id",
  medicare: "forbidden_medicare",
  payment_details: "forbidden_payment_details",
};

// `{field}` is replaced by the field's label in quotes, or "One of the details".
const NOTICES: Record<Notice, { done: boolean; text: string }> = {
  deleted: { done: true, text: "Record and attached files deleted." },
  file_too_large: { done: false, text: "Nothing was attached: choose a file of 25 MB or less." },
  saved: { done: true, text: "Added to Life admin." },
  saved_matched: { done: true, text: "You already had this in Life admin, so that record was updated instead of adding another." },
  saved_unchanged: { done: true, text: "That's already in Life admin, so nothing changed." },
  saved_partly: { done: false, text: "Saved, but some details were left out: use the date picker for dates, plain amounts such as 412.50, and three-letter currency codes such as AUD." },
  updated: { done: true, text: "Changes saved." },
  updated_partly: { done: false, text: "Changes saved, but some details weren't changed: use the date picker for dates, plain amounts such as 412.50, and three-letter currency codes such as AUD." },
  unchanged: { done: true, text: "Nothing changed." },
  attached: { done: true, text: "File attached." },
  reminded: { done: true, text: "Reminders updated." },
  confirmed: { done: true, text: "Confirmed. Your agents can't change it now without asking you first." },
  confirmed_all: { done: true, text: "All confirmed. Your agents can't change these now without asking you first." },
  dismissed: { done: true, text: "Removed as not yours. If an agent finds it again, it won't be added back." },
  accepted: { done: true, text: "Change accepted." },
  declined: { done: true, text: "Kept your version. The suggested change was dropped." },
  ticked: { done: true, text: "Checklist updated." },
  handed: { done: true, text: "Handed to an agent." },
  created: { done: true, text: "Task created." },
  assigned: { done: true, text: "Task reassigned." },
  noted: { done: true, text: "Note added." },
  completed: { done: true, text: "Task marked done." },
  invalid_input: { done: false, text: "Nothing was saved. Check the values you entered and try again." },
  invalid_reminders: { done: false, text: "Reminders weren't changed. Enter whole days from 0 to 36500, separated by commas, or leave the field empty to turn reminders off." },
  record_empty: { done: false, text: "Nothing was added: fill in at least one detail." },
  record_type_missing: { done: false, text: "Nothing was added: choose what you're adding first." },
  task_title_missing: { done: false, text: "No task was created: describe what needs doing in a few words." },
  note_missing: { done: false, text: "No note was added: write the note first." },
  problem: { done: false, text: "We couldn't save that change. It may have been removed already, so refresh the page and try again." },
  forbidden_tax_file_number: { done: false, text: "Nothing was saved: {field} looks like a tax file number. Warthog never keeps tax file numbers." },
  forbidden_secret: { done: false, text: "Nothing was saved: {field} looks like a password, PIN, security answer or code. Warthog never keeps these in Life admin." },
  forbidden_bank_account: { done: false, text: "Nothing was saved: {field} looks like a BSB and account number. Keep only the bank's name and the last 4 digits." },
  forbidden_government_id: { done: false, text: "Nothing was saved: {field} looks like a passport, licence, visa or Centrelink number. Keep the number in your Vault, and only the expiry date and details here." },
  forbidden_medicare: { done: false, text: "Nothing was saved: {field} looks like a Medicare number. Keep the number in your Vault, and only the expiry date here." },
  forbidden_payment_details: { done: false, text: "Nothing was saved: {field} looks like payment details (how to pay, a payee, a biller code or reference). Warthog doesn't keep payment details; pay through the provider's own app or bill." },
};

function toNotice(raw: string | string[] | undefined): Notice | null {
  return typeof raw === "string" && Object.hasOwn(NOTICES, raw) ? (raw as Notice) : null;
}

// The outcome of the last action, in words plus an icon (never colour alone), as the page's
// one notice slot under the heading band. A problem is announced immediately (alert); a
// success politely (status). It removes `?notice=` (and the field it names) from the address
// once shown.
function OutcomeNotice({ notice, field }: { notice: Notice; field: string | null }) {
  const { done, text } = NOTICES[notice];
  const shown = text.replace("{field}", field ? `\u201c${field}\u201d` : "one of the details");
  return <PageNotice tone={done ? "success" : "error"} clearParams={["notice", "field"]}>{shown}</PageNotice>;
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
        notice={notice ? <OutcomeNotice notice={notice} field={noticeField(firstParam(params.field))} /> : null}
        records={{
          today: data.today,
          // The older tabs (subscriptions, receipts, renewals) in reminder links open "Your things".
          initialTab: recordTab(firstParam(params.tab)),
          addType: recordType(firstParam(params.add) ?? "") ? firstParam(params.add) : null,
          records: data.records,
          checklist: data.checklist,
          addRecordAction,
          editRecordAction,
          attachFileAction,
          deleteRecordAction,
          confirmRecordAction,
          confirmAllAction,
          dismissRecordAction,
          acceptPendingAction,
          declinePendingAction,
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
