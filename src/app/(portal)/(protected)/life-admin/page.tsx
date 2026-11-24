import * as React from "react";
import { redirect } from "next/navigation";

import { getServerDb } from "@/server/db/server";
import type { ActionResult } from "./actions";
import { LifeAdminScreen } from "@/components/life-admin/life-admin-screen";
import { resolveAssigneeFilter } from "@/components/life-admin/task-groups";
import { firstParam } from "@/lib/href";
import {
  historyFilters,
  requestedLifeAdminTab,
  recordTab,
  noticeField,
  recordDate,
  recordFields,
  recordFilters,
  recordIds,
  recordParent,
  recordReturnPath,
  recordStatus,
  recordTypeId,
  reminderOffsetsFrom,
  taskReturnPath,
} from "./form-inputs";
import { OutcomeNotice, toNotice, type Notice } from "./notices";
import { buildActions, resolveSession, run, type Outcome } from "./wiring";
import { loadProfileBuildChoice } from "@/server/home/profile-build";

// E14-S13 — Life Admin page (the thin protected-page loader + action wiring over the
// tested `createLifeAdminActions` seam, `./actions`). It reads the signed-in session
// from the host-locked `__Host-wh_session` cookie, turns it (via the seam's `load`) into
// the person's own records and tasks — content decrypted, each task's assignee + note authors
// resolved to agent names — and mounts the already-render-tested <LifeAdminScreen/>: one row of
// tabs, Records | Add | Upcoming | History | Tasks (`?tab=` picks the one shown first, else Records,
// or Add while nothing is on file; all stay mounted, so switching keeps a half-typed record or task). An older address (`?view=…`, the
// Bookings tab, the moving checklist, older reminder links) opens the tab it meant, and the view
// puts today's address in the browser. Every control
// is BOUND to a `use server` wrapper over the SAME seam; each wrapper re-derives the verified
// session (never trusting a client value for identity), takes its input from the submitted
// form, persists member-scoped through the seam, and redirects back with a `?notice=` the page
// renders in plain words — a refusal (another person's id, a foreign agent) or a 4xx from the
// boundary is reported as a plain problem, never swallowed (no dead controls). The Records tab's
// `?category=…&status=…` filters and History's `?history_category=…&history_status=…` (each
// repeatable) are validated against the person's own catalogue and the known statuses here
// (unknown values are dropped; no Records status means Active), and record actions return to the
// tab and filters they were submitted under. The Tasks view's `?assignee=` filter is validated
// against the person's own agents here (anything else shows every task), and task actions return
// to the filter they were submitted under.
//
// Thin by design (the server-composition-roots addendum): per-request data (the search
// params) is read BEFORE `getServerDb()` so `next build` marks the page dynamic and
// never prerenders it or opens the database at build time; config is read INSIDE the
// handler (`loadConfig()`), never at module load; the database comes from the
// process-wide `getServerDb()`, never `createDb`, and the shared handle is never closed.
// The `(protected)` layout already guards every page. Config and secrets flow only
// through `loadConfig()` (INV-103) — this entry reads no `process.env` of its own, and
// the seam holds no secret (db, KeyWrapper, clock and blob are injected).

