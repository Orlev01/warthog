import * as React from "react";
import { ExternalLink, Globe, Route, Server } from "lucide-react";

import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { ButtonLink } from "@/components/ui/button-link";
import { formatCount, plural } from "@/domain/admin/format";
import { timeZoneNote } from "@/domain/display-time";
import type { TrafficModel } from "@/domain/admin/model";
import { BarList } from "./bar-list";
import { RangeTabs } from "./range-tabs";
import { Sparkline } from "./sparkline";
import { StatTiles } from "./stat-tiles";
import { TrendList } from "./view-common";

// TrafficView — requests and page loads by route class and host (docs/design/admin-portal.md §5).
// Counted in the proxy by closed labels only, so there is never a path, address or user agent
// here; response status codes live in Azure's ingress metrics, linked out.

export function TrafficView({ model }: { model: TrafficModel }) {
  const { range } = model;
  return (
    <div className="wh-page">
      <WorkspaceHeading
        title="Traffic"
        description={`Requests and page loads by what was asked for and which host, counted without storing anything about who asked. ${timeZoneNote(model.timeZone)}`}
        meta={`${plural(model.requests.value, "request")} ${range.label} · ${plural(model.documents.value, "page load")} · ${plural(model.limited, "refusal")} for too many attempts`}
        nav={<RangeTabs path="/traffic" active={range.key} />}
        scope={false}
      >
        {model.azureMetricsUrl ? (
          <ButtonLink href={model.azureMetricsUrl} size="sm" rel="noreferrer" target="_blank">
            <ExternalLink aria-hidden={true} className="h-4 w-4 shrink-0" />
            Azure ingress metrics
          </ButtonLink>
        ) : null}
      </WorkspaceHeading>
      <StatTiles
        label="Traffic numbers"
        tiles={[
          { key: "requests", label: "Requests", value: formatCount(model.requests.value), delta: { value: model.requests.value, previous: model.requests.previous, previousLabel: range.previousLabel }, sparkline: <Sparkline label={`Requests per ${range.bucket}`} points={model.series.requests} /> },
          { key: "documents", label: "Page loads", value: formatCount(model.documents.value), delta: { value: model.documents.value, previous: model.documents.previous, previousLabel: range.previousLabel }, sparkline: <Sparkline label={`Page loads per ${range.bucket}`} points={model.series.documents} /> },
          { key: "limited", label: "Rate-limited", value: formatCount(model.limited), sub: "sign-in or handoff attempts refused", tone: model.limited > 0 ? "warning" : "neutral" },
        ]}
      />
      <div className="wh-dashboard-grid">
        <div className="wh-dashboard-column">
          <WorkspacePanel title="Over time" icon={Globe} description={`Per ${range.bucket} over ${range.label}, and today hour by hour.`}>
            <TrendList
              timeZone={model.timeZone}
              trends={[
                { key: "requests", label: "Requests", total: model.requests.value, points: model.series.requests },
                { key: "documents", label: "Page loads", total: model.documents.value, points: model.series.documents },
                { key: "today", label: "Today by hour", total: model.todayByHour.reduce((sum, p) => sum + p.value, 0), points: model.todayByHour },
              ]}
            />
          </WorkspacePanel>
        </div>
        <div className="wh-dashboard-column">
          <WorkspacePanel title="By what was asked for" icon={Route} description="Public pages, sign-in, the signed-in app, agent connections, the admin portal and health probes.">
            <BarList label="Requests by route" rows={model.byRoute} empty="No traffic counted yet. Counts appear a minute after the first request." />
          </WorkspacePanel>
          <WorkspacePanel title="By host" icon={Server} description="The member app against the admin portal.">
            <BarList label="Requests by host" rows={model.byHost} empty="No traffic counted yet." />
          </WorkspacePanel>
        </div>
      </div>
    </div>
  );
}
