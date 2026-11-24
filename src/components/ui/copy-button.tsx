"use client";

import * as React from "react";
import { AlertTriangle, Check, Copy } from "lucide-react";

import { Button } from "./button";
import { Toast, type ToastDismissReason } from "./toast";

type CopyState = "idle" | "copying" | "copied" | "failed";

type CopyDeps = {
  writeText?: (value: string) => Promise<void>;
  onChange?: () => void;
};

// The value is used only by the clipboard call, never retained in feedback state.
export function createCopyController({ writeText, onChange }: CopyDeps) {
  let state: CopyState = "idle";
  let revision = 0;
  function set(next: CopyState) { state = next; onChange?.(); }
  return {
    getState: () => state,
    dismiss() { revision++; set("idle"); },
    async copy(value: string) {
      if (state === "copying") return;
      const attempt = ++revision;
      set("copying");
      try {
        if (!writeText) throw new Error("Clipboard unavailable");
        await writeText(value);
        if (attempt === revision) set("copied");
      } catch {
        if (attempt === revision) set("failed");
      }
    },
  };
}

export const DEFAULT_COPY_MESSAGE = "Copied to clipboard.";
// A routine "Copied" confirmation clears itself; the button keeps saying "Copied".
export const COPY_TOAST_DURATION = 4000;

/** How long the copy toast stays: a routine confirmation expires; a custom message (which
 * may carry an instruction, such as clearing the clipboard) stays until dismissed. */
export function copyToastDuration(successMessage: string | undefined, dismissAfter: number | null | undefined): number | null {
  if (dismissAfter !== undefined) return dismissAfter;
  return successMessage === undefined || successMessage === DEFAULT_COPY_MESSAGE ? COPY_TOAST_DURATION : null;
}

export type CopyButtonProps = {
  value: string;
  successMessage?: string;
  // What is being copied, for the accessible name ("Warthog address" → "Copy Warthog
  // address"). The visible label stays "Copy". Never the value itself.
  label?: string;
  // Override the toast's lifetime in ms (null keeps it until dismissed).
  dismissAfter?: number | null;
  // The screen's one primary action (Home's "Copy for Claude"); secondary otherwise.
  variant?: "primary" | "secondary";
  // The button's words before copying ("Copy for Claude"); "Copy" by default.
  text?: string;
};

export function CopyButton({ value, successMessage, label, dismissAfter, variant = "secondary", text = "Copy" }: CopyButtonProps) {
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const button = React.useRef<HTMLButtonElement>(null);
  const errorId = React.useId();
  const [copy] = React.useState(() => createCopyController({
    writeText: async (text) => {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
    },
    onChange: redraw,
  }));
  React.useEffect(() => { copy.dismiss(); }, [copy, value]);
  const state = copy.getState();
  const message = successMessage ?? DEFAULT_COPY_MESSAGE;
  // An expired toast hides while the button keeps saying "Copied"; the next copy shows it again.
  const [toastExpired, setToastExpired] = React.useState(false);
  return <div className="flex min-w-0 shrink-0 flex-col gap-2 sm:max-w-56">
    <Button ref={button} variant={variant} aria-disabled={state === "copying" || undefined}
      aria-busy={state === "copying" || undefined}
      aria-describedby={state === "failed" ? errorId : undefined}
      onClick={() => { setToastExpired(false); void copy.copy(value); }}>
      {state === "copied" ? <Check aria-hidden={true} className="h-4 w-4 shrink-0" /> : <Copy aria-hidden={true} className="h-4 w-4 shrink-0" />}
      {state === "copying" ? "Copying…" : state === "copied" ? "Copied" : text}
      {label ? <span className="sr-only"> {label}</span> : null}
    </Button>
    {state === "failed" ? <p id={errorId} role="alert" className="flex items-start gap-2 text-sm text-danger">
      <AlertTriangle aria-hidden={true} className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 break-words">Couldn’t copy. Select the value and copy it manually.</span>
    </p> : null}
    <Toast
      message={state === "copied" && !toastExpired ? message : null}
      dismissAfter={copyToastDuration(successMessage, dismissAfter)}
      onDismiss={(reason: ToastDismissReason) => {
        // The "Copied" state stays on the button after the toast clears itself; an explicit
        // dismissal resets it, and returns focus to Copy only when the × had it.
        if (reason === "timeout") { setToastExpired(true); return; }
        copy.dismiss();
        if (reason === "button") button.current?.focus();
      }}
    />
  </div>;
}
