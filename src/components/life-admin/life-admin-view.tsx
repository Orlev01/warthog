"use client";

import * as React from "react";
import { ListChecks } from "lucide-react";

import { ViewPanels } from "@/components/ui/view-tabs";
import { LIST_ROW } from "@/components/ui/list-group";
import { ActionForm, FormSubmit, PendingFormFields } from "@/components/ui/form-submit";
import { ButtonLink } from "@/components/ui/button-link";
import { EmptyState } from "@/components/ui/empty";
import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { BUILT_IN, catalogueFromData, type CatalogueData } from "@/domain/life-admin/catalogue";
import { DisabledControl, HINT_CLASS } from "./record-forms";
import { DEFAULT_LIST_STATUSES, bookingsView, listStatusOf, listedRecords, upcomingSections } from "./record-groups";
import { RecordsView } from "./records-view";
import { UpcomingView } from "./upcoming-view";
import { BookingsView } from "./bookings-view";
import type {
  BookingFilters,
  CategoryStateView,
  ChecklistItemView,
  LifeAdminAction,
  LifeAdminRecordView,
  LifeAdminTab,
  NextStepView,
  RecordActions,
  RecordFilter,
  SuggestedCategoryView,
} from "./record-view-types";

export type {
  AssetOption,
  BookingFilters,
  CategoryStateView,
  ChecklistItemView,
  NextStepView,
  SuggestedCategoryView,
  LifeAdminAction,
  LifeAdminRecordView,
  LifeAdminTab,
  PendingChangeView,
  RecordActions,
  RecordActorView,
  RecordFilter,
  RecordFoundInView,
  RecordKind,
  RecordListStatus,
} from "./record-view-types";

// E14-S11 — Life-admin records and checklist view component
// (src/components/life-admin/life-admin-view.tsx), reshaped by the life-admin profile
// (docs/adr/life-admin-profile.md).
//
// The records half of Life admin has four in-page tabs (`?tab=`): "Records", the person's typed
// life admin — what's active by category (their own catalogue, built-in and their own
// categories), then whatever other statuses they choose, filtered by category and status — that
// they and their agents keep (./records-view.tsx); "Upcoming", what needs them soon across every
// category (./upcoming-view.tsx); "Bookings", every booking live and past (./bookings-view.tsx);
// and the MOVING CHECKLIST. Agents fill most of it in from email; what they save arrives as a
// suggestion the person confirms, and their change to a confirmed record waits for the person.
// The tab's old name ("things") and the older tab values (subscriptions, receipts, renewals) are
// mapped to "Records" by the page, and each record keeps its `#record-<id>` anchor, so reminder
// links still land on the record: one the filters don't show (finished, say, or in a category
// the person hid) goes to the item's own page.
//
// This is the pure, prop-driven VIEW (a Client Component in the app): it renders FROM the
// props the Life Admin loader hands it, with fields already decrypted, agent names resolved
// and server actions passed in — no clock, DB or session in the view. The loader passes the
// person's local date as `today`. The page heading and the Records | Tasks views live in
// LifeAdminScreen (./life-admin-screen.tsx).
//
// No control may ever be dead (constitution: "No dead controls"): a control whose server
// action is not supplied — or that cannot act because of its own state (a checklist item
// already handed to an agent) — renders DISABLED with a one-line reason tied to it. Colour
// comes from the design tokens and shared components, never a raw hex.

export type LifeAdminViewProps = RecordActions & {
  // The person's local date (YYYY-MM-DD, in their account time zone), from the loader. What
  // is overdue or coming up is worked out against it; the view never reads the clock.
  today: string;
  // The person's time zone (date-times without their own read in it; forms default to it).
  zone?: string;
  // The person's catalogue (built-in and their own categories), as plain data. Absent ⇒ built-in.
  catalogue?: CatalogueData;
  // Each category's place on the page. Absent ⇒ worked out from the records alone.
  categories?: ReadonlyArray<CategoryStateView>;
  suggestedCategories?: ReadonlyArray<SuggestedCategoryView>;
  // Open next steps with a due date, across items.
  nextSteps?: ReadonlyArray<NextStepView>;
  // The Records tab's category and status filters, validated by the page. Absent ⇒ what's
  // active, in every category.
  recordFilter?: RecordFilter;
  // The Bookings tab's filters and page, validated by the page.
  bookingFilters?: BookingFilters;
  // Every live record the person has (dismissed ones are never loaded).
  records: ReadonlyArray<LifeAdminRecordView>;
  checklist: ReadonlyArray<ChecklistItemView>;
  // Which tab a render shows first; both are always navigable.
  initialTab?: LifeAdminTab;
  // The type picked in the Add panel's first step (`?add=`), already validated by the page.
  addType?: string | null;
  tickOffAction?: LifeAdminAction;
  handToAgentAction?: LifeAdminAction;
};

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
    <WorkspacePanel
      title="Moving checklist"
      description={
        checklist.length === 0
          ? "The places that still have your old address, once you're moving."
          : `${done} of ${checklist.length} done. Tick items off, or hand one to an agent to do for you.`
      }
      icon={ListChecks}
    >
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
    </WorkspacePanel>
  );
}

