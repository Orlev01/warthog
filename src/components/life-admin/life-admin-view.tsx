"use client";

import * as React from "react";
import {
  AlertTriangle,
  Bell,
  BellOff,
  Calendar,
  CalendarClock,
  CalendarOff,
  ChevronDown,
  Inbox,
  ListChecks,
  Plus,
  Settings2,
  Trash2,
  type LucideIcon,
} from "lucide-react";

import { ViewPanels } from "@/components/ui/view-tabs";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { ActionForm, FormSubmit, PendingFormFields } from "@/components/ui/form-submit";
import { Button, buttonClasses, type ButtonVariant } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Field, Label, SelectField } from "@/components/ui/field";
import { CONTROL_TEXT } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty";
import { receiptUploadError } from "@/lib/receipt-upload";
import { groupRecordsByDue, recordTitle, reminderSummary, type DueGroupKey } from "./record-groups";
import { RECORD_STATUS_CHOICES, dueLine, fieldLabel, recordFacts, statusLabel } from "./record-format";

// E14-S11 — Life-admin records and checklist view component
// (src/components/life-admin/life-admin-view.tsx).
//
// The Life Admin screen is a primary-journey surface (brief "Life admin" /
// "Moving-house helper"; design §4.1): the person sees and maintains the records they
// and their agents both keep — SUBSCRIPTIONS, RECEIPTS & WARRANTIES, and RENEWALS &
// APPOINTMENTS — on tabs, alongside the MOVING CHECKLIST. Every record shows its
// (already-decrypted) fields with add/edit controls and a per-record reminder-offset
// setting; a receipt also carries an attach-file control with its return-by and
// warranty-end dates; each checklist item carries a tick-off and a "hand to an agent"
// control.
//
// Layout (the UI/UX pass): the four record views are one bounded panel whose tab row is its
// top ruled row, so the page reads as heading band → one panel, never text on the canvas.
// Inside a view the Add disclosure comes first (a "+" button), then the due-date groups as
// sub-sections with divider rows. A row leads with the record's name and "Due 1 Dec 2026 ·
// Active", then its facts as label/value pairs in a fixed label column (record-format.ts:
// plain labels, formatted dates, one "Cost" line), its reminder setting in words and one
// "Manage" disclosure holding reminders, attach, edit and delete (delete asks first).
//
// Organisation (the "tidy and organise" pass): each record tab groups its records by how
// soon they fall due — Overdue, Next 30 days, Later, No due date — soonest first, with
// counts on the groups and on the tabs. The `#record-<id>` anchor stays on the row
// (reminder notifications and other pages link to it). The loader passes the person's
// local date as `today`, so grouping never reads the clock.
//
// This is the pure, prop-driven VIEW (a Client Component in the app): it renders the
// screen FROM the props the Life Admin page loader (E14-S10 `lifeAdminPageData`) hands
// it, with fields already decrypted and server actions passed in — exactly the
// precedent the sibling memory / inbox / connectors views set (pre-formatted values in,
// no clock / DB / session in the view). The page heading and the Records | Tasks views
// live in LifeAdminScreen (./life-admin-screen.tsx).
//
// No control may ever be dead (constitution: "No dead controls"): a control whose
// server action is not supplied — or that cannot act because of the record's own state
// (a checklist item already handed to an agent) — renders DISABLED with a one-line
// reason tied to it. Colour comes from the design tokens (globals.css) and shared
// components, never a raw hex.

// ─── the prop contract this task introduces ─────────────────────────────────────────

export type RecordKind =
  | "subscription"
  | "receipt_warranty"
  | "renewal_appointment";

// One life-admin record as the view renders it, AFTER the loader has decrypted its
// fields: its id, its kind, its decrypted display fields (key → value), its due date,
// its status, its current reminder offsets (days before due) and — receipts only —
// whether a file is already attached.
export type LifeAdminRecordView = {
  id: string;
  kind: RecordKind;
  fields: Record<string, string>;
  dueDate: string | null;
  status: string;
  reminderOffsets: number[];
  hasAttachedFile?: boolean;
  files?: readonly { id: string; size: number }[];
};

// One moving-checklist item: its id, its label, whether it is ticked off, and the id of
// the task it was handed to an agent as (non-null ⇒ already handed off).
export type ChecklistItemView = {
  id: string;
  label: string;
  done: boolean;
  linkedTaskId: string | null;
};

