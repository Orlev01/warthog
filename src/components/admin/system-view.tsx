import * as React from "react";
import { Database, Server, Timer, Users } from "lucide-react";

import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { formatCount, formatDate, formatWhen, plural } from "@/domain/admin/format";
import { timeZoneNote } from "@/domain/display-time";
import type { SystemModel } from "@/domain/admin/model";
import { FactList } from "./fact-list";
import { SweepTable } from "./view-common";

// SystemView — the running system's facts (docs/design/admin-portal.md §5): schema version,
// feature flags, account and household totals, the metric store and the scheduler.

export function SystemView({ model, now }: { model: SystemModel; now: Date }) {
  const overdue = model.sweeps.filter((s) => s.overdue).length;
  return (
    <div className="wh-page">
      <WorkspaceHeading
        title="System"
        description={`The release that is running, what it is configured to do, and whether its background work is keeping up. ${timeZoneNote(model.timeZone)}`}
        meta={`Schema ${model.migration ?? "unknown"} · scheduler last ran ${formatWhen(model.schedulerLastTickAt, model.timeZone, now, "not yet")} · ${overdue === 0 ? "every sweep on time" : plural(overdue, "sweep") + " overdue"}`}
        scope={false}
      />
      <WorkspacePanel title="Release" icon={Server} description="What this process is running with.">
        <FactList label="Release facts" facts={[
          { key: "migration", label: "Latest migration", value: model.migration ?? "Unknown" },
          { key: "sms", label: "Text messages", value: model.smsEnabled ? "On" : "Off" },
          { key: "admin", label: "Admin sessions", value: formatCount(model.adminSessions) },
        ]} />
      </WorkspacePanel>
      <WorkspacePanel title="Accounts and households" icon={Users} description="Totals right now; deleted accounts wait as tombstones until the purge removes them.">
        <FactList label="Account totals" facts={[
          { key: "active", label: "Accounts", value: formatCount(model.accounts.active) },
          { key: "admins", label: "Admins", value: formatCount(model.accounts.admins) },
          { key: "tombstones", label: "Awaiting purge", value: formatCount(model.accounts.tombstones) },
          { key: "households", label: "Households", value: formatCount(model.households.total) },
          { key: "members", label: "Household members", value: formatCount(model.households.members) },
        ]} />
      </WorkspacePanel>
      <WorkspacePanel title="Metric store" icon={Database} description={`Operational numbers only, kept for ${formatCount(model.metricEvents.retentionDays)} days.`}>
        <FactList label="Metric store" facts={[
          { key: "rows", label: "Rows", value: formatCount(model.metricEvents.rows) },
          { key: "oldest", label: "Oldest", value: formatDate(model.metricEvents.oldestAt, model.timeZone, "None yet") },
          { key: "retention", label: "Kept for", value: `${formatCount(model.metricEvents.retentionDays)} days` },
        ]} />
      </WorkspacePanel>
      <WorkspacePanel title="Sweeps" icon={Timer} description="Each periodic sweep, its interval and when it last ran.">
        <SweepTable sweeps={model.sweeps} timeZone={model.timeZone} now={now} />
      </WorkspacePanel>
    </div>
  );
}
