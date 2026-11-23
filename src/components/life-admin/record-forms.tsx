"use client";

import * as React from "react";
import { Plus } from "lucide-react";

import { ActionForm, FormSubmit, PendingFormFields } from "@/components/ui/form-submit";
import { Button, buttonClasses, type ButtonVariant } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Field, SelectField, TextareaField } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import type { Catalogue } from "@/domain/life-admin/catalogue";
import { calendarDate, MAX_FIELD_CHARS, MAX_NOTES_CHARS } from "@/domain/life-admin/normalise";
import { CYCLES, type FieldDef, type RecordTypeDef } from "@/domain/life-admin/record-types";
import { dueLabelOf, fieldLabel, statusChoices, statusLabel, typedFieldLabel } from "./record-format";
import type { AssetOption, LifeAdminAction, LifeAdminRecordView } from "./record-view-types";

// The typed record forms (docs/adr/life-admin-profile.md): adding a record of a kind from the
// person's own catalogue and editing one, with an input per field of the kind chosen by the
// field's kind — a date picker for dates, a date-and-time picker with the time zone it happens
// in for date-times, a month picker for a month and year, a decimal keypad with its unit for
// numbers and amounts, Yes/No for a yes-or-no field, suggestions (a <datalist>) for fields
// with usual values, a text area for notes — then the due date in the kind's own words
// ("Expires"; a booking's start sets it, so a booking has none), the status in the kind's
// lifecycle's words (a booking: confirmed, waiting, cancelled, didn't go; a case: open,
// waiting, resolved) and, for a record that may belong to an anchor, which one.
//
// Adding takes two steps that need no client JavaScript: a GET form picks the kind
// (`?add=vehicles.registration`, validated by the page), then that kind's form posts to the
// add action. Every field posts as `field:<key>` (form version 2) so a personal field named
// like the metadata ("dueDate") never becomes scheduling metadata; a date-time's zone posts as
// `zone:<key>` and is combined with it on the server.

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

// ─── time zones ──────────────────────────────────────────────────────────────────────

// The zones the date-time picker offers, besides the person's own and the record's.
export const COMMON_ZONES: readonly string[] = [
  "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Adelaide", "Australia/Darwin",
  "Australia/Perth", "Australia/Hobart", "Pacific/Auckland", "Pacific/Fiji", "Asia/Tokyo", "Asia/Seoul",
  "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Singapore", "Asia/Kuala_Lumpur", "Asia/Bangkok", "Asia/Makassar",
  "Asia/Jakarta", "Asia/Kolkata", "Asia/Dubai", "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Rome",
  "Europe/Athens", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Vancouver", "Pacific/Honolulu", "UTC",
];

/** A zone as a person reads it: "Sydney (Australia)", "Los Angeles (America)", "UTC". */
export function zoneLabel(zone: string): string {
  const parts = zone.split("/");
  if (parts.length < 2) return zone;
  return `${parts[parts.length - 1]!.replace(/_/g, " ")} (${parts[0]!.replace(/_/g, " ")})`;
}

/** The zones to offer: the person's own first, the record's own, then the common list. */
export function zoneChoices(personZone: string, own?: string | null): string[] {
  return [...new Set([personZone, ...(own ? [own] : []), ...COMMON_ZONES].filter(Boolean))];
}

// A stored date-time split for the picker: its wall time, and its zone ("offset:+05:30" when
// it was saved with an offset only); a date alone reads as midnight, and says so.
export function dateTimeParts(value: string): { local: string; zone: string | null; dateOnly: string | null } {
  const v = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v) && calendarDate(v) === v ? v : null;
  if (dateOnly) return { local: `${dateOnly}T00:00`, zone: null, dateOnly };
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?(?:\[([^\]]+)\])?$/.exec(v);
  if (!match) return { local: "", zone: null, dateOnly: null };
  const [, date, time, offset, bracket] = match;
  const zone = bracket ?? (offset ? `offset:${offset === "Z" ? "+00:00" : offset.length === 5 ? `${offset.slice(0, 3)}:${offset.slice(3)}` : offset}` : null);
  return { local: `${date}T${time}`, zone, dateOnly: null };
}

// ─── one input per field, by the field's kind ────────────────────────────────────────

const CURRENCY_HINT = "Three letters, for example AUD.";
const DURATION_HINT = "For example 45 minutes, 2 hours or 12 months.";
const PERSON_HINT = "A first name or relationship only, for example Mum or Sam.";

