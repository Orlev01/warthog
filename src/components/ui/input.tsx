import * as React from "react";

// Input, Textarea — the shared text-field primitives, built on the design tokens
// (globals.css). A ≥44px touch target (WCAG 2.2 AA) via `min-h-11` (2.75rem), a border on
// the form-control token (≥3:1, WCAG 1.4.11 — never the faint divider line), with colour,
// border and focus coming from tokens — never a raw hex. A Field threads id /
// aria-describedby / aria-invalid through it to associate a Label and an error message, so
// these forward every standard attribute (including autoComplete and inputMode).
//
// Text size: 16px on phones, tablets, landscape phones and any touch screen, so iOS never
// zooms the page when a field takes focus; 14px only on a desktop-width screen with a mouse.
// Never switch it at `sm:` (640px) — a phone held sideways is wider than that.
//
// Width: fields fill their column by default (`full`). Give short values a short field so
// the label and the value stay together on wide screens; every width is full on phones.
//   • text  — names, emails, titles (448px).
//   • short — dates, amounts, numbers, short selects (192px).
//   • code  — one-time codes, two- or three-digit values (128px).

export type FieldWidth = "full" | "text" | "short" | "code";

/** The text-size rule every text control shares (inputs, selects, textareas). */
export const CONTROL_TEXT = "text-base lg:pointer-fine:text-sm";

// The single focus outline (the same one the global :focus-visible rule draws).
const CONTROL_FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

const CONTROL_BASE = `min-w-0 w-full max-w-full rounded-field border border-line-input bg-surface px-3 text-fg placeholder:text-fg-muted disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger ${CONTROL_TEXT} ${CONTROL_FOCUS}`;

const FIELD_WIDTHS: Record<FieldWidth, string | undefined> = {
  full: undefined,
  text: "sm:max-w-md",
  short: "sm:max-w-48",
  code: "sm:max-w-32",
};

/** The width class for a control (and its Field) at the given width. */
export function fieldWidthClass(width: FieldWidth = "full"): string | undefined {
  return FIELD_WIDTHS[width];
}

/** Class string for a single-line text control. Exported for screens that must compose a raw <input>. */
export const INPUT_CLASS = `min-h-11 ${CONTROL_BASE}`;

/** Class string for a multi-line text control. Exported for screens that must compose a raw <textarea>. */
export const TEXTAREA_CLASS = `min-h-24 py-2 leading-normal ${CONTROL_BASE}`;

export type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "width"> & {
  width?: FieldWidth;
};

export function Input({ className, width = "full", ...props }: InputProps) {
  return <input className={[INPUT_CLASS, fieldWidthClass(width), className].filter(Boolean).join(" ")} {...props} />;
}

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  width?: FieldWidth;
};

export function Textarea({ className, width = "full", rows = 3, ...props }: TextareaProps) {
  return <textarea rows={rows} className={[TEXTAREA_CLASS, fieldWidthClass(width), className].filter(Boolean).join(" ")} {...props} />;
}
