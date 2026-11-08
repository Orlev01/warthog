import * as React from "react";

// Select — the shared native drop-down primitive, built on the design tokens
// (globals.css), matching the Input: a ≥44px touch target (WCAG 2.2 AA) via `min-h-11`,
// a visible focus ring, and colour/border from tokens — never a raw hex. `SELECT_CLASS`
// is exported for the screens that still compose a raw <select>.

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

export const SELECT_CLASS =
  "min-h-11 w-full rounded-card border border-line bg-surface px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg aria-invalid:border-danger";

export function Select({ className, children, ...props }: SelectProps) {
  return (
    <select className={[SELECT_CLASS, className].filter(Boolean).join(" ")} {...props}>
      {children}
    </select>
  );
}
