"use client";

import * as React from "react";

import { ViewPanels } from "@/components/ui/view-tabs";
import { LifeAdminView, type LifeAdminViewProps } from "./life-admin-view";
import { TasksView, type TasksViewProps } from "./tasks-view";

// The Life admin page body (UI/UX pass: containment-02/18/19, desktop-07, interaction-19,
// newcomer-23). One heading band holds the title, the page's purpose and the two views —
// Records & reminders | Tasks — as in-page tabs (`?view=life|tasks`, validated, Back and
// Forward restore them). Both views stay mounted, so switching between them keeps a
// half-typed record or task instead of reloading the page and dropping it. The outcome of
// the last action (`notice`) is the first thing under the band, inside the view it came
// from. The records view's own tabs (Your things | Moving checklist) are a bounded strip of
// their own above its panels (./life-admin-view.tsx).

export type LifeAdminScreenView = "life" | "tasks";

export type LifeAdminScreenProps = {
  // The view the request asked for (`?view=`); the records view when absent.
  initialView: LifeAdminScreenView;
  // The page's outcome notice (a PageNotice), shown under the heading band.
  notice?: React.ReactNode;
  records: LifeAdminViewProps;
  tasks: TasksViewProps;
};

export function LifeAdminScreen({ initialView, notice, records, tasks }: LifeAdminScreenProps) {
  return (
    <ViewPanels
      label="Life admin views"
      parameter="view"
      defaultTab="life"
      initialTab={initialView}
      heading={{
        title: "Life admin",
        description: "Your vehicles, home, bills, insurance, bookings, ID expiry dates and subscriptions, what's coming up, and tasks, kept up to date by you and your agents.",
      }}
      tabs={[
        {
          key: "life",
          label: "Records & reminders",
          content: (
            <>
              {initialView === "life" ? notice : null}
              <LifeAdminView {...records} />
            </>
          ),
        },
        {
          key: "tasks",
          label: "Tasks",
          content: (
            <>
              {initialView === "tasks" ? notice : null}
              <TasksView {...tasks} />
            </>
          ),
        },
      ]}
    />
  );
}

export default LifeAdminScreen;
