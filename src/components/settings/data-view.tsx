"use client";

import * as React from "react";
import { Archive, Trash2 } from "lucide-react";

import { DataTransferControls } from "./data-transfer";
import { Button } from "@/components/ui/button";
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
};

// The plain default confirmation phrase, used when the page supplies none.
const DEFAULT_PHRASE = "delete my account";

function SectionHeading({ icon: Icon, children }: { icon: typeof Archive; children: React.ReactNode }) {
  return (
    <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-fg">
      <Icon aria-hidden={true} className="h-4 w-4 shrink-0" />
      {children}
    </h2>
  );
}

export function DataView({
  importedHistory,
  confirmationPhrase = DEFAULT_PHRASE,
  confirmationInput = "",
  deleteAccountAction,
}: DataViewProps) {
  // The confirmation gate: seed from the prop, track what is typed, and derive the
  // Delete control's live/disabled state SOLELY from an exact match of the phrase.
  const [confirmation, setConfirmation] = React.useState(confirmationInput);
  const unlocked = confirmation === confirmationPhrase;

  return (
    <section className="flex flex-col gap-8">
      <DataTransferControls />

      {/* ----- Imported history: a clearly-labelled, READ-ONLY archive, kept separate
               from the live activity feed (an import never claims authorship). ----- */}
      <div className="flex flex-col gap-3">
        <SectionHeading icon={Archive}>Imported history</SectionHeading>
        <p className="text-sm text-fg-muted">
          A read-only archive of activity brought over from a previous export. It is kept
          separate from your live activity record and cannot be changed.
        </p>
        {importedHistory.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {importedHistory.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-1 rounded-card border border-line bg-surface p-4"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium text-fg">{entry.kind}</span>
                  <span className="text-sm text-fg-muted">{entry.at}</span>
                </div>
                <p className="text-fg">{entry.summary}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">Nothing has been imported yet.</p>
        )}
      </div>

      {/* ----- Delete account: a plain explainer of the weight, then the gated control.
               The destructive button stays locked until the exact phrase is typed. ----- */}
      <div className="flex flex-col gap-3">
        <SectionHeading icon={Trash2}>Delete account</SectionHeading>
        <p className="text-sm text-fg-muted">
          This is a sensitive step, so take a moment before it goes ahead. Deleting your
          account is permanent and cannot be undone. Access is revoked immediately and your
          account's encryption-key reference is removed from the live database. Remaining
          live account rows are queued for deletion within 24 hours. Backups can retain older
          data, and external email or SMS providers retain their own records, for the periods
          described in the privacy policy.
        </p>
        <form action={deleteAccountAction} className="flex flex-col gap-3">
          <Field
            label="Confirmation phrase"
            name="confirmation"
            type="text"
            autoComplete="off"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
          <p className="text-sm text-fg-muted">
            {unlocked
              ? "The phrase matches — the button below will permanently delete your account."
              : (
                <>
                  To unlock the button, type <strong className="text-fg">{confirmationPhrase}</strong> in
                  the field above exactly.
                </>
              )}
          </p>
          <Button type="submit" variant="secondary" disabled={!unlocked} className="self-start">
            <Trash2 aria-hidden={true} className="h-4 w-4 shrink-0" />
            Delete my account
          </Button>
        </form>
      </div>
    </section>
  );
}

export default DataView;
