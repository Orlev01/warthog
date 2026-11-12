"use client";

import * as React from "react";
import { CheckCircle2, X } from "lucide-react";

export type ToastDismissReason = "button" | "escape" | "timeout";

export type ToastProps = {
  message: string | null;
  onDismiss: (reason: ToastDismissReason) => void;
  // Auto-dismiss after this many milliseconds; the timer pauses while the toast is
  // hovered or focused. Omit (or null) to keep it until dismissed. Only routine
  // confirmations may expire: errors, security steps and next steps belong inline.
  dismissAfter?: number | null;
};

// Keep the polite announcer mounted before the result arrives. The visible toast never
// takes focus; Escape or its × dismisses it. While it is on screen the page reserves room
// for it (controls.css), so it never hides the focused control or the page's last control.
export function Toast({ message, onDismiss, dismissAfter = null }: ToastProps) {
  const [paused, setPaused] = React.useState(false);
  const dismissRef = React.useRef(onDismiss);
  React.useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  React.useEffect(() => {
    if (!message) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) dismissRef.current("escape");
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [message]);

  React.useEffect(() => {
    if (!message || dismissAfter == null || paused) return;
    const timer = window.setTimeout(() => dismissRef.current("timeout"), dismissAfter);
    return () => window.clearTimeout(timer);
  }, [message, dismissAfter, paused]);

  React.useEffect(() => {
    if (!message) setPaused(false);
  }, [message]);

  return <>
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{message}</div>
    {message ? (
      <aside
        aria-label="Notification"
        data-wh-toast=""
        onPointerEnter={() => setPaused(true)}
        onPointerLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
        }}
        className="wh-toast fixed left-[max(1rem,env(safe-area-inset-left))] right-[max(1rem,env(safe-area-inset-right))] bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 mx-auto flex max-w-sm items-center gap-2 rounded-card border border-line bg-surface py-1 pl-3 pr-1 text-sm text-fg shadow-lg sm:left-auto sm:right-[max(1.5rem,env(safe-area-inset-right))] sm:mx-0 sm:w-[calc(100%-3rem)] lg:bottom-[max(1.5rem,env(safe-area-inset-bottom))]"
      >
        <CheckCircle2 aria-hidden={true} className="h-5 w-5 shrink-0 text-success" />
        <p className="min-w-0 flex-1 break-words py-2">{message}</p>
        <button type="button" aria-label="Dismiss notification" onClick={() => onDismiss("button")}
          className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-surface-muted hover:text-fg">
          <X aria-hidden={true} className="h-4 w-4" />
        </button>
      </aside>
    ) : null}
  </>;
}
