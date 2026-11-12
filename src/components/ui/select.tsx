import * as React from "react";

import { CONTROL_TEXT, fieldWidthClass, type FieldWidth } from "./input";

// Select — the shared native drop-down primitive, built on the design tokens
// (globals.css), matching the Input: a ≥44px touch target (WCAG 2.2 AA) via `min-h-11`,
// the single focus outline, 16px text on phones and touch screens (no zoom on focus), and
// colour/border from tokens — never a raw hex. `SELECT_CLASS` is exported for the screens
// that still compose a raw <select>. `width="short"` suits a short list of options.

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  width?: FieldWidth;
};

export const SELECT_CLASS = `min-h-11 min-w-0 w-full max-w-full rounded-field border border-line-input bg-surface px-3 text-fg disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${CONTROL_TEXT}`;

export function Select({ className, width = "full", children, ...props }: SelectProps) {
  return (
    <select className={[SELECT_CLASS, fieldWidthClass(width), className].filter(Boolean).join(" ")} {...props}>
      {children}
    </select>
  );
}
