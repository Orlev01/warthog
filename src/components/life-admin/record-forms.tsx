"use client";

import * as React from "react";
import { Plus } from "lucide-react";

import { ActionForm, FormSubmit, PendingFormFields } from "@/components/ui/form-submit";
import { Button, buttonClasses, type ButtonVariant } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Field, SelectField, TextareaField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { calendarDate, MAX_FIELD_CHARS, MAX_NOTES_CHARS } from "@/domain/life-admin/normalise";
import { CATEGORIES, CYCLES, recordType, typesInCategory, type FieldDef, type RecordTypeDef } from "@/domain/life-admin/record-types";
import { RECORD_STATUS_CHOICES, dueLabelOf, fieldLabel, statusLabel, typedFieldLabel } from "./record-format";
import type { AssetOption, LifeAdminAction, LifeAdminRecordView } from "./record-view-types";

// The typed record forms (docs/adr/life-admin-profile.md): adding a record of a chosen type
// and editing one, with an input per field of the type chosen by the field's kind — a date
// picker for dates, a decimal keypad for amounts, suggestions (a <datalist>) for fields with
// usual values, a text area for notes — then the due date in the type's own words
// ("Expires"), the status and, for a record that belongs to a vehicle, home or pet, which one.
//
// Adding takes two steps that need no client JavaScript: a GET form picks the type
// (`?add=vehicle.registration`, validated by the page), then that type's form posts to the
// add action. Every field posts as `field:<key>` (form version 2) so a personal field named
// like the metadata ("dueDate") never becomes scheduling metadata.

// ─── shared pieces ───────────────────────────────────────────────────────────────────

// A <summary> that looks like a Button: the shared button look, with the disclosure marker
// hidden because the label (and its chevron) says what opens.
export function summaryClass(variant: ButtonVariant, size: "sm" | "md" = "md"): string {
  return buttonClasses({ variant, size, className: "w-fit list-none [&::-webkit-details-marker]:hidden" });
}

// A small muted line under a control: help text or the reason a control is unavailable.
export const HINT_CLASS = "text-sm text-fg-muted";

