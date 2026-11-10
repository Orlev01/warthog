import { notificationSenders } from "../../../../server/notify/production";
import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Notice as InlineNotice } from "@/components/ui/notice";

import { HouseholdView } from "@/components/household/household-view";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { getUserById } from "@/server/db/users";
import { KNOWN_CURRENCIES } from "@/server/db/account-currency";
import { verifySession, type Session } from "@/server/auth/session";
import { systemClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import {
  selectSenders,
  type Senders,
  type OutgoingMessage,
} from "@/server/notify/senders";
import type { SharedAddressNotifier } from "@/server/db/household-shared-address";
import { HttpError } from "@/server/http/validate";
import type { Db } from "@/server/db/index";
import { createHouseholdActions, type ActionResult } from "./actions";

// E15-S14 — Household page (the thin protected-page loader over the tested
// `createHouseholdActions` seam, `./actions`) wired to its controls.
//
// The loader reads the signed-in session from the host-locked `__Host-wh_session`
// cookie, turns it (via the seam's `load`) into the caller's OWN member-scoped household
// report — the shared address, currency, budget, the caller's own limit + follow choice,
// the roster, any pending transfer and any still-open invites — and mounts the
// render-tested <HouseholdView/>. A person in no household is offered the create control.
//
// Each control submits a native <form action={…}>: a thin `"use server"` wrapper
// re-derives the verified session (never trusting a client value, design §5), calls the
// seam member-scoped to that session person, and redirects back with a `?notice=` code
// this page maps to plain words — a refusal (a non-owner mutation, a mis-shaped id) or a
// boundary 4xx is shown, never swallowed (no silent failure, no dead control).
//
// Thin by design (the server-composition-roots addendum): per-request data (the session
// cookie, the `?notice=` search param) is read BEFORE `getServerDb()` so `next build`
// marks the page dynamic and never prerenders it or opens the database at build time;
// config is read INSIDE each handler (`loadConfig()`), never at module load; the database
// comes from the process-wide `getServerDb()`, never `createDb`, and the shared handle is
// never closed. Config and secrets flow only through `loadConfig()` (INV-103).

const SESSION_COOKIE = "__Host-wh_session";
const SCREEN = "/household";

// Real senders stand-in: until the Azure channel senders are built, sending through one
// rejects loudly rather than dropping the message (constitution: never fail silently).
// With dev tooling on, `selectSenders` routes every channel to the dev outbox instead.


// The shared-address edit notifier seam: a member's shared-address change nudges every
// OTHER member. Resolve the member's own email and deliver a fixed, personal-content-free
// body through the configured sender (the dev outbox in dev); a member with no row is
// skipped rather than crashing the edit.
function buildSharedAddressNotifier(db: Db, senders: Senders): SharedAddressNotifier {
  return {
    async notifyMember({ userId, body }) {
      const member = await getUserById(db, userId);
      if (!member) return;
      await senders.email.sendEmail({ recipient: member.email, body });
    },
  };
}

// Build the household actions with the real seams. The KeyWrapper (local AES outside
// production, Key Vault in production) unwraps the OWNER's DEK to en/decrypt the shared
// address; the configured senders carry the invite link and the shared-address nudge.
function buildActions(db: Db) {
  const config = loadConfig();
  const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  const senders = notificationSenders(config, db);
  return createHouseholdActions({
    db,
    keyWrapper,
    clock: systemClock,
    random: systemRandom,
    notify: buildSharedAddressNotifier(db, senders),
    email: senders.email,
    publicBaseUrl: config.publicBaseUrl,
  });
}

// Resolve the signed-in session from the cookie (or null), re-derived wherever it is
// needed so no handler trusts a client value for identity (design §5).
async function resolveSession(db: Db): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// Where a finished form action sends the person: back to the screen with the success
// code, the refusal's reason, or `invalid_request` for a boundary 4xx. Anything else is a
// genuine server fault and is rethrown, never dressed up as a notice.
function noticeLocation(successCode: string, outcome: ActionResult | unknown): string {
  if (outcome instanceof HttpError) return `${SCREEN}?notice=invalid_request`;
  if (outcome instanceof Error) throw outcome;
  const result = outcome as ActionResult;
  const code = result.ok ? successCode : result.reason;
  return `${SCREEN}?notice=${encodeURIComponent(code)}`;
}

// --- the wired server actions (thin wrappers over the tested seam) --------------------

async function createHouseholdAction(_formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) redirect("/signin");
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).createHousehold(session);
  } catch (error) {
    outcome = error;
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("household_created", outcome));
}

