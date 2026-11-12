// E15-S14 — Household page actions (the injectable seam the thin household `page.tsx`
// loader + its server-action wrappers compose).
//
// The Household screen reads the shared household state server-side and mounts the
// controls (brief "Household sharing"; design §4.1 / §8). This factory is the testable
// core behind those controls: load the caller's OWN household report, create a
// household, invite a member, remove one, leave, transfer / accept / close ownership,
// edit the one shared address, set the budget / a member's limit / the currency, and
// choose whether to follow the shared address.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next App-Router `page.tsx`
// entry may export ONLY its framework fields, so the injectable, unit-testable seam —
// the `createHouseholdActions(deps)` factory the loader composes and binds its server
// actions over — cannot live there without breaking `next build` (OBS-025). The testable
// logic lives in this plain sibling (the convention's `createXActions(deps)` pattern, the
// same shape as `createRulesActions` / `createSpendingActions` / `createLifeAdminActions`).
//
// Security (each a reviewer veto; CLAUDE.md member scope + design §5):
//   • Every method takes the person's VERIFIED Session and derives the acting user id from
//     `session.userId` — NEVER a client value. The caller's household is resolved FROM the
//     session user id alone (getHouseholdForMember); NO household id is ever accepted from
//     the client, so a signed-in person acts only on their OWN household and only ever on a
//     member OF it. A cross-household member id resolves to no member and is refused.
//   • The owner-only mutations (budget, member limit, currency, remove, transfer, close)
//     gate on the caller BEING the owner — a non-owner is refused with a plain reason and
//     nothing changes. editSharedAddress / setAddressFollow are open to any member;
//     leaveHousehold is for a non-owner (the owner must transfer or close first).
//   • A mis-shaped member id (not a well-formed uuid — household ids are uuids, so this is
//     the OBS-049 defence the AC's "positive integer" wording stands in for) is rejected at
//     the validation boundary with a 4xx HttpError (parseParams) BEFORE it can reach
//     `WHERE user_id = $N` as a cast; a malformed / oversized input (a non-numeric amount,
//     an oversized address / currency / email) is likewise a 4xx, so nothing is written.
//   • Every statement the stores issue is parameterized (INV-102), so a SQL-shaped value
//     travels as a BOUND value and cannot alter a query.
//   • The actions run purely from their injected seams (db, keyWrapper, clock, random,
//     notify, email, publicBaseUrl): they read no `process.env` and hold no secret
//     (INV-103), so no ambient env value lands in a result or in stored household content.

import { z } from "zod";

import { parseParams } from "@/server/http/validate";
import {
  createHousehold as storeCreateHousehold,
  getHouseholdForMember,
  removeMember as storeRemoveMember,
  leaveHousehold as storeLeaveHousehold,
  transferOwnership as storeTransferOwnership,
  acceptOwnership as storeAcceptOwnership,
  closeHousehold as storeCloseHousehold,
  setHouseholdBudget as storeSetHouseholdBudget,
  setMemberLimit as storeSetMemberLimit,
  setHouseholdCurrency as storeSetHouseholdCurrency,
} from "@/server/db/households";
import {
  setSharedAddress,
  setFollowChoice,
  type SharedAddressNotifier,
} from "@/server/db/household-shared-address";
import { issueInvite, InviteRefusedError, type IssuedInvite } from "@/server/db/household-invites";
import { isKnownCurrency } from "@/server/db/account-currency";
import { ensureHouseholdKey } from "@/server/household/household-key";
import { readHouseholdPageData, type HouseholdPageData as HouseholdReport } from "@/server/household/page-data";
import { getUserById } from "@/server/db/users";
import type { Session } from "@/server/auth/session";
import type { Clock } from "@/server/seams/clock";
import type { Random } from "@/server/seams/random";
import type { KeyWrapper } from "@/server/crypto/key-wrapper";
import type { EmailSender } from "@/server/notify/senders";
import type { Db } from "@/server/db/index";

// The injected seams — no process.env (INV-103). `keyWrapper` wraps/unwraps the HOUSEHOLD's
// data key the shared address is encrypted under; `clock` is the invite-window / page-read
// "now" (never SQL now()); `random` draws the invite token and a new household key;
// `notify` is the shared-address edit notifier;
// `email` delivers the invite link (the single message carrying it); `publicBaseUrl` is the
// configured public origin the invite link is built on (never the request host).
export interface HouseholdActionsDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  readonly clock: Clock;
  readonly random: Random;
  readonly notify: SharedAddressNotifier;
  readonly email: EmailSender;
  readonly publicBaseUrl: string;
}

// A mutation's result: success, or a refusal naming its reason (never a silent success).
// The page maps the reason to plain copy.
export type ActionResult = { ok: true } | { ok: false; reason: string };

