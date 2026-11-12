"use client";

import * as React from "react";
import { AlertTriangle, Bell, BellOff, Calendar, CalendarClock, CalendarOff, ChevronDown, Settings2, type LucideIcon } from "lucide-react";

import { ViewPanels } from "@/components/ui/view-tabs";
import { ListGroup, LIST_ROW } from "@/components/ui/list-group";
import { ActionForm, FormSubmit, PendingFormFields } from "@/components/ui/form-submit";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty";
import { receiptUploadError } from "@/lib/receipt-upload";
import { groupRecordsByDue, recordTitle, reminderSummary, type DueGroupKey } from "./record-groups";

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
// Organisation (the "tidy and organise" pass): each record tab groups its records by how
// soon they fall due — Overdue, Next 30 days, Later, No due date — soonest first, with
// counts on the groups and on the tabs. A row leads with the record's name, due date,
// other fields and a one-line reminder summary; its controls (reminders, attach, edit,
// delete) sit behind ONE "Manage" disclosure. The `#record-<id>` anchor stays on the row
// (reminder notifications and other pages link to it). The loader passes the person's
// local date as `today`, so grouping never reads the clock.
//
// This is the pure, prop-driven VIEW (a Client Component in the app): it renders the
// screen FROM the props the Life Admin page loader (E14-S10 `lifeAdminPageData`) hands
// it, with fields already decrypted and server actions passed in — exactly the
// precedent the sibling memory / inbox / connectors views set (pre-formatted values in,
// no clock / DB / session in the view). The real page wiring (reading the data, binding
// the server actions) lives in a LATER task.
//
// No control may ever be dead (constitution: "No dead controls"): a control whose
// server action is not supplied — or that cannot act because of the record's own state
// (a checklist item already handed to an agent) — renders DISABLED with a one-line
// reason. Colour comes from the design tokens (globals.css) and shared components, never
// a raw hex.

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

// ─── styling (design tokens; no raw hex) ─────────────────────────────────────────────
//
// Native control classes on the tokens. They deliberately omit the shared Button's
// `disabled:` utility variants so a LIVE control's class never reads as "disabled"; the
// one DISABLED control carries the native `disabled` attribute instead (same approach as
// the sibling inbox / connectors views). The accent fill is a tab's / an Add's one
// primary action; everything else is the neutral surface.
const BTN_BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const BTN_DISABLED = `${BTN_BASE} border border-line bg-surface text-fg-muted opacity-50`;

const SUMMARY_CLASS =
  "inline-flex min-h-11 w-fit cursor-pointer items-center gap-2 rounded-card text-sm font-medium text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";
const FILE_INPUT_CLASS =
  "min-h-11 min-w-0 w-full max-w-full text-base text-fg file:me-3 file:rounded-card file:border file:border-line file:bg-surface file:px-3 file:py-2 file:text-sm file:text-fg sm:text-sm";

