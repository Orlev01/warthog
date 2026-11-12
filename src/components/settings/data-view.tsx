"use client";

import * as React from "react";
import { Archive, Trash2 } from "lucide-react";

import { DataTransferControls } from "./data-transfer";
import { WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";
import { ConfirmItsYou } from "@/components/ui/confirm-its-you";
import { EmptyState } from "@/components/ui/empty";
import { Field } from "@/components/ui/field";

// E16-S10 — Data & privacy view component (src/components/settings/data-view.tsx;
// brief "Export and portability", constitution 20 "Australian Privacy Act and
// GDPR-style rights", design §4.1 account deletion = crypto-shredding).
//
// The Data & privacy screen is the one calm, plain-English home for the three heavy
// data actions — EXPORT all of your data, IMPORT a previous Warthog export, and DELETE
// your account — plus a read-only view of any history that was brought over by an import
// ("Imported history", kept OUTSIDE the live, hash-chained activity record so an import
// never claims authorship — constitution 14). Because deleting everything is
// irreversible, the weight of it is made clear BEFORE it happens (a plain
// sensitive-moment explainer), and the destructive control stays locked until the person
// types an exact confirmation phrase.
//
// Transfers are browser-controlled so protected plaintext never enters a native form.
// Deletion remains a separately gated server action.

// An archived entry brought over by a past import, already display-ready.
export type DataViewImportedEntry = {
  id: string;
  kind: string; // display-ready label, e.g. "Payment"
  at: string; // pre-formatted time label, e.g. "1 March 2025"
  summary: string; // one-line, already-redacted, display-ready
};

// A form-submit server action the page hands down to wire a control. The browser posts
// the control's fields as FormData; the action acts member-scoped to the session person.
export type DataFormAction = (formData: FormData) => void | Promise<void>;

export type DataViewProps = {
  // the entries brought over by a past import, shown in a read-only "Imported history"
  // section distinct from the live activity feed. May be EMPTY (a fresh account).
  importedHistory: ReadonlyArray<DataViewImportedEntry>;
  // the EXACT phrase the person must type to unlock account deletion. Shown on screen so
  // they know what to type; optional, with a plain default.
  confirmationPhrase?: string;
  // the current contents of the confirmation field; seeds its initial value (default "").
  confirmationInput?: string;

  deleteAccountAction?: DataFormAction;

  // Export, import and delete need a confirmation within the last five minutes. When the
  // session has none, the page passes `needsConfirm` and the view offers ONE "Confirm it's
  // you" at the top; a transfer refused later points back to that same control.
  needsConfirm?: boolean;
  // Why it's being asked (e.g. the delete refusal), shown inside the control so it clears
  // once confirmed.
  confirmExplanation?: string;
  // The member's enrolled factors, so the control offers only what they can use.
  passkey?: boolean;
  authenticator?: boolean;
};

// The plain default confirmation phrase, used when the page supplies none.
const DEFAULT_PHRASE = "delete my account";

const DEFAULT_CONFIRM_EXPLANATION =
  "Exporting, importing or deleting your data needs a quick check that it's really you.";

// A divider row inside a panel.
const ROW = "flex min-w-0 flex-col gap-1 border-b border-line py-3 text-sm first:pt-0 last:border-0 last:pb-0 [overflow-wrap:anywhere]";

export function DataView({
  importedHistory,
  confirmationPhrase = DEFAULT_PHRASE,
  confirmationInput = "",
  deleteAccountAction,
  needsConfirm = false,
  confirmExplanation,
  passkey,
  authenticator,
}: DataViewProps) {
  // The confirmation gate: seed from the prop, track what is typed, and derive the
  // Delete control's live/disabled state SOLELY from an exact match of the phrase.
  const [confirmation, setConfirmation] = React.useState(confirmationInput);
  const unlocked = confirmation === confirmationPhrase;

  // The page's single "Confirm it's you". A transfer refused for want of a fresh
  // confirmation shows it (a fresh copy if the last one was already used), scrolls it into
  // view and moves focus there, rather than mounting a second control further down.
  const [confirm, setConfirm] = React.useState({
    shown: needsConfirm,
    key: 0,
    confirmed: false,
    explanation: confirmExplanation ?? DEFAULT_CONFIRM_EXPLANATION,
    // Bumped by every refused transfer, so focus moves even when the control was already shown.
    request: 0,
  });
  const confirmRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (confirm.request === 0) return;
    confirmRef.current?.scrollIntoView({ block: "center" });
    confirmRef.current?.focus({ preventScroll: true });
  }, [confirm.request]);
  const askToConfirm = React.useCallback(() => {
    setConfirm((current) => ({
      shown: true,
      key: current.confirmed || !current.shown ? current.key + 1 : current.key,
      confirmed: false,
      explanation: "Nothing was changed. Confirm it's you, then try again.",
      request: current.request + 1,
    }));
  }, []);

  return (
    <>
      {confirm.shown ? (
        <div ref={confirmRef} tabIndex={-1} className="rounded-panel">
          <ConfirmItsYou
            key={confirm.key}
            passkey={passkey}
            authenticator={authenticator}
            explanation={confirm.explanation}
            confirmedText="Thanks — that's confirmed. You can export, import or delete your data for the next five minutes."
            onConfirmed={() => setConfirm((current) => ({ ...current, confirmed: true }))}
          />
        </div>
      ) : null}

      <DataTransferControls onStepUpRequired={askToConfirm} />

      {/* ----- Imported history: a clearly-labelled, READ-ONLY archive, kept separate
               from the live activity feed (an import never claims authorship). ----- */}
      <WorkspacePanel
        title="Imported history"
        description="A read-only archive of activity brought over from a previous export. It's kept separate from your live Activity and can't be changed."
      >
        {importedHistory.length > 0 ? (
          <ul role="list" className="flex min-w-0 flex-col">
            {importedHistory.map((entry) => (
              <li key={entry.id} className={ROW}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium text-fg">{entry.kind}</span>
                  <span className="text-fg-muted">{entry.at}</span>
                </div>
                <p className="text-fg">{entry.summary}</p>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            variant="inline"
            icon={Archive}
            heading="Nothing has been imported yet."
            description="Activity from a file you import appears here."
          />
        )}
      </WorkspacePanel>

      {/* ----- Delete account: what happens, in plain words, then the gated control.
               The destructive button stays locked until the exact phrase is typed. ----- */}
      <ActionForm action={deleteAccountAction ?? (() => undefined)} className="contents">
        <WorkspacePanel
          title="Delete account"
          description="Deleting your account is permanent and can't be undone."
          footer={
            <>
              <FormSubmit variant="danger" disabled={!unlocked} pendingLabel="Deleting your account…">
                <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
                Delete my account
              </FormSubmit>
              <span role="status" className="min-w-0">
                {unlocked
                  ? "That matches. This button deletes your account permanently."
                  : "The button unlocks once you've typed the phrase."}
              </span>
            </>
          }
        >
          <div className="flex min-w-0 flex-col gap-4">
            <ul className="flex min-w-0 list-disc flex-col gap-2 pl-5 text-sm text-fg">
              <li>
                <span className="font-medium">Straight away:</span> every agent and service connection is
                cut off, you&apos;re signed out on every device, and your data can no longer be opened.
              </li>
              <li>
                <span className="font-medium">Within 24 hours:</span> everything left in your account is
                removed.
              </li>
              <li>
                <span className="font-medium">For a limited time:</span> backups, and messages we&apos;ve
                already sent you by email or text, are kept as our{" "}
                <a href="/privacy" className="underline underline-offset-4">privacy policy</a> explains.
              </li>
              <li>If you own a household, transfer or close it first.</li>
            </ul>
            <Field
              label="Confirmation phrase"
              hint={
                <>
                  To continue, type <strong className="text-fg">{confirmationPhrase}</strong> exactly.
                </>
              }
              name="confirmation"
              type="text"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              width="text"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </div>
        </WorkspacePanel>
      </ActionForm>
    </>
  );
}

export default DataView;
