import * as React from "react";
import { Bot, Clock, KeyRound, Plug, ShieldCheck, Timer } from "lucide-react";

import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { formatCount, formatShare, formatWhen, plural } from "@/domain/admin/format";
import { timeZoneNote } from "@/domain/display-time";
import type { ReliabilityModel } from "@/domain/admin/model";
import { BarList } from "./bar-list";
import { FactList } from "./fact-list";
import { RangeTabs } from "./range-tabs";
import { Sparkline } from "./sparkline";
import { StatTiles } from "./stat-tiles";
import { SweepTable } from "./view-common";

// ReliabilityView — where the product fails (docs/design/admin-portal.md §5): sign-in
// failures and lockouts, agent request failures by category, platform and service, connector
// trouble, the integrity check, the job queue and each sweep against its interval.

export function ReliabilityView({ model, now }: { model: ReliabilityModel; now: Date }) {
  const { range, signins, agentErrors, connectors, integrity, jobs } = model;
  const failedSignins = signins.byOutcome.filter((r) => r.key !== "ok").reduce((sum, r) => sum + r.value, 0);
  const overdue = model.sweeps.filter((s) => s.overdue).length;
  return (
    <div className="wh-page">
      <WorkspaceHeading
        title="Reliability"
        description={`Where things fail: sign-ins, agent requests, connected services and background work. ${timeZoneNote(model.timeZone)}`}
        meta={`${plural(agentErrors.failed.value, "failed agent request")} ${range.label} · ${plural(failedSignins, "failed sign-in")} · ${plural(jobs.failed, "failed job")} · ${overdue === 0 ? "every sweep on time" : plural(overdue, "sweep") + " overdue"}`}
        nav={<RangeTabs path="/reliability" active={range.key} />}
        scope={false}
      />
      <StatTiles
        label="Failure numbers"
        tiles={[
          { key: "failed", label: "Failed agent requests", value: formatCount(agentErrors.failed.value), sub: agentErrors.total.value > 0 ? `${formatShare(agentErrors.failed.value, agentErrors.total.value)} of ${formatCount(agentErrors.total.value)}` : "no requests yet", delta: { value: agentErrors.failed.value, previous: agentErrors.failed.previous, previousLabel: range.previousLabel, goodWhen: "down" } },
          { key: "signins", label: "Failed sign-ins", value: formatCount(failedSignins), sub: `${plural(signins.lockoutAlerts, "lockout alert")} sent`, sparkline: <Sparkline label={`Failed sign-ins per ${range.bucket}`} points={signins.failedSeries} /> },
          { key: "jobs", label: "Failed jobs", value: formatCount(jobs.failed), sub: `${plural(jobs.pending, "job")} pending`, tone: jobs.failed > 0 ? "danger" : "neutral" },
          { key: "integrity", label: "Integrity check", value: integrity.failed == null ? "Not yet run" : integrity.failed === 0 ? "Passed" : `${formatCount(integrity.failed)} failed`, sub: integrity.lastRunAt ? `last run ${formatWhen(integrity.lastRunAt, model.timeZone, now)}` : "runs daily", tone: integrity.failed != null && integrity.failed > 0 ? "danger" : "neutral" },
        ]}
      />
      <div className="wh-dashboard-grid">
        <div className="wh-dashboard-column">
          <WorkspacePanel title="Sign-in" icon={KeyRound} description={`Sign-in attempts by outcome ${range.label}, and why the failed ones failed.`}>
            <div className="flex flex-col gap-4">
              <BarList label="Sign-ins by outcome" rows={signins.byOutcome} empty="No sign-in attempts in this period." />
              <BarList label="Failed sign-ins by reason" rows={signins.failedByCategory} empty="No sign-in failed in this period." />
            </div>
          </WorkspacePanel>
          <WorkspacePanel title="Agent request failures" icon={Bot} description="Refused or failed requests by reason, platform and service.">
            <div className="flex flex-col gap-4">
              <BarList label="Failures by reason" rows={agentErrors.byCategory} empty="No agent request failed in this period." />
              <BarList label="Failures by platform" marks="agent" rows={agentErrors.byPlatform} empty="No agent request failed in this period." />
              <BarList label="Failures by service" marks="service" rows={agentErrors.byConnector} empty="No request to a service failed in this period." />
            </div>
          </WorkspacePanel>
          <WorkspacePanel title="Connected services" icon={Plug} description="Connections needing attention, and connects or refreshes that failed.">
            <div className="flex flex-col gap-4">
              <BarList label="Needs reconnecting" rows={connectors.needsReconnect} empty="Every connection is healthy." />
              <BarList label="Refresh failures" rows={connectors.refreshFailures} empty="No token refresh failed in this period." />
              <BarList label="Connect failures" rows={connectors.connectFailures} empty="No connection attempt failed in this period." />
            </div>
          </WorkspacePanel>
        </div>
        <div className="wh-dashboard-column">
          <WorkspacePanel title="Activity record integrity" icon={ShieldCheck} description="The daily check recomputes every account's hash chain without reading any content.">
            <FactList label="Integrity" facts={[
              { key: "last", label: "Last run", value: formatWhen(integrity.lastRunAt, model.timeZone, now, "Not yet") },
              { key: "passed", label: "Accounts passed", value: integrity.passed == null ? "—" : formatCount(integrity.passed) },
              { key: "failed", label: "Accounts failed", value: integrity.failed == null ? "—" : formatCount(integrity.failed) },
            ]} />
          </WorkspacePanel>
          <WorkspacePanel title="Background jobs" icon={Clock} description="The queue of payload-driven jobs: what is waiting, running and failed.">
            <div className="flex flex-col gap-4">
              <FactList label="Job queue" facts={[
                { key: "pending", label: "Pending", value: formatCount(jobs.pending) },
                { key: "failed", label: "Failed", value: formatCount(jobs.failed) },
                { key: "oldest", label: "Oldest pending", value: formatWhen(jobs.oldestPendingAt, model.timeZone, now, "None") },
              ]} />
              <Sparkline label={`Job failures per ${range.bucket}`} points={jobs.failuresSeries} height={56} timeZone={model.timeZone} />
              <BarList label="Jobs by type and state" rows={jobs.byTypeStatus.map((j) => ({ key: `${j.type}:${j.status}`, label: `${j.type} · ${j.status}`, value: j.count, tone: j.status === "failed" ? "danger" : undefined }))} empty="No jobs have been queued yet." />
            </div>
          </WorkspacePanel>
          <WorkspacePanel title="Sweeps" icon={Timer} description="Each periodic sweep and whether it is running on time.">
            <SweepTable sweeps={model.sweeps} timeZone={model.timeZone} now={now} />
          </WorkspacePanel>
        </div>
      </div>
    </div>
  );
}
