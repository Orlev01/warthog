"use client";

import * as React from "react";
import { useFormStatus } from "react-dom";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";

// The Delete control on one of the person's skills (UI/UX follow-up). Deleting a skill
// can't be undone and every agent loses it at once, so it never happens on one click — and
// no longer through the browser's own confirm() box, which can't name the skill, can't be
// styled or themed, and which some browsers suppress. Delete opens an in-page dialog, the
// same danger confirmation as removing a passkey or disconnecting an agent: it names the
// skill and says what deleting it means, the safe choice comes first and takes focus, and
// only the dialog's "Delete skill" posts — through the guarded ActionForm, so one confirmed
// tap sends exactly one request. Escape and "Keep skill" close it, and the browser returns
// focus to the card's Delete; once the skill is deleted its card is gone, so focus moves to
// the library (`onDeleted`) rather than falling back to the top of the page. The delete action and its guards are unchanged (member-scoped,
// validated id, a packaged skill refused — skills/actions.ts).
//
// The trigger is a plain button, not a submit, so nothing is deleted before the page has
// hydrated and the dialog can ask first.

export type DeleteSkillAction = (formData: FormData) => void | Promise<void>;

/** What the confirmation says. Pure, so the wording is testable. */
export function deleteSkillCopy(title: string): { title: string; body: string } {
  return {
    title: `Delete ${title}?`,
    body: "Your agents lose access to it straight away, and this can't be undone. To keep a copy, download it first.",
  };
}

// Closes the dialog once its submission has settled (the redirect has re-rendered the page).
// On success the card is gone anyway; on a refusal the dialog must not stay open over the
// outcome notice.
function CloseWhenSettled({ dialog }: { dialog: React.RefObject<HTMLDialogElement | null> }) {
  const { pending } = useFormStatus();
  const wasPending = React.useRef(false);
  React.useEffect(() => {
    if (wasPending.current && !pending) dialog.current?.close();
    wasPending.current = pending;
  }, [dialog, pending]);
  return null;
}

export function DeleteSkillControl({
  action,
  skillId,
  title,
  onDeleted,
}: {
  action?: DeleteSkillAction;
  skillId: string;
  title: string;
  // Where focus goes once the skill is gone: its card (and this control) leave the page with
  // it, so focus would otherwise fall back to the top of the document.
  onDeleted?: () => void;
}) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  const bodyId = React.useId();
  const copy = deleteSkillCopy(title);
  const submitted = React.useRef(false);
  const onDeletedRef = React.useRef(onDeleted);
  React.useEffect(() => {
    onDeletedRef.current = onDeleted;
  });
  // Unmounted after a confirmed delete: once the refreshed page has painted, hand focus on —
  // but only if it was lost, never away from somewhere the person has put it.
  React.useEffect(
    () => () => {
      if (!submitted.current) return;
      const next = onDeletedRef.current;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!active || active === document.body) next?.();
      });
    },
    [],
  );
  return (
    <ActionForm
      action={action ?? (async () => undefined)}
      onSubmit={() => {
        submitted.current = true;
      }}
    >
      <input type="hidden" name="id" value={skillId} />
      <Button
        type="button"
        variant="danger"
        size="sm"
        aria-haspopup="dialog"
        onClick={() => {
          const modal = dialog.current;
          if (modal && !modal.open) modal.showModal();
        }}
      >
        <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
        Delete
        <span className="sr-only"> {title}</span>
      </Button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="top-[env(safe-area-inset-top)] right-[env(safe-area-inset-right)] bottom-[env(safe-area-inset-bottom)] left-[env(safe-area-inset-left)] m-auto max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] w-[calc(100%-2rem-env(safe-area-inset-left)-env(safe-area-inset-right))] max-w-md overflow-y-auto rounded-panel border border-line bg-surface p-4 text-fg shadow-lg sm:p-6"
      >
        <h2 id={titleId} className="wh-section-title [overflow-wrap:anywhere]">
          {copy.title}
        </h2>
        <p id={bodyId} className="mt-3 text-sm text-fg-muted">
          {copy.body}
        </p>
        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" autoFocus onClick={() => dialog.current?.close()}>
            Keep skill
          </Button>
          <FormSubmit variant="danger-solid" pendingLabel="Deleting…">
            Delete skill
          </FormSubmit>
        </div>
        <CloseWhenSettled dialog={dialog} />
      </dialog>
    </ActionForm>
  );
}
