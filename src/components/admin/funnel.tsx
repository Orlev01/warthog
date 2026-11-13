import * as React from "react";
import { TrendingDown } from "lucide-react";

import { EmptyState } from "@/components/ui/empty";
import { formatCount, formatShare } from "@/domain/admin/format";
import type { FunnelStep } from "@/domain/admin/model";

// Funnel — milestones in order (docs/design/admin-portal.md §5): each step's count, how many
// went on from the step before in words ("83% went on", "5 of 6 went on" under ten), a bar
// proportional to the first step, and the biggest drop named in words with an icon. Steps
// may link to the accounts stalled there.

export function biggestDropIndex(steps: readonly FunnelStep[]): number | null {
  let index: number | null = null;
  let largest = 0;
  for (let i = 1; i < steps.length; i++) {
    const drop = steps[i - 1]!.count - steps[i]!.count;
    if (drop > largest) {
      largest = drop;
      index = i;
    }
  }
  return index;
}

export function Funnel({ steps, label, empty }: { steps: readonly FunnelStep[]; label: string; empty: string }) {
  if (steps.length === 0 || steps[0]!.count === 0) return <EmptyState variant="inline" heading={empty} />;
  const first = steps[0]!.count;
  const drop = biggestDropIndex(steps);
  return (
    <ol className="wh-funnel" aria-label={label}>
      {steps.map((step, i) => {
        const previous = i > 0 ? steps[i - 1]!.count : null;
        const width = Math.max(0, Math.min(100, (step.count / first) * 100));
        const name = step.href ? <a href={step.href} className="underline underline-offset-4">{step.label}</a> : <span>{step.label}</span>;
        return (
          <li key={step.key} className="wh-funnel-step" data-drop={drop === i ? "" : undefined}>
            <span className="wh-funnel-head">
              <span className="wh-funnel-label">{name}</span>
              <span className="wh-funnel-count">{formatCount(step.count)}</span>
            </span>
            <span className="wh-bar-track" aria-hidden={true}>
              <span className="wh-bar-fill" style={{ width: `${width}%` }} />
            </span>
            {previous !== null ? (
              <span className="wh-funnel-conversion">
                {previous > 0 ? `${formatShare(step.count, previous)} went on` : "nothing to go on from"}
                {drop === i ? (
                  <span className="wh-funnel-drop wh-tone-warning">
                    <TrendingDown aria-hidden={true} className="wh-tone-icon h-3.5 w-3.5 shrink-0" />
                    biggest drop
                  </span>
                ) : null}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
