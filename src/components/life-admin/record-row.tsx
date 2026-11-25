"use client";

import * as React from "react";
import { Bell, BellOff, ChevronDown, CircleDashed, GitCompare, Link2, Trash2, UserCheck } from "lucide-react";

import { LIST_ROW } from "@/components/ui/list-group";
import { ActionForm, FormSubmit, PendingFormFields } from "@/components/ui/form-submit";
import { Label } from "@/components/ui/field";
import { CONTROL_TEXT } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { Catalogue } from "@/domain/life-admin/catalogue";
import { shortDate } from "@/domain/life-admin/journal";
import type { DueMeans, RecordTypeDef } from "@/domain/life-admin/record-types";
import { receiptUploadError } from "@/lib/receipt-upload";
import { phaseOfView, reminderSummary } from "./record-groups";
import { formatCalendarDate, provenanceLine, recordName, rowSummary, typedFacts, whenLine } from "./record-format";
import { DisabledControl, EditRecordForm, HINT_CLASS, ReturnFields, parentOptions, summaryClass } from "./record-forms";
import { PhaseBadge } from "./phase-badge";
import type { AssetOption, LifeAdminAction, LifeAdminRecordView, RecordActions, RecordHandlingView } from "./record-view-types";

// One record as a compact divider row (docs/adr/life-admin-profile.md), so a long list scans: its
// name (a link to the item's own page, with its journal), where it stands as words and an icon
// ("Due soon"), a "Not checked yet" tag while it is an agent's suggestion, then one muted line —
// its kind, when it's due, renews or starts in the kind's words, its cost and cycle, and its
// provider ("Expires 14 Dec 2026 · AUD 412.50 a year · Transport for NSW") — and who is handling
// it with its next step. Everything else is one click away in its "Details" disclosure: its facts
// labelled and formatted the kind's way, when Warthog will remind the person about its date (and
// a choice of days to change that; nothing at all when it has no date), who added it (and where
// an agent says it found it), its downloads (receipts), and its controls (attach, edit, delete). Every value is text: nothing an agent read from email, or wrote in a journal, ever
// becomes a link.
//
// The row keeps the `record-<id>` anchor (focusable, clear of the sticky header) that
// reminder notifications, Home and the Coming up list link to. Where the record also shows on
// another tab that carries that anchor (Upcoming, Bills), the row is marked `data-record="<id>"`
// instead, so the page has one anchor per record and a link can still land on the row on screen.
// A tab may give the row its own muted line (`summary`; Bills: when the next payment is, what it
// costs) and one more line under it (`extra`; Bills: what it comes out of).

/** An item's own page, with where it stands and its whole journal. */
export const itemHref = (id: string) => `/life-admin/items/${encodeURIComponent(id)}`;

// The native file picker, on the field tokens: 16px text on touch screens, the picker
// button as a quiet pill.
const FILE_INPUT_CLASS = `min-h-11 min-w-0 w-full max-w-full text-fg file:me-3 file:min-h-9 file:cursor-pointer file:rounded-full file:border file:border-line file:bg-surface file:px-3 file:text-sm file:font-medium file:text-fg ${CONTROL_TEXT}`;

// The days before a record's date its reminders can go out: the usual choices, plus any other day
// the record already has, so nothing set before is lost. Latest first.
export const REMINDER_CHOICES: readonly number[] = [30, 14, 7, 1, 0];
export function reminderChoices(current: readonly number[]): number[] {
  return [...new Set([...REMINDER_CHOICES, ...current])].sort((a, b) => b - a);
}
const choiceLabel = (days: number) => (days === 0 ? "On the day" : `${days} ${days === 1 ? "day" : "days"} before`);

// The record's date in words, the way its kind says it ("Expires 14 Dec 2026", "Starts 3 Dec 2026").
export function dateWords(type: RecordTypeDef, dueDate: string): string {
  return `${type.due?.label ?? "Due"} ${formatCalendarDate(dueDate)}`;
}

// What the date is, for "Remind me before …".
const BEFORE: Readonly<Record<DueMeans, string>> = {
  expires: "it expires",
  renews: "it renews",
  due: "it's due",
  ends: "it ends",
  return_by: "the return-by date",
  starts: "it starts",
};