// A present-but-not-actionable control (no dead controls): the native `disabled` attribute
// does the disabling, and a one-line reason tied to it says why.
export function DisabledControl({ label, reason }: { label: string; reason: string }) {
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

// ─── one input per field, by the field's kind ────────────────────────────────────────

const CURRENCY_HINT = "Three letters, for example AUD.";

function FieldInput({
  id,
  field,
  label,
  value,
}: {
  id: string;
  field: FieldDef | null;
  label: string;
  value: string;
}) {
  const name = `field:${field?.key ?? ""}`;
  const kind = field?.kind ?? "text";
  const hint = field?.hint ?? (kind === "currency" ? CURRENCY_HINT : undefined);
  if (kind === "long_text") {
    return <TextareaField label={label} id={id} name={name} defaultValue={value} hint={hint} maxLength={MAX_NOTES_CHARS} width="text" />;
  }
  // A stored value that isn't a calendar date (an older record) stays a text field, so
  // saving the form never blanks it.
  if (kind === "date" && (value === "" || calendarDate(value) === value)) {
    return <Field label={label} id={id} name={name} type="date" defaultValue={value} hint={hint} width="short" />;
  }
  const suggestions = kind === "cycle" ? CYCLES : field?.choices;
  const listId = suggestions?.length ? `${id}-choices` : undefined;
  const short = kind === "amount" || kind === "currency" || kind === "last4" || kind === "cycle";
  return (
    <>
      <Field
        label={label}
        id={id}
        name={name}
        defaultValue={value}
        hint={hint}
        maxLength={MAX_FIELD_CHARS}
        list={listId}
        autoComplete="off"
        {...(kind === "amount" ? { inputMode: "decimal" as const } : {})}
        {...(kind === "phone" ? { type: "tel", inputMode: "tel" as const } : {})}
        {...(kind === "website" ? { inputMode: "url" as const } : {})}
        width={short ? "short" : "text"}
      />
      {listId ? (
        <datalist id={listId}>
          {suggestions!.map((choice) => (
            <option key={choice} value={choice} />
          ))}
        </datalist>
      ) : null}
    </>
  );
}

/**
 * Every field of the type (empty ones too) prefilled from `values`, then any other text
 * value the record already holds (an agent's own detail) under a tidied label.
 */
export function TypeFieldInputs({
  type,
  values = {},
}: {
  type: RecordTypeDef;
  values?: Readonly<Record<string, string>>;
}) {
  const baseId = React.useId();
  const known = new Set(type.fields.map((field) => field.key));
  const typeLabels = new Set(type.fields.map((field) => field.label.toLowerCase()));
  const extras = Object.keys(values).filter((key) => !known.has(key));
  return (
    <>
      {type.fields.map((field, index) => (
        <FieldInput key={field.key} id={`${baseId}-f${index}`} field={field} label={field.label} value={values[field.key] ?? ""} />
      ))}
      {extras.map((key, index) => {
        const label = fieldLabel(key);
        return (
          <FieldInput
            key={`extra:${key}`}
            id={`${baseId}-x${index}`}
            field={{ key, label, kind: "text" }}
            // An older detail whose tidied name matches one of the type's own reads apart.
            label={typeLabels.has(label.toLowerCase()) ? `${label} (as saved)` : label}
            value={values[key] ?? ""}
          />
        );
      })}
    </>
  );
}

// The record's status as a choice: the record statuses, plus the record's own value when an
// older record holds something else, so editing never silently changes it.
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

/** The assets a record of `type` may belong to, from the person's own records. */
export function parentOptions(type: RecordTypeDef, assets: readonly AssetOption[], selfId?: string): AssetOption[] {
  const parents = type.parents ?? [];
  return assets.filter((asset) => parents.includes(asset.typeId) && asset.id !== selfId);
}

/**
 * The due date (in the type's words; left out when the type has no due date and the record
 * holds none), the status, and "Belongs to" (left out when the person has no record it can
 * belong to).
 */
export function ScheduleFields({
  type,
  dueDate = null,
  status = "active",
  parentId = null,
  parents,
}: {
  type: RecordTypeDef;
  dueDate?: string | null;
  status?: string;
  parentId?: string | null;
  parents: readonly AssetOption[];
}) {
  const id = React.useId();
  const showsDue = Boolean(type.due) || Boolean(dueDate);
  const several = new Set(parents.map((asset) => asset.typeId)).size > 1;
  return (
    <>
      <input type="hidden" name="recordFormVersion" value="2" />
      {showsDue ? (
        <Field
          label={`${dueLabelOf(type)} (optional)`}
          id={`${id}-date`}
          type="date"
          name="dueDate"
          defaultValue={dueDate ?? ""}
          hint="Warthog reminds you before this date. Leave it empty for no reminders."
          width="short"
        />
      ) : null}
      <StatusField id={id} status={status} />
      {parents.length > 0 ? (
        <SelectField label="Belongs to" id={`${id}-parent`} name="parentId" defaultValue={parentId ?? ""} width="text">
          <option value="">Not linked</option>
          {parents.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {several ? `${asset.name} (${asset.typeLabel})` : asset.name}
            </option>
          ))}
        </SelectField>
      ) : null}
    </>
  );
}

// ─── editing ─────────────────────────────────────────────────────────────────────────

/**
 * The edit form for one record: every field of its type and its other text details, then
 * its schedule. Values an older agent saved as lists or objects are listed read-only and
 * are not part of the form, so saving keeps them exactly as they are. Saving is the
 * person's own change, so it also confirms a suggestion.
 */
