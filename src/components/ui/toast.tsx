"use client";

import * as React from "react";
import { CheckCircle2, X } from "lucide-react";

export type ToastProps = {
  message: string | null;
  onDismiss: () => void;
};

// Keep the polite announcer mounted before the result arrives. The visible toast
// never takes focus or times out; errors and next steps belong inline instead.
export function Toast({ message, onDismiss }: ToastProps) {
  return <>
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{message}</div>
    {message ? (
      <aside aria-label="Notification" className="fixed left-[max(1rem,env(safe-area-inset-left))] right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-sm items-start gap-3 rounded-card border border-line bg-surface p-3 text-sm text-fg shadow-lg sm:left-auto sm:right-[max(1.5rem,env(safe-area-inset-right))] sm:mx-0 sm:w-[calc(100%-3rem)] lg:bottom-[max(1.5rem,env(safe-area-inset-bottom))]">
        <CheckCircle2 aria-hidden={true} className="mt-3 h-5 w-5 shrink-0 text-success" />
        <p className="min-w-0 flex-1 break-words py-3">{message}</p>
        <button type="button" aria-label="Dismiss notification" onClick={onDismiss}
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
          <X aria-hidden={true} className="h-4 w-4" />
        </button>
      </aside>
    ) : null}
  </>;
}