// The household report the page renders: the shared-items-only read, with each member (and
// a pending transfer's target) identified by their account email — the address the owner
// invited them with — so the member list never shows an internal id. Nothing else about
// another member is added: no name from their vault, no limit, no spending.
export type HouseholdPageData = Omit<HouseholdReport, "members" | "pendingTransfer"> & {
  readonly members: Array<HouseholdReport["members"][number] & { readonly email: string | null }>;
  readonly pendingTransfer: (NonNullable<HouseholdReport["pendingTransfer"]> & { readonly toEmail: string | null }) | null;
};

// An amount typed into a budget or limit field: null when the field was left empty (or holds
// only spaces) — a missing amount, never a budget of 0 — otherwise the number, which the
// boundary then validates (a non-number or a negative is a 4xx).
export function amountInput(raw: FormDataEntryValue | null): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return Number(raw.trim());
}

// What createHousehold optionally takes: a starting currency (defaults to the owner's
// account currency when omitted). The owner is always the SESSION user, never a client id.
export interface CreateHouseholdInput {
  readonly currency?: string;
}

export interface HouseholdActions {
  // The caller's OWN household report (member-scoped by `session.userId`, never a client
  // value), or null when the caller is in no household — the data the loader mounts the
  // view over. READ-ONLY.
  load(session: Session): Promise<HouseholdPageData | null>;
  // Make a household owned by the session user; a person already in a household is refused.
  createHousehold(session: Session, input?: CreateHouseholdInput): Promise<ActionResult>;
  // OWNER-only: invite a newcomer by email — issue the invite and deliver the link; a
  // non-owner is refused and nothing is sent, as is an invite past the household's free
  // places or its hourly allowance. A malformed / oversized email is a 4xx.
  inviteMember(session: Session, input: { email: string }): Promise<ActionResult>;
  // OWNER-only: remove a member of the owner's own household (a mis-shaped id is a 4xx).
  removeMember(session: Session, input: { memberId: string }): Promise<ActionResult>;
  // A NON-owner leaves on their own; the owner is refused (transfer or close first).
  leaveHousehold(session: Session): Promise<ActionResult>;
  // OWNER-only: record a pending transfer to a member of the owner's household.
  transferOwnership(session: Session, input: { toUserId: string }): Promise<ActionResult>;
  // The named pending target accepts — ownership moves; anyone else is refused.
  acceptOwnership(session: Session): Promise<ActionResult>;
  // OWNER-only: close the household (the shared container is gone for everyone).
  closeHousehold(session: Session): Promise<ActionResult>;
  // ANY member: edit the one shared address (encrypted under the HOUSEHOLD's data key, so
  // every member's read decrypts it and an ownership transfer never strands it). An
  // oversized value is a 4xx.
  editSharedAddress(
    session: Session,
    input: { current: string; upcoming?: string | null; movingOn?: string | null },
  ): Promise<ActionResult>;
  // OWNER-only: set the shared monthly household budget (a non-numeric amount is a 4xx).
  setHouseholdBudget(session: Session, input: { monthlyBudget: number }): Promise<ActionResult>;
  // OWNER-only: set a member's monthly limit (a mis-shaped id / non-numeric amount is a 4xx).
  setMemberLimit(session: Session, input: { memberId: string; monthlyLimit: number }): Promise<ActionResult>;
  // OWNER-only: set the household currency (an oversized value is a 4xx; an unknown code is
  // refused with a plain reason, the stored currency left unchanged).
  setHouseholdCurrency(session: Session, input: { currency: string }): Promise<ActionResult>;
  // ANY member: choose whether their vault postal address follows the shared one.
  setAddressFollow(session: Session, input: { follow: boolean }): Promise<ActionResult>;
}

// The refusal reasons (mapped to copy by the page). Any non-empty string satisfies the
// "plain reason" contract; named constants keep the vocabulary in one place.
const NO_HOUSEHOLD = "no_household";
const NOT_A_MEMBER = "not_a_member";
const NOT_OWNER = "not_owner";
const ALREADY_IN_HOUSEHOLD = "already_in_household";
const UNKNOWN_CURRENCY = "unknown_currency";
// The invite store's limits (review fix W3.1): no free place left for another open invite,
// or the household's hourly invite allowance is spent.
const INVITE_REFUSALS = { no_room: "invite_no_room", throttled: "invite_throttled" } as const;

// The one shape a member id may take: a well-formed uuid. A malformed value ("42", "",
// "   ", an injection probe) is rejected at the boundary with a 4xx (parseParams throws an
// HttpError) BEFORE it can reach `WHERE user_id = $N` as a cast (OBS-049 / INV-102).
const uuidSchema = z.uuid();