export type LifeAdminTab =
  | "subscriptions"
  | "receipts"
  | "renewals"
  | "checklist";

// A control bound to a server action the page passes.
type LifeAdminAction = (formData: FormData) => void | Promise<void>;

export type LifeAdminViewProps = {
  // The person's local date (YYYY-MM-DD, in their account time zone), from the loader.
  // Records are grouped as overdue / due soon / later against it; the view never reads
  // the clock.
  today: string;
  subscriptions: ReadonlyArray<LifeAdminRecordView>;
  receipts: ReadonlyArray<LifeAdminRecordView>;
  renewals: ReadonlyArray<LifeAdminRecordView>;
  checklist: ReadonlyArray<ChecklistItemView>;
  // Which tab's content a render shows; the four tabs are always navigable.
  initialTab?: LifeAdminTab;
  // Controls bound to the server actions the page passes. OPTIONAL: a control whose
  // action is supplied is LIVE; one with no action renders DISABLED with a stated reason
  // (no dead controls). The page (a later task) always supplies them.
  addRecordAction?: LifeAdminAction;
  editRecordAction?: LifeAdminAction;
  attachFileAction?: LifeAdminAction;
  deleteRecordAction?: LifeAdminAction;
  tickOffAction?: LifeAdminAction;
  handToAgentAction?: LifeAdminAction;
};

// ─── shared pieces ───────────────────────────────────────────────────────────────────

// A <summary> that looks like a Button: the shared button look, with the disclosure marker
// hidden because the label (and its chevron) says what opens.
function summaryClass(variant: ButtonVariant, size: "sm" | "md" = "md"): string {
  return buttonClasses({ variant, size, className: "w-fit list-none [&::-webkit-details-marker]:hidden" });
}

// The native file picker, on the field tokens: 16px text on touch screens, the picker
// button as a quiet pill.
const FILE_INPUT_CLASS = `min-h-11 min-w-0 w-full max-w-full text-fg file:me-3 file:min-h-9 file:cursor-pointer file:rounded-full file:border file:border-line file:bg-surface file:px-3 file:text-sm file:font-medium file:text-fg ${CONTROL_TEXT}`;

// A small muted line under a control: help text or the reason a control is unavailable.
const HINT_CLASS = "text-sm text-fg-muted";

// ─── a present-but-not-actionable control (no dead controls) ─────────────────────────
//
// The native `disabled` attribute does the disabling, and a one-line reason says why; the
// reason is tied to the button so a screen reader announces it with the control.
function DisabledControl({ label, reason }: { label: string; reason: string }) {
  const reasonId = React.useId();
  return (
    <div className="flex flex-col gap-1">
      <Button variant="secondary" disabled aria-describedby={reasonId}>
        {label}
      </Button>
      <p id={reasonId} className={HINT_CLASS}>{reason}</p>
    </div>
  );
}

// ─── per-record controls ─────────────────────────────────────────────────────────────

// Each record kind's Add control, revealed from a disclosure so an empty tab still shows
// it. LIVE (a form bound to addRecordAction, carrying the record kind) when supplied;
// otherwise DISABLED with a reason.
const ADD_LABELS: Record<RecordKind, string> = {
  subscription: "Add a subscription",
  receipt_warranty: "Add a receipt",
  renewal_appointment: "Add a renewal",
};

const RECORD_TABS: Record<RecordKind, string> = {
  subscription: "subscriptions", receipt_warranty: "receipts", renewal_appointment: "renewals",
};