// ─── the view ────────────────────────────────────────────────────────────────────────

export { nextTabIndex } from "@/components/ui/view-tabs";

// A tab label with its count, e.g. "Records (3)".
function counted(label: string, count: number): string {
  return `${label} (${count})`;
}

// A `#record-<id>` link (reminder emails, Home, older bookmarks) lands on its row: a row inside a
// closed disclosure is opened first, and one the page doesn't show (the filters leave it out, or
// its category is hidden) goes to the item's own page instead.
function useRecordAnchor() {
  React.useEffect(() => {
    const match = /^#record-([0-9a-f-]{36})$/i.exec(window.location.hash);
    if (!match) return;
    const row = document.getElementById(`record-${match[1]}`);
    if (!row) {
      const item = `/life-admin/items/${match[1]!.toLowerCase()}`;
      // Not when the person just came back from that item's page: it would send them straight back.
      let fromItem = false;
      try {
        fromItem = document.referrer !== "" && new URL(document.referrer).pathname === item;
      } catch {
        fromItem = false;
      }
      if (!fromItem) window.location.replace(item);
      return;
    }
    for (let parent = row.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
    row.scrollIntoView({ block: "start" });
    row.focus({ preventScroll: true });
  }, []);
}

// The records half of Life admin: a bounded tab strip ("Records" | "Upcoming" | "Bookings" |
// "Moving checklist"), then the selected tab's panels. Every tab stays mounted, so a half-typed
// record survives a switch. The Records count is what's active.
export function LifeAdminView({
  today,
  zone = "UTC",
  catalogue: catalogueData,
  categories,
  suggestedCategories = [],
  nextSteps = [],
  recordFilter = { categories: [], statuses: DEFAULT_LIST_STATUSES },
  bookingFilters = {},
  records,
  checklist,
  initialTab,
  addType,
  tickOffAction,
  handToAgentAction,
  ...actions
}: LifeAdminViewProps) {
  useRecordAnchor();
  const catalogue = React.useMemo(() => (catalogueData ? catalogueFromData(catalogueData) : BUILT_IN), [catalogueData]);
  const states = React.useMemo<CategoryStateView[]>(
    () =>
      categories
        ? [...categories]
        : catalogue.categories.map((category) => {
            const count = records.filter((record) => catalogue.typeOfRecord(record.kind, record.type ?? null).category === category.id).length;
            return { id: category.id, visibility: count > 0 || category.origin === "custom" ? "shown" : "available", records: count };
          }),
    [categories, catalogue, records],
  );
  const active = listedRecords(records, catalogue, states).filter((record) => listStatusOf(record) === "active").length;
  const upcoming = upcomingSections(records);
  const upcomingCount = upcoming.now.length + upcoming.overdue.length + upcoming.week.length + upcoming.later.length;
  const liveBookings = bookingsView(records, catalogue, {}, zone).live.length;
  return (
    <ViewPanels
      label="Life admin sections"
      parameter="tab"
      defaultTab="records"
      initialTab={initialTab}
      tabs={[
        {
          key: "records",
          label: counted("Records", active),
          content: (
            <RecordsView
              records={records}
              catalogue={catalogue}
              categories={states}
              suggestedCategories={suggestedCategories}
              today={today}
              zone={zone}
              addType={addType}
              filter={recordFilter}
              actions={actions}
            />
          ),
        },
        {
          key: "upcoming",
          label: counted("Upcoming", upcomingCount),
          content: <UpcomingView records={records} catalogue={catalogue} nextSteps={nextSteps} today={today} zone={zone} />,
        },
        {
          key: "bookings",
          label: counted("Bookings", liveBookings),
          content: <BookingsView records={records} catalogue={catalogue} filters={bookingFilters} today={today} zone={zone} />,
        },
        {
          key: "checklist",
          label: counted("Moving checklist", checklist.length),
          content: <ChecklistPanel checklist={checklist} tickOffAction={tickOffAction} handToAgentAction={handToAgentAction} />,
        },
      ]}
    />
  );
}

export default LifeAdminView;
