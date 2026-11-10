import * as React from "react";

import { Input, type InputProps } from "./input";

// Field, Label — the accessible form-control composition (WCAG 2.2 AA), built
// on the design tokens (globals.css). The Field associates its Label and its
// error message with the Input itself: the Label's `for` matches the Input's
// `id` (generated when the caller gives none), and the error message's id is
// threaded through the Input's aria-describedby. An error is conveyed by text
// plus aria-invalid — never by colour alone.

export type LabelProps = React.LabelHTMLAttributes<HTMLLabelElement>;

export function Label({ className, children, ...props }: LabelProps) {
  return (
    <label className={["text-sm font-medium text-fg", className].filter(Boolean).join(" ")} {...props}>
      {children}
    </label>
  );
}

export type FieldProps = InputProps & {
  label: React.ReactNode;
  error?: string;
};

export function Field({ label, error, id, "aria-describedby": describedBy, "aria-invalid": invalid, ...inputProps }: FieldProps) {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const hasError = Boolean(error);
  const descriptionIds = [...new Set([...(describedBy?.split(/\s+/).filter(Boolean) ?? []), ...(hasError ? [errorId] : [])])];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <Input
        id={inputId}
        aria-invalid={hasError ? true : invalid}
        aria-describedby={descriptionIds.join(" ") || undefined}
        {...inputProps}
      />
      {hasError ? (
        <p id={errorId} className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
