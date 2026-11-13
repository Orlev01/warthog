import * as React from "react";
import { Filter, Plug, ShieldAlert, TrendingUp } from "lucide-react";

import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { formatCount, formatDurationMs, plural } from "@/domain/admin/format";
import { timeZoneNote } from "@/domain/display-time";
import type { OverviewModel } from "@/domain/admin/model";
import { BarList } from "./bar-list";
import { Funnel } from "./funnel";
import { RangeTabs } from "./range-tabs";
import { Sparkline } from "./sparkline";
import { StatTiles, type StatTile } from "./stat-tiles";
import { AttentionList, TrendList } from "./view-common";

// OverviewView — the glance screen (docs/design/admin-portal.md §5): five tiles, then what
// needs attention beside the activation funnel, with the trends and top services alongside.
// A non-zero Needs attention tile comes first in markup (so phones read it first); otherwise
// it closes the row. Purely a renderer over an already-computed model.

export function OverviewView({ model }: { model: OverviewModel }) {
  const { tiles, range } = model;
  const previousLabel = range.previousLabel;
  const attention: StatTile = {
    key: "attention",
    label: "Needs attention",
    value: formatCount(tiles.needsAttention),
    sub: tiles.needsAttention === 0 ? "Nothing is waiting on you" : plural(tiles.needsAttention, "thing", "things") + " to look at",
    tone: tiles.needsAttention > 0 ? "danger" : "neutral",
    href: "/reliability",
  };
  const main: StatTile[] = [
    {
      key: "signups",
      label: "Sign-ups",
      value: formatCount(tiles.signups.value),
      delta: { value: tiles.signups.value, previous: tiles.signups.previous, previousLabel },
      sparkline: <Sparkline label="Sign-ups per day" points={tiles.signups.series} />,
      href: "/signups",
    },
    {
      key: "people",
      label: "Active people",
      value: formatCount(tiles.activePeople.value),
      delta: { value: tiles.activePeople.value, previous: tiles.activePeople.previous, previousLabel },
      href: "/usage",
    },
    {
      key: "requests",
      label: "Agent requests",
      value: formatCount(tiles.agentRequests.value),
      sub: `${formatCount(tiles.agentRequests.failed)} refused or failed`,
      delta: { value: tiles.agentRequests.value, previous: tiles.agentRequests.previous, previousLabel },
      href: "/usage",
    },
    {
      key: "approvals",
      label: "Approvals decided",
      value: formatCount(tiles.approvalsDecided.value),
      sub: tiles.approvalsDecided.medianResponseMs == null ? "No replies yet" : `median reply ${formatDurationMs(tiles.approvalsDecided.medianResponseMs)}`,
      delta: { value: tiles.approvalsDecided.value, previous: tiles.approvalsDecided.previous, previousLabel },
      href: "/usage",
    },
  ];
  const ordered = tiles.needsAttention > 0 ? [attention, ...main] : [...main, attention];
  return (
    <div className="wh-page">
      <WorkspaceHeading
        title="Overview"
        description={`How Warthog is being used and where it needs attention. ${timeZoneNote(model.timeZone)}`}
        meta={`Showing ${range.label} · ${tiles.needsAttention === 0 ? "nothing needs attention" : plural(tiles.needsAttention, "item") + " need" + (tiles.needsAttention === 1 ? "s" : "") + " attention"}`}
        nav={<RangeTabs path="/" active={range.key} />}
        scope={false}
      />
      <StatTiles label="Headline numbers" tiles={ordered} />
      <div className="wh-dashboard-grid">
        <div className="wh-dashboard-column">
          <WorkspacePanel title="Needs attention" icon={ShieldAlert} description="Concrete problems, each linked to where to look." action={<a href="/reliability">Reliability</a>}>
            <AttentionList items={model.attention} empty="Nothing needs attention" />
          </WorkspacePanel>
          <WorkspacePanel title="Activation funnel" icon={Filter} description="How far accounts have got, all time. Each step links to the accounts stalled there.">
            <Funnel label="Activation funnel" steps={model.funnel} empty="No accounts yet. Share the sign-up link to get started." />
          </WorkspacePanel>
        </div>
        <div className="wh-dashboard-column">
          <WorkspacePanel title="Trends" icon={TrendingUp} description={`Per day over ${range.label}.`}>
            <TrendList
              timeZone={model.timeZone}
              trends={[
                { key: "signups", label: "Sign-ups", total: tiles.signups.value, points: model.trends.signups },
                { key: "people", label: "Active people", total: tiles.activePeople.value, points: model.trends.activePeople },
                { key: "requests", label: "Agent requests", total: tiles.agentRequests.value, points: model.trends.requests },
              ]}
            />
          </WorkspacePanel>
          <WorkspacePanel title="Top services" icon={Plug} description="Connected services by number of connections." action={<a href="/usage">Usage</a>}>
            <BarList label="Top services" marks="service" rows={model.topServices} empty="No services connected yet. They appear once someone connects Gmail, Calendar or another service." />
          </WorkspacePanel>
        </div>
      </div>
    </div>
  );
}
