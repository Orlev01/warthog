"use client";

import * as React from "react";
import { DoorOpen, LogOut, Trash2, UserMinus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses, type ButtonVariant } from "@/components/ui/button";
import { Field, SelectField } from "@/components/ui/field";
import { ActionForm as GuardedForm, FormSubmit, PendingFormFields } from "@/components/ui/form-submit";
import { LIST_ROW } from "@/components/ui/list-group";
import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";

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
// Layout (the UI/UX pass): a heading band, the outcome notice, then one panel per task —
// Members, Shared address, Your postal address, Budget, and (for the owner) Invite, Budget and
// limits, Transfer ownership and Close — with each field and its Save button in the same
// panel. Members are named by their account email (the address they were invited with),
// never by an internal id. Removing a member, leaving and closing the household each ask
// first, in a danger disclosure that says what happens, before the final danger button.
//
// This is the render-testable, prop-driven VIEW (a Client Component): it renders the
// screen entirely from its props so a render test pins each behaviour without a DOM, a
// session or any server plumbing. The bound controls are guarded forms (one submission at
// a time) whose `action` is a server action the page passes. The prop shapes mirror the
// household page loader but are declared LOCALLY so the view never couples to the server
// db modules. Colour comes from the design tokens (globals.css) — never a raw hex.

export type HouseholdRole = "owner" | "member";

// One member of the household — a ROSTER entry: their id (what a form posts), their role
// and the account email they're shown by. Never another member's private figure: the read
// strips every other member's spend, limit and address, so there is none to render.
export type HouseholdMemberView = {
  userId: string;
  role: HouseholdRole;
  email?: string | null;
};

// The one shared address (decrypted). The editor edits `current`; `upcoming` /
// `movingOn` are a planned move the read may also carry.
export type SharedAddress = {
  householdId: string;
  current: string;
  upcoming: string | null;
  movingOn: Date | string | null;
};

// A pending ownership transfer: the member it would pass to on accept (and their email).
export type PendingTransferView = {
  toUserId: string;
  toEmail?: string | null;
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

// A server action a form submits to (the page binds the real one). Optional: a control
// with no bound action renders disabled with a reason (no dead control).
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
  // the outcome of the last action (a PageNotice), shown under the heading band.
  notice?: React.ReactNode;
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
  acceptOwnershipAction?: FormAction;
};

