import * as React from "react";

import { PageNotice } from "@/components/ui/notice";
import type { IdentifierRule } from "@/domain/life-admin/identifiers";

// The outcome notices of Life admin's pages (the list page and an item's own page): each
// action redirects back with `?notice=<key>` (and, for a refusal, `&field=<label>`), and the
// page shows the one notice in plain words plus an icon (never colour alone). A refusal names
// the field or place, never its value.

export type Notice =
  | "deleted"
  | "file_too_large"
  | "saved"
  | "saved_matched"
  | "saved_unchanged"
  | "saved_partly"
  | "updated"
  | "updated_partly"
  | "unchanged"
  | "attached"
  | "reminded"
  | "confirmed"
  | "confirmed_all"
  | "dismissed"
  | "accepted"
  | "accepted_all"
  | "declined"
  | "ticked"
  | "handed"
  | "created"
  | "assigned"
  | "noted"
  | "completed"
  | "category_kept"
  | "category_declined"
  | "category_shown"
  | "category_hidden"
  | "category_cleared"
  | "journal_added"
  | "journal_cut"
  | "journal_invalid"
  | "journal_full"
  | "next_done"
  | "steward_set"
  | "steward_cleared"
  | "steward_unknown"
  | "invalid_input"
  | "invalid_reminders"
  | "record_empty"
  | "record_type_missing"
  | "task_title_missing"
  | "note_missing"
  | "problem"
  | ForbiddenNotice;

// One notice per identifier rule (domain/life-admin/identifiers.ts), so the refusal says what
// the value looked like and what to do instead; the field is named, never its value.
export type ForbiddenNotice = `forbidden_${IdentifierRule}`;
export const FORBIDDEN_NOTICES: Record<IdentifierRule, ForbiddenNotice> = {
  tax_file_number: "forbidden_tax_file_number",
  secret: "forbidden_secret",
  bank_account: "forbidden_bank_account",
  government_id: "forbidden_government_id",
  medicare: "forbidden_medicare",
  payment_details: "forbidden_payment_details",
};