async function inviteMemberAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) redirect("/signin");
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).inviteMember(session, {
      email: String(formData.get("invite-email") ?? ""),
    });
  } catch (error) {
    outcome = error;
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("invite_sent", outcome));
}

async function editAddressAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) redirect("/signin");
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).editSharedAddress(session, {
      current: String(formData.get("shared-address") ?? ""),
    });
  } catch (error) {
    outcome = error;
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("address_saved", outcome));
}

async function followChoiceAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) redirect("/signin");
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).setAddressFollow(session, {
      follow: formData.get("follow-household-address") != null,
    });
  } catch (error) {
    outcome = error;
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("address_choice_saved", outcome));
}

async function budgetAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) redirect("/signin");
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).setHouseholdBudget(session, {
      monthlyBudget: Number(formData.get("household-budget")),
    });
  } catch (error) {
    outcome = error;
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("budget_saved", outcome));
}

async function limitAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) redirect("/signin");
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).setMemberLimit(session, {
      memberId: String(formData.get("member-id") ?? session.userId),
      monthlyLimit: Number(formData.get("member-limit")),
    });
  } catch (error) {
    outcome = error;
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("limit_saved", outcome));
}

async function currencyAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) redirect("/signin");
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).setHouseholdCurrency(session, {
      currency: String(formData.get("household-currency") ?? ""),
    });
  } catch (error) {
    outcome = error;
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("currency_saved", outcome));
}

async function removeMemberAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) redirect("/signin");
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).removeMember(session, {
      memberId: String(formData.get("member-id") ?? ""),
    });
  } catch (error) {
    outcome = error;
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("member_removed", outcome));
}

async function leaveAction(_formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) redirect("/signin");
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).leaveHousehold(session);
  } catch (error) {
    outcome = error;
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("left_household", outcome));
}

async function transferAction(formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) redirect("/signin");
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).transferOwnership(session, {
      toUserId: String(formData.get("transfer-to") ?? ""),
    });
  } catch (error) {
    outcome = error;
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("transfer_started", outcome));
}

async function acceptOwnershipAction(_formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) redirect("/signin");
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).acceptOwnership(session);
  } catch (error) {
    outcome = error;
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("ownership_accepted", outcome));
}

async function closeAction(_formData: FormData): Promise<void> {
  "use server";
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) redirect("/signin");
  let outcome: ActionResult | unknown;
  try {
    outcome = await buildActions(db).closeHousehold(session);
  } catch (error) {
    outcome = error;
  }
  revalidatePath(SCREEN);
  redirect(noticeLocation("household_closed", outcome));
}

// --- the outcome notice (plain words + an icon, never colour alone) -------------------

type Notice = { tone: "done" | "problem"; text: string };

