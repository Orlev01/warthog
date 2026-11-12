"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";

// The Remove control for one passkey on Settings › Security (interaction-05). Removing a
// passkey is a sign-in factor gone, so it never happens on one click: Remove opens an
// in-page dialog that names the passkey and says plainly what removing it means. Only the
// dialog's "Remove passkey" posts the form, through the guarded ActionForm, so one confirmed
// tap sends exactly one request. The action still requires a fresh confirmation and is
// scoped to the session person (settings/security/actions.ts).
//
// Never the last sign-in method (follow-up S2): when this is the account's ONLY passkey and
// there's no authenticator app, the server refuses the removal, so the dialog doesn't offer
// it. It says why and links to the two ways to add another sign-in method first. With an
// authenticator app, removing the only passkey is allowed and the dialog warns plainly.
//
// The trigger is a plain button, not a submit, so nothing is removed before the page has
// hydrated and the dialog can ask first.

export type RemovePasskeyAction = (formData: FormData) => void | Promise<void>;

// `blocked`: removal isn't possible (the last sign-in method), so the dialog offers the
// alternatives instead of a Remove button.
export type RemovePasskeyCopy = { title: string; body: string[]; blocked: boolean };

// Where the blocked dialog sends the person: the two ways to add another sign-in method,
// both on this screen (security-view.tsx renders these ids).
export const ADD_PASSKEY_ANCHOR = "add-a-passkey";
export const SET_UP_AUTHENTICATOR_ANCHOR = "set-up-authenticator";

/** What the confirmation says, by situation. Pure, so the wording is testable. */
export function removePasskeyCopy({
  name,
  added,
  onlyPasskey,
  authenticatorEnabled,
}: {
  name: string;
  added: string;
  onlyPasskey: boolean;
  authenticatorEnabled: boolean;
}): RemovePasskeyCopy {
  const vault =
    "If this passkey unlocks your cards and protected details, you'll unlock them with your vault recovery phrase or vault passphrase instead.";
  if (!onlyPasskey) {
    return {
      title: `Remove ${name}?`,
      body: [
        `${name} (added ${added}) will stop working for signing in and confirming it's you. Your other passkeys keep working.`,
        vault,
      ],
      blocked: false,
    };
  }
  if (authenticatorEnabled) {
    return {
      title: "Remove your only passkey?",
      body: [
        "This is the only passkey on your account. Once it's removed, you'll sign in with your email and authenticator app, and confirm it's you with a code from the app.",
        vault,
        "If you're replacing this passkey, add the new one first.",
      ],
      blocked: false,
    };
  }
  return {
    title: "You can't remove your only passkey",
    body: [
      "This passkey is the only way you can sign in, so removing it would lock you out of your account.",
      "Add another passkey or set up an authenticator app first. Then you can remove this one.",
    ],
    blocked: true,
  };
}

// Closes the dialog once its submission has settled (the redirect has re-rendered the
// page). On success the row is gone anyway; on a refusal (e.g. confirm it's you first)
// the dialog must not stay open over the outcome.
function CloseWhenSettled({ dialog }: { dialog: React.RefObject<HTMLDialogElement | null> }) {
  const { pending } = useFormStatus();
  const wasPending = React.useRef(false);
  React.useEffect(() => {
    if (wasPending.current && !pending) dialog.current?.close();
    wasPending.current = pending;
  }, [dialog, pending]);
  return null;
}

export function RemovePasskeyControl({
  action,
  passkeyId,
  name,
  added,
  onlyPasskey,
  authenticatorEnabled,
}: {
  action?: RemovePasskeyAction;
  passkeyId: string;
  name: string;
  added: string;
  onlyPasskey: boolean;
  authenticatorEnabled: boolean;
}) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const bodyId = React.useId();
  const copy = removePasskeyCopy({ name, added, onlyPasskey, authenticatorEnabled });
  return (
    <ActionForm action={action ?? (() => undefined)} className="shrink-0">
      <input type="hidden" name="passkeyId" value={passkeyId} />
      <Button
        type="button"
        variant="danger"
        size="sm"
        aria-haspopup="dialog"
        aria-label={`Remove ${name}`}
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
              {[
                { href: `#${ADD_PASSKEY_ANCHOR}`, label: "Add a passkey" },
                { href: `#${SET_UP_AUTHENTICATOR_ANCHOR}`, label: "Set up an authenticator app" },
              ].map((link) => (
                <li key={link.href}>
                  {/* Close first, so the page can scroll to the section behind the dialog. */}
                  <a
                    href={link.href}
                    className="inline-flex min-h-11 items-center font-medium text-fg underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    onClick={() => dialog.current?.close()}
                  >
                    {link.label}
                  </a>
                </li>
              ))}
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
              Keep passkey
            </Button>
            <FormSubmit variant="danger-solid" pendingLabel="Removing…">
              Remove passkey
            </FormSubmit>
          </div>
        )}
        <CloseWhenSettled dialog={dialog} />
      </dialog>
    </ActionForm>
  );
}
