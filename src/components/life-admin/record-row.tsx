"use client";

import * as React from "react";
import { Bell, BellOff, ChevronDown, CircleDashed, GitCompare, Settings2, Trash2 } from "lucide-react";

import { LIST_ROW } from "@/components/ui/list-group";
import { ActionForm, FormSubmit, PendingFormFields } from "@/components/ui/form-submit";
import { Field, Label } from "@/components/ui/field";
import { CONTROL_TEXT } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { RecordTypeDef } from "@/domain/life-admin/record-types";
import { receiptUploadError } from "@/lib/receipt-upload";
import { reminderSummary } from "./record-groups";
import { provenanceLine, recordFacts, recordName, typedDueLine, typedFieldLabel } from "./record-format";
import { DisabledControl, EditRecordForm, HINT_CLASS, parentOptions, summaryClass } from "./record-forms";
import type { AssetOption, LifeAdminAction, LifeAdminRecordView, RecordActions } from "./record-view-types";

// One record as a divider row (docs/adr/life-admin-profile.md): its name, then its type, due
// date in the type's words and status ("Registration · Expires 14 Dec 2026 · Active"), a
// "Not checked yet" tag while it is an agent's suggestion, its facts labelled the type's way,
// its reminder setting in words, who added it (and where an agent says it found it), its
// downloads (receipts) and one "Manage" disclosure holding reminders, attach, edit and
// delete. Every value is text: nothing an agent read from email ever becomes a link.
//
// The row keeps the `record-<id>` anchor (focusable, clear of the sticky header) that
// reminder notifications, Home and the Coming up list link to.

// The native file picker, on the field tokens: 16px text on touch screens, the picker
// button as a quiet pill.
const FILE_INPUT_CLASS = `min-h-11 min-w-0 w-full max-w-full text-fg file:me-3 file:min-h-9 file:cursor-pointer file:rounded-full file:border file:border-line file:bg-surface file:px-3 file:text-sm file:font-medium file:text-fg ${CONTROL_TEXT}`;

// The per-record reminder-offset setting, prefilled with the record's OWN offsets (days
// before due). Adjusting it is an edit, so it is bound to editRecordAction; DISABLED with a
// reason when that is not supplied.
function ReminderSetting({ record, editRecordAction }: { record: LifeAdminRecordView; editRecordAction?: LifeAdminAction }) {
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
        <input type="hidden" name="returnTab" value="things" />
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
        <input type="hidden" name="returnTab" value="things" />
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
  editRecordAction,
  submitLabel,
}: {
  record: LifeAdminRecordView;
  type: RecordTypeDef;
  name: string;
  parents: readonly AssetOption[];
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
      <EditRecordForm record={record} type={type} parents={parents} editRecordAction={editRecordAction} submitLabel={submitLabel} />
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
          <input type="hidden" name="returnTab" value="things" />
          <FormSubmit variant="danger-solid" pendingLabel="Deleting…">Delete record and files</FormSubmit>
        </ActionForm>
      </div>
    </details>
  );
}

// ONE disclosure holding every per-record control, so a long list reads as names and dates,
// not a stack of forms. Its summary is named for the record.
function ManageControls({
  record,
  type,
  name,
  parents,
  actions,
}: {
  record: LifeAdminRecordView;
  type: RecordTypeDef;
  name: string;
  parents: readonly AssetOption[];
  actions: RecordActions;
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
        <ReminderSetting record={record} editRecordAction={actions.editRecordAction} />
        {record.kind === "receipt_warranty" ? <AttachControl record={record} attachFileAction={actions.attachFileAction} /> : null}
        <div className="flex min-w-0 flex-wrap items-start gap-2 border-t border-line pt-4">
          <EditControl record={record} type={type} name={name} parents={parents} editRecordAction={actions.editRecordAction} />
          {actions.deleteRecordAction ? <DeleteControl record={record} name={name} deleteRecordAction={actions.deleteRecordAction} /> : null}
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

/** The record's facts, labelled through its type, as a label/value list. */
export function RecordFacts({ record, type, titleKey, limit }: { record: LifeAdminRecordView; type: RecordTypeDef; titleKey: string | null; limit?: number }) {
  const facts = recordFacts(record.fields, titleKey, (key) => typedFieldLabel(type, key));
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

export function RecordRow({
  record,
  type,
  lead,
  assets,
  actions,
}: {
  record: LifeAdminRecordView;
  type: RecordTypeDef;
  // What the row leads with instead of the record's name (an asset's own row under its
  // name says "Vehicle details").
  lead?: string;
  assets: readonly AssetOption[];
  actions: RecordActions;
}) {
  const { name, key: titleKey } = recordName(record.kind, record.type, record.fields);
  const reminders = reminderSummary(record.dueDate, record.reminderOffsets);
  const ReminderIcon = reminders.on ? Bell : BellOff;
  const suggested = record.reviewState === "suggested";
  return (
    <li id={`record-${record.id}`} tabIndex={-1} className={`${LIST_ROW} scroll-mt-32`}>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <p className="min-w-0 font-medium text-fg [overflow-wrap:anywhere]">{lead ?? name}</p>
            {suggested ? <NotCheckedTag /> : null}
            {record.pending ? (
              <Badge tone="info" icon={GitCompare}>
                Change suggested
              </Badge>
            ) : null}
          </div>
          <p className="text-sm text-fg-muted">{typedDueLine(type, record.dueDate, record.status)}</p>
        </div>

        <RecordFacts record={record} type={type} titleKey={lead ? null : titleKey} />

        <p className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
          <ReminderIcon aria-hidden={true} className="h-4 w-4 shrink-0" />
          {reminders.text}
        </p>

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

        <ManageControls record={record} type={type} name={name} parents={parentOptions(type, assets, record.id)} actions={actions} />
      </div>
    </li>
  );
}