// Bounds that reject a payload masquerading as a value: an email, an address and a currency
// are each a short field, not a document. An oversized value is a 4xx at the boundary.
const MAX_EMAIL = 320; // RFC 5321 maximum
const MAX_ADDRESS = 2000; // a postal address, generously bounded
const MAX_CURRENCY = 3; // an ISO 4217 code is three letters; the store checks validity

// The per-action input schemas (validated BEFORE any query, so a rejected call writes
// nothing). A money amount must be a non-negative number; an unknown-but-well-formed
// currency passes the shape here and is refused by the store's known-set check.
const inviteSchema = z.object({ email: z.email().max(MAX_EMAIL) });
const memberIdSchema = z.object({ memberId: uuidSchema });
const transferSchema = z.object({ toUserId: uuidSchema });
const budgetSchema = z.object({ monthlyBudget: z.number().min(0) });
const memberLimitSchema = z.object({ memberId: uuidSchema, monthlyLimit: z.number().min(0) });
const currencySchema = z.string().min(1).max(MAX_CURRENCY);
const currencyInputSchema = z.object({ currency: currencySchema });
const followSchema = z.object({ follow: z.boolean() });
// The address is trimmed before it is checked, so one made only of spaces is refused (a 4xx)
// rather than saved as a blank shared address.
const editAddressSchema = z.object({
  current: z.string().trim().min(1).max(MAX_ADDRESS),
  upcoming: z.string().max(MAX_ADDRESS).nullish(),
  movingOn: z.iso.date().nullish(),
});

// The invite email's body — a fixed nudge carrying NO personal content (the link is the one
// thing that matters); the invited person opens it to accept.
const INVITE_BODY = "You've been invited to join a household on Warthog. Open the link to accept.";