// ─── a present-but-not-actionable control (no dead controls) ─────────────────────────
//
// The native `disabled` attribute does the disabling, and a one-line reason says why.
function DisabledControl({ label, reason }: { label: string; reason: string }) {
  return (
    <div className="flex flex-col gap-1">
      <button type="button" disabled className={BTN_DISABLED}>
        {label}
      </button>
      <p className="text-xs text-fg-muted">{reason}</p>
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

function ScheduleFields({ id, dueDate, status = "active" }: { id: string; dueDate?: string | null; status?: string }) {
  return <>
    <input type="hidden" name="recordFormVersion" value="2" />
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-date`}>Due date (optional)</Label>
      <Input id={`${id}-date`} type="date" name="dueDate" defaultValue={dueDate ?? ""} aria-describedby={`${id}-date-help`} />
      <p id={`${id}-date-help`} className="text-xs text-fg-muted">Reminders use this date. Leave it empty for no reminders.</p>
    </div>
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${id}-status`}>Status</Label>
      <Input id={`${id}-status`} name="status" defaultValue={status} required maxLength={200} />
    </div>
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
    <details className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <summary className={SUMMARY_CLASS}>{label}</summary>
      <ActionForm action={addRecordAction} className="mt-2 flex flex-col gap-3">
        <PendingFormFields>
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="returnTab" value={RECORD_TABS[kind]} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId}>What to add</Label>
            <Input
              id={fieldId}
              name="title"
              placeholder="Describe it"
              required
              maxLength={2000}
            />
          </div>
          <ScheduleFields id={fieldId} />
        </PendingFormFields>
        <div>
          <FormSubmit variant="primary" preserveFocus pendingLabel="Adding record…">{label}</FormSubmit>
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
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fieldId}>Remind me (days before)</Label>
        <Input
          id={fieldId}
          name="reminderOffsets"
          defaultValue={value}
          disabled
        />
        <p className="text-xs text-fg-muted">
          Changing reminders isn't available just now.
        </p>
      </div>
    );
  }
  return (
    <ActionForm action={editRecordAction} className="flex flex-col gap-1.5">
      <PendingFormFields>
        <input type="hidden" name="recordId" value={record.id} />
        <input type="hidden" name="returnTab" value={RECORD_TABS[record.kind]} />
        <input type="hidden" name="setting" value="reminder" />
        <Label htmlFor={fieldId}>Remind me (days before)</Label>
        <Input id={fieldId} name="reminderOffsets" defaultValue={value} aria-describedby={`${fieldId}-help`} />
        <p id={`${fieldId}-help`} className="text-xs text-fg-muted">
          Use whole days from 0 to 36500, separated by commas (for example, 14, 1). Leave empty to turn reminders off.
        </p>
      </PendingFormFields>
      <div>
        <FormSubmit variant="secondary" preserveFocus pendingLabel="Saving reminder…">Save reminder</FormSubmit>
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
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={fieldId}>Attach a file</Label>
        <input
          id={fieldId}
          type="file"
          name="file"
          disabled
          className={FILE_INPUT_CLASS}
        />
        <p className="text-xs text-fg-muted">
          Attaching a file isn't available just now.
        </p>
      </div>
    );
  }
  return (
    <ActionForm action={attachFileAction} className="flex flex-col gap-1.5">
      <PendingFormFields>
        <input type="hidden" name="recordId" value={record.id} />
        <input type="hidden" name="returnTab" value={RECORD_TABS[record.kind]} />
        <Label htmlFor={fieldId}>Attach a file</Label>
        <input
          id={fieldId}
          type="file"
          name="file"
          required
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
        <p className="text-xs text-fg-muted">
          Up to 25 MiB per file. Files are encrypted before storage.
        </p>
      </PendingFormFields>
      <div>
        <FormSubmit variant="secondary" preserveFocus pendingLabel="Attaching file…">Attach file</FormSubmit>
      </div>
    </ActionForm>
  );
}

// A record's Edit control: a disclosure whose form (bound to editRecordAction) carries
// this record's id and an input per decrypted field prefilled with its value. DISABLED
// with a reason when editRecordAction is not supplied.
function EditControl({
  record,
  editRecordAction,
}: {
  record: LifeAdminRecordView;
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
    <details className="flex flex-col gap-3">
      <summary className={SUMMARY_CLASS}>Edit</summary>
      <ActionForm action={editRecordAction} className="mt-2 flex flex-col gap-3">
        <PendingFormFields>
          <input type="hidden" name="recordId" value={record.id} />
          <input type="hidden" name="returnTab" value={RECORD_TABS[record.kind]} />
          {Object.entries(record.fields).map(([key, fieldValue], index) => {
            const fieldId = `${baseId}-${index}`;
            return (
              <div key={key} className="flex flex-col gap-1.5">
                <Label htmlFor={fieldId}>{key}</Label>
                <Input id={fieldId} name={`field:${key}`} defaultValue={fieldValue} />
              </div>
            );
          })}
          <ScheduleFields id={baseId} dueDate={record.dueDate} status={record.status} />
        </PendingFormFields>
        <div>
          <FormSubmit variant="secondary" preserveFocus pendingLabel="Saving changes…">Save changes</FormSubmit>
        </div>
      </ActionForm>
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
    <details className="group/manage">
      <summary className={`${SUMMARY_CLASS} list-none [&::-webkit-details-marker]:hidden`}>
        <Settings2 aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted" />
        Manage<span className="sr-only"> {name}</span>
        <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open/manage:rotate-180" />
      </summary>
      <div className="mt-2 flex min-w-0 flex-col gap-5 border-s-2 border-line ps-4">
        <ReminderSetting record={record} editRecordAction={editRecordAction} />
        {record.kind === "receipt_warranty" ? <AttachControl record={record} attachFileAction={attachFileAction} /> : null}
        <EditControl record={record} editRecordAction={editRecordAction} />
        {deleteRecordAction ? (
          <details>
            <summary className={SUMMARY_CLASS}>Delete record</summary>
            <p className="my-3 text-sm text-fg-muted">
              Delete this record and all its attached files? This cannot be
              undone.
            </p>
            <ActionForm action={deleteRecordAction}>
              <input type="hidden" name="recordId" value={record.id} />
              <input type="hidden" name="returnTab" value={RECORD_TABS[record.kind]} />
              <FormSubmit variant="secondary" preserveFocus pendingLabel="Deleting record…">Delete record and files</FormSubmit>
            </ActionForm>
          </details>
        ) : null}
      </div>
    </details>
  );
}

