"use client";

import * as React from "react";

import { ViewPanels, type ViewPanelsHeading } from "@/components/ui/view-tabs";
import { BUILT_IN, catalogueFromData, type CatalogueData } from "@/domain/life-admin/catalogue";
import { DEFAULT_LIST_STATUSES, listedRecords } from "./record-groups";
import { AddView, RecordsView, assetsOf, nothingOnFile } from "./records-view";
import type { ProfileBuildView } from "@/domain/home/profile-build";
import { UpcomingView } from "./upcoming-view";
import { BillsView, paymentSourceLabels } from "./bills-view";
import { HistoryView } from "./history-view";
import { PaymentSourcesProvider } from "./record-forms";
import { addFormRedirect, shownLifeAdminAddress } from "./tab-address";
import type {
  BillsGrouping,
  CategoryStateView,
  HistoryFilter,
  LifeAdminRecordView,
  LifeAdminTab,
  NextStepView,
  RecordActions,
  RecordFilter,
  SuggestedCategoryView,
} from "./record-view-types";

export type {
  AssetOption,
  BillsGrouping,
  CategoryStateView,
  HistoryFilter,
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

// Life admin's tabs (src/components/life-admin/life-admin-view.tsx; docs/adr/life-admin-profile.md;
// founder, 23 and 24 Nov 2026): one row of tabs (`?tab=`), no counts in their names —
//   • "Records": what's on file and ongoing in the person's life — accounts, policies,
//     memberships, documents, the things other records belong to, matters in progress — what's
//     active first, by category (their own catalogue, built-in and their own categories), then
//     what's on hold, filtered by category and status (./records-view.tsx);
//   • "Add": what's still to fill in — the empty categories to look for (or say are not for
//     them) — and adding a record themselves (./records-view.tsx `AddView`). It opens first while
//     nothing is on file;
//   • "Upcoming": what needs them or is booked — renewals and expiry dates coming up, every
//     booking ahead, and next steps due (./upcoming-view.tsx);
//   • "Bills": what they pay on repeat, across categories — what it costs, when the next payment
//     is and which card or account it comes out of — by date or by account (./bills-view.tsx);
//   • "History": everything finished, strictly apart, newest first, filtered by category and
//     status (./history-view.tsx);
//   • "Tasks", when the page passes it (LifeAdminScreen does).
// Agents fill most of it in from email; what they save arrives as a suggestion the person
// confirms, and their change to a confirmed record waits for the person. Each record keeps its
// `#record-<id>` anchor, so reminder links still land on it (on the tab shown, its row there,
// marked `data-record`, when that tab lists it too: Upcoming, Bills): one this page doesn't show as
// a row (a booking, something finished, or in a category the person hid) goes to the item's own
// page. Every tab's Add and Edit forms suggest the person's open cards and accounts for a bill's
// Paid with.
//
// This is the pure, prop-driven VIEW (a Client Component in the app): it renders FROM the
// props the Life Admin loader hands it, with fields already decrypted, agent names resolved
// and server actions passed in — no clock, DB or session in the view. The loader passes the
// person's local date as `today`.
//
// No control may ever be dead (constitution: "No dead controls"): a control whose server
// action is not supplied renders DISABLED with a one-line reason tied to it. Colour comes from
// the design tokens and shared components, never a raw hex.

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
  // History's category and status filters and page, validated by the page. Absent ⇒ everything.
  historyFilter?: HistoryFilter;
  // How the Bills tab groups (`?bills=account`), validated by the page. Absent ⇒ by date.
  billsGroup?: BillsGrouping;
  // Every live record the person has (dismissed ones are never loaded).
  records: ReadonlyArray<LifeAdminRecordView>;
  // Which tab a render shows first; every tab is always navigable.
  initialTab?: LifeAdminTab;
  // The type picked in the Add panel's first step (`?add=`), already validated by the page.
  addType?: string | null;
  // Who can build the person's whole profile, for the Add tab (docs/adr/profile-build.md).
  profileBuild?: ProfileBuildView;
  // The page heading over the tabs, the outcome of the last action (shown in the tab first
  // shown), and the Tasks tab's content.
  heading?: ViewPanelsHeading;
  notice?: React.ReactNode;
  tasks?: React.ReactNode;
};

// ─── the view ────────────────────────────────────────────────────────────────────────

export { nextTabIndex } from "@/components/ui/view-tabs";