function DateTimeInput({ id, field, label, value, zone }: { id: string; field: FieldDef; label: string; value: string; zone: string }) {
  const parts = dateTimeParts(value);
  const stored = value.trim() !== "" && parts.local === "";
  if (stored) {
    // A value the picker can't show (an agent's own wording) stays text, so saving never blanks it.
    return <Field label={label} id={id} name={`field:${field.key}`} defaultValue={value} maxLength={MAX_FIELD_CHARS} autoComplete="off" width="text" />;
  }
  const zones = zoneChoices(zone, parts.zone && !parts.zone.startsWith("offset:") ? parts.zone : null);
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
      <legend className="sr-only">{label}</legend>
      <Field
        label={label}
        id={id}
        name={`field:${field.key}`}
        type="datetime-local"
        defaultValue={parts.local}
        hint={parts.dateOnly ? "Saved as a date only. Add the time if you know it." : field.hint}
        width="short"
      />
      <SelectField
        label={<>Time zone<span className="sr-only"> for {label}</span></>}
        id={`${id}-zone`}
        name={`zone:${field.key}`}
        defaultValue={parts.zone ?? zone}
        width="text"
      >
        {parts.zone?.startsWith("offset:") ? <option value={parts.zone}>{`UTC${parts.zone.slice(7)} (as saved)`}</option> : null}
        {zones.map((choice) => (
          <option key={choice} value={choice}>
            {zoneLabel(choice)}
          </option>
        ))}
      </SelectField>
      {parts.dateOnly ? <input type="hidden" name={`dateonly:${field.key}`} value={parts.dateOnly} /> : null}
    </fieldset>
  );
}

