"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./button";

type FormAction = (data: FormData) => void | Promise<void>;

export function createFormSubmissionGuard() {
  let reserved = false;
  let running = false;
  return {
    reserve(): boolean {
      if (reserved) return false;
      reserved = true;
      return true;
    },
    async run(action: FormAction, data: FormData): Promise<void> {
      if (running) return;
      reserved = true;
      running = true;
      try {
        await action(data);
      } finally {
        // Redirects are framework control flow and must propagate unchanged.
        running = false;
        reserved = false;
      }
    },
  };
}

export function ActionForm({ action, onSubmit, ...props }: Omit<React.ComponentProps<"form">, "action"> & { action: FormAction }) {
  const guardRef = React.useRef<ReturnType<typeof createFormSubmissionGuard> | null>(null);
  if (!guardRef.current) guardRef.current = createFormSubmissionGuard();
  const guard = guardRef.current;
  return <form {...props} onSubmit={(event) => {
    onSubmit?.(event);
    if (!event.defaultPrevented && !guard.reserve()) event.preventDefault();
  }} action={(data) => guard.run(action, data)} />;
}

// The submitted FormData has already been captured before these fields freeze.
// Keep the initiating submit button outside so it can retain keyboard focus.
export function PendingFormFields({ children, pendingLabel }: { children: React.ReactNode; pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return <>
    <fieldset disabled={pending} className="contents">{children}</fieldset>
    {pending && pendingLabel ? <p role="status" className="text-sm text-fg-muted">{pendingLabel}</p> : null}
  </>;
}

export function FormSubmit({
  children,
  pendingLabel,
  variant = "primary",
  preserveFocus = false,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  variant?: ButtonProps["variant"];
  preserveFocus?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      variant={variant}
      disabled={pending && !preserveFocus}
      aria-disabled={pending && preserveFocus ? true : undefined}
      className={preserveFocus ? "aria-disabled:opacity-50" : undefined}
      onClick={(event) => { if (pending) event.preventDefault(); }}
      aria-busy={pending}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}