// A `#record-<id>` link (reminder notifications, older bookmarks, coming back from an edit) lands
// on its row in the tab shown — the row carrying the anchor, else the same record's row on that
// tab (`data-record`: on Upcoming or Bills, a record that lives on Records): a row inside a closed
// disclosure is opened first, and one that tab doesn't show (a booking, something finished, the
// filters leave it out, or its category is hidden) goes to the item's own page instead.
function useRecordAnchor() {
  React.useEffect(() => {
    const match = /^#record-([0-9a-f-]{36})$/i.exec(window.location.hash);
    if (!match) return;
    const shown = (element: HTMLElement | null) => (element && !element.closest('[role="tabpanel"][hidden]') ? element : null);
    const row =
      shown(document.getElementById(`record-${match[1]}`)) ??
      [...document.querySelectorAll<HTMLElement>(`[data-record="${match[1]}"]`)].find((element) => shown(element)) ??
      null;
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

// The address is made to name the tab the page opened, before the tabs read it: an older address
// (`?view=…`, an older tab name) becomes today's, keeping the `#record-<id>`, and `?tab=` names the
// shown tab whenever it isn't this person's default (Records, or Add while nothing is on file), so
// the tabs never fall back to a different one. A layout effect, so it runs before the tabs' own
// (passive) effect reads the address.
function useCurrentAddress(shown: LifeAdminTab, defaultTab: LifeAdminTab) {
  React.useLayoutEffect(() => {
    // An old link to the add form (from before the Add tab) reloads at the Add tab's address.
    const addForm = addFormRedirect(window.location.search, window.location.hash, shown);
    if (addForm) {
      window.location.replace(addForm);
      return;
    }
    const next = shownLifeAdminAddress(window.location.search, window.location.hash, shown, defaultTab);
    // No state of our own: Next.js then takes the new address as its own (it would put its old one
    // back on its next render if handed its own state).
    if (next) window.history.replaceState(null, "", next);
    // Once, for the address the page was opened at; the tabs keep it current after that.
  }, []);
}

// Life admin's tabs: Records | Add | Upcoming | Bills | History (| Tasks), then the selected tab's panels.
// Every tab stays mounted, so a half-typed record or task survives a switch. With nothing on file
// (`nothingOnFile`: no record shown and nothing to check) Add is the tab an address without `?tab=`
// opens.
export function LifeAdminView({
  today,
  zone = "UTC",
  catalogue: catalogueData,
  categories,
  suggestedCategories = [],
  nextSteps = [],
  recordFilter = { categories: [], statuses: DEFAULT_LIST_STATUSES },
  historyFilter = { categories: [], statuses: [] },
  billsGroup = "date",
  records,
  initialTab,
  addType,
  profileBuild,
  heading,
  notice,
  tasks,
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
  // A category the person said is not for them is hidden on every tab (its records are kept;
  // Add lists it under "Not for me", to undo).
  const listed = React.useMemo(() => listedRecords(records, catalogue, states), [records, catalogue, states]);
  const defaultTab: LifeAdminTab = nothingOnFile(records, listed, suggestedCategories) ? "add" : "records";
  const shown = initialTab ?? defaultTab;
  useCurrentAddress(shown, defaultTab);
  const assets = React.useMemo(() => assetsOf(records, catalogue), [records, catalogue]);
  // A bill's Paid with suggests the person's open cards and accounts, in every tab's forms.
  const sources = React.useMemo(() => paymentSourceLabels(records, catalogue), [records, catalogue]);
  const withNotice = (key: LifeAdminTab, content: React.ReactNode) => (
    <>
      {shown === key ? notice : null}
      {content}
    </>
  );
  return (
    <PaymentSourcesProvider value={sources}>
      <ViewPanels
        label="Life admin"
        parameter="tab"
        defaultTab={defaultTab}
        initialTab={shown}
        heading={heading}
        tabs={[
          {
            key: "records",
            label: "Records",
            content: withNotice(
              "records",
              <RecordsView
                records={records}
                catalogue={catalogue}
                categories={states}
                suggestedCategories={suggestedCategories}
                today={today}
                zone={zone}
                filter={recordFilter}
                assets={assets}
                actions={actions}
              />,
            ),
          },
          {
            key: "add",
            label: "Add",
            content: withNotice(
              "add",
              <AddView
                records={records}
                catalogue={catalogue}
                categories={states}
                zone={zone}
                addType={addType}
                assets={assets}
                profileBuild={profileBuild}
                actions={actions}
              />,
            ),
          },
          {
            key: "upcoming",
            label: "Upcoming",
            content: withNotice("upcoming", <UpcomingView records={listed} catalogue={catalogue} nextSteps={nextSteps} today={today} zone={zone} actions={actions} />),
          },
          {
            key: "bills",
            label: "Bills",
            content: withNotice(
              "bills",
              <BillsView records={records} listed={listed} catalogue={catalogue} today={today} zone={zone} group={billsGroup} assets={assets} actions={actions} />,
            ),
          },
          {
            key: "history",
            label: "History",
            content: withNotice("history", <HistoryView records={listed} catalogue={catalogue} filter={historyFilter} today={today} zone={zone} actions={actions} />),
          },
          ...(tasks ? [{ key: "tasks", label: "Tasks", content: withNotice("tasks", tasks) }] : []),
        ]}
      />
    </PaymentSourcesProvider>
  );
}

export default LifeAdminView;