function FieldInput({
  id,
  field,
  label,
  value,
  zone,
}: {
  id: string;
  field: FieldDef | null;
  label: string;
  value: string;
  zone: string;
}) {
  const name = `field:${field?.key ?? ""}`;
  const kind = field?.kind ?? "text";
  const hint =
    field?.hint ??
    (kind === "currency" ? CURRENCY_HINT : kind === "duration" ? DURATION_HINT : kind === "person" ? PERSON_HINT : undefined);
  if (kind === "long_text") {
    return <TextareaField label={label} id={id} name={name} defaultValue={value} hint={hint} maxLength={MAX_NOTES_CHARS} width="text" />;
  }
  // A stored value that isn't a calendar date (an older record) stays a text field, so
  // saving the form never blanks it.
  if (kind === "date" && (value === "" || calendarDate(value) === value)) {
    return <Field label={label} id={id} name={name} type="date" defaultValue={value} hint={hint} width="short" />;
  }
  if (kind === "datetime" && field) {
    return <DateTimeInput id={id} field={field} label={label} value={value} zone={zone} />;
  }
  if (kind === "month_year" && (value === "" || /^\d{4}-\d{2}$/.test(value))) {
    return <Field label={label} id={id} name={name} type="month" defaultValue={value} hint={hint ?? "Month and year."} width="short" />;
  }
  if (kind === "boolean") {
    const current = value.trim().toLowerCase();
    const known = current === "" || current === "yes" || current === "no";
    return (
      <SelectField label={label} id={id} name={name} defaultValue={known ? current : value} hint={hint} width="short">
        <option value="">Not set</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
        {known ? null : <option value={value}>{value}</option>}
      </SelectField>
    );
  }
  if (kind === "number") {
    return (
      <div className="flex min-w-0 items-end gap-2">
        <Field
          label={label}
          id={id}
          name={name}
          defaultValue={value}
          hint={hint}
          inputMode="decimal"
          maxLength={40}
          autoComplete="off"
          width="short"
          {...(field?.unit ? { "aria-describedby": `${id}-unit` } : {})}
        />
        {field?.unit ? (
          <span id={`${id}-unit`} className="mb-3 text-sm text-fg-muted">
            {field.unit}
          </span>
        ) : null}
      </div>
    );
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
        {...(kind === "last4" ? { inputMode: "numeric" as const, maxLength: 4 } : {})}
        {...(kind === "phone" ? { type: "tel", inputMode: "tel" as const } : {})}
        {...(kind === "email" ? { type: "email", inputMode: "email" as const } : {})}
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
 * Every field of the kind (empty ones too) prefilled from `values`, then any other text
 * value the record already holds (an agent's own detail) under a tidied label. Date-times
 * default to `zone` (the person's own).
 */
export function TypeFieldInputs({
  type,
  values = {},
  zone = "UTC",
}: {
  type: RecordTypeDef;
  values?: Readonly<Record<string, string>>;
  zone?: string;
}) {
  const baseId = React.useId();
  const known = new Set(type.fields.map((field) => field.key));
  const typeLabels = new Set(type.fields.map((field) => field.label.toLowerCase()));
  const extras = Object.keys(values).filter((key) => !known.has(key));
  return (
    <>
      {type.fields.map((field, index) => (
        <FieldInput key={field.key} id={`${baseId}-f${index}`} field={field} label={field.label} value={values[field.key] ?? ""} zone={zone} />
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
            zone={zone}
          />
        );
      })}
    </>
  );
}

// The record's status as a choice in its kind's words: a booking's (confirmed, waiting,
// cancelled, didn't go), a case's (open, waiting, resolved) or a standing item's, plus the
// record's own value when an older record holds something else, so editing never silently
// changes it.
function StatusField({ id, type, status, state }: { id: string; type: RecordTypeDef; status: string; state?: string | null }) {
  const choices = statusChoices(type.lifecycle);
  const fallback = type.lifecycle === "booking" ? "confirmed" : type.lifecycle === "case" ? "open" : "active";
  const current = (type.lifecycle === "standing" ? status : state ?? (type.lifecycle === "booking" && status === "cancelled" ? "cancelled" : "")).trim() || fallback;
  const known = choices.some((choice) => choice.value === current.toLowerCase());
  return (
    <SelectField label="Status" id={`${id}-status`} name="status" defaultValue={known ? current.toLowerCase() : current} width="short">
      {known ? null : <option value={current}>{statusLabel(current)}</option>}
      {choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </SelectField>
  );
}

/** The anchors a record of `type` may belong to, from the person's own records (the catalogue's one rule). */
export function parentOptions(type: RecordTypeDef, assets: readonly AssetOption[], catalogue: Catalogue, selfId?: string): AssetOption[] {
  return assets.filter((asset) => {
    const parent = catalogue.type(asset.typeId);
    return asset.id !== selfId && parent !== undefined && catalogue.canBelongTo(type, parent);
  });
}

/**
 * The due date (in the kind's words; left out for a booking, whose start sets it, and when
 * the kind has no due date and the record holds none), the status, and "Belongs to" (left out
 * when the person has no anchor it can belong to).
 */
export function ScheduleFields({
  type,
  dueDate = null,
  status = "active",
  state = null,
  parentId = null,
  parents,
}: {
  type: RecordTypeDef;
  dueDate?: string | null;
  status?: string;
  state?: string | null;
  parentId?: string | null;
  parents: readonly AssetOption[];
}) {
  const id = React.useId();
  const showsDue = type.lifecycle !== "booking" && (Boolean(type.due) || Boolean(dueDate));
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
      <StatusField id={id} type={type} status={status} state={state} />
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
 * The edit form for one record: every field of its kind and its other text details, then
 * its schedule. Values an older agent saved as lists or objects are listed read-only and
 * are not part of the form, so saving keeps them exactly as they are. Saving is the
 * person's own change, so it also confirms a suggestion.
 */
export function EditRecordForm({
  record,
  type,
  parents,
  zone = "UTC",
  editRecordAction,
  submitLabel = "Save changes",
}: {
  record: LifeAdminRecordView;
  type: RecordTypeDef;
  parents: readonly AssetOption[];
  zone?: string;
  editRecordAction: LifeAdminAction;
  submitLabel?: string;
}) {
  const held = Object.entries(record.heldFields ?? {});
  return (
    <ActionForm action={editRecordAction} className="mt-3 flex min-w-0 flex-col gap-4">
      <PendingFormFields>
        <input type="hidden" name="recordId" value={record.id} />
        <input type="hidden" name="returnTab" value="things" />
        <TypeFieldInputs type={type} values={record.fields} zone={zone} />
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
        <ScheduleFields type={type} dueDate={record.dueDate} status={record.status} state={record.state ?? null} parentId={record.parentId ?? null} parents={parents} />
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
 * "Add something": step one picks the kind with a plain GET form (`?add=<kind>`), its choices
 * grouped by the person's categories (their own included); step two, once the page has
 * validated the kind, is that kind's form. Without an add action the picker still shows and
 * the form is replaced by a disabled control saying why.
 */
export function AddRecordPanel({
  catalogue,
  addType,
  assets,
  zone = "UTC",
  addRecordAction,
}: {
  catalogue: Catalogue;
  addType?: string | null;
  assets: readonly AssetOption[];
  zone?: string;
  addRecordAction?: LifeAdminAction;
}) {
  const pickerId = React.useId();
  const type = addType ? catalogue.type(addType) : undefined;
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
              {catalogue.categories.map((category) => {
                const kinds = catalogue.typesIn(category.id);
                return kinds.length === 0 ? null : (
                  <optgroup key={category.id} label={category.label}>
                    {kinds.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </optgroup>
                );
              })}
            </SelectField>
            <Button type="submit" variant={type ? "secondary" : "primary"}>
              {type ? "Change" : "Next"}
            </Button>
          </form>
          {type ? <AddForm type={type} parents={parentOptions(type, assets, catalogue)} zone={zone} addRecordAction={addRecordAction} /> : null}
        </div>
      </WorkspacePanel>
    </div>
  );
}

function AddForm({
  type,
  parents,
  zone,
  addRecordAction,
}: {
  type: RecordTypeDef;
  parents: readonly AssetOption[];
  zone: string;
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
        {type.documentLike ? (
          <Notice tone="info" announce={false}>
            Only the expiry date and details go here. Keep the number itself in your Vault, where you release it when it&apos;s needed.
          </Notice>
        ) : null}
        {type.lifecycle === "booking" ? (
          <Notice tone="info" announce={false}>
            Its start sets the date Warthog reminds you about, so there&apos;s no separate due date.
          </Notice>
        ) : null}
        <TypeFieldInputs type={type} zone={zone} />
        <ScheduleFields type={type} parents={parents} />
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
