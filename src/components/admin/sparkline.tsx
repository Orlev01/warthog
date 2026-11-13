import * as React from "react";

import { formatBucket, formatCount } from "@/domain/admin/format";
import type { SeriesPoint } from "@/domain/admin/model";

// Sparkline — one series as an inline SVG line with a soft fill (docs/design/admin-portal.md §5).
// It is an image to assistive technology (`role="img"` with a summary that gives the range and
// the latest value, plus a <title>), drawn in `currentColor` on a wrapper in the workspace
// accent so it follows both themes and forced colours; no library, no animation. Longer
// series also carry a visually hidden table so every value is reachable. Points arrive
// bucketed and zero-filled; this never reaches for a clock.

const WIDTH = 120;

export function Sparkline({
  points,
  label,
  height = 32,
  timeZone,
}: {
  points: readonly SeriesPoint[];
  label: string;
  height?: 32 | 56;
  // When given, the hidden table names each bucket in this zone; otherwise by its instant.
  timeZone?: string;
}) {
  const values = points.map((p) => p.value);
  const max = values.length ? Math.max(...values) : 0;
  const min = values.length ? Math.min(...values) : 0;
  const span = Math.max(max - min, 1);
  const step = values.length > 1 ? WIDTH / (values.length - 1) : 0;
  const coords = values.map((v, i) => [values.length > 1 ? i * step : WIDTH / 2, height - 2 - ((v - min) / span) * (height - 4)] as const);
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = coords.length ? `${line} L${coords[coords.length - 1]![0].toFixed(1)} ${height} L${coords[0]![0].toFixed(1)} ${height} Z` : "";
  const latest = values.length ? values[values.length - 1]! : 0;
  const summary = values.length
    ? `${label}: ${formatCount(min)} to ${formatCount(max)}, latest ${formatCount(latest)}`
    : `${label}: no data yet`;
  const last = coords[coords.length - 1];
  return (
    <span className="wh-sparkline text-tint" data-height={height}>
      <svg role="img" aria-label={summary} viewBox={`0 0 ${WIDTH} ${height}`} preserveAspectRatio="none" focusable="false">
        <title>{summary}</title>
        {area ? <path d={area} fill="currentColor" fillOpacity={0.1} stroke="none" /> : null}
        {line ? <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" /> : null}
        {last ? <circle cx={last[0]} cy={last[1]} r={2} fill="currentColor" vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      {points.length > 7 ? (
        <table className="sr-only">
          <caption>{label}</caption>
          <thead><tr><th scope="col">When</th><th scope="col">Value</th></tr></thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.at}><td>{timeZone ? formatBucket(p.at, timeZone) : p.at}</td><td>{formatCount(p.value)}</td></tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </span>
  );
}
