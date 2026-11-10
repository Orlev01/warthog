"use client";

import * as React from "react";

import { ViewPanels } from "@/components/ui/view-tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty";
import { receiptUploadError } from "@/lib/receipt-upload";

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
const BTN_PRIMARY = `${BTN_BASE} bg-accent text-accent-fg hover:bg-accent-hover`;
const BTN_SECONDARY = `${BTN_BASE} border border-line bg-surface text-fg hover:bg-surface-muted`;
const BTN_DISABLED = `${BTN_BASE} border border-line bg-surface text-fg-muted opacity-50`;

const SUMMARY_CLASS =
  "inline-flex w-fit cursor-pointer items-center gap-2 text-sm font-medium text-fg";
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
      <form action={addRecordAction} className="mt-2 flex flex-col gap-3">
        <input type="hidden" name="kind" value={kind} />
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
        <div>
          <button type="submit" className={BTN_PRIMARY}>
            {label}
          </button>
        </div>
      </form>
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
    <form action={editRecordAction} className="flex flex-col gap-1.5">
      <input type="hidden" name="recordId" value={record.id} />
      <input type="hidden" name="setting" value="reminder" />
      <Label htmlFor={fieldId}>Remind me (days before)</Label>
      <Input id={fieldId} name="reminderOffsets" defaultValue={value} />
      <div>
        <button type="submit" className={BTN_SECONDARY}>
          Save reminder
        </button>
      </div>
    </form>
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
    <form action={attachFileAction} className="flex flex-col gap-1.5">
      <input type="hidden" name="recordId" value={record.id} />
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
      <div>
        <button type="submit" className={BTN_SECONDARY}>
          Attach file
        </button>
      </div>
    </form>
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
      <form action={editRecordAction} className="mt-2 flex flex-col gap-3">
        <input type="hidden" name="recordId" value={record.id} />
        {Object.entries(record.fields).map(([key, fieldValue], index) => {
          const fieldId = `${baseId}-${index}`;
          return (
            <div key={key} className="flex flex-col gap-1.5">
              <Label htmlFor={fieldId}>{key}</Label>
              <Input id={fieldId} name={key} defaultValue={fieldValue} />
            </div>
          );
        })}
        <div>
          <button type="submit" className={BTN_SECONDARY}>
            Save changes
          </button>
        </div>
      </form>
    </details>
  );
}

// One record as a card: its decrypted fields, its status and due date, its reminder-offset
// setting, an attach-file control (receipts only) and its Edit control.
function RecordCard({
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
  return (
    <li className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <dl className="grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {Object.entries(record.fields).map(([key, fieldValue]) => (
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

      <p className="text-sm text-fg-muted">
        {record.dueDate
          ? `Due ${record.dueDate} · ${record.status}`
          : record.status}
      </p>

      <ReminderSetting record={record} editRecordAction={editRecordAction} />

      {record.kind === "receipt_warranty" ? (
        <AttachControl record={record} attachFileAction={attachFileAction} />
      ) : null}

      {record.files?.length ? (
        <ul className="flex flex-col gap-2">
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
      <EditControl record={record} editRecordAction={editRecordAction} />
      {deleteRecordAction ? (
        <details className="mt-2">
          <summary className={SUMMARY_CLASS}>Delete record</summary>
          <p className="my-3 text-sm text-fg-muted">
            Delete this record and all its attached files? This cannot be
            undone.
          </p>
          <form action={deleteRecordAction}>
            <input type="hidden" name="recordId" value={record.id} />
            <button type="submit" className={BTN_SECONDARY}>
              Delete record and files
            </button>
          </form>
        </details>
      ) : null}
    </li>
  );
}

// A record tab's panel: its Add control (offered even with no records) and the records.
function RecordPanel({
  kind,
  heading,
  records,
  addRecordAction,
  editRecordAction,
  attachFileAction,
  deleteRecordAction,
}: {
  kind: RecordKind;
  heading: string;
  records: ReadonlyArray<LifeAdminRecordView>;
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
        <ul className="flex flex-col gap-3">
          {records.map((record) => (
            <RecordCard
              key={record.id}
              record={record}
              editRecordAction={editRecordAction}
              attachFileAction={attachFileAction}
              deleteRecordAction={deleteRecordAction}
            />
          ))}
        </ul>
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
    <form action={tickOffAction}>
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
    </form>
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
    <form action={handToAgentAction}>
      <input type="hidden" name="itemId" value={item.id} />
      <button type="submit" className={BTN_SECONDARY}>
        Hand to an agent
      </button>
    </form>
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

export function LifeAdminView({
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
            label: "Subscriptions",
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
            label: "Receipts & warranties",
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
            label: "Renewals & appointments",
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
            label: "Moving checklist",
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
