import * as React from "react";
import { Activity, Bot, Inbox, Plug, Users } from "lucide-react";

import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty";
import { LIST_ROW, ListGroup } from "@/components/ui/list-group";
import { formatCount, formatDurationMs, formatShare, plural } from "@/domain/admin/format";
import { timeZoneNote } from "@/domain/display-time";
import type { UsageModel } from "@/domain/admin/model";
import { BarList } from "./bar-list";
import { FactList } from "./fact-list";
import { RangeTabs } from "./range-tabs";
import { Sparkline } from "./sparkline";
import { StatTiles } from "./stat-tiles";

// UsageView — people, agents, requests, approvals and services (docs/design/admin-portal.md §5).

export function UsageView({ model }: { model: UsageModel }) {
  const { range, requests, approvals } = model;
  return (
    <div className="wh-page">
      <WorkspaceHeading
        title="Usage"
        description={`Who is active, what agents are asking for, and how approvals are going. ${timeZoneNote(model.timeZone)}`}
        meta={`${plural(model.activePeople.week, "person", "people")} active in the last 7 days · ${plural(requests.total.value, "agent request")} ${range.label}`}
        nav={<RangeTabs path="/usage" active={range.key} />}
        scope={false}
      />
      <StatTiles
        label="Usage numbers"
        tiles={[
          { key: "requests", label: "Agent requests", value: formatCount(requests.total.value), delta: { value: requests.total.value, previous: requests.total.previous, previousLabel: range.previousLabel }, sparkline: <Sparkline label={`Agent requests per ${range.bucket}`} points={requests.series} /> },
          { key: "decided", label: "Approvals decided", value: formatCount(approvals.decided.value), sub: approvals.medianResponseMs == null ? "No replies yet" : `median reply ${formatDurationMs(approvals.medianResponseMs)}`, delta: { value: approvals.decided.value, previous: approvals.decided.previous, previousLabel: range.previousLabel } },
          { key: "pending", label: "Approvals waiting", value: formatCount(approvals.pending), sub: "right now" },
          { key: "expiry", label: "Approvals expired", value: approvals.expiryRate ? formatShare(approvals.expiryRate.numerator, approvals.expiryRate.denominator) : "none yet", sub: "of those decided or expired" },
        ]}
      />
      <div className="wh-dashboard-grid">
        <div className="wh-dashboard-column">
          <WorkspacePanel title="Active people" icon={Users} description="Distinct people whose signed-in session was seen in the window.">
            <FactList label="Active people" facts={[
              { key: "today", label: "Today", value: formatCount(model.activePeople.today) },
              { key: "week", label: "Last 7 days", value: formatCount(model.activePeople.week) },
              { key: "month", label: "Last 30 days", value: formatCount(model.activePeople.month) },
            ]} />
          </WorkspacePanel>
          <WorkspacePanel title="Active agents" icon={Bot} description="Agents that made at least one request in the window, and the platforms they run on.">
            <div className="flex flex-col gap-4">
              <FactList label="Active agents" facts={[
                { key: "today", label: "Today", value: formatCount(model.activeAgents.today) },
                { key: "week", label: "Last 7 days", value: formatCount(model.activeAgents.week) },
                { key: "month", label: "Last 30 days", value: formatCount(model.activeAgents.month) },
              ]} />
              <BarList label="Agents by platform" marks="agent" rows={model.activeAgents.byPlatform} empty="No agent has been active yet." />
            </div>
          </WorkspacePanel>
          <WorkspacePanel title="Agent requests" icon={Activity} description={`What happened to each request ${range.label}, and how fast Warthog answered.`}>
            <div className="flex flex-col gap-4">
              <FactList label="Latency" facts={[
                { key: "p50", label: "Typical response", value: formatDurationMs(requests.latency.p50) },
                { key: "p95", label: "Slowest 5%", value: formatDurationMs(requests.latency.p95) },
              ]} />
              {requests.total.value === 0 ? (
                <EmptyState variant="inline" heading="No agent requests in this period." description="Requests appear here as soon as a connected agent calls a Warthog tool." />
              ) : (
                <>
                  <BarList label="Requests by outcome" rows={requests.byOutcome} empty="No agent requests in this period." />
                  <BarList label="Requests by platform" marks="agent" rows={requests.byPlatform} empty="No agent requests in this period." />
                  <BarList label="Requests by service" marks="service" rows={requests.byConnector} empty="No request reached a connected service in this period." />
                </>
              )}
            </div>
          </WorkspacePanel>
        </div>
        <div className="wh-dashboard-column">
          <WorkspacePanel title="Approvals" icon={Inbox} description={`Decisions per ${range.bucket} and how long people took to reply.`}>
            <div className="flex flex-col gap-4">
              {approvals.decided.value === 0 ? (
                <EmptyState variant="inline" heading="No approvals decided in this period." description="Decisions appear here once an agent asks for something and someone replies." />
              ) : (
                <Sparkline label={`Approvals decided per ${range.bucket}`} points={approvals.decidedSeries} height={56} timeZone={model.timeZone} />
              )}
              <FactList label="Approval timing" facts={[
                { key: "median", label: "Median reply", value: formatDurationMs(approvals.medianResponseMs) },
                { key: "p95", label: "Slowest 5%", value: formatDurationMs(approvals.p95ResponseMs) },
                { key: "pending", label: "Waiting now", value: formatCount(approvals.pending) },
              ]} />
            </div>
          </WorkspacePanel>
          <WorkspacePanel title="Connected services" icon={Plug} description="Connections by service, with any that need reconnecting.">
            {model.connections.length === 0 ? (
              <EmptyState variant="inline" heading="No services connected yet." description="They appear once someone connects Gmail, Calendar or another service." />
            ) : (
              <ListGroup id="connections" title="Connections" level={3}>
                {model.connections.map((row) => (
                  <li key={row.key} className={LIST_ROW}>
                    <span className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 text-sm">
                      <span className="font-medium">{row.label}</span>
                      <span className="tabular-nums">{plural(row.value, "connection")}</span>
                    </span>
                    {row.failing > 0 ? <span><Badge tone="warning">{plural(row.failing, "needs reconnecting", "need reconnecting")}</Badge></span> : null}
                  </li>
                ))}
              </ListGroup>
            )}
          </WorkspacePanel>
          <WorkspacePanel title="Services people asked for" icon={Plug} description="Requests for services Warthog doesn't connect yet, counted when at least two people asked.">
            <BarList label="Services asked for" rows={model.servicesRequested} empty="No service has been asked for twice yet." />
          </WorkspacePanel>
        </div>
      </div>
    </div>
  );
}
