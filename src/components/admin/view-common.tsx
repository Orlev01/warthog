import * as React from "react";
import { AlertTriangle, CheckCircle2, CircleAlert } from "lucide-react";

import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty";
import { PageNotice } from "@/components/ui/notice";
import { formatCount, formatWhen } from "@/domain/admin/format";
import type { AttentionItem, SeriesPoint, SweepRow } from "@/domain/admin/model";
import { Sparkline } from "./sparkline";

// Pieces several admin views share (docs/design/admin-portal.md §5): a labelled trend row,
// the "needs attention" list, the sweep table in a labelled scroll region, and the bounded
// error screen a page shows when its numbers could not be loaded.

export function TrendList({ trends, timeZone }: { trends: readonly { key: string; label: string; total: number; points: readonly SeriesPoint[] }[]; timeZone: string }) {
  return (
    <ul className="wh-trend-list">
      {trends.map((trend) => (
        <li key={trend.key} className="wh-trend">
          <span className="wh-trend-head">
            <span>{trend.label}</span>
            <strong>{formatCount(trend.total)}</strong>
          </span>
          <Sparkline label={trend.label} points={trend.points} height={56} timeZone={timeZone} />
        </li>
      ))}
    </ul>
  );
}

export function AttentionList({ items, empty }: { items: readonly AttentionItem[]; empty: string }) {
  if (items.length === 0) return <EmptyState variant="inline" icon={CheckCircle2} heading={empty} />;
  return (
    <ul role="list" className="wh-list-group-rows">
      {items.map((item) => {
        const Icon = item.tone === "danger" ? CircleAlert : AlertTriangle;
        return (
          <li key={item.id} className={`wh-attention-row border-b border-line py-2 last:border-0 wh-tone-${item.tone}`}>
            <Icon aria-hidden={true} className="wh-tone-icon h-4 w-4" />
            <a href={item.href}>{item.text}</a>
          </li>
        );
      })}
    </ul>
  );
}

export function SweepTable({ sweeps, timeZone, now }: { sweeps: readonly SweepRow[]; timeZone: string; now: Date }) {
  if (sweeps.length === 0) return <EmptyState variant="inline" heading="No sweeps have run yet." description="The scheduler records each sweep the first time it runs." />;
  return (
    <div role="region" aria-label="Background sweeps" tabIndex={0} className="wh-admin-table-region">
      <table className="wh-admin-table">
        <caption>Each sweep's interval and when it last ran; overdue means more than twice its interval has passed.</caption>
        <thead>
          <tr>
            <th scope="col">Sweep</th>
            <th scope="col" data-numeric="">Every</th>
            <th scope="col">Last ran</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {sweeps.map((sweep) => (
            <tr key={sweep.name}>
              <td>{sweep.name}</td>
              <td data-numeric="">{intervalLabel(sweep.intervalMs)}</td>
              <td>{formatWhen(sweep.lastRunAt, timeZone, now, "Not yet")}</td>
              <td>{sweep.overdue ? <Badge tone="warning" icon={AlertTriangle}>Overdue</Badge> : <Badge tone="success" icon={CheckCircle2}>On time</Badge>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function intervalLabel(ms: number): string {
  if (ms >= 24 * 60 * 60_000) return `${Math.round(ms / (24 * 60 * 60_000))} day${ms >= 2 * 24 * 60 * 60_000 ? "s" : ""}`;
  if (ms >= 60 * 60_000) return `${Math.round(ms / (60 * 60_000))} h`;
  return `${Math.round(ms / 60_000)} min`;
}

/** What a page shows when its loader failed: a bounded heading and one plain notice. */
export function AdminPageError({ title, description }: { title: string; description: string }) {
  return (
    <div className="wh-page">
      <WorkspaceHeading title={title} description={description} scope={false} />
      <PageNotice tone="error" clearParams={[]}>Some numbers couldn&#39;t be loaded. Refresh to try again.</PageNotice>
    </div>
  );
}

export { WorkspacePanel };
