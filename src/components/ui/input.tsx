import * as React from "react";

// Input — the shared text-field primitive, built on the design tokens
// (globals.css). A ≥44px touch target (WCAG 2.2 AA) via `min-h-11` (2.75rem), a
// border on the form-control token (≥3:1, WCAG 1.4.11 — never the faint divider line),
// with colour, border and focus coming from tokens — never a raw hex. A Field
// threads id / aria-describedby / aria-invalid through it to associate a Label
// and an error message, so the Input forwards every standard input attribute.

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

const base =
  "min-h-11 w-full rounded-card border border-line-input bg-surface px-3 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg aria-invalid:border-danger";

export function Input({ className, ...props }: InputProps) {
  return <input className={[base, className].filter(Boolean).join(" ")} {...props} />;
}