// When Warthog reminds the person about this record's date, as a choice of days (ticked: the
// record's own). Changing it is an edit, so it is bound to editRecordAction; the boxes are
// DISABLED with a reason when that is not supplied. Unticking every box turns reminders off.
function ReminderSetting({ record, type, dueDate, editRecordAction }: { record: LifeAdminRecordView; type: RecordTypeDef; dueDate: string; editRecordAction?: LifeAdminAction }) {
  const hintId = React.useId();
  const choices = reminderChoices(record.reminderOffsets);
  const before = type.due ? BEFORE[type.due.means] : "the date";
  const boxes = (
    <fieldset className="flex min-w-0 flex-col gap-1" aria-describedby={hintId} disabled={!editRecordAction}>
      <legend className="text-sm font-medium text-fg">
        Remind me before {before} ({formatCalendarDate(dueDate)})
      </legend>
      <p id={hintId} className={HINT_CLASS}>
        {editRecordAction
          ? "Warthog sends a notification to the devices where you've turned notifications on. Untick them all for no reminders."
          : "Changing reminders isn't available just now."}
      </p>
      <ul role="list" className="grid min-w-0 grid-cols-1 gap-x-4 sm:grid-cols-2">
        {choices.map((days) => (
          <li key={days} className="min-w-0">
            <label className="inline-flex min-h-11 items-center gap-2 text-sm text-fg">
              <input type="checkbox" name="reminderOffsets" value={String(days)} defaultChecked={record.reminderOffsets.includes(days)} className="size-4" />
              {choiceLabel(days)}
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
  return (
    <details className="group/reminders min-w-0">
      <summary className={`${summaryClass("ghost", "sm")} -ms-3`}>
        Change reminders
        <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open/reminders:rotate-180" />
      </summary>
      <div className="mt-2 flex min-w-0 flex-col gap-3 rounded-card bg-surface-muted p-4">
        {editRecordAction ? (
          <ActionForm action={editRecordAction} className="flex flex-col gap-3">
            <PendingFormFields>
              <input type="hidden" name="recordId" value={record.id} />
              <ReturnFields />
              <input type="hidden" name="setting" value="reminder" />
              {boxes}
            </PendingFormFields>
            <div>
              <FormSubmit variant="secondary" pendingLabel="Saving…">Save reminders</FormSubmit>
            </div>
          </ActionForm>
        ) : (
          boxes
        )}
      </div>
    </details>
  );
}

// The attach-file control for a receipt. LIVE (a form bound to attachFileAction, with a
// file input) when supplied; otherwise the file input renders DISABLED with a reason.
function AttachControl({ record, attachFileAction }: { record: LifeAdminRecordView; attachFileAction?: LifeAdminAction }) {
  const fieldId = React.useId();
  if (!attachFileAction) {
    return (
      <div className="flex flex-col gap-2">
        <Label htmlFor={fieldId}>Attach a file</Label>
        <input id={fieldId} type="file" name="file" disabled aria-describedby={`${fieldId}-reason`} className={FILE_INPUT_CLASS} />
        <p id={`${fieldId}-reason`} className={HINT_CLASS}>
          Attaching a file isn&apos;t available just now.
        </p>
      </div>
    );
  }
  return (
    <ActionForm action={attachFileAction} className="flex flex-col gap-3">
      <PendingFormFields>
        <input type="hidden" name="recordId" value={record.id} />
        <ReturnFields />
        <div className="flex min-w-0 flex-col gap-2">
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
              input.setCustomValidity(file ? (receiptUploadError(file.size) ?? "") : "Choose a file.");
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

// A record's Edit control: a disclosure holding the typed edit form. DISABLED with a reason
// when editRecordAction is not supplied.
export function EditControl({
  record,
  type,
  name,
  parents,
  zone,
  editRecordAction,
  submitLabel,
}: {
  record: LifeAdminRecordView;
  type: RecordTypeDef;
  name: string;
  parents: readonly AssetOption[];
  zone?: string;
  editRecordAction?: LifeAdminAction;
  submitLabel?: string;
}) {
  if (!editRecordAction) {
    return <DisabledControl label="Edit" reason="Editing isn't available just now." />;
  }
  return (
    <details className="group/edit min-w-0 open:basis-full">
      <summary className={summaryClass("secondary", "sm")}>
        Edit<span className="sr-only"> {name}</span>
        <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open/edit:rotate-180" />
      </summary>
      <EditRecordForm record={record} type={type} parents={parents} zone={zone} editRecordAction={editRecordAction} submitLabel={submitLabel} />
    </details>
  );
}

// Delete cannot be undone, so it asks first: a danger disclosure whose panel says what will
// go, then the final danger submit.
function DeleteControl({ record, name, deleteRecordAction }: { record: LifeAdminRecordView; name: string; deleteRecordAction: LifeAdminAction }) {
  return (
    <details className="min-w-0 open:basis-full">
      <summary className={summaryClass("danger", "sm")}>
        <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
        Delete record<span className="sr-only"> {name}</span>
      </summary>
      <div className="mt-3 flex flex-col gap-3 rounded-card bg-surface-muted p-4">
        <p className="text-sm text-fg">Delete this record and all its attached files? This can&apos;t be undone.</p>
        <ActionForm action={deleteRecordAction}>
          <input type="hidden" name="recordId" value={record.id} />
          <ReturnFields />
          <FormSubmit variant="danger-solid" pendingLabel="Deleting…">Delete record and files</FormSubmit>
        </ActionForm>
      </div>
    </details>
  );
}

// The row's controls, after its facts in Details: attach (a receipt), edit and delete.
function ManageControls({
  record,
  type,
  name,
  parents,
  zone,
  actions,
}: {
  record: LifeAdminRecordView;
  type: RecordTypeDef;
  name: string;
  parents: readonly AssetOption[];
  zone: string;
  actions: RecordActions;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-5 border-t border-line pt-4">
      {record.kind === "receipt_warranty" ? <AttachControl record={record} attachFileAction={actions.attachFileAction} /> : null}
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <EditControl record={record} type={type} name={name} parents={parents} zone={zone} editRecordAction={actions.editRecordAction} />
        {actions.deleteRecordAction ? <DeleteControl record={record} name={name} deleteRecordAction={actions.deleteRecordAction} /> : null}
      </div>
    </div>
  );
}

// Where the browser supports it, the Details disclosure's summary sits at the end of the row and
// its opened panel spans the row's full width under it; elsewhere the opened disclosure takes the
// row's width.
const ROW_DISCLOSURE =
  "group/details min-w-0 open:basis-full supports-[selector(::details-content)]:contents details-content:basis-full details-content:order-last not-open:details-content:hidden";

// A file size in megabytes, for the download links.
function megabytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb < 0.1 ? "under 0.1 MB" : `${mb.toFixed(1)} MB`;
}

/** A record's provenance line, from its view props. */
export function recordProvenance(record: LifeAdminRecordView): string {
  return provenanceLine({
    addedBy: record.addedBy ?? { kind: "person" },
    changedBy: record.changedBy ?? null,
    reviewState: record.reviewState ?? "confirmed",
    foundIn: record.foundIn ?? null,
  });
}

/** "Not checked yet": an agent's suggestion the person hasn't confirmed (words and an icon). */
export function NotCheckedTag() {
  return (
    <Badge tone="warning" icon={CircleDashed}>
      Not checked yet
    </Badge>
  );
}

/** The record's facts, labelled and formatted through its kind, as a label/value list. */
export function RecordFacts({
  record,
  type,
  titleKey,
  limit,
  zone = "UTC",
  currentYear,
}: {
  record: LifeAdminRecordView;
  type: RecordTypeDef;
  titleKey: string | null;
  limit?: number;
  zone?: string;
  currentYear?: string;
}) {
  // A booking's start already reads in the line under its name.
  const fields = type.lifecycle === "booking" && record.fields.starts_at ? { ...record.fields, starts_at: "" } : record.fields;
  const facts = typedFacts(type, fields, titleKey, zone, currentYear);
  const shown = limit === undefined ? facts : facts.slice(0, limit);
  if (shown.length === 0) return null;
  return (
    <dl className="grid min-w-0 max-w-xl grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)]">
      {shown.map((fact) => (
        <React.Fragment key={fact.key}>
          <dt className="min-w-0 text-fg-muted [overflow-wrap:anywhere]">{fact.label}</dt>
          <dd className="mb-2 min-w-0 text-fg [overflow-wrap:anywhere] sm:mb-0">{fact.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

/** "Handled by Instinct · Next: Book the roadworthy, due 28 Nov" (either part when it's there). */
export function handlingText(handling: RecordHandlingView | undefined, zone: string): string | null {
  if (!handling) return null;
  const parts: string[] = [];
  if (handling.steward) parts.push(`Handled by ${handling.steward}`);
  if (handling.next?.text) parts.push(`Next: ${handling.next.text}${handling.next.due ? `, due ${shortDate(handling.next.due, zone)}` : ""}`);
  return parts.length ? parts.join(" · ") : null;
}

/** The line under a record's name: its kind and when it happens or is due ("Flight · Starts Thu 3 Dec, 7:30 pm AEDT"). */
export function kindLine(type: RecordTypeDef, record: LifeAdminRecordView, zone: string, currentYear?: string): string {
  return [type.label, whenLine(type, record, zone, currentYear)].filter(Boolean).join(" · ");
}

export function RecordRow({
  record,
  type,
  catalogue,
  lead,
  partOf,
  category,
  note,
  summary: givenSummary,
  extra,
  anchor = true,
  assets,
  zone = "UTC",
  currentYear,
  actions,
}: {
  record: LifeAdminRecordView;
  type: RecordTypeDef;
  catalogue: Catalogue;
  // What the row leads with instead of the record's name (an anchor's own row under its
  // name says "Vehicle details").
  lead?: string;
  // The anchor it belongs to, when the row isn't listed under it.
  partOf?: string | null;
  // Its category, when the list runs across categories (On hold, History).
  category?: string;
  // Added to the line under its name ("in 12 days", on Upcoming).
  note?: string | null;
  // The line under its name in place of the usual one (kind, when, cost, provider).
  summary?: string;
  // One more line under that one (on Bills: "From NAB card ending 2686 · Registered to …").
  extra?: React.ReactNode;
  // False where the record also shows on another tab that carries its `record-<id>` anchor
  // (a renewal on Upcoming that lives on Records), so the page has one anchor per record: the
  // row is then marked `data-record="<id>"`, for a link to land on it on the tab shown.
  anchor?: boolean;
  assets: readonly AssetOption[];
  zone?: string;
  currentYear?: string;
  actions: RecordActions;
}) {
  const { name, key: titleKey } = recordName(type, record.fields, Boolean(record.type));
  const phase = phaseOfView(record);
  // Reminders only ever go out for something live with a date.
  const when = record.dueDate && phase.bucket === "live" ? dateWords(type, record.dueDate) : null;
  const reminders = when ? reminderSummary(record.dueDate, record.reminderOffsets, when) : null;
  const ReminderIcon = reminders?.on ? Bell : BellOff;
  const suggested = record.reviewState === "suggested";
  const handling = handlingText(record.handling, zone);
  const summary = [givenSummary ?? rowSummary(type, record, { name, titleKey, lead: Boolean(lead), category, zone, currentYear }), note].filter(Boolean).join(" · ");
  return (
    <li {...(anchor ? { id: `record-${record.id}` } : { "data-record": record.id })} tabIndex={-1} className={`${LIST_ROW} scroll-mt-32`}>
      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <a
              href={itemHref(record.id)}
              className="inline-flex min-h-11 min-w-0 items-center font-medium text-fg underline-offset-4 hover:underline lg:pointer-fine:min-h-7 [overflow-wrap:anywhere]"
            >
              {lead ?? name}
              {lead ? <span className="sr-only">: {name}</span> : null}
            </a>
            <PhaseBadge phase={phase.phase} label={phase.label} />
            {suggested ? <NotCheckedTag /> : null}
            {record.pending ? (
              <Badge tone="info" icon={GitCompare}>
                Change suggested
              </Badge>
            ) : null}
          </div>
          {summary ? <p className="min-w-0 text-sm text-fg-muted [overflow-wrap:anywhere]">{summary}</p> : null}
          {extra ? <div className="min-w-0 text-sm text-fg-muted [overflow-wrap:anywhere]">{extra}</div> : null}
          {partOf ? (
            <p className="inline-flex min-w-0 items-center gap-1.5 text-sm text-fg-muted [overflow-wrap:anywhere]">
              <Link2 aria-hidden={true} className="h-4 w-4 shrink-0" />
              Part of {partOf}
            </p>
          ) : null}
          {handling ? (
            <p className="inline-flex min-w-0 items-start gap-1.5 text-sm text-fg [overflow-wrap:anywhere]">
              <UserCheck aria-hidden={true} className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
              <span className="min-w-0">{handling}</span>
            </p>
          ) : null}
        </div>

        <details className={ROW_DISCLOSURE}>
          {/* Pulled back by its own padding, so on a phone (where it wraps under the row) its
              label lines up with the row's text. */}
          <summary className={`${summaryClass("ghost", "sm")} -ms-3`}>
            Details<span className="sr-only"> {name}</span>
            <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open/details:rotate-180" />
          </summary>
          <div className="mt-2 flex min-w-0 flex-col gap-3 border-s-2 border-line ps-4">
            <RecordFacts record={record} type={type} titleKey={lead ? null : titleKey} zone={zone} currentYear={currentYear} />

            {reminders && when ? (
              <div className="flex min-w-0 flex-col gap-1">
                <p className="inline-flex items-start gap-1.5 text-sm text-fg-muted [overflow-wrap:anywhere]">
                  <ReminderIcon aria-hidden={true} className="mt-0.5 h-4 w-4 shrink-0" />
                  {reminders.text}
                </p>
                <ReminderSetting record={record} type={type} dueDate={record.dueDate!} editRecordAction={actions.editRecordAction} />
              </div>
            ) : null}

            <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">{recordProvenance(record)}</p>

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

            <ManageControls record={record} type={type} name={name} parents={parentOptions(type, assets, catalogue, record.id)} zone={zone} actions={actions} />
          </div>
        </details>
      </div>
    </li>
  );
}
