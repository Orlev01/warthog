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

export function Field({ label, error, id, ...inputProps }: FieldProps) {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  const hasError = Boolean(error);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>{label}</Label>
      <Input
        id={inputId}
        aria-invalid={hasError ? true : undefined}
        aria-describedby={hasError ? errorId : undefined}
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