// `{field}` is replaced by the field's label in quotes, or "One of the details".
export const NOTICES: Record<Notice, { done: boolean; text: string }> = {
  deleted: { done: true, text: "Record and attached files deleted." },
  file_too_large: { done: false, text: "Nothing was attached: choose a file of 25 MB or less." },
  saved: { done: true, text: "Added to Life admin." },
  saved_matched: { done: true, text: "You already had this in Life admin, so that record was updated instead of adding another." },
  saved_unchanged: { done: true, text: "That's already in Life admin, so nothing changed." },
  saved_partly: { done: false, text: "Saved, but some details were left out: use the date picker for dates, plain amounts such as 412.50, and three-letter currency codes such as AUD." },
  updated: { done: true, text: "Changes saved." },
  updated_partly: { done: false, text: "Changes saved, but some details weren't changed: use the date picker for dates, plain amounts such as 412.50, and three-letter currency codes such as AUD." },
  unchanged: { done: true, text: "Nothing changed." },
  attached: { done: true, text: "File attached." },
  reminded: { done: true, text: "Reminders updated." },
  confirmed: { done: true, text: "Confirmed. Your agents can't change it now without asking you first." },
  confirmed_all: { done: true, text: "All confirmed. Your agents can't change these now without asking you first." },
  dismissed: { done: true, text: "Removed as not yours. If an agent finds it again, it won't be added back." },
  accepted: { done: true, text: "Change accepted." },
  accepted_all: { done: true, text: "All the changes were accepted." },
  declined: { done: true, text: "Kept your version. The suggested change was dropped." },
  ticked: { done: true, text: "Checklist updated." },
  handed: { done: true, text: "Handed to an agent." },
  created: { done: true, text: "Task created." },
  assigned: { done: true, text: "Task reassigned." },
  noted: { done: true, text: "Note added." },
  completed: { done: true, text: "Task marked done." },
  category_kept: { done: true, text: "Kept. It's one of your own categories now." },
  category_declined: { done: true, text: "Category declined. Its suggested records were removed, anything you'd confirmed moved to Something else, and agents won't suggest it again." },
  category_shown: { done: true, text: "Done. It's suggested under Fill in the rest until there's something in it." },
  category_hidden: { done: true, text: "Marked as not for you. You can undo it under Not for me in Fill in the rest." },
  category_cleared: { done: true, text: "Done. That category shows again once there's something in it." },
  journal_added: { done: true, text: "Added to this item's log. Any agent working on it next will see it." },
  journal_cut: { done: true, text: "Added to this item's log, cut to 280 characters." },
  journal_invalid: { done: false, text: "Nothing was added: write one or two lines of up to 280 characters, and use the date picker for a due date." },
  journal_full: { done: false, text: "Nothing was added: this item's log is full." },
  next_done: { done: true, text: "Marked done." },
  steward_set: { done: true, text: "Saved. That agent is shown as handling this item. It's a label only: it doesn't change what any agent can see or do." },
  steward_cleared: { done: true, text: "Saved. No one is shown as handling this item." },
  steward_unknown: { done: false, text: "Nothing changed: that agent isn't connected any more." },
  invalid_input: { done: false, text: "Nothing was saved. Check the values you entered and try again." },
  invalid_reminders: { done: false, text: "Reminders weren't changed. Enter whole days from 0 to 36500, separated by commas, or leave the field empty to turn reminders off." },
  record_empty: { done: false, text: "Nothing was added: fill in at least one detail." },
  record_type_missing: { done: false, text: "Nothing was added: choose what you're adding first." },
  task_title_missing: { done: false, text: "No task was created: describe what needs doing in a few words." },
  note_missing: { done: false, text: "No note was added: write the note first." },
  problem: { done: false, text: "We couldn't save that change. It may have been removed already, so refresh the page and try again." },
  forbidden_tax_file_number: { done: false, text: "Nothing was saved: {field} looks like a tax file number. Warthog never keeps tax file numbers." },
  forbidden_secret: { done: false, text: "Nothing was saved: {field} looks like a password, PIN, security answer or code. Warthog never keeps these in Life admin." },
  forbidden_bank_account: { done: false, text: "Nothing was saved: {field} looks like a BSB and account number. Keep only the bank's name and the last 4 digits." },
  forbidden_government_id: { done: false, text: "Nothing was saved: {field} looks like a passport, licence, visa or Centrelink number. Keep the number in your Vault, and only the expiry date and details here." },
  forbidden_medicare: { done: false, text: "Nothing was saved: {field} looks like a Medicare number. Keep the number in your Vault, and only the expiry date here." },
  forbidden_payment_details: { done: false, text: "Nothing was saved: {field} looks like payment details (how to pay, a payee, a biller code or reference). Warthog doesn't keep payment details; pay through the provider's own app or bill." },
};

export function toNotice(raw: string | string[] | undefined): Notice | null {
  return typeof raw === "string" && Object.hasOwn(NOTICES, raw) ? (raw as Notice) : null;
}

/** A notice's words, with the field it names in quotes ("one of the details" when none). */
export function noticeText(notice: Notice, field: string | null): string {
  return NOTICES[notice].text.replace("{field}", field ? `“${field}”` : "one of the details");
}

// The outcome of the last action, in words plus an icon (never colour alone), as the page's
// one notice slot under the heading band. A problem is announced immediately (alert); a
// success politely (status). It removes `?notice=` (and the field it names) from the address
// once shown.
export function OutcomeNotice({ notice, field }: { notice: Notice; field: string | null }) {
  return (
    <PageNotice tone={NOTICES[notice].done ? "success" : "error"} clearParams={["notice", "field"]}>
      {noticeText(notice, field)}
    </PageNotice>
  );
}
