"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { LoaderCircle } from "lucide-react";

import { Button, type ButtonProps } from "./button";
import { rememberSubmitFocus, restoreSubmitFocus } from "./form-focus";

// The guarded submit pattern for every server-action form (docs: $AUDIT/fixes/API-F2.md):
//
//   <ActionForm action={saveAction} className="flex flex-col gap-3">
//     <PendingFormFields>…fields…</PendingFormFields>
//     <FormSubmit pendingLabel="Saving…">Save</FormSubmit>
//   </ActionForm>
//
// • ActionForm accepts exactly one submission at a time: a second click, Enter or
//   requestSubmit() while the first is running is dropped before React queues it, so a
//   double or triple click creates one record. The action itself is passed straight to
//   <form action>, so a server action still works before the page has hydrated.
// • FormSubmit shows its pending label while its form is submitting and ignores further
//   clicks. It is never `disabled` while pending (aria-disabled + aria-busy instead), so
//   the keyboard focus stays on it rather than falling back to the top of the page.
// • PendingFormFields freezes the fields for the same reason without disabling them: they
//   stay focusable but ignore input until the save has finished.
// • After the save, when the page re-renders the same form (a redirect to `?notice=saved`
//   remounts it), focus returns to the field or button that had it (form-focus.ts).

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
    // Ends a reservation once the submission it covered has settled.
    release(): void {
      if (!running) reserved = false;
    },
    isReserved: (): boolean => reserved,
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

type FormGuard = ReturnType<typeof createFormSubmissionGuard>;

// Lives inside the <form> so it can read that form's status. When a submission settles
// (pending true → false, including after the refreshed page has rendered), the guard
// accepts the next deliberate submission.
function SubmissionWatcher({ guard, pendingRef, formRef }: { guard: FormGuard; pendingRef: React.RefObject<boolean>; formRef: React.RefObject<HTMLFormElement | null> }) {
  const { pending } = useFormStatus();
  React.useEffect(() => {
    pendingRef.current = pending;
    if (pending) return;
    guard.release();
    if (formRef.current) restoreSubmitFocus(formRef.current);
  }, [guard, pending, pendingRef, formRef]);
  return null;
}

export type ActionFormProps = Omit<React.ComponentProps<"form">, "action"> & { action: FormAction };

export function ActionForm({ action, onSubmit, children, ref, ...props }: ActionFormProps) {
  const guardRef = React.useRef<FormGuard | null>(null);
  if (!guardRef.current) guardRef.current = createFormSubmissionGuard();
  const guard = guardRef.current;
  const pendingRef = React.useRef(false);
  const formRef = React.useRef<HTMLFormElement | null>(null);
  return (
    <form
      {...props}
      ref={(node) => {
        formRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      action={action}
      onSubmit={(event) => {
        onSubmit?.(event);
        if (event.defaultPrevented) return;
        if (!guard.reserve()) {
          event.preventDefault();
          return;
        }
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        rememberSubmitFocus(event.currentTarget, submitter instanceof HTMLElement ? submitter : null);
        // If nothing started (another handler cancelled the submission), don't leave
        // the form locked.
        window.setTimeout(() => {
          if (!pendingRef.current) guard.release();
        }, 1000);
      }}
    >
      {children}
      <SubmissionWatcher guard={guard} pendingRef={pendingRef} formRef={formRef} />
    </form>
  );
}

// The submitted FormData has already been captured, so the fields only need to ignore
// input until the save finishes. They are not disabled: disabling the focused field would
// throw keyboard focus back to the top of the page.
export function PendingFormFields({ children, pendingLabel }: { children: React.ReactNode; pendingLabel?: string }) {
  const { pending } = useFormStatus();
  const ref = React.useRef<HTMLFieldSetElement>(null);
  const pendingRef = React.useRef(pending);
  React.useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  React.useEffect(() => {
    const fieldset = ref.current;
    if (!fieldset) return;
    const block = (event: Event) => {
      if (pendingRef.current) event.preventDefault();
    };
    // Typing, pasting and deleting in text fields; checkbox, radio and button activation.
    fieldset.addEventListener("beforeinput", block);
    fieldset.addEventListener("click", block, true);
    return () => {
      fieldset.removeEventListener("beforeinput", block);
      fieldset.removeEventListener("click", block, true);
    };
  }, []);
  return <>
    <fieldset
      ref={ref}
      className="wh-pending-fields contents"
      aria-busy={pending || undefined}
      aria-disabled={pending || undefined}
    >
      {children}
    </fieldset>
    {pending && pendingLabel ? <p role="status" className="text-sm text-fg-muted">{pendingLabel}</p> : null}
  </>;
}

export type FormSubmitProps = Omit<ButtonProps, "type" | "children"> & {
  children: React.ReactNode;
  // What the button says while its form is saving ("Saving…", "Deleting rule…").
  pendingLabel: string;
  /** @deprecated Focus is always preserved now; the prop is accepted and ignored. */
  preserveFocus?: boolean;
};

export function FormSubmit({
  children,
  pendingLabel,
  variant = "primary",
  preserveFocus: _preserveFocus,
  onClick,
  name,
  value,
  className,
  ref,
  "aria-disabled": ariaDisabled,
  ...props
}: FormSubmitProps) {
  const { pending, data } = useFormStatus();
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);
  // Also in a plain <form action={…}>: remember focus as the form submits, and put it back
  // when the re-rendered form mounts or the save settles.
  React.useEffect(() => {
    const form = buttonRef.current?.form;
    if (!form) return;
    const remember = (event: SubmitEvent) => rememberSubmitFocus(form, event.submitter instanceof HTMLElement ? event.submitter : null);
    form.addEventListener("submit", remember);
    restoreSubmitFocus(form);
    return () => form.removeEventListener("submit", remember);
  }, []);
  React.useEffect(() => {
    const form = buttonRef.current?.form;
    if (!pending && form) restoreSubmitFocus(form);
  }, [pending]);
  // When several submit buttons share a form (Approve / Deny), only the one that was
  // pressed says it is working; the others are inert until the form settles.
  const submittedByThis = pending && (name === undefined || !data || data.get(name) === String(value ?? ""));
  return (
    <Button
      ref={(node: HTMLButtonElement | null) => {
        buttonRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      type="submit"
      variant={variant}
      name={name}
      value={value}
      className={className}
      aria-disabled={pending ? true : ariaDisabled}
      aria-busy={submittedByThis || undefined}
      onClick={(event) => {
        if (pending || ariaDisabled === true || ariaDisabled === "true") {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      {...props}
    >
      {submittedByThis ? (
        <>
          <LoaderCircle aria-hidden={true} className="h-4 w-4 shrink-0 animate-spin" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}