export function createHouseholdActions(deps: HouseholdActionsDeps): HouseholdActions {
  const { db, keyWrapper, clock, random, notify, email, publicBaseUrl } = deps;

  // The household's own data key (created on first use, re-encrypting a pre-existing
  // shared address under it) — the shared address is encrypted under it, so an edit by ANY
  // member stores ciphertext every member's read decrypts, whoever owns the household.
  function householdKey(householdId: string): Promise<Uint8Array> {
    return ensureHouseholdKey(householdId, { db, keyWrapper, random });
  }

  // The caller's own household report (member-scoped by the session), with every member
  // named by their account email. A member whose row is missing reads as null (the view
  // then says "Household member"), never as their id.
  async function load(session: Session): Promise<HouseholdPageData | null> {
    const report = await readHouseholdPageData(session.userId, { db, keyWrapper, clock });
    if (!report) return null;
    const emails = new Map<string, string | null>();
    for (const member of report.members) emails.set(member.userId, (await getUserById(db, member.userId))?.email ?? null);
    return {
      ...report,
      members: report.members.map((member) => ({ ...member, email: emails.get(member.userId) ?? null })),
      pendingTransfer: report.pendingTransfer
        ? { ...report.pendingTransfer, toEmail: emails.get(report.pendingTransfer.toUserId) ?? null }
        : null,
    };
  }

  async function createHousehold(session: Session, input?: CreateHouseholdInput): Promise<ActionResult> {
    // A person belongs to exactly one household — a second create is refused, unchanged.
    if (await getHouseholdForMember(db, session.userId)) {
      return { ok: false, reason: ALREADY_IN_HOUSEHOLD };
    }
    let currency: string | undefined;
    if (input?.currency !== undefined) {
      currency = parseParams(currencySchema, input.currency);
      if (!isKnownCurrency(currency)) return { ok: false, reason: UNKNOWN_CURRENCY };
    }
    const household = await storeCreateHousehold(db, { ownerId: session.userId, currency });
    // Give the new household its data key up front, so shared content is never written
    // under a person's key.
    await householdKey(household.id);
    return { ok: true };
  }

  async function inviteMember(session: Session, input: { email: string }): Promise<ActionResult> {
    const { email: recipient } = parseParams(inviteSchema, input);
    const household = await getHouseholdForMember(db, session.userId);
    if (!household) return { ok: false, reason: NO_HOUSEHOLD };
    // Owner-only to ISSUE — the invite store does not re-check this (its job is the token
    // lifecycle), so the gate lives here, against the session user id (never a client value).
    if (household.ownerId !== session.userId) return { ok: false, reason: NOT_OWNER };

    // The store refuses past the household's free places or its hourly allowance; then
    // nothing is stored and nothing is sent.
    let invite: IssuedInvite;
    try {
      invite = await issueInvite(db, { householdId: household.id, email: recipient }, { clock, random });
    } catch (error) {
      if (error instanceof InviteRefusedError) return { ok: false, reason: INVITE_REFUSALS[error.reason] };
      throw error;
    }
    // The link is built on the CONFIGURED public origin, never the request host; it carries
    // the raw token exactly once, in this single delivering message.
    const link = `${publicBaseUrl}/household/join/${invite.token}`;
    await email.sendEmail({ recipient, body: INVITE_BODY, link });
    return { ok: true };
  }

  async function removeMember(session: Session, input: { memberId: string }): Promise<ActionResult> {
    const { memberId } = parseParams(memberIdSchema, input);
    const household = await getHouseholdForMember(db, session.userId);
    if (!household) return { ok: false, reason: NO_HOUSEHOLD };
    const result = await storeRemoveMember(db, {
      householdId: household.id,
      actorId: session.userId,
      userId: memberId,
    });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  async function leaveHousehold(session: Session): Promise<ActionResult> {
    const household = await getHouseholdForMember(db, session.userId);
    if (!household) return { ok: false, reason: NOT_A_MEMBER };
    const result = await storeLeaveHousehold(db, { householdId: household.id, userId: session.userId });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  async function transferOwnership(session: Session, input: { toUserId: string }): Promise<ActionResult> {
    const { toUserId } = parseParams(transferSchema, input);
    const household = await getHouseholdForMember(db, session.userId);
    if (!household) return { ok: false, reason: NO_HOUSEHOLD };
    const result = await storeTransferOwnership(db, {
      householdId: household.id,
      actorId: session.userId,
      toUserId,
    });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  async function acceptOwnership(session: Session): Promise<ActionResult> {
    const household = await getHouseholdForMember(db, session.userId);
    if (!household) return { ok: false, reason: NO_HOUSEHOLD };
    // Move any shared content still under the CURRENT owner's DEK (a household from before
    // household keys) onto the household key BEFORE ownership moves, while that owner's DEK
    // is still the one it is encrypted under. A no-op once the household has its key.
    if (household.pendingOwnerId === session.userId) await householdKey(household.id);
    const result = await storeAcceptOwnership(db, { householdId: household.id, userId: session.userId });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  async function closeHousehold(session: Session): Promise<ActionResult> {
    const household = await getHouseholdForMember(db, session.userId);
    if (!household) return { ok: false, reason: NO_HOUSEHOLD };
    const result = await storeCloseHousehold(db, { householdId: household.id, actorId: session.userId });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  async function editSharedAddress(
    session: Session,
    input: { current: string; upcoming?: string | null; movingOn?: string | null },
  ): Promise<ActionResult> {
    const parsed = parseParams(editAddressSchema, input);
    const household = await getHouseholdForMember(db, session.userId);
    if (!household) return { ok: false, reason: NOT_A_MEMBER };
    const key = await householdKey(household.id);
    const result = await setSharedAddress(
      db,
      {
        householdId: household.id,
        actorId: session.userId,
        current: parsed.current,
        upcoming: parsed.upcoming ?? null,
        movingOn: parsed.movingOn ?? null,
      },
      key,
      { notify },
    );
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  async function setHouseholdBudget(session: Session, input: { monthlyBudget: number }): Promise<ActionResult> {
    const { monthlyBudget } = parseParams(budgetSchema, input);
    const household = await getHouseholdForMember(db, session.userId);
    if (!household) return { ok: false, reason: NO_HOUSEHOLD };
    const result = await storeSetHouseholdBudget(db, {
      householdId: household.id,
      actorId: session.userId,
      monthlyBudget,
    });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  async function setMemberLimit(
    session: Session,
    input: { memberId: string; monthlyLimit: number },
  ): Promise<ActionResult> {
    const { memberId, monthlyLimit } = parseParams(memberLimitSchema, input);
    const household = await getHouseholdForMember(db, session.userId);
    if (!household) return { ok: false, reason: NO_HOUSEHOLD };
    const result = await storeSetMemberLimit(db, {
      householdId: household.id,
      actorId: session.userId,
      userId: memberId,
      monthlyLimit,
    });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  async function setHouseholdCurrency(session: Session, input: { currency: string }): Promise<ActionResult> {
    const { currency } = parseParams(currencyInputSchema, input);
    const household = await getHouseholdForMember(db, session.userId);
    if (!household) return { ok: false, reason: NO_HOUSEHOLD };
    const result = await storeSetHouseholdCurrency(db, {
      householdId: household.id,
      actorId: session.userId,
      currency,
    });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  async function setAddressFollow(session: Session, input: { follow: boolean }): Promise<ActionResult> {
    const { follow } = parseParams(followSchema, input);
    const household = await getHouseholdForMember(db, session.userId);
    if (!household) return { ok: false, reason: NOT_A_MEMBER };
    const result = await setFollowChoice(db, { householdId: household.id, userId: session.userId, follow });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  }

  return {
    load,
    createHousehold,
    inviteMember,
    removeMember,
    leaveHousehold,
    transferOwnership,
    acceptOwnership,
    closeHousehold,
    editSharedAddress,
    setHouseholdBudget,
    setMemberLimit,
    setHouseholdCurrency,
    setAddressFollow,
  };
}
