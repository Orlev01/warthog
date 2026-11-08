"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty";

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

export type RecordKind = "subscription" | "receipt_warranty" | "renewal_appointment";

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
};

// One moving-checklist item: its id, its label, whether it is ticked off, and the id of
// the task it was handed to an agent as (non-null ⇒ already handed off).
export type ChecklistItemView = {
  id: string;
  label: string;
  done: boolean;
  linkedTaskId: string | null;
};

export type LifeAdminTab = "subscriptions" | "receipts" | "renewals" | "checklist";

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
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-card px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const BTN_PRIMARY = `${BTN_BASE} bg-accent text-accent-fg hover:bg-accent-hover`;
const BTN_SECONDARY = `${BTN_BASE} border border-line bg-surface text-fg hover:bg-surface-muted`;
const BTN_DISABLED = `${BTN_BASE} border border-line bg-surface text-fg-muted opacity-50`;

// The selected tab is marked by more than its fill (review fix G10, WCAG 1.4.1): a visible
// outline on the form-control token and heavier text.
const TAB_ACTIVE = `${BTN_BASE} border border-line-input bg-surface-muted font-semibold text-fg`;
const TAB_INACTIVE = `${BTN_BASE} border border-transparent text-fg-muted hover:bg-surface-muted`;

const SUMMARY_CLASS =
  "inline-flex w-fit cursor-pointer items-center gap-2 text-sm font-medium text-fg";
const FILE_INPUT_CLASS =
  "text-sm text-fg file:me-3 file:rounded-card file:border file:border-line file:bg-surface file:px-3 file:py-2 file:text-sm file:text-fg";

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
    return <DisabledControl label={label} reason="Adding isn't available just now." />;
  }
  return (
    <details className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <summary className={SUMMARY_CLASS}>{label}</summary>
      <form action={addRecordAction} className="mt-2 flex flex-col gap-3">
        <input type="hidden" name="kind" value={kind} />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId}>What to add</Label>
          <Input id={fieldId} name="title" placeholder="Describe it" />
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
        <Input id={fieldId} name="reminderOffsets" defaultValue={value} disabled />
        <p className="text-xs text-fg-muted">Changing reminders isn't available just now.</p>
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
        <input id={fieldId} type="file" name="file" disabled className={FILE_INPUT_CLASS} />
        <p className="text-xs text-fg-muted">Attaching a file isn't available just now.</p>
      </div>
    );
  }
  return (
    <form action={attachFileAction} className="flex flex-col gap-1.5">
      <input type="hidden" name="recordId" value={record.id} />
      <Label htmlFor={fieldId}>Attach a file</Label>
      <input id={fieldId} type="file" name="file" className={FILE_INPUT_CLASS} />
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
    return <DisabledControl label="Edit" reason="Editing isn't available just now." />;
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
}: {
  record: LifeAdminRecordView;
  editRecordAction?: LifeAdminAction;
  attachFileAction?: LifeAdminAction;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {Object.entries(record.fields).map(([key, fieldValue]) => (
          <React.Fragment key={key}>
            <dt className="text-fg-muted">{key}</dt>
            <dd className="text-fg">{fieldValue}</dd>
          </React.Fragment>
        ))}
      </dl>

      <p className="text-sm text-fg-muted">
        {record.dueDate ? `Due ${record.dueDate} · ${record.status}` : record.status}
      </p>

      <ReminderSetting record={record} editRecordAction={editRecordAction} />

      {record.kind === "receipt_warranty" ? (
        <AttachControl record={record} attachFileAction={attachFileAction} />
      ) : null}

      <EditControl record={record} editRecordAction={editRecordAction} />
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
}: {
  kind: RecordKind;
  heading: string;
  records: ReadonlyArray<LifeAdminRecordView>;
  addRecordAction?: LifeAdminAction;
  editRecordAction?: LifeAdminAction;
  attachFileAction?: LifeAdminAction;
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
        <label className="inline-flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" className="size-4" defaultChecked={item.done} disabled />
          Done
        </label>
        <p className="text-xs text-fg-muted">Ticking items off isn't available just now.</p>
      </div>
    );
  }
  return (
    <form action={tickOffAction}>
      <input type="hidden" name="itemId" value={item.id} />
      <label className="inline-flex items-center gap-2 text-sm text-fg">
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

// The roving-focus step for the tab list (WAI-ARIA tabs pattern): Left/Right move to the
// previous/next tab, wrapping at the ends; Home/End jump to the first/last. Any other key
// returns null (left to the browser).
export function nextTabIndex(current: number, key: string, count: number): number | null {
  if (key === "ArrowRight") return (current + 1) % count;
  if (key === "ArrowLeft") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

const TABS: ReadonlyArray<{ key: LifeAdminTab; label: string }> = [
  { key: "subscriptions", label: "Subscriptions" },
  { key: "receipts", label: "Receipts & warranties" },
  { key: "renewals", label: "Renewals & appointments" },
  { key: "checklist", label: "Moving checklist" },
];

export function LifeAdminView({
  subscriptions,
  receipts,
  renewals,
  checklist,
  initialTab,
  addRecordAction,
  editRecordAction,
  attachFileAction,
  tickOffAction,
  handToAgentAction,
}: LifeAdminViewProps) {
  const [active, setActive] = React.useState<LifeAdminTab>(initialTab ?? "subscriptions");
  // The section switcher is a WAI-ARIA tab list (review fix G10): role=tab buttons in a
  // labelled tablist, a roving tabindex with arrow-key movement, and one tabpanel labelled
  // by the selected tab (aria-selected on a plain button is never announced).
  const baseId = React.useId();
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const tabId = (key: LifeAdminTab) => `${baseId}-tab-${key}`;
  const panelId = `${baseId}-panel`;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Life admin</h1>

      <div role="tablist" aria-label="Life admin sections" className="flex flex-wrap gap-2">
        {TABS.map((tab, index) => {
          const selected = active === tab.key;
          return (
            <button
              key={tab.key}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={tabId(tab.key)}
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              className={selected ? TAB_ACTIVE : TAB_INACTIVE}
              onClick={() => setActive(tab.key)}
              onKeyDown={(event) => {
                const next = nextTabIndex(index, event.key, TABS.length);
                if (next === null) return;
                event.preventDefault();
                setActive(TABS[next]!.key);
                tabRefs.current[next]?.focus();
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(active)}
        tabIndex={0}
        className="flex flex-col gap-6"
      >
        {active === "subscriptions" ? (
          <RecordPanel
            kind="subscription"
            heading="Subscriptions"
            records={subscriptions}
            addRecordAction={addRecordAction}
            editRecordAction={editRecordAction}
            attachFileAction={attachFileAction}
          />
        ) : null}

        {active === "receipts" ? (
          <RecordPanel
            kind="receipt_warranty"
            heading="Receipts & warranties"
            records={receipts}
            addRecordAction={addRecordAction}
            editRecordAction={editRecordAction}
            attachFileAction={attachFileAction}
          />
        ) : null}

        {active === "renewals" ? (
          <RecordPanel
            kind="renewal_appointment"
            heading="Renewals & appointments"
            records={renewals}
            addRecordAction={addRecordAction}
            editRecordAction={editRecordAction}
            attachFileAction={attachFileAction}
          />
        ) : null}

        {active === "checklist" ? (
          <ChecklistPanel
            checklist={checklist}
            tickOffAction={tickOffAction}
            handToAgentAction={handToAgentAction}
          />
        ) : null}
      </div>
    </div>
  );
}

export default LifeAdminView;
