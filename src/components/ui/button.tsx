import * as React from "react";

// Button — the shared action primitive, built on the design tokens (globals.css). Every
// action shape in the product comes from `buttonClasses()`: native <button>s via Button,
// links via ButtonLink (button-link.tsx), and <summary>/<a> elements that only need the
// look. Colour, radius and focus come from tokens, never raw values.
//
// Variants — exactly one `primary` per task:
//   • primary      the one accent action (Save, Continue, Approve).
//   • secondary    every other action: a neutral bordered pill.
//   • ghost        a low-emphasis action with no border (Cancel, Dismiss, Show more).
//   • danger       the entry point to something destructive or irreversible (Remove,
//                  Disconnect, Delete…): danger text and border, no fill.
//   • danger-solid the final confirm of a destructive step, after the person has seen
//                  what will happen. Never the first thing on a page.
//
// Sizes — every size keeps a 44px target below 1024px and on touch screens:
//   • md (default) 44px everywhere.
//   • sm           44px on phones and touch; 36px on a desktop with a mouse, for dense rows.
//   • lg           48px, for account entry and the public pages.
//
// Width — `auto` (default) is the button's natural width. In the signed-in workspace a
// Button never stretches across a column from 640px up (controls.css), even inside a
// flex column; `full` fills its container, `phone-full` fills it only below 640px.

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger-solid";
export type ButtonSize = "sm" | "md" | "lg";
export type ButtonWidth = "auto" | "full" | "phone-full";

export type ButtonStyleOptions = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  width?: ButtonWidth;
  className?: string;
};

// Shared across variants: the pill, a single focus outline on the focus token (the same
// outline the global :focus-visible rule draws, so it is never doubled) and a dimmed,
// non-actionable disabled look. Native `disabled` and `aria-disabled` look the same; the
// attribute itself does the disabling.
const base =
  "wh-button inline-flex items-center justify-center gap-2 rounded-full border text-center text-sm font-medium transition-[color,background-color,border-color] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  // The accent fill. Its border is transparent, so forced-colours themes (which drop
  // backgrounds) still paint a ButtonText boundary around the screen's main action.
  primary: "border-transparent bg-accent text-accent-fg hover:bg-accent-hover",
  // Neutral surface pill. A pressed toggle (aria-pressed) reads as selected: a strong
  // border, the muted fill and a heavier label, not colour alone.
  secondary:
    "border-line bg-surface text-fg hover:bg-surface-muted aria-pressed:border-fg aria-pressed:bg-surface-muted aria-pressed:font-semibold",
  ghost: "border-transparent bg-transparent text-fg hover:bg-surface-muted aria-pressed:bg-surface-muted aria-pressed:font-semibold",
  danger: "border-danger/50 bg-surface text-danger hover:border-danger hover:bg-danger/10",
  // accent-fg is white on the light danger red and near-black on the dark theme's pink,
  // so the label clears 4.5:1 in both.
  "danger-solid": "border-transparent bg-danger text-accent-fg hover:bg-danger/90",
};

const sizes: Record<ButtonSize, string> = {
  sm: "min-h-11 px-3 lg:pointer-fine:min-h-9",
  md: "min-h-11 px-4",
  lg: "min-h-12 px-5",
};

const widths: Record<ButtonWidth, string | undefined> = {
  auto: undefined,
  full: "w-full",
  "phone-full": "w-full sm:w-auto",
};

/** The class string for anything that should look like a Button (links, summaries). */
export function buttonClasses({ variant = "primary", size = "md", width = "auto", className }: ButtonStyleOptions = {}): string {
  return [base, variants[variant], sizes[size], widths[width], className].filter(Boolean).join(" ");
}

/** Marks an element's width as chosen by its caller, so the workspace's natural-width
 * default (controls.css) leaves it alone. */
export function buttonWidthAttribute(width: ButtonWidth = "auto"): { "data-width"?: ButtonWidth } {
  return width === "auto" ? {} : { "data-width": width };
}

export type ButtonProps = React.ComponentPropsWithRef<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  width?: ButtonWidth;
};

export function Button({ variant = "primary", size = "md", width = "auto", type, className, children, ...props }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={buttonClasses({ variant, size, width, className })}
      {...buttonWidthAttribute(width)}
      {...props}
    >
      {children}
    </button>
  );
}
