import * as React from "react";

// Button — the shared action primitive, built on the design tokens (globals.css).
// Exactly one accent action per screen: use `primary` for it, `secondary` for
// everything else. Colour, radius and focus come from tokens, never raw values.

type ButtonVariant = "primary" | "secondary";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

// Shared across variants: a ≥44px touch target, a visible focus ring on the
// focus token, and a non-actionable disabled state (the native `disabled`
// attribute does the disabling; these classes only reflect it visually).
const base =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-card px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  // The one accent action: the solid accent fill.
  primary: "bg-accent text-accent-fg hover:bg-accent-hover",
  // Neutral surface button — no accent fill (the accent is reserved for primary).
  secondary: "border border-line bg-surface text-fg hover:bg-surface-muted",
};

export function Button({ variant = "primary", type, className, children, ...props }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={[base, variants[variant], className].filter(Boolean).join(" ")}
      {...props}
    >
      {children}
    </button>
  );
}
