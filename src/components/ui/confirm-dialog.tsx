"use client";

// The shared confirmation dialog (UI/UX audit 2026-11-23 W-40, W-16). A native <dialog> opened
// with showModal(): focus stays inside, the page behind is inert, and Escape cancels. The safe
// choice comes first in the DOM, so it is focused, read and tabbed to first, and phones stack
// the buttons in that same order (no reversed column, A11Y-12).
//
// Controlled: the caller owns `open` and decides what confirming does. The existing dialogs
// (disconnect, remove passkey, delete skill, …) can move onto this one at a time.

import * as React from "react";

import { Button } from "./button";

// Sized for any phone, clear of the notch and home bar.
export const DIALOG_CLASS =
  "top-[env(safe-area-inset-top)] right-[env(safe-area-inset-right)] bottom-[env(safe-area-inset-bottom)] left-[env(safe-area-inset-left)] m-auto max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-[calc(100%-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))] max-w-md overflow-y-auto rounded-panel border border-line bg-surface p-4 text-fg shadow-lg sm:p-6";

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  // What happens if the person confirms, in plain words.
  readonly description: React.ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  // "danger" when confirming loses something; "neutral" otherwise.
  readonly tone?: "danger" | "neutral";
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  tone = "danger",
}: ConfirmDialogProps): React.ReactElement | null {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const bodyId = React.useId();

  React.useEffect(() => {
    const modal = dialog.current;
    if (open && modal && !modal.open) modal.showModal();
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className={DIALOG_CLASS}
      // Escape (or the browser closing it) is a cancel, never a confirm.
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId} className="wh-section-title">
        {title}
      </h2>
      <div id={bodyId} className="mt-3 flex flex-col gap-3 text-sm text-fg-muted">
        {typeof description === "string" ? <p>{description}</p> : description}
      </div>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" autoFocus onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button type="button" variant={tone === "danger" ? "danger-solid" : "primary"} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}

export default ConfirmDialog;
