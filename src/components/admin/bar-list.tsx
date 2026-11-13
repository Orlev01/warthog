import * as React from "react";

import { AgentMark, ServiceMark } from "@/components/ui/brand-mark";
import { EmptyState } from "@/components/ui/empty";
import { formatCount } from "@/domain/admin/format";
import type { BreakdownRow } from "@/domain/admin/model";

// BarList — a top-N breakdown (docs/design/admin-portal.md §5): each row a label (with the
// service's or platform's own mark when it has one), its count in tabular figures, and a
// proportional bar that is decorative — the count carries the meaning. Bars take the accent;
// only a row that IS a failure category takes the danger tone. The empty state names what
// would appear.

export function BarList({
  rows,
  label,
  marks = "none",
  empty,
  max,
}: {
  rows: readonly BreakdownRow[];
  label: string;
  // Which mark a row's `brand` names: a connected service, an agent platform, or none.
  marks?: "service" | "agent" | "none";
  empty: string;
  // The value a full bar means; defaults to the largest row.
  max?: number;
}) {
  if (rows.length === 0) return <EmptyState variant="inline" heading={empty} />;
  const full = Math.max(max ?? 0, ...rows.map((r) => r.value), 1);
  return (
    <ol className="wh-bar-list" aria-label={label}>
      {rows.map((row) => {
        const width = Math.max(0, Math.min(100, (row.value / full) * 100));
        const name = row.href ? <a href={row.href} className="underline underline-offset-4">{row.label}</a> : <span>{row.label}</span>;
        return (
          <li key={row.key} className="wh-bar-row" data-tone={row.tone ?? undefined}>
            <span className="wh-bar-label">
              {marks === "service" ? <ServiceMark id={row.brand} name={row.label} size="xs" /> : null}
              {marks === "agent" ? <AgentMark platform={row.brand} name={row.label} size="xs" /> : null}
              {name}
            </span>
            <span className="wh-bar-count">{formatCount(row.value)}</span>
            <span className="wh-bar-track" aria-hidden={true}>
              <span className="wh-bar-fill" style={{ width: `${width}%` }} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}