// ─── the bound-or-disabled seam ──────────────────────────────────────────────────────
//
// A control group bound to its server action, or — when the page has not bound one — the
// same controls inside a natively disabled fieldset with a one-line reason and NO <form>, so
// nothing can submit nowhere (an action-less form would GET its fields into the URL, shared
// address included). Bound forms are guarded: one submission at a time.
function HouseholdForm({
  action,
  reason,
  className,
  children,
}: {
  action?: FormAction;
  reason: string;
  className?: string;
  children: React.ReactNode;
}) {
  if (action) {
    return (
      <GuardedForm action={action} className={className}>
        {children}
      </GuardedForm>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <fieldset disabled className={className}>
        {children}
      </fieldset>
      <p className="text-sm text-fg-muted">{reason}</p>
    </div>
  );
}

// One task as one panel whose Save sits in the panel's footer: bound, the whole panel is the
// form; unbound, the fields are disabled and the footer says why (still inside the panel).
function FormPanel({
  action,
  reason,
  title,
  description,
  submit,
  pendingLabel,
  submitVariant = "secondary",
  children,
}: {
  action?: FormAction;
  reason: string;
  title: string;
  description?: React.ReactNode;
  submit: string;
  pendingLabel: string;
  submitVariant?: ButtonVariant;
  children: React.ReactNode;
}) {
  if (!action) {
    return (
      <WorkspacePanel
        title={title}
        description={description}
        footer={
          <>
            <Button variant={submitVariant} disabled>
              {submit}
            </Button>
            <span>{reason}</span>
          </>
        }
      >
        <fieldset disabled className="flex min-w-0 flex-col gap-4">
          {children}
        </fieldset>
      </WorkspacePanel>
    );
  }
  return (
    <GuardedForm action={action}>
      <WorkspacePanel
        title={title}
        description={description}
        footer={
          <FormSubmit variant={submitVariant} pendingLabel={pendingLabel}>
            {submit}
          </FormSubmit>
        }
      >
        <PendingFormFields>
          <div className="flex min-w-0 flex-col gap-4">{children}</div>
        </PendingFormFields>
      </WorkspacePanel>
    </GuardedForm>
  );
}

// A destructive step that asks first: a danger disclosure whose panel says what will
// happen, then the final danger button. Unbound, the step is disabled with its reason.
function ConfirmStep({
  action,
  reason,
  summary,
  summaryLabel,
  icon: Icon,
  warning,
  confirm,
  pendingLabel,
  hidden,
}: {
  action?: FormAction;
  reason: string;
  summary: string;
  // Extra words for a screen reader, naming what the step acts on.
  summaryLabel?: string;
  icon: typeof Trash2;
  warning: React.ReactNode;
  confirm: string;
  pendingLabel: string;
  hidden?: React.ReactNode;
}) {
  if (!action) {
    return (
      <HouseholdForm reason={reason}>
        <Button variant="danger" size="sm" disabled>
          <Icon aria-hidden={true} className="h-4 w-4 shrink-0" />
          {summary}
        </Button>
      </HouseholdForm>
    );
  }
  return (
    <details className="min-w-0 open:basis-full">
      <summary className={buttonClasses({ variant: "danger", size: "sm", className: "w-fit list-none [&::-webkit-details-marker]:hidden" })}>
        <Icon aria-hidden={true} className="h-4 w-4 shrink-0" />
        {summary}
        {summaryLabel ? <span className="sr-only"> {summaryLabel}</span> : null}
      </summary>
      <div className="mt-3 flex flex-col gap-3 rounded-card bg-surface-muted p-4">
        <div className="max-w-prose text-sm text-fg">{warning}</div>
        <GuardedForm action={action}>
          {hidden}
          <FormSubmit variant="danger-solid" size="sm" pendingLabel={pendingLabel}>
            {confirm}
          </FormSubmit>
        </GuardedForm>
      </div>
    </details>
  );
}

// ─── copy ────────────────────────────────────────────────────────────────────────────

// Money ALWAYS shown with its currency: the ISO 4217 code sits directly on the figure,
// so a multi-currency view never leaves a bare "$" ambiguous.
function money(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

// The shared budget total in plain copy (an unset budget reads as plain words, never a
// null placeholder).
function budgetTotalText(household: HouseholdPageData): string {
  if (household.monthlyBudget === null) return "No budget set yet";
  return `${money(household.monthlyBudget, household.currency)} a month`;
}

// The caller's OWN monthly limit in plain copy (their own figure — never another
// member's).
function ownLimitText(household: HouseholdPageData): string {
  if (household.ownLimit === null) return "No limit set yet";
  return `${money(household.ownLimit, household.currency)} a month`;
}

// How a member is named: their account email, or a neutral label when it isn't known —
// never their internal id.
function memberName(member: HouseholdMemberView, index: number): string {
  return member.email?.trim() || `Household member ${index + 1}`;
}

// ─── the view ────────────────────────────────────────────────────────────────────────

const ROW = `${LIST_ROW} sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-4`;

export function HouseholdView({
  household,
  currentUserId,
  currencyOptions,
  notice,
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
  acceptOwnershipAction,
}: HouseholdViewProps) {
  const isOwner = currentUserId === household.ownerId;
  const nameOf = new Map(household.members.map((member, index) => [member.userId, memberName(member, index)]));
  // The non-owner members — the candidates the owner may remove or transfer to.
  const otherMembers = household.members.filter((m) => m.userId !== household.ownerId);
  // At least the current currency is always a choice, so the currency control is never
  // offered with nothing selectable.
  const options =
    currencyOptions && currencyOptions.length > 0 ? currencyOptions : [household.currency];
  const transferTarget = household.pendingTransfer
    ? household.pendingTransfer.toEmail?.trim() || nameOf.get(household.pendingTransfer.toUserId) || "the member you chose"
    : null;
  const transferToYou = household.pendingTransfer?.toUserId === currentUserId;

  return (
    <div className="wh-page">
      <WorkspaceHeading
        title="Household"
        description="Share an address and a monthly budget with the people you live with. Everyone keeps their own account and private details."
        meta={`${household.members.length} ${household.members.length === 1 ? "member" : "members"} · ${isOwner ? "you're the owner" : "you're a member"}`}
      />
      {notice}

      {/* ----- A transfer waiting for the caller to accept. ----- */}
      {transferToYou ? (
        <WorkspacePanel
          title="Become the owner"
          description="The current owner has asked to transfer this household to you. Once you accept, you manage its members, budget, limits and currency."
          footer={
            acceptOwnershipAction ? (
              <GuardedForm action={acceptOwnershipAction}>
                <FormSubmit pendingLabel="Accepting…">Accept ownership</FormSubmit>
              </GuardedForm>
            ) : (
              <HouseholdForm reason="Accepting ownership isn't available just now.">
                <Button disabled>Accept ownership</Button>
              </HouseholdForm>
            )
          }
        />
      ) : null}

      {/* ----- The member list: an entry for every member, marking the owner. ----- */}
      <WorkspacePanel title="Members" description="Everyone in the household sees this list. Members are shown by the email address they joined with.">
        <ul role="list" className="flex min-w-0 flex-col">
          {household.members.map((member, index) => {
            const memberIsOwner = member.userId === household.ownerId;
            const memberIsYou = member.userId === currentUserId;
            const name = memberName(member, index);
            return (
              <li key={member.userId} className={ROW}>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="min-w-0 font-medium text-fg [overflow-wrap:anywhere]">{memberIsYou ? "You" : name}</span>
                  {memberIsYou && member.email ? (
                    <span className="min-w-0 text-sm text-fg-muted [overflow-wrap:anywhere]">{member.email}</span>
                  ) : null}
                  <Badge tone={memberIsOwner ? "tint" : "neutral"}>{memberIsOwner ? "Owner" : "Member"}</Badge>
                </span>
                {/* Remove a member — the owner's alone, and only ever a non-owner member
                    (the owner cannot remove themselves). It asks first. */}
                {isOwner && !memberIsOwner ? (
                  <ConfirmStep
                    action={removeMemberAction}
                    reason="Removing members isn't available just now."
                    summary="Remove"
                    summaryLabel={name}
                    icon={UserMinus}
                    warning={
                      <p>
                        Remove {name} from the household? They keep their own Warthog account, but lose the shared address and
                        stop counting towards the household budget.
                      </p>
                    }
                    confirm="Remove member"
                    pendingLabel="Removing…"
                    hidden={<input type="hidden" name="member-id" value={member.userId} />}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      </WorkspacePanel>

      {/* ----- The shared address: a live editor for the owner AND any member. ----- */}
      <FormPanel
        action={editAddressAction}
        reason="Editing the shared address isn't available just now."
        title="Shared address"
        description="The one address everyone in the household shares. Any member can change it, and the others are told when they do."
        submit="Save address"
        pendingLabel="Saving…"
        submitVariant="primary"
      >
        <Field
          label="Address"
          id="shared-address"
          name="shared-address"
          type="text"
          autoComplete="street-address"
          required
          maxLength={2000}
          defaultValue={household.sharedAddress?.current ?? ""}
        />
      </FormPanel>

      {/* The "use the household address" follow choice — for every member, reflecting the
          caller's current choice. */}
      <FormPanel
        action={followChoiceAction}
        reason="Changing whether you follow the shared address isn't available just now."
        title="Your postal address"
        submit="Save choice"
        pendingLabel="Saving…"
      >
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            name="follow-household-address"
            defaultChecked={household.followChoice}
            className="mt-1 h-4 w-4 shrink-0"
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium text-fg">Use the household address</span>
            <span className="text-sm text-fg-muted">
              Your postal address in About you follows the shared one. Turn it off to keep your own.
            </span>
          </span>
        </label>
      </FormPanel>

      {/* ----- Household budget total — shown to every member. TOTALS ONLY: the shared
              budget and the caller's OWN limit, never another member's figure. ----- */}
      <WorkspacePanel
        title="Budget"
        description="Shared totals only: no one sees another member's merchants or entries. Budgets and limits reset at the start of each month, at the same moment for everyone in the household."
      >
        <dl className="flex min-w-0 flex-col">
          <div className={ROW}>
            <dt className="font-medium text-fg">Household budget</dt>
            <dd className="font-medium text-fg">{budgetTotalText(household)}</dd>
          </div>
          <div className={ROW}>
            <dt className="text-fg">Your monthly limit</dt>
            <dd className="text-sm text-fg-muted">{ownLimitText(household)}</dd>
          </div>
        </dl>
      </WorkspacePanel>

      {/* ----- Owner-only management: invite, budget, per-member limit, currency,
              transfer and close. A non-owner gets none of these (absent). ----- */}
      {isOwner ? (
        <>
          {/* Invite a member by email. */}
          <FormPanel
            action={inviteAction}
            reason="Inviting members isn't available just now."
            title="Invite a member"
            description="They get an email with a link to join, valid for 7 days. A household has room for 8 people."
            submit="Send invite"
            pendingLabel="Sending…"
          >
            <Field
              label="Their email address"
              id="invite-email"
              name="invite-email"
              type="email"
              autoComplete="off"
              inputMode="email"
              required
              maxLength={320}
              width="text"
            />
            {household.pendingInvites.length > 0 ? (
              <div className="flex min-w-0 flex-col gap-1 border-t border-line pt-4">
                <h3 className="wh-group-title">Waiting to join</h3>
                <ul role="list" className="flex min-w-0 flex-col">
                  {household.pendingInvites.map((invite) => (
                    <li key={invite.email} className={ROW}>
                      <span className="min-w-0 text-fg [overflow-wrap:anywhere]">{invite.email}</span>
                      <span className="text-sm text-fg-muted">Invite sent</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </FormPanel>

          {/* The shared budget, a member's limit and the currency: one panel, a row each, every
              field beside its own Save. */}
          <WorkspacePanel
            title="Budget, limits and currency"
            description={`Monthly amounts, in the household currency (${household.currency}). An amount of 0 allows no spending at all.`}
          >
            <div className="flex min-w-0 flex-col">
              <HouseholdForm
                action={budgetAction}
                reason="Changing the household budget isn't available just now."
                className="flex min-w-0 flex-col gap-3 border-b border-line pb-4 sm:flex-row sm:flex-wrap sm:items-end"
              >
                <Field
                  label={`Household budget (${household.currency})`}
                  id="household-budget"
                  name="household-budget"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  required
                  defaultValue={household.monthlyBudget ?? ""}
                  width="short"
                />
                <FormSubmit variant="secondary" pendingLabel="Saving…">
                  Save budget
                </FormSubmit>
              </HouseholdForm>

              {/* Each member's monthly limit (in the household currency). */}
              <HouseholdForm
                action={limitAction}
                reason="Changing member limits isn't available just now."
                className="flex min-w-0 flex-col gap-3 border-b border-line py-4 sm:flex-row sm:flex-wrap sm:items-end"
              >
                {otherMembers.length > 0 ? (
                  <SelectField label="Limit for" id="member-limit-for" name="member-id" defaultValue={currentUserId} width="text">
                    <option value={currentUserId}>You</option>
                    {otherMembers.map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {nameOf.get(member.userId)}
                      </option>
                    ))}
                  </SelectField>
                ) : null}
                <Field
                  label={`Monthly limit (${household.currency})`}
                  id="member-limit"
                  name="member-limit"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  required
                  defaultValue={otherMembers.length > 0 ? "" : (household.ownLimit ?? "")}
                  width="short"
                />
                <FormSubmit variant="secondary" pendingLabel="Saving…">
                  Save limit
                </FormSubmit>
              </HouseholdForm>

              {/* The household currency every figure is in. */}
              <HouseholdForm
                action={currencyAction}
                reason="Changing the household currency isn't available just now."
                className="flex min-w-0 flex-col gap-3 pt-4 sm:flex-row sm:flex-wrap sm:items-end"
              >
                <SelectField
                  label="Household currency"
                  id="household-currency"
                  name="household-currency"
                  defaultValue={household.currency}
                  width="short"
                >
                  {options.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </SelectField>
                <FormSubmit variant="secondary" pendingLabel="Saving…">
                  Save currency
                </FormSubmit>
              </HouseholdForm>
            </div>
          </WorkspacePanel>

          {/* Transfer ownership — the new owner must accept. Offered only when there is
              someone to transfer to, so it is never a dead control. */}
          {otherMembers.length > 0 ? (
            <FormPanel
              action={transferAction}
              reason="Transferring ownership isn't available just now."
              title="Transfer ownership"
              description="The new owner has to accept before ownership changes. Until then, you stay the owner."
              submit="Transfer ownership"
              pendingLabel="Starting transfer…"
            >
              <SelectField label="Transfer to" id="transfer-to" name="transfer-to" width="text">
                {otherMembers.map((member) => (
                  <option key={member.userId} value={member.userId}>
                    {nameOf.get(member.userId)}
                  </option>
                ))}
              </SelectField>
              {transferTarget ? (
                <p className="text-sm text-fg-muted">The transfer to {transferTarget} is waiting for them to accept.</p>
              ) : null}
            </FormPanel>
          ) : null}

          {/* Close the household — for everyone, so it asks first. */}
          <WorkspacePanel
            title="Close the household"
            description="Closing removes the shared address, budget and limits for everyone. Every member keeps their own account."
          >
            <ConfirmStep
              action={closeAction}
              reason="Closing the household isn't available just now."
              summary="Close household"
              icon={DoorOpen}
              warning={
                <>
                  <p className="font-medium">Close the household for everyone?</p>
                  <p className="mt-1">
                    The shared address, the household budget and every member&apos;s limit are removed for everyone in the household (
                    {household.members.length} {household.members.length === 1 ? "member" : "members"}). This can&apos;t be undone; you&apos;d
                    have to start a new household and invite everyone again.
                  </p>
                </>
              }
              confirm="Close household for everyone"
              pendingLabel="Closing…"
            />
          </WorkspacePanel>
        </>
      ) : (
        // A non-owner member can leave the household (it asks first).
        <WorkspacePanel
          title="Leave the household"
          description="Only the owner manages the budget, limits, currency and membership. You can leave at any time and keep your own account."
        >
          <ConfirmStep
            action={leaveAction}
            reason="Leaving the household isn't available just now."
            summary="Leave household"
            icon={LogOut}
            warning={<p>Leave the household? You stop sharing its address and budget. To rejoin, the owner has to invite you again.</p>}
            confirm="Leave household"
            pendingLabel="Leaving…"
          />
        </WorkspacePanel>
      )}
    </div>
  );
}

export default HouseholdView;