// One record as a divider row: its name, due date and status, its other decrypted fields,
// its reminder setting in words, its downloads (receipts) and the Manage disclosure. The
// row keeps the `record-<id>` anchor (focusable, clear of the sticky header) that
// reminder notifications and other pages link to.
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
  const otherFields = Object.entries(record.fields).filter(([key]) => key !== titleKey);
  const reminders = reminderSummary(record.dueDate, record.reminderOffsets);
  const ReminderIcon = reminders.on ? Bell : BellOff;
  return (
    <li id={`record-${record.id}`} tabIndex={-1} className={`${LIST_ROW} scroll-mt-32`}>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium text-fg">{name}</p>
          <p className="text-sm text-fg-muted">
            {record.dueDate
              ? `Due ${record.dueDate} · ${record.status}`
              : record.status}
          </p>
        </div>

        {otherFields.length ? (
          <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            {otherFields.map(([key, fieldValue]) => (
              <React.Fragment key={key}>
                <dt className="min-w-0 text-fg-muted [overflow-wrap:anywhere]">
                  {key}
                </dt>
                <dd className="mb-2 min-w-0 text-fg [overflow-wrap:anywhere] sm:mb-0">
                  {fieldValue}
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
                  className="inline-flex min-h-11 items-center text-sm underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                >
                  Download attachment {index + 1} (
                  {(file.size / 1024 / 1024).toFixed(2)} MiB)
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

// A record tab's panel: its Add control (offered even with no records) and the records,
// grouped by due date (only the groups that have records), soonest first.
function RecordPanel({
  kind,
  heading,
  records,
  today,
  addRecordAction,
  editRecordAction,
  attachFileAction,
  deleteRecordAction,
}: {
  kind: RecordKind;
  heading: string;
  records: ReadonlyArray<LifeAdminRecordView>;
  today: string;
  addRecordAction?: LifeAdminAction;
  editRecordAction?: LifeAdminAction;
  attachFileAction?: LifeAdminAction;
  deleteRecordAction?: LifeAdminAction;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-fg">{heading}</h2>
      <AddControl kind={kind} addRecordAction={addRecordAction} />
      {records.length === 0 ? (
        <EmptyState
          heading="Nothing here yet"
          description="When you add one it'll show here with its details and reminders."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {groupRecordsByDue(records, today).map((group) => (
            <ListGroup
              key={group.key}
              id={`records-${kind}-${group.key}`}
              level={3}
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
    </section>
  );
}

// ─── the moving checklist ────────────────────────────────────────────────────────────

// The tick-off control: a checkbox reflecting whether the item is done. LIVE (ticking
// submits the page's tickOffAction) when supplied; otherwise DISABLED with a reason.
function TickControl({
  item,
  tickOffAction,
}: {
  item: ChecklistItemView;
  tickOffAction?: LifeAdminAction;
}) {
  if (!tickOffAction) {
    return (
      <div className="flex flex-col gap-1">
        <label className="inline-flex min-h-11 items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            className="size-4"
            defaultChecked={item.done}
            disabled
          />
          Done
        </label>
        <p className="text-xs text-fg-muted">
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
          Done
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
      <FormSubmit variant="secondary" preserveFocus pendingLabel="Handing to an agent…">Hand to an agent</FormSubmit>
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
    <li className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4">
      <p className="text-fg">{item.label}</p>
      <div className="flex flex-wrap items-center gap-4">
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
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-fg">Moving checklist</h2>
      {checklist.length === 0 ? (
        <EmptyState
          heading="No checklist items yet"
          description="Your moving checklist will show here, each item ready to tick off or hand to an agent."
        />
      ) : (
        <ul className="flex flex-col gap-3">
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
    </section>
  );
}

// ─── the view ────────────────────────────────────────────────────────────────────────

export { nextTabIndex } from "@/components/ui/view-tabs";

// A tab label with its count, e.g. "Subscriptions (3)".
function counted(label: string, count: number): string {
  return `${label} (${count})`;
}

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
    <div className="wh-page flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">
        Life admin
      </h1>
      <ViewPanels
        label="Life admin sections"
        parameter="tab"
        initialTab={initialTab}
        tabs={[
          {
            key: "subscriptions",
            label: counted("Subscriptions", subscriptions.length),
            content: (
              <RecordPanel
                kind="subscription"
                heading="Subscriptions"
                records={subscriptions}
                {...recordActions}
              />
            ),
          },
          {
            key: "receipts",
            label: counted("Receipts & warranties", receipts.length),
            content: (
              <RecordPanel
                kind="receipt_warranty"
                heading="Receipts & warranties"
                records={receipts}
                {...recordActions}
              />
            ),
          },
          {
            key: "renewals",
            label: counted("Renewals & appointments", renewals.length),
            content: (
              <RecordPanel
                kind="renewal_appointment"
                heading="Renewals & appointments"
                records={renewals}
                {...recordActions}
              />
            ),
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
  );
}

export default LifeAdminView;