// The record's status as a choice: the usual statuses, plus the record's own value when an
// agent saved something else, so editing never silently changes it.
function StatusField({ id, status }: { id: string; status: string }) {
  const current = status.trim() || "active";
  const known = RECORD_STATUS_CHOICES.some((choice) => choice.value === current.toLowerCase());
  return (
    <SelectField label="Status" id={`${id}-status`} name="status" defaultValue={known ? current.toLowerCase() : current} width="short">
      {known ? null : <option value={current}>{statusLabel(current)}</option>}
      {RECORD_STATUS_CHOICES.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </SelectField>
  );
}

function ScheduleFields({ id, dueDate, status = "active" }: { id: string; dueDate?: string | null; status?: string }) {
  return <>
    <input type="hidden" name="recordFormVersion" value="2" />
    <Field
      label="Due date (optional)"
      id={`${id}-date`}
      type="date"
      name="dueDate"
      defaultValue={dueDate ?? ""}
      hint="Reminders use this date. Leave it empty for no reminders."
      width="short"
    />
    <StatusField id={id} status={status} />
  </>;
}

function AddControl({
  kind,
  addRecordAction,
}: {
  kind: RecordKind;
  addRecordAction?: LifeAdminAction;
}) {
  const fieldId = React.useId();
  const label = ADD_LABELS[kind];
  if (!addRecordAction) {
    return (
      <DisabledControl
        label={label}
        reason="Adding isn't available just now."
      />
    );
  }
  return (
    <details className="group/add min-w-0">
      <summary className={summaryClass("secondary")}>
        <Plus aria-hidden={true} className="h-4 w-4 shrink-0" />
        {label}
        <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open/add:rotate-180" />
      </summary>
      <ActionForm action={addRecordAction} className="mt-3 flex flex-col gap-4 rounded-card bg-surface-muted p-4">
        <PendingFormFields>
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="returnTab" value={RECORD_TABS[kind]} />
          <Field
            label="What to add"
            id={fieldId}
            name="title"
            placeholder="Describe it"
            required
            maxLength={2000}
            width="text"
          />
          <ScheduleFields id={fieldId} />
        </PendingFormFields>
        <div>
          <FormSubmit variant="primary" pendingLabel="Adding…">{label}</FormSubmit>
        </div>
      </ActionForm>
    </details>
  );
}

// The per-record reminder-offset setting: a labelled control prefilled with the record's
// OWN current offsets (days before due), so it reflects the record, not a default.
// Adjusting a record's reminders is an edit, so it is bound to editRecordAction; DISABLED
// with a reason when that is not supplied.
function ReminderSetting({
  record,
  editRecordAction,
}: {
  record: LifeAdminRecordView;
  editRecordAction?: LifeAdminAction;
}) {
  const fieldId = React.useId();
  const value = record.reminderOffsets.join(", ");
  if (!editRecordAction) {
    return (
      <Field
        label="Remind me (days before)"
        id={fieldId}
        name="reminderOffsets"
        defaultValue={value}
        disabled
        hint="Changing reminders isn't available just now."
        width="short"
      />
    );
  }
  return (
    <ActionForm action={editRecordAction} className="flex flex-col gap-3">
      <PendingFormFields>
        <input type="hidden" name="recordId" value={record.id} />
        <input type="hidden" name="returnTab" value={RECORD_TABS[record.kind]} />
        <input type="hidden" name="setting" value="reminder" />
        <Field
          label="Remind me (days before)"
          id={fieldId}
          name="reminderOffsets"
          defaultValue={value}
          inputMode="numeric"
          hint="Whole days from 0 to 36500, separated by commas (for example, 14, 1). Leave it empty to turn reminders off."
          width="short"
        />
      </PendingFormFields>
      <div>
        <FormSubmit variant="secondary" pendingLabel="Saving…">Save reminder</FormSubmit>
      </div>
    </ActionForm>
  );
}

// The attach-file control for a receipt. LIVE (a form bound to attachFileAction, with a
// file input) when supplied; otherwise the file input renders DISABLED with a reason.
function AttachControl({
  record,
  attachFileAction,
}: {
  record: LifeAdminRecordView;
  attachFileAction?: LifeAdminAction;
}) {
  const fieldId = React.useId();
  if (!attachFileAction) {
    return (
      <div className="flex flex-col gap-2">
        <Label htmlFor={fieldId}>Attach a file</Label>
        <input
          id={fieldId}
          type="file"
          name="file"
          disabled
          aria-describedby={`${fieldId}-reason`}
          className={FILE_INPUT_CLASS}
        />
        <p id={`${fieldId}-reason`} className={HINT_CLASS}>
          Attaching a file isn't available just now.
        </p>
      </div>
    );
  }
  return (
    <ActionForm action={attachFileAction} className="flex flex-col gap-3">
      <PendingFormFields>
        <input type="hidden" name="recordId" value={record.id} />
        <input type="hidden" name="returnTab" value={RECORD_TABS[record.kind]} />
        <div className="flex flex-col gap-2">
          <Label htmlFor={fieldId}>Attach a file</Label>
          <p id={`${fieldId}-help`} className={`-mt-1 ${HINT_CLASS}`}>
            Up to 25 MB per file. Files are encrypted before they&apos;re stored.
          </p>
          <input
            id={fieldId}
            type="file"
            name="file"
            required
            aria-describedby={`${fieldId}-help`}
            className={FILE_INPUT_CLASS}
            onChange={(event) => {
              const input = event.currentTarget;
              const file = input.files?.[0];
              input.setCustomValidity(
                file ? (receiptUploadError(file.size) ?? "") : "Choose a file.",
              );
              if (file) input.reportValidity();
            }}
          />
        </div>
      </PendingFormFields>
      <div>
        <FormSubmit variant="secondary" pendingLabel="Attaching…">Attach file</FormSubmit>
      </div>
    </ActionForm>
  );
}

// A record's Edit control: a disclosure whose form (bound to editRecordAction) carries
// this record's id and an input per decrypted field prefilled with its value, each with its
// plain label. DISABLED with a reason when editRecordAction is not supplied.
function EditControl({
  record,
  name,
  editRecordAction,
}: {
  record: LifeAdminRecordView;
  name: string;
  editRecordAction?: LifeAdminAction;
}) {
  const baseId = React.useId();
  if (!editRecordAction) {
    return (
      <DisabledControl
        label="Edit"
        reason="Editing isn't available just now."
      />
    );
  }
  return (
    <details className="group/edit min-w-0 open:basis-full">
      <summary className={summaryClass("secondary", "sm")}>
        Edit<span className="sr-only"> {name}</span>
        <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open/edit:rotate-180" />
      </summary>
      <ActionForm action={editRecordAction} className="mt-3 flex flex-col gap-4">
        <PendingFormFields>
          <input type="hidden" name="recordId" value={record.id} />
          <input type="hidden" name="returnTab" value={RECORD_TABS[record.kind]} />
          {Object.entries(record.fields).map(([key, fieldValue], index) => (
            <Field
              key={key}
              label={fieldLabel(key)}
              id={`${baseId}-${index}`}
              name={`field:${key}`}
              defaultValue={fieldValue}
              width="text"
            />
          ))}
          <ScheduleFields id={baseId} dueDate={record.dueDate} status={record.status} />
        </PendingFormFields>
        <div>
          <FormSubmit variant="secondary" pendingLabel="Saving…">Save changes</FormSubmit>
        </div>
      </ActionForm>
    </details>
  );
}

// Delete cannot be undone, so it asks first: a danger disclosure whose panel says what will
// go, then the final danger submit.
function DeleteControl({
  record,
  name,
  deleteRecordAction,
}: {
  record: LifeAdminRecordView;
  name: string;
  deleteRecordAction: LifeAdminAction;
}) {
  return (
    <details className="min-w-0 open:basis-full">
      <summary className={summaryClass("danger", "sm")}>
        <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
        Delete record<span className="sr-only"> {name}</span>
      </summary>
      <div className="mt-3 flex flex-col gap-3 rounded-card bg-surface-muted p-4">
        <p className="text-sm text-fg">
          Delete this record and all its attached files? This can&apos;t be undone.
        </p>
        <ActionForm action={deleteRecordAction}>
          <input type="hidden" name="recordId" value={record.id} />
          <input type="hidden" name="returnTab" value={RECORD_TABS[record.kind]} />
          <FormSubmit variant="danger-solid" pendingLabel="Deleting…">Delete record and files</FormSubmit>
        </ActionForm>
      </div>
    </details>
  );
}

// The kind's own word, for a record with no filled-in field to lead with.
const KIND_NOUNS: Record<RecordKind, string> = {
  subscription: "Subscription",
  receipt_warranty: "Receipt",
  renewal_appointment: "Renewal",
};

// ONE disclosure holding every per-record control — the reminder form, the attach form
// (receipts), Edit and Delete (with its own confirmation step) — so a long list reads as
// names and dates, not a stack of forms. Its summary is named for the record so each
// "Manage" is distinguishable to a screen reader.
function ManageControls({
  record,
  name,
  editRecordAction,
  attachFileAction,
  deleteRecordAction,
}: {
  record: LifeAdminRecordView;
  name: string;
  editRecordAction?: LifeAdminAction;
  attachFileAction?: LifeAdminAction;
  deleteRecordAction?: LifeAdminAction;
}) {
  return (
    <details className="group/manage min-w-0">
      {/* Pulled left by its own padding, so its icon lines up with the row's text. */}
      <summary className={`${summaryClass("ghost", "sm")} -ms-3`}>
        <Settings2 aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted" />
        Manage<span className="sr-only"> {name}</span>
        <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open/manage:rotate-180" />
      </summary>
      <div className="mt-2 flex min-w-0 flex-col gap-5 border-s-2 border-line ps-4">
        <ReminderSetting record={record} editRecordAction={editRecordAction} />
        {record.kind === "receipt_warranty" ? <AttachControl record={record} attachFileAction={attachFileAction} /> : null}
        <div className="flex min-w-0 flex-wrap items-start gap-2 border-t border-line pt-4">
          <EditControl record={record} name={name} editRecordAction={editRecordAction} />
          {deleteRecordAction ? <DeleteControl record={record} name={name} deleteRecordAction={deleteRecordAction} /> : null}
        </div>
      </div>
    </details>
  );
}

// A file size in megabytes, for the download links.
function megabytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb < 0.1 ? "under 0.1 MB" : `${mb.toFixed(1)} MB`;
}

