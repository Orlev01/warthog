"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";
import { ADD_PASSKEY_ANCHOR } from "./remove-passkey";

// The Remove control for the authenticator app on Settings › Security (sign-in audit,
// founder decision 13 November 2026). The same in-page danger confirmation as removing a
// passkey (remove-passkey.tsx): Remove opens a dialog that says plainly what removing the
// app means, and only the dialog's "Remove authenticator app" posts the form, through the
// guarded ActionForm, so one confirmed tap sends exactly one request. The action requires a
// fresh confirmation and is scoped to the session person (settings/security/actions.ts).
//
// Never the last sign-in method: with no passkey the app is the only way to sign in, so the
// server refuses and the dialog doesn't offer it. It says why and links to Add a passkey.
//
// The trigger is a plain button, not a submit, so nothing is removed before the page has
// hydrated and the dialog can ask first.

export type RemoveAuthenticatorAction = (formData: FormData) => void | Promise<void>;

export type RemoveAuthenticatorCopy = { title: string; body: string[]; blocked: boolean };

/** What the confirmation says, by situation. Pure, so the wording is testable. */
export function removeAuthenticatorCopy({ hasPasskey }: { hasPasskey: boolean }): RemoveAuthenticatorCopy {
  if (hasPasskey) {
    return {
      title: "Remove your authenticator app?",
      body: [
        "You'll no longer sign in or confirm it's you with a code from the app. Your passkeys keep working.",
        "If you're moving to a new app, remove this one, then set up the new one here.",
      ],
      blocked: false,
    };
  }
  return {
    title: "You can't remove your authenticator app",
    body: [
      "Your authenticator app is the only way you can sign in, so removing it would lock you out of your account.",
      "Add a passkey first. Then you can remove the app.",
    ],
    blocked: true,
  };
}

// Closes the dialog once its submission has settled (the redirect has re-rendered the page),
// so a refusal (e.g. confirm it's you first) isn't hidden behind it.
function CloseWhenSettled({ dialog }: { dialog: React.RefObject<HTMLDialogElement | null> }) {
  const { pending } = useFormStatus();
  const wasPending = React.useRef(false);
  React.useEffect(() => {
    if (wasPending.current && !pending) dialog.current?.close();
    wasPending.current = pending;
  }, [dialog, pending]);
  return null;
}

export function RemoveAuthenticatorControl({
  action,
  hasPasskey,
}: {
  action?: RemoveAuthenticatorAction;
  hasPasskey: boolean;
}) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const bodyId = React.useId();
  const copy = removeAuthenticatorCopy({ hasPasskey });
  return (
    <ActionForm action={action ?? (() => undefined)} className="shrink-0">
      <Button
        type="button"
        variant="danger"
        size="sm"
        aria-haspopup="dialog"
        aria-label="Remove authenticator app"
        onClick={() => {
          const modal = dialog.current;
          if (modal && !modal.open) modal.showModal();
        }}
      >
        <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
        Remove
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="top-[env(safe-area-inset-top)] right-[env(safe-area-inset-right)] bottom-[env(safe-area-inset-bottom)] left-[env(safe-area-inset-left)] m-auto max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-[calc(100%-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))] max-w-md overflow-y-auto rounded-panel border border-line bg-surface p-4 text-fg shadow-lg sm:p-6"
      >
        <h2 id={titleId} className="wh-section-title">
          {copy.title}
        </h2>
        <div id={bodyId} className="mt-3 flex flex-col gap-3 text-sm text-fg-muted">
          {copy.body.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        {copy.blocked ? (
          <>
            <ul role="list" className="mt-4 flex flex-col gap-2 text-sm">
              <li>
                {/* Close first, so the page can scroll to the section behind the dialog. */}
                <a
                  href={`#${ADD_PASSKEY_ANCHOR}`}
                  className="inline-flex min-h-11 items-center font-medium text-fg underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  onClick={() => dialog.current?.close()}
                >
                  Add a passkey
                </a>
              </li>
            </ul>
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button type="button" variant="secondary" autoFocus onClick={() => dialog.current?.close()}>
                Close
              </Button>
            </div>
          </>
        ) : (
          <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" autoFocus onClick={() => dialog.current?.close()}>
              Keep authenticator app
            </Button>
            <FormSubmit variant="danger-solid" pendingLabel="Removing…">
              Remove authenticator app
            </FormSubmit>
          </div>
        )}
        <CloseWhenSettled dialog={dialog} />
      </dialog>
    </ActionForm>
  );
}