// Plain Australian English, no protocol jargon (brief design_ux.copy). Unknown codes
// render nothing, so the query string can never inject copy onto the screen.
const NOTICES: Record<string, Notice> = {
  household_created: { tone: "done", text: "Your household is set up. Invite the people you share with." },
  invite_sent: { tone: "done", text: "Invite sent — they'll get a link to join your household." },
  address_saved: { tone: "done", text: "The shared address is saved." },
  address_choice_saved: { tone: "done", text: "Your address choice is saved." },
  budget_saved: { tone: "done", text: "The household budget is saved." },
  limit_saved: { tone: "done", text: "The member limit is saved." },
  currency_saved: { tone: "done", text: "The household currency is saved." },
  member_removed: { tone: "done", text: "That member has been removed from the household." },
  left_household: { tone: "done", text: "You've left the household." },
  transfer_started: { tone: "done", text: "Transfer started — it takes effect once they accept." },
  ownership_accepted: { tone: "done", text: "You're now the household owner." },
  household_closed: { tone: "done", text: "The household is closed." },
  joined: { tone: "done", text: "You've joined the household." },
  invalid: { tone: "problem", text: "That invite link isn't valid any more — it may already have been used." },
  expired: { tone: "problem", text: "That invite link has expired. Ask the household owner for a new one." },
  wrong_account: {
    tone: "problem",
    text: "That invite was sent to a different email address. Sign in with that account to join.",
  },
  household_full: { tone: "problem", text: "That household already has the most members it can have (8)." },
  invite_no_room: {
    tone: "problem",
    text: "No invite was sent: a household has room for 8 people, and the open invites already fill the free places.",
  },
  invite_throttled: { tone: "problem", text: "No invite was sent: you've sent a lot of invites this hour. Try again later." },
  not_owner: { tone: "problem", text: "Only the household owner can do that." },
  not_a_member: { tone: "problem", text: "You're not a member of a household." },
  no_household: { tone: "problem", text: "You're not in a household yet." },
  already_in_household: { tone: "problem", text: "You're already in a household." },
  owner_cannot_leave: {
    tone: "problem",
    text: "As the owner you can't leave — transfer ownership or close the household first.",
  },
  no_pending_transfer: { tone: "problem", text: "There's no ownership transfer waiting for you to accept." },
  unknown_currency: { tone: "problem", text: "Nothing was changed: that isn't a currency we recognise." },
  invalid_request: { tone: "problem", text: "Nothing was changed: that request wasn't valid. Please try again." },
};

function householdNotice(code: string | undefined): Notice | null {
  return (code !== undefined && Object.hasOwn(NOTICES, code) && NOTICES[code]) || null;
}

function NoticeBanner({ notice }: { notice: Notice }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-8 sm:px-6">
      <InlineNotice tone={notice.tone === "done" ? "success" : "error"}>{notice.text}</InlineNotice>
    </div>
  );
}

// Offered to a person in no household: the one control that starts one they own.
function CreateHouseholdPrompt() {
  return (
    <section className="wh-page wh-page--reading flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Household</h1>
      <Card className="flex flex-col gap-3">
        <p className="text-fg">
          You're not in a household yet. Create one to share a postal address, a monthly budget and
          per-member limits with the people you live with.
        </p>
        <form action={createHouseholdAction}>
          <Button type="submit">Create a household</Button>
        </form>
      </Card>
    </section>
  );
}

// Offered to the named target of a pending transfer: the control that accepts ownership —
// the view carries no accept slot, so this sits alongside it (never a dead control).
function AcceptOwnershipPrompt() {
  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-3 px-4 pb-8 sm:px-6">
      <Card className="flex flex-col gap-3">
        <p className="text-fg">The current owner has asked to transfer this household to you.</p>
        <form action={acceptOwnershipAction}>
          <Button type="submit">Accept ownership</Button>
        </form>
      </Card>
    </section>
  );
}

export default async function HouseholdPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const rawNotice = (await searchParams).notice;
  const notice = householdNotice(typeof rawNotice === "string" ? rawNotice : undefined);
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) redirect("/signin");

  const data = await buildActions(db).load(session);

  return (
    <div className="flex w-full flex-col">
      {notice ? <NoticeBanner notice={notice} /> : null}
      {data ? (
        <>
          <HouseholdView
            household={data}
            currentUserId={session.userId}
            currencyOptions={KNOWN_CURRENCIES}
            inviteAction={inviteMemberAction}
            editAddressAction={editAddressAction}
            followChoiceAction={followChoiceAction}
            budgetAction={budgetAction}
            limitAction={limitAction}
            currencyAction={currencyAction}
            removeMemberAction={removeMemberAction}
            leaveAction={leaveAction}
            transferAction={transferAction}
            closeAction={closeAction}
          />
          {data.pendingTransfer?.toUserId === session.userId ? <AcceptOwnershipPrompt /> : null}
        </>
      ) : (
        <CreateHouseholdPrompt />
      )}
    </div>
  );
}
