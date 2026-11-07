"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

// E15-S13 — Household view component (brief "Household sharing"; design §4.1 / §8).
//
// The Household screen lets an OWNER manage members, the shared monthly household
// budget, each member's monthly limit, the household currency and the shared address,
// and lets ANY member edit the one shared address and choose "use the household
// address" — while NEVER exposing another member's private data and NEVER leaving a
// dead control. Concretely (brief lines 390-402):
//   - the owner invites members by email, sets the shared household budget and a
//     per-member limit (both in the household currency the owner sets), sets the
//     household currency, removes a member, transfers ownership (the new owner must
//     accept) and closes the household;
//   - any member edits the one shared address and chooses "use the household address"
//     (their vault postal address then follows the shared one) or keeps their own;
//   - a non-owner member can leave;
//   - every member sees the member list and the household budget total — TOTALS ONLY,
//     never another member's merchants or individual entries.
//
// This is the render-testable, prop-driven VIEW (a Client Component): it renders the
// screen entirely from its props so a render test pins each behaviour without a DOM, a
// session or any server plumbing. The real plumbing — persisting a budget/limit/
// currency/address change, issuing an invite, removing a member, transferring
// ownership, closing the household, following the shared address — is wired by a later
// task (the page + its sibling actions module); the bound controls are native forms
// whose `action` is a server action the page passes. The prop shapes mirror the
// already-built list-all read (`HouseholdPageData`, E15-S12) but are declared LOCALLY
// so the view never couples to the server db modules. Colour comes from the design
// tokens (globals.css) — never a raw hex.

export type HouseholdRole = "owner" | "member";

// One member of the household — a bare ROSTER entry (userId + role), never another
// member's private figure: the read strips every other member's spend, limit and
// address, so there is none to render.
export type HouseholdMemberView = {
  userId: string;
  role: HouseholdRole;
};

// The one shared address (decrypted). The editor edits `current`; `upcoming` /
// `movingOn` are a planned move the read may also carry.
export type SharedAddress = {
  householdId: string;
  current: string;
  upcoming: string | null;
  movingOn: Date | string | null;
};

// A pending ownership transfer: just the member it would pass to on accept.
export type PendingTransferView = {
  toUserId: string;
};

// A still-open invite (unused + unexpired) the owner manages.
export type PendingInvite = {
  email: string;
  expiresAt: Date | string;
};

// The member-scoped, shared-items-only report the Household page read hands back.
export type HouseholdPageData = {
  householdId: string;
  ownerId: string;
  currency: string;
  monthlyBudget: number | null;
  members: HouseholdMemberView[];
  sharedAddress: SharedAddress | null;
  followChoice: boolean;
  ownLimit: number | null;
  pendingTransfer: PendingTransferView | null;
  pendingInvites: PendingInvite[];
};

// A server action a form submits to (the page binds the real one; the view renders a
// live control either way). Optional — a control with no bound action renders disabled
// with a reason (no dead control), but the page binds every one.
export type FormAction = (formData: FormData) => void | Promise<void>;

export type HouseholdViewProps = {
  // the member-scoped, shared-items-only report the page read returns.
  household: HouseholdPageData;
  // the SESSION's user id (never a client value). The caller is the owner iff
  // currentUserId === household.ownerId; the owner-only controls key off this.
  currentUserId: string;
  // the selectable household currencies (ISO 4217 codes) the owner's currency control
  // offers.
  currencyOptions?: readonly string[];
  // the server actions the page binds.
  inviteAction?: FormAction;
  editAddressAction?: FormAction;
  followChoiceAction?: FormAction;
  budgetAction?: FormAction;
  limitAction?: FormAction;
  currencyAction?: FormAction;
  removeMemberAction?: FormAction;
  leaveAction?: FormAction;
  transferAction?: FormAction;
  closeAction?: FormAction;
};

// A native <select> on the design tokens (one source of visual truth — never a
// parallel style).
const SELECT_CLASS =
  "min-h-11 w-full rounded-card border border-line bg-surface px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

