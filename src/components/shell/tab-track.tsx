"use client";
import * as React from "react";
import { revealCurrent, useScrollEdges } from "./scroll-edges";

// A horizontally scrolling row of tabs, sub-tabs or pills. It renders server-side as plain
// markup (links stay links and work before hydration); once hydrated it keeps the current
// item in view and shows an edge fade while more items are hidden. `current` is any value
// that changes when the selection changes (an href or a tab key), so a client navigation or
// Back/Forward re-reveals the new selection.
export function TabTrack({
  as: Tag = "div",
  current,
  className,
  children,
  ...props
}: {
  as?: "div" | "nav";
  current?: string;
  className?: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, "className" | "children">) {
  const ref = React.useRef<HTMLElement>(null);
  useScrollEdges(ref, "x");
  React.useEffect(() => {
    if (ref.current) revealCurrent(ref.current);
  }, [current]);
  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement & HTMLElement>}
      {...props}
      className={className}
    >
      {children}
    </Tag>
  );
}
