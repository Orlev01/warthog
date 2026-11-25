"use client";

import * as React from "react";

import { LifeAdminView, type LifeAdminViewProps } from "./life-admin-view";
import { TasksView, type TasksViewProps } from "./tasks-view";
import type { LifeAdminTab } from "./record-view-types";

// The Life admin page body (UI/UX pass: containment-02/18/19, desktop-07, interaction-19,
// newcomer-23; founder, 23 Nov 2026). One heading band holds the title, the page's purpose and
// one row of tabs — Records | Add | Upcoming | Bills | History | Tasks (`?tab=`, validated, Back and Forward
// restore them). Every tab stays mounted, so switching keeps a half-typed record or task instead
// of reloading the page and dropping it. The outcome of the last action (`notice`) is the first
// thing in the tab it came from.

export type LifeAdminScreenProps = {
  // The tab the request asked for (`?tab=`, older addresses mapped by the page); when absent, Records,
  // or Add while nothing is on file.
  initialTab?: LifeAdminTab;
  // The page's outcome notice (a PageNotice), shown at the top of the tab first shown.
  notice?: React.ReactNode;
  records: Omit<LifeAdminViewProps, "initialTab" | "heading" | "notice" | "tasks">;
  tasks: TasksViewProps;
};

export function LifeAdminScreen({ initialTab, notice, records, tasks }: LifeAdminScreenProps) {
  return (
    <LifeAdminView
      {...records}
      initialTab={initialTab}
      notice={notice}
      heading={{
        title: "Life admin",
        description: "Records are the accounts, policies and things you have now. Add is what's still to fill in. Upcoming is what needs you or is booked. Bills is what you pay on repeat and what it comes out of. History is what's finished. Tasks are jobs for you or your agents. You and your agents keep it up to date.",
      }}
      tasks={<TasksView {...tasks} />}
    />
  );
}

export default LifeAdminScreen;