// A path with one more query parameter.
function withQuery(path: string, query: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

function str(formData: FormData, name: string): string {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : "";
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
  const back = recordReturnPath(formData);
  if (!type) redirect(`${withQuery(back, "notice=record_type_missing")}#new-record`);
  // Added on the Add tab, a record is then shown on Records (or, when it doesn't live there, as a
  // booking or something finished, on its own page); a problem keeps the person on Add with the
  // form open.
  const landing = recordTab(formData.get("returnTab")) === "add" ? "/life-admin?tab=records" : back;
  await run(savedOutcome, (actions, session) =>
    actions.saveRecord(session, {
      type,
      fields: recordFields(formData),
      dueDate: recordDate(formData),
      status: recordStatus(formData),
      parentId: recordParent(formData),
    }),
    landing,
    "invalid_input",
    withQuery(back, `add=${encodeURIComponent(type)}`),
  );
}

async function editRecordAction(formData: FormData): Promise<void> {
  "use server";
  const recordId = str(formData, "recordId");
  if (str(formData, "setting") === "reminder") {
    await run(() => ({ notice: "reminded", recordId }), (actions, session) =>
      actions.setRecordReminders(session, {
        id: recordId,
        reminderOffsets: reminderOffsetsFrom(formData),
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
  await run("confirmed", (actions, session) => actions.confirmRecord(session, { id: str(formData, "recordId") }), recordReturnPath(formData));
}

async function confirmAllAction(formData: FormData): Promise<void> {
  "use server";
  await run("confirmed_all", (actions, session) => actions.confirmAll(session, { ids: recordIds(formData) }), recordReturnPath(formData));
}

async function dismissRecordAction(formData: FormData): Promise<void> {
  "use server";
  await run("dismissed", (actions, session) => actions.dismissRecord(session, { id: str(formData, "recordId") }), recordReturnPath(formData));
}

async function acceptPendingAction(formData: FormData): Promise<void> {
  "use server";
  const recordId = str(formData, "recordId");
  await run(() => ({ notice: "accepted", recordId }), (actions, session) => actions.acceptPending(session, { id: recordId }), recordReturnPath(formData));
}

async function acceptAllPendingAction(formData: FormData): Promise<void> {
  "use server";
  await run("accepted_all", (actions, session) => actions.acceptAllPending(session, { ids: recordIds(formData) }), recordReturnPath(formData));
}

async function declinePendingAction(formData: FormData): Promise<void> {
  "use server";
  const recordId = str(formData, "recordId");
  await run(() => ({ notice: "declined", recordId }), (actions, session) => actions.declinePending(session, { id: recordId }), recordReturnPath(formData));
}

async function keepCategoryAction(formData: FormData): Promise<void> {
  "use server";
  await run("category_kept", (actions, session) => actions.keepCategory(session, { slug: str(formData, "slug") }), recordReturnPath(formData));
}

async function declineCategoryAction(formData: FormData): Promise<void> {
  "use server";
  await run("category_declined", (actions, session) => actions.declineCategory(session, { slug: str(formData, "slug") }), recordReturnPath(formData));
}

const VISIBILITY_NOTICES: Readonly<Record<string, Notice>> = { shown: "category_shown", hidden: "category_hidden", cleared: "category_cleared" };

async function setCategoryVisibilityAction(formData: FormData): Promise<void> {
  "use server";
  await run(
    (result) => ({ notice: VISIBILITY_NOTICES[result.outcome ?? ""] ?? "updated" }),
    (actions, session) => actions.setCategoryVisibility(session, { category: str(formData, "category"), setting: str(formData, "setting") }),
    recordReturnPath(formData),
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

export default async function LifeAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const params = await searchParams;
  const notice = toNotice(params.notice);
  // The tab the address asks for; none lets the view open Records, or Add while nothing is on file.
  const tab = requestedLifeAdminTab(params);
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }

  const actions = buildActions(db);
  const data = await actions.load(session);
  // The Records and History filters, checked against the person's own catalogue.
  const categoryIds = data.catalogue.categories.map((category) => category.id);
  const recordFilter = recordFilters({ category: params.category, status: params.status }, categoryIds);
  const historyFilter = historyFilters({ history_category: params.history_category, history_status: params.history_status, history_page: params.history_page }, categoryIds);

  // Every tab is rendered (and stays mounted); `tab` only picks the one shown first.
  return (
    <div className="wh-page">
      <LifeAdminScreen
        initialTab={tab}
        notice={notice ? <OutcomeNotice notice={notice} field={noticeField(firstParam(params.field))} /> : null}
        records={{
          today: data.today,
          zone: data.zone,
          catalogue: data.catalogue,
          categories: data.categories,
          suggestedCategories: data.suggestedCategories,
          nextSteps: data.nextSteps,
          // Build your whole profile, on the Add tab (docs/adr/profile-build.md).
          profileBuild: await loadProfileBuildChoice(db, session.userId),
          recordFilter,
          historyFilter,
          // A kind from the person's own catalogue (their categories included), else none.
          addType: data.catalogue.types.some((type) => type.id === firstParam(params.add)) ? firstParam(params.add) : null,
          records: data.records,
          addRecordAction,
          editRecordAction,
          attachFileAction,
          deleteRecordAction,
          confirmRecordAction,
          confirmAllAction,
          dismissRecordAction,
          acceptPendingAction,
          acceptAllPendingAction,
          declinePendingAction,
          keepCategoryAction,
          declineCategoryAction,
          setCategoryVisibilityAction,
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
