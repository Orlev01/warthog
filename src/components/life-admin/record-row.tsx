"use client";

import * as React from "react";
import { ArrowRight, Bell, BellOff, ChevronDown, CircleDashed, GitCompare, Link2, Settings2, Trash2, UserCheck } from "lucide-react";

import { LIST_ROW } from "@/components/ui/list-group";
import { ActionForm, FormSubmit, PendingFormFields } from "@/components/ui/form-submit";
import { Field, Label } from "@/components/ui/field";
import { CONTROL_TEXT } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button-link";
import type { Catalogue } from "@/domain/life-admin/catalogue";
import { shortDate } from "@/domain/life-admin/journal";
import type { RecordTypeDef } from "@/domain/life-admin/record-types";
import { receiptUploadError } from "@/lib/receipt-upload";
import { phaseOfView, reminderSummary } from "./record-groups";
import { provenanceLine, recordName, typedFacts, whenLine } from "./record-format";
import { DisabledControl, EditRecordForm, HINT_CLASS, parentOptions, summaryClass } from "./record-forms";
import { PhaseBadge } from "./phase-badge";
import type { AssetOption, LifeAdminAction, LifeAdminRecordView, RecordActions, RecordHandlingView } from "./record-view-types";

// One record as a divider row (docs/adr/life-admin-profile.md): its name, then its kind, when
// it happens or is due in the kind's words ("Registration · Expires 14 Dec 2026", "Flight ·
// Starts Thu 3 Dec, 7:30 pm AEDT") and where it stands as words and an icon ("Due soon"), a
// "Not checked yet" tag while it is an agent's suggestion, its facts labelled and formatted the
// kind's way, who is handling it and its next step, its reminder setting in words, who added it
// (and where an agent says it found it), its downloads (receipts), "Open" (the item page, with
// its journal) and one "Manage" disclosure holding reminders, attach, edit and delete. Every
// value is text: nothing an agent read from email, or wrote in a journal, ever becomes a link.
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
    <details className="group/manage min-w-0 open:basis-full">
      <summary className={summaryClass("ghost", "sm")}>
        <Settings2 aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted" />
        Manage<span className="sr-only"> {name}</span>
        <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open/manage:rotate-180" />
      </summary>
      <div className="mt-2 flex min-w-0 flex-col gap-5 border-s-2 border-line ps-4">
        <ReminderSetting record={record} editRecordAction={actions.editRecordAction} />
        {record.kind === "receipt_warranty" ? <AttachControl record={record} attachFileAction={actions.attachFileAction} /> : null}
        <div className="flex min-w-0 flex-wrap items-start gap-2 border-t border-line pt-4">
          <EditControl record={record} type={type} name={name} parents={parents} zone={zone} editRecordAction={actions.editRecordAction} />
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

/** "Open": the item's own page, with where it stands and its whole journal. */
export function OpenLink({ recordId, name }: { recordId: string; name: string }) {
  return (
    <ButtonLink href={`/life-admin/items/${encodeURIComponent(recordId)}`} variant="secondary" size="sm">
      Open<span className="sr-only"> {name}</span>
      <ArrowRight aria-hidden={true} className="h-4 w-4 shrink-0" />
    </ButtonLink>
  );
}

export function RecordRow({
  record,
  type,
  catalogue,
  lead,
  partOf,
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
  assets: readonly AssetOption[];
  zone?: string;
  currentYear?: string;
  actions: RecordActions;
}) {
  const { name, key: titleKey } = recordName(type, record.fields, Boolean(record.type));
  const reminders = reminderSummary(record.dueDate, record.reminderOffsets);
  const ReminderIcon = reminders.on ? Bell : BellOff;
  const suggested = record.reviewState === "suggested";
  const phase = phaseOfView(record);
  const handling = handlingText(record.handling, zone);
  return (
    <li id={`record-${record.id}`} tabIndex={-1} className={`${LIST_ROW} scroll-mt-32`}>
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <p className="min-w-0 font-medium text-fg [overflow-wrap:anywhere]">{lead ?? name}</p>
            {suggested ? <NotCheckedTag /> : null}
            {record.pending ? (
              <Badge tone="info" icon={GitCompare}>
                Change suggested
              </Badge>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <p className="min-w-0 text-sm text-fg-muted [overflow-wrap:anywhere]">{kindLine(type, record, zone, currentYear)}</p>
            <PhaseBadge phase={phase.phase} label={phase.label} />
          </div>
        </div>

        {partOf ? (
          <p className="inline-flex min-w-0 items-center gap-1.5 text-sm text-fg-muted [overflow-wrap:anywhere]">
            <Link2 aria-hidden={true} className="h-4 w-4 shrink-0" />
            Part of {partOf}
          </p>
        ) : null}

        <RecordFacts record={record} type={type} titleKey={lead ? null : titleKey} zone={zone} currentYear={currentYear} />

        {handling ? (
          <p className="inline-flex min-w-0 items-start gap-1.5 text-sm text-fg [overflow-wrap:anywhere]">
            <UserCheck aria-hidden={true} className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
            <span className="min-w-0">{handling}</span>
          </p>
        ) : null}

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

        <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
          <OpenLink recordId={record.id} name={name} />
          <ManageControls record={record} type={type} name={name} parents={parentOptions(type, assets, catalogue, record.id)} zone={zone} actions={actions} />
        </div>
      </div>
    </li>
  );
}