export function EditRecordForm({
  record,
  type,
  parents,
  editRecordAction,
  submitLabel = "Save changes",
}: {
  record: LifeAdminRecordView;
  type: RecordTypeDef;
  parents: readonly AssetOption[];
  editRecordAction: LifeAdminAction;
  submitLabel?: string;
}) {
  const held = Object.entries(record.heldFields ?? {});
  return (
    <ActionForm action={editRecordAction} className="mt-3 flex min-w-0 flex-col gap-4">
      <PendingFormFields>
        <input type="hidden" name="recordId" value={record.id} />
        <input type="hidden" name="returnTab" value="things" />
        <TypeFieldInputs type={type} values={record.fields} />
        {held.length ? (
          <div className="flex min-w-0 flex-col gap-2 rounded-card bg-surface-muted p-4">
            <p className="text-sm font-medium text-fg">Also saved</p>
            <p className={HINT_CLASS}>An agent saved these in a form this page can&apos;t edit. They&apos;re kept as they are.</p>
            <dl className="grid min-w-0 grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)]">
              {held.map(([key, summary]) => (
                <React.Fragment key={key}>
                  <dt className="min-w-0 text-fg-muted [overflow-wrap:anywhere]">{typedFieldLabel(type, key)}</dt>
                  <dd className="mb-2 min-w-0 text-fg [overflow-wrap:anywhere] sm:mb-0">{summary}</dd>
                </React.Fragment>
              ))}
            </dl>
          </div>
        ) : null}
        <ScheduleFields type={type} dueDate={record.dueDate} status={record.status} parentId={record.parentId ?? null} parents={parents} />
      </PendingFormFields>
      <div>
        <FormSubmit variant="secondary" pendingLabel="Saving…">{submitLabel}</FormSubmit>
      </div>
    </ActionForm>
  );
}

// ─── adding ──────────────────────────────────────────────────────────────────────────

const ADD_ANCHOR = "new-record";

/**
 * "Add something": step one picks the type with a plain GET form (`?add=<type>`); step two,
 * once the page has validated the type, is that type's form. Without an add action the
 * picker still shows and the form is replaced by a disabled control saying why.
 */
export function AddRecordPanel({
  addType,
  assets,
  addRecordAction,
}: {
  addType?: string | null;
  assets: readonly AssetOption[];
  addRecordAction?: LifeAdminAction;
}) {
  const pickerId = React.useId();
  const type = addType ? recordType(addType) : undefined;
  return (
    <div id={ADD_ANCHOR} className="min-w-0 scroll-mt-32">
      <WorkspacePanel
        title="Add something yourself"
        description="Choose what it is, then fill in what you know. You can leave anything empty."
        icon={Plus}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <form method="get" action={`/life-admin#${ADD_ANCHOR}`} className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
            <input type="hidden" name="view" value="life" />
            <input type="hidden" name="tab" value="things" />
            <SelectField label="What are you adding?" id={pickerId} name="add" defaultValue={type?.id ?? ""} required width="text">
              <option value="" disabled>
                Choose a type
              </option>
              {CATEGORIES.map((category) => (
                <optgroup key={category.id} label={category.label}>
                  {typesInCategory(category.id).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </SelectField>
            <Button type="submit" variant={type ? "secondary" : "primary"}>
              {type ? "Change" : "Next"}
            </Button>
          </form>
          {type ? <AddForm type={type} assets={assets} addRecordAction={addRecordAction} /> : null}
        </div>
      </WorkspacePanel>
    </div>
  );
}

function AddForm({
  type,
  assets,
  addRecordAction,
}: {
  type: RecordTypeDef;
  assets: readonly AssetOption[];
  addRecordAction?: LifeAdminAction;
}) {
  if (!addRecordAction) {
    return <DisabledControl label="Add to Life admin" reason="Adding isn't available just now." />;
  }
  return (
    <ActionForm action={addRecordAction} aria-label={`Add a ${type.label.toLowerCase()}`} className="flex min-w-0 flex-col gap-4 rounded-card bg-surface-muted p-4">
      <PendingFormFields>
        <input type="hidden" name="type" value={type.id} />
        <input type="hidden" name="returnTab" value="things" />
        <p className="font-medium text-fg">{type.label}</p>
        {type.category === "id" ? (
          <Notice tone="info" announce={false}>
            Only the expiry date and details go here. Keep the number itself in your Vault, where you release it when it&apos;s needed.
          </Notice>
        ) : null}
        <TypeFieldInputs type={type} />
        <ScheduleFields type={type} parents={parentOptions(type, assets)} />
      </PendingFormFields>
      <div className="flex flex-wrap items-center gap-2">
        <FormSubmit variant="primary" pendingLabel="Adding…">Add to Life admin</FormSubmit>
        <ButtonLink variant="ghost" href={`/life-admin?view=life&tab=things#${ADD_ANCHOR}`}>
          Cancel
        </ButtonLink>
      </div>
    </ActionForm>
  );
}
