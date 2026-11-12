import * as React from "react";

import { Input, Textarea, type FieldWidth, type InputProps, type TextareaProps } from "./input";
import { Select, type SelectProps } from "./select";

// Field, Label — the accessible form-control composition (WCAG 2.2 AA), built
// on the design tokens (globals.css). The Field associates its Label, optional hint and
// error message with the control itself: the Label's `for` matches the control's
// `id` (generated when the caller gives none), and the hint and error ids are threaded
// through the control's aria-describedby. An error is conveyed by text plus
// aria-invalid — never by colour alone.
//
// `className` styles the Field's wrapper (so `sm:flex-1` lets a field grow in a row);
// `inputClassName` reaches the control itself. `width` sizes the control (see input.tsx),
// so its label can still sit on one line above a short field.
// TextareaField and SelectField are the same composition around a Textarea or Select.

export type LabelProps = React.LabelHTMLAttributes<HTMLLabelElement>;

export function Label({ className, children, ...props }: LabelProps) {
  return (
    <label className={["text-sm font-medium text-fg", className].filter(Boolean).join(" ")} {...props}>
      {children}
    </label>
  );
}

type FieldFrameProps = {
  label: React.ReactNode;
  // Short help shown under the label and read with the control.
  hint?: React.ReactNode;
  error?: string;
  width?: FieldWidth;
  // Applied to the wrapper, never the control.
  className?: string;
};

type ControlWiring = {
  id: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
  "aria-describedby"?: string;
};

function FieldFrame({
  label,
  hint,
  error,
  width,
  className,
  id,
  describedBy,
  invalid,
  control,
}: FieldFrameProps & {
  id?: string;
  describedBy?: string;
  invalid?: React.AriaAttributes["aria-invalid"];
  control: (wiring: ControlWiring & { width?: FieldWidth }) => React.ReactNode;
}) {
  const generatedId = React.useId();
  const controlId = id ?? generatedId;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const hasError = Boolean(error);
  const descriptionIds = [
    ...new Set([
      ...(describedBy?.split(/\s+/).filter(Boolean) ?? []),
      ...(hint ? [hintId] : []),
      ...(hasError ? [errorId] : []),
    ]),
  ];
  return (
    <div className={["flex min-w-0 flex-col gap-2", className].filter(Boolean).join(" ")}>
      <Label htmlFor={controlId}>{label}</Label>
      {hint ? (
        <p id={hintId} className="-mt-1 text-sm text-fg-muted">
          {hint}
        </p>
      ) : null}
      {control({
        width,
        id: controlId,
        "aria-invalid": hasError ? true : invalid,
        "aria-describedby": descriptionIds.join(" ") || undefined,
      })}
      {hasError ? (
        <p id={errorId} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export type FieldProps = Omit<InputProps, "className"> &
  FieldFrameProps & {
    inputClassName?: string;
  };

export function Field({
  label,
  hint,
  error,
  width,
  className,
  inputClassName,
  id,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  ...inputProps
}: FieldProps) {
  return (
    <FieldFrame
      label={label}
      hint={hint}
      error={error}
      width={width}
      className={className}
      id={id}
      describedBy={describedBy}
      invalid={invalid}
      control={(wiring) => <Input className={inputClassName} {...inputProps} {...wiring} />}
    />
  );
}

export type TextareaFieldProps = Omit<TextareaProps, "className"> &
  FieldFrameProps & {
    inputClassName?: string;
  };

export function TextareaField({
  label,
  hint,
  error,
  width,
  className,
  inputClassName,
  id,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  ...textareaProps
}: TextareaFieldProps) {
  return (
    <FieldFrame
      label={label}
      hint={hint}
      error={error}
      width={width}
      className={className}
      id={id}
      describedBy={describedBy}
      invalid={invalid}
      control={(wiring) => <Textarea className={inputClassName} {...textareaProps} {...wiring} />}
    />
  );
}

export type SelectFieldProps = Omit<SelectProps, "className"> &
  FieldFrameProps & {
    inputClassName?: string;
  };

export function SelectField({
  label,
  hint,
  error,
  width,
  className,
  inputClassName,
  id,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  children,
  ...selectProps
}: SelectFieldProps) {
  return (
    <FieldFrame
      label={label}
      hint={hint}
      error={error}
      width={width}
      className={className}
      id={id}
      describedBy={describedBy}
      invalid={invalid}
      control={(wiring) => (
        <Select className={inputClassName} {...selectProps} {...wiring}>
          {children}
        </Select>
      )}
    />
  );
}
