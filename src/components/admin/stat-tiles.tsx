import * as React from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

import { describeDelta } from "@/domain/admin/format";
import type { Tone } from "@/domain/admin/model";

// StatTiles — the headline numbers of an admin page (docs/design/admin-portal.md §5): a row
// of raised tiles, each one label, one value and, in words, how it moved against the previous
// window (icon plus text, never colour alone). A tile may carry a sparkline and may be a link
// to its detail page. Two-up on phones, up to five-up on desktop (the portal stylesheet). Values arrive
// computed; this renders them.

export type StatTile = {
  key: string;
  label: string;
  value: string;
  sub?: string;
  delta?: { value: number; previous: number | null; previousLabel: string; goodWhen?: "up" | "down" };
  // A tone for the whole tile when the number itself carries meaning (Needs attention > 0).
  tone?: Tone;
  sparkline?: React.ReactNode;
  href?: string;
};

const ICONS = { up: ArrowUpRight, down: ArrowDownRight, flat: Minus, none: Minus } as const;

function Tile({ tile }: { tile: StatTile }) {
  const delta = tile.delta ? describeDelta(tile.delta.value, tile.delta.previous, tile.delta.previousLabel, tile.delta.goodWhen) : null;
  const DeltaIcon = delta ? ICONS[delta.direction] : null;
  const body = (
    <>
      <span className="wh-stat-label">{tile.label}</span>
      <span className="wh-stat-value">{tile.value}</span>
      {tile.sub ? <span className="wh-stat-sub">{tile.sub}</span> : null}
      {delta && DeltaIcon ? (
        <span className={`wh-stat-delta wh-tone-${delta.tone}`}>
          <DeltaIcon aria-hidden={true} className="wh-tone-icon h-4 w-4 shrink-0" />
          <span>{delta.text}</span>
        </span>
      ) : null}
      {tile.sparkline ? <span className="wh-stat-spark">{tile.sparkline}</span> : null}
    </>
  );
  return (
    <li className="wh-stat-tile wh-surface" data-tone={tile.tone ?? undefined}>
      {tile.href ? <a href={tile.href} className="wh-stat-tile-link">{body}</a> : <div className="wh-stat-tile-body">{body}</div>}
    </li>
  );
}

export function StatTiles({ tiles, label }: { tiles: readonly StatTile[]; label: string }) {
  return (
    <ul className="wh-stat-tiles" aria-label={label}>
      {tiles.map((tile) => <Tile key={tile.key} tile={tile} />)}
    </ul>
  );
}