// The shared text-field style, matching the Input primitive's tokens.
const INPUT_CLASS =
  "min-h-11 w-full rounded-card border border-line bg-surface px-3 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

// Money ALWAYS shown with its currency: the ISO 4217 code sits directly on the figure,
// so a multi-currency view never leaves a bare "$" ambiguous.
function money(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

// The shared budget total in plain copy (an unset budget reads as plain words, never a
// null placeholder).
function budgetTotalText(household: HouseholdPageData): string {
  if (household.monthlyBudget === null) return "No budget set yet";
  return `${money(household.monthlyBudget, household.currency)} per month`;
}

// The caller's OWN monthly limit in plain copy (their own figure — never another
// member's).
function ownLimitText(household: HouseholdPageData): string {
  if (household.ownLimit === null) return "No limit set yet";
  return `${money(household.ownLimit, household.currency)} per month`;
}

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
      {children}
    </label>
  );
}

export function HouseholdView({
  household,
  currentUserId,
  currencyOptions,
  inviteAction,
  editAddressAction,
  followChoiceAction,
  budgetAction,
  limitAction,
  currencyAction,
  removeMemberAction,
  leaveAction,
  transferAction,
  closeAction,
}: HouseholdViewProps) {
  const isOwner = currentUserId === household.ownerId;
  // The non-owner members — the candidates the owner may remove or transfer to.
  const otherMembers = household.members.filter((m) => m.userId !== household.ownerId);
  // At least the current currency is always a choice, so the currency control is never
  // offered with nothing selectable.
  const options =
    currencyOptions && currencyOptions.length > 0 ? currencyOptions : [household.currency];

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Household</h1>

      {/* ----- The member list: an entry for every member, marking the owner. ----- */}
      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-fg">Members</h2>
        <Card>
          <ul className="flex flex-col gap-2">
            {household.members.map((member) => {
              const memberIsOwner = member.userId === household.ownerId;
              const memberIsYou = member.userId === currentUserId;
              return (
                <li
                  key={member.userId}
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-fg">{member.userId}</span>
                    {memberIsYou ? <span className="text-sm text-fg-muted">(You)</span> : null}
                    <span className="rounded-card border border-line bg-surface-muted px-2 py-0.5 text-xs font-medium text-fg-muted">
                      {memberIsOwner ? "Owner" : "Member"}
                    </span>
                  </span>
                  {/* Remove a member — the owner's alone, and only ever a non-owner
                      member (the owner cannot remove themselves). */}
                  {isOwner && !memberIsOwner ? (
                    <form action={removeMemberAction}>
                      <input type="hidden" name="member-id" value={member.userId} />
                      <Button variant="secondary" type="submit">
                        Remove member
                      </Button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      {/* ----- The shared address: a live editor for the owner AND any member. ----- */}
      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-fg">Shared address</h2>
        <form action={editAddressAction} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="shared-address">The one address everyone in the household shares</Label>
            <input
              id="shared-address"
              name="shared-address"
              type="text"
              defaultValue={household.sharedAddress?.current ?? ""}
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <Button type="submit">Save address</Button>
          </div>
        </form>

        {/* The "use the household address" follow choice — for every member, reflecting
            the caller's current choice. */}
        <form action={followChoiceAction} className="flex flex-col gap-3">
          <label className="flex items-start gap-3 rounded-card border border-line bg-surface p-3">
            <input
              type="checkbox"
              name="follow-household-address"
              defaultChecked={household.followChoice}
              className="mt-1 h-4 w-4 shrink-0 accent-accent"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium text-fg">Use the household address</span>
              <span className="text-sm text-fg-muted">
                Your vault postal address follows the shared one. Turn it off to keep your own.
              </span>
            </span>
          </label>
          <div>
            <Button variant="secondary" type="submit">
              Save address choice
            </Button>
          </div>
        </form>
      </div>

      {/* ----- Household budget total — shown to every member. TOTALS ONLY: the shared
              budget and the caller's OWN limit, never another member's figure. ----- */}
      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-fg">Budget</h2>
        <Card className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-fg">Household budget</span>
            <span className="font-medium text-fg">{budgetTotalText(household)}</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
            <span className="text-fg">Your monthly limit</span>
            <span className="text-sm text-fg-muted">{ownLimitText(household)}</span>
          </div>
          <p className="text-sm text-fg-muted">
            Shared totals only — no one sees another member&apos;s merchants or entries.
          </p>
        </Card>
      </div>

      {/* ----- Owner-only management: invite, budget, per-member limit, currency,
              transfer and close. A non-owner gets none of these (absent). ----- */}
      {isOwner ? (
        <div className="flex flex-col gap-6">
          <h2 className="text-lg font-semibold text-fg">Manage the household</h2>

          {/* Invite a member by email. */}
          <form action={inviteAction} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-email">Invite a member by email</Label>
              <input
                id="invite-email"
                name="invite-email"
                type="email"
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <Button type="submit">Send invite</Button>
            </div>
            {household.pendingInvites.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {household.pendingInvites.map((invite) => (
                  <li key={invite.email} className="text-sm text-fg-muted">
                    {invite.email} — invited, awaiting sign-up
                  </li>
                ))}
              </ul>
            ) : null}
          </form>

          {/* The shared monthly household budget (in the household currency). */}
          <form action={budgetAction} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="household-budget">Household budget ({household.currency})</Label>
              <input
                id="household-budget"
                name="household-budget"
                type="number"
                min={0}
                step="0.01"
                defaultValue={household.monthlyBudget ?? ""}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <Button variant="secondary" type="submit">
                Save budget
              </Button>
            </div>
          </form>

          {/* Each member's monthly limit (in the household currency). */}
          <form action={limitAction} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="member-limit">Monthly limit per member ({household.currency})</Label>
              <input
                id="member-limit"
                name="member-limit"
                type="number"
                min={0}
                step="0.01"
                defaultValue={household.ownLimit ?? ""}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <Button variant="secondary" type="submit">
                Save limit
              </Button>
            </div>
          </form>

          {/* The household currency every figure is in. */}
          <form action={currencyAction} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="household-currency">Household currency</Label>
              <select
                id="household-currency"
                name="household-currency"
                defaultValue={household.currency}
                className={SELECT_CLASS}
              >
                {options.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Button variant="secondary" type="submit">
                Save currency
              </Button>
            </div>
          </form>

          {/* Transfer ownership — the new owner must accept. Offered only when there is
              someone to transfer to, so it is never a dead control. */}
          {otherMembers.length > 0 ? (
            <form action={transferAction} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="transfer-to">Transfer ownership to</Label>
                <select id="transfer-to" name="transfer-to" className={SELECT_CLASS}>
                  {otherMembers.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.userId}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-sm text-fg-muted">
                The new owner has to accept before ownership changes.
              </p>
              {household.pendingTransfer ? (
                <p className="text-sm text-fg-muted">
                  Transfer to {household.pendingTransfer.toUserId} is awaiting their acceptance.
                </p>
              ) : null}
              <div>
                <Button variant="secondary" type="submit">
                  Transfer ownership
                </Button>
              </div>
            </form>
          ) : null}

          {/* Close the household. */}
          <form action={closeAction} className="flex flex-col gap-3">
            <p className="text-sm text-fg-muted">
              Closing the household removes the shared budget, limits and address for everyone.
            </p>
            <div>
              <Button variant="secondary" type="submit">
                Close household
              </Button>
            </div>
          </form>
        </div>
      ) : (
        // A non-owner member can leave the household.
        <form action={leaveAction} className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-fg">Leave</h2>
          <p className="text-sm text-fg-muted">
            Only the owner manages the budget, limits, currency and membership. You can leave at any
            time.
          </p>
          <div>
            <Button variant="secondary" type="submit">
              Leave household
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

export default HouseholdView;
