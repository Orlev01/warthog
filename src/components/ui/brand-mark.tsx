import * as React from "react";

import { agentBrand, brandInitial, serviceBrand, type BrandMarkRef } from "@/domain/brands";

// A service's or agent's own mark on a fixed light tile (docs/adr/brand-marks-and-accent.md),
// or a neutral initial when the brand has no mark. Decorative: the visible name beside it is
// the accessible name, so the image carries an empty alt. Plain <img> of a same-origin static
// SVG — no inline colour, no script, no layout shift (fixed size).

type Size = "xs" | "sm" | "md" | "lg";

function Tile({ mark, name, size }: { mark?: BrandMarkRef; name: string; size: Size }) {
  if (!mark) {
    return (
      <span aria-hidden={true} data-size={size} className="wh-brand-tile wh-brand-initial">
        {brandInitial(name)}
      </span>
    );
  }
  return (
    <span aria-hidden={true} data-size={size} className="wh-brand-tile" data-brand={mark.title}>
      <img src={mark.src} alt="" width={24} height={24} decoding="async" loading="lazy" />
    </span>
  );
}

export function ServiceMark({ id, name, size = "md" }: { id?: string; name: string; size?: Size }) {
  return <Tile mark={serviceBrand(id)} name={name} size={size} />;
}

export function AgentMark({ platform, name, size = "md" }: { platform?: string; name: string; size?: Size }) {
  return <Tile mark={agentBrand(platform, name)} name={name} size={size} />;
}