// One record as a divider row: its name, due date and status, its other decrypted fields
// as labelled facts, its reminder setting in words, its downloads (receipts) and the Manage
// disclosure. The row keeps the `record-<id>` anchor (focusable, clear of the sticky header)
// that reminder notifications and other pages link to.
function RecordRow({
  record,
  editRecordAction,
  attachFileAction,
  deleteRecordAction,
}: {
  record: LifeAdminRecordView;
  editRecordAction?: LifeAdminAction;
  attachFileAction?: LifeAdminAction;
  deleteRecordAction?: LifeAdminAction;
}) {
  const { title, key: titleKey } = recordTitle(record.fields);
  const name = title || KIND_NOUNS[record.kind];
  const facts = recordFacts(record.fields, titleKey);
  const reminders = reminderSummary(record.dueDate, record.reminderOffsets);
  const ReminderIcon = reminders.on ? Bell : BellOff;
  const line = dueLine(record.dueDate, record.status);
  return (
    <li id={`record-${record.id}`} tabIndex={-1} className={`${LIST_ROW} scroll-mt-32`}>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="font-medium text-fg">{name}</p>
          {line ? <p className="text-sm text-fg-muted">{line}</p> : null}
        </div>

        {facts.length ? (
          <dl className="grid min-w-0 max-w-xl grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)]">
            {facts.map((fact) => (
              <React.Fragment key={fact.key}>
                <dt className="min-w-0 text-fg-muted [overflow-wrap:anywhere]">
                  {fact.label}
                </dt>
                <dd className="mb-2 min-w-0 text-fg [overflow-wrap:anywhere] sm:mb-0">
                  {fact.value}
                </dd>
              </React.Fragment>
            ))}
          </dl>
        ) : null}

        <p className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
          <ReminderIcon aria-hidden={true} className="h-4 w-4 shrink-0" />
          {reminders.text}
        </p>

        {record.files?.length ? (
          <ul className="flex flex-col">
            {record.files.map((file, index) => (
              <li key={file.id}>
                <a
                  href={`/api/receipts/${file.id}`}
                  className="inline-flex min-h-11 items-center text-sm font-medium text-fg underline underline-offset-4"
                >
                  Download attachment {index + 1} ({megabytes(file.size)})
                  <span className="sr-only"> for {name}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : null}

        <ManageControls
          record={record}
          name={name}
          editRecordAction={editRecordAction}
          attachFileAction={attachFileAction}
          deleteRecordAction={deleteRecordAction}
        />
      </div>
    </li>
  );
}

// Each due group's heading icon (decorative: the heading's words carry the meaning).
const DUE_GROUP_ICONS: Record<DueGroupKey, { Icon: LucideIcon; tone: string }> = {
  overdue: { Icon: AlertTriangle, tone: "text-warning" },
  soon: { Icon: CalendarClock, tone: "text-fg-muted" },
  later: { Icon: Calendar, tone: "text-fg-muted" },
  undated: { Icon: CalendarOff, tone: "text-fg-muted" },
};

function DueGroupTitle({ group, title }: { group: DueGroupKey; title: string }) {
  const { Icon, tone } = DUE_GROUP_ICONS[group];
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon aria-hidden={true} className={`h-4 w-4 shrink-0 ${tone}`} />
      {title}
    </span>
  );
}

// What an empty record view says will appear there.
const EMPTY_COPY: Record<RecordKind, { heading: string; description: string }> = {
  subscription: {
    heading: "No subscriptions yet.",
    description: "Add the services you pay for regularly. You and your agents see each one here with its cost, due date and reminders.",
  },
  receipt_warranty: {
    heading: "No receipts yet.",
    description: "Add a purchase to keep its receipt, return-by date and warranty in one place.",
  },
  renewal_appointment: {
    heading: "No renewals or appointments yet.",
    description: "Add a licence, registration or appointment and Warthog reminds you before it's due.",
  },
};

// A record tab's content: its Add control (offered even with no records), then the records
// grouped by due date (only the groups that have records), soonest first, as sub-sections
// of the records panel.
function RecordPanel({
  kind,
  records,
  today,
  addRecordAction,
  editRecordAction,
  attachFileAction,
  deleteRecordAction,
}: {
  kind: RecordKind;
  records: ReadonlyArray<LifeAdminRecordView>;
  today: string;
  addRecordAction?: LifeAdminAction;
  editRecordAction?: LifeAdminAction;
  attachFileAction?: LifeAdminAction;
  deleteRecordAction?: LifeAdminAction;
}) {
  return (
    <>
      <AddControl kind={kind} addRecordAction={addRecordAction} />
      {records.length === 0 ? (
        <EmptyState variant="inline" icon={Inbox} heading={EMPTY_COPY[kind].heading} description={EMPTY_COPY[kind].description} />
      ) : (
        <div className="flex min-w-0 flex-col">
          {groupRecordsByDue(records, today).map((group) => (
            <ListGroup
              key={group.key}
              id={`records-${kind}-${group.key}`}
              title={<DueGroupTitle group={group.key} title={group.title} />}
              count={group.records.length}
            >
              {group.records.map((record) => (
                <RecordRow
                  key={record.id}
                  record={record}
                  editRecordAction={editRecordAction}
                  attachFileAction={attachFileAction}
                  deleteRecordAction={deleteRecordAction}
                />
              ))}
            </ListGroup>
          ))}
        </div>
      )}
    </>
  );
}

// ─── the moving checklist ────────────────────────────────────────────────────────────

// The tick-off control: a checkbox reflecting whether the item is done, named for its item.
// LIVE (ticking submits the page's tickOffAction) when supplied; otherwise DISABLED with a
// reason.
function TickControl({
  item,
  tickOffAction,
}: {
  item: ChecklistItemView;
  tickOffAction?: LifeAdminAction;
}) {
  const reasonId = React.useId();
  if (!tickOffAction) {
    return (
      <div className="flex flex-col gap-1">
        <label className="inline-flex min-h-11 items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            className="size-4"
            defaultChecked={item.done}
            disabled
            aria-describedby={reasonId}
          />
          Done<span className="sr-only">: {item.label}</span>
        </label>
        <p id={reasonId} className={HINT_CLASS}>
          Ticking items off isn't available just now.
        </p>
      </div>
    );
  }
  return (
    <ActionForm action={tickOffAction}>
      <PendingFormFields pendingLabel="Saving checklist…">
        <input type="hidden" name="itemId" value={item.id} />
        <label className="inline-flex min-h-11 items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            name="done"
            className="size-4"
            defaultChecked={item.done}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              event.currentTarget.form?.requestSubmit()
            }
          />
          Done<span className="sr-only">: {item.label}</span>
        </label>
      </PendingFormFields>
    </ActionForm>
  );
}

// The "hand to an agent" control. DISABLED with a reason when the item is already linked
// to a task (you cannot hand it off twice) or when no handToAgentAction is supplied;
// otherwise LIVE (a form bound to handToAgentAction, carrying this item's id).
function HandControl({
  item,
  handToAgentAction,
}: {
  item: ChecklistItemView;
  handToAgentAction?: LifeAdminAction;
}) {
  if (item.linkedTaskId !== null) {
    return (
      <DisabledControl
        label="Hand to an agent"
        reason="Already handed to an agent, so you can't hand it off again."
      />
    );
  }
  if (!handToAgentAction) {
    return (
      <DisabledControl
        label="Hand to an agent"
        reason="Handing items to an agent isn't available just now."
      />
    );
  }
  return (
    <ActionForm action={handToAgentAction}>
      <input type="hidden" name="itemId" value={item.id} />
      <FormSubmit variant="secondary" size="sm" pendingLabel="Handing over…">
        Hand to an agent<span className="sr-only">: {item.label}</span>
      </FormSubmit>
    </ActionForm>
  );
}

function ChecklistItem({
  item,
  tickOffAction,
  handToAgentAction,
}: {
  item: ChecklistItemView;
  tickOffAction?: LifeAdminAction;
  handToAgentAction?: LifeAdminAction;
}) {
  return (
    <li className={LIST_ROW}>
      <p className="text-fg">{item.label}</p>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <TickControl item={item} tickOffAction={tickOffAction} />
        <HandControl item={item} handToAgentAction={handToAgentAction} />
      </div>
    </li>
  );
}

function ChecklistPanel({
  checklist,
  tickOffAction,
  handToAgentAction,
}: {
  checklist: ReadonlyArray<ChecklistItemView>;
  tickOffAction?: LifeAdminAction;
  handToAgentAction?: LifeAdminAction;
}) {
  const done = checklist.filter((item) => item.done).length;
  return (
    <>
      {checklist.length === 0 ? null : (
        <p className={HINT_CLASS}>
          {`${done} of ${checklist.length} done. Tick items off, or hand one to an agent to do for you.`}
        </p>
      )}
      {checklist.length === 0 ? (
        <EmptyState
          variant="inline"
          icon={ListChecks}
          heading="No moving checklist yet."
          description="It appears when you add an upcoming address in About you, listing the places that still have your old one."
          action={<ButtonLink href="/vault" size="sm">Go to About you</ButtonLink>}
        />
      ) : (
        <ul role="list" className="flex min-w-0 flex-col">
          {checklist.map((item) => (
            <ChecklistItem
              key={item.id}
              item={item}
              tickOffAction={tickOffAction}
              handToAgentAction={handToAgentAction}
            />
          ))}
        </ul>
      )}
    </>
  );
}

// ─── the view ────────────────────────────────────────────────────────────────────────

export { nextTabIndex } from "@/components/ui/view-tabs";

// A tab label with its count, e.g. "Subscriptions (3)".
function counted(label: string, count: number): string {
  return `${label} (${count})`;
}

// The records half of Life admin: one bounded panel whose top row is the record-kind tab
// row (scrolling in one line on phones, the selected tab kept in view) and whose body is
// the selected kind's records. Everything stays mounted, so a half-typed record survives a
// tab switch.
export function LifeAdminView({
  today,
  subscriptions,
  receipts,
  renewals,
  checklist,
  initialTab,
  addRecordAction,
  editRecordAction,
  attachFileAction,
  deleteRecordAction,
  tickOffAction,
  handToAgentAction,
}: LifeAdminViewProps) {
  const recordActions = {
    today,
    addRecordAction,
    editRecordAction,
    attachFileAction,
    deleteRecordAction,
  };
  return (
    <section aria-label="Records and reminders" className="wh-panel wh-records-panel">
      <div className="wh-panel-body flex min-w-0 flex-col gap-4">
        <ViewPanels
          label="Record types"
          parameter="tab"
          initialTab={initialTab}
          tabs={[
            {
              key: "subscriptions",
              label: counted("Subscriptions", subscriptions.length),
              content: <RecordPanel kind="subscription" records={subscriptions} {...recordActions} />,
            },
            {
              key: "receipts",
              label: counted("Receipts & warranties", receipts.length),
              content: <RecordPanel kind="receipt_warranty" records={receipts} {...recordActions} />,
            },
            {
              key: "renewals",
              label: counted("Renewals & appointments", renewals.length),
              content: <RecordPanel kind="renewal_appointment" records={renewals} {...recordActions} />,
            },
            {
              key: "checklist",
              label: counted("Moving checklist", checklist.length),
              content: (
                <ChecklistPanel
                  checklist={checklist}
                  tickOffAction={tickOffAction}
                  handToAgentAction={handToAgentAction}
                />
              ),
            },
          ]}
        />
      </div>
    </section>
  );
}

export default LifeAdminView;
