import * as React from "react";

// Skeleton — a placeholder shimmer block shown while content loads, built on the
// design tokens (globals.css). It announces itself to assistive tech with
// role="status" + aria-busy (WCAG 2.2 AA — a loading state must be perceivable to
// a screen reader, not animation/colour alone). The caller sizes it via
// `className`. Colour comes from tokens, never raw hex.

export type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      role="status"
      aria-busy={true}
      className={["animate-pulse rounded-card bg-surface-muted", className].filter(Boolean).join(" ")}
      {...props}
    />
  );
}
