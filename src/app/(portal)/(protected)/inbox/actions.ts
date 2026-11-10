import { formatAccountTime } from "@/server/display-time";
import { timeZoneFor } from "@/server/spending/time-zone";
// E12-S10 — Approval decision actions (the injectable seam the thin inbox
// `page.tsx` loader + its server-action wrappers compose).
//
// The inbox lets a person decide the approvals agents are waiting on (brief
// "Approval inbox" / "Agents wait safely"; design §6). This factory is the
// testable core behind the inbox controls: approve, deny, or ask the agent for
// more detail — each a server-verified decision, never trusted from the client.
//
// Why a sibling `actions.ts` factory (not `page.tsx`): a Next `page.tsx` entry
// file may export only its framework fields, so it cannot carry an injectable,
// unit-testable seam without breaking `next build`. The thin loader renders the
// inbox; the testable decision logic lives here (the convention's
// `createXActions(deps)` pattern, the same shape as `createSecurityActions`).
//
// Security (each a reviewer veto; CLAUDE.md member scope + design §5/§6):
//   • Every method takes the person's VERIFIED Session and derives the acting
//     user id from `session.userId` — never a client-supplied value. Every read
//     and write is member-scoped by that id, so a signed-in person can never
//     decide (or even mark opened) another person's approval by its id: it
//     resolves to no row for them and is refused ({ ok: false }), never a silent
//     success and never a throw.
//   • approveApproval moves the approval to `approved`; for a held NON-release
//     call it then triggers that call's single execution via the pipeline's
//     `executeApprovedHold` (single-shot, so the held tool runs exactly once).
//     denyApproval moves it to `denied`; askForMoreDetail moves it to
//     `more_detail`, recording the person's question. Each decision also marks
//     the approval opened (the inbox view write).
//   • Approving a HIGH-TIER or CARD release is a sensitive hand-over: it requires
//     a fresh step-up (requireStepUp, 5-minute window). Without one the approval
//     is NOT approved and nothing is handed over — refused with a plain reason. A
//     release is NEVER run through the pipeline (the agent collects it via
//     `collect_release`); only a held non-release call is executed on approval.
//   • A mis-shaped approval id (not a well-formed uuid) and an empty/oversized
//     question are rejected at the validation boundary with a 4xx HttpError
//     (parseParams, OBS-049/INV-102) — never cast at `WHERE id = $1`, never a
//     500. Every statement the actions issue is parameterized, so a SQL-shaped
//     value travels as a BOUND value and cannot alter a query.
//   • The actions run purely from their injected seams (db, clock, keyWrapper,
//     executeApprovedHold): they read no `process.env` and hold no secret
//     (INV-103), so no ambient env value can leak into a result or stored content.

import { z } from "zod";

import { parseParams } from "../../../../server/http/validate";
import { requireStepUp } from "../../../../server/auth/step-up";
import {
  ApprovalAlreadyDecidedError,
  decide,
  getApproval,
  type Decision,
  type StoredApproval,
} from "../../../../server/db/approvals";
import { markOpened } from "../../../../server/approvals/opened";
import {
  readInbox,
  type PendingApproval,
  type DecidedApproval,
} from "../../../../server/approvals/inbox-read";
import { getCardCiphertext, listCards } from "../../../../server/db/cards";
import { getHighTierCiphertext, listHighTierFields } from "../../../../server/db/high-tier-fields";
import { getUserById } from "../../../../server/db/users";
import { listIdentityFields } from "../../../../server/db/identity-fields";
import { withTransaction } from "../../../../server/db/index";
import { createRedactingRecorder } from "../../../../server/mcp/recorder";
import { isReleaseRequest } from "../../../../domain/approvals/release-kind";
import { formatMoney, highTierFieldLabel } from "../../../../domain/approvals/request-sentence";
import type { Session } from "../../../../server/auth/session";
import type { Clock } from "../../../../server/seams/clock";
import type { KeyWrapper } from "../../../../server/crypto/key-wrapper";
import type { Db } from "../../../../server/db/index";
import type { ApprovedHoldResult } from "../../../../server/mcp/pipeline";
import type {
  DecidedRequestView,
  DecidedStatus,
  HighTierFieldView,
  InboxViewProps,
  PendingRequestView,
  ReleaseKind,
  RequestDetail,
  SavedCardView,
} from "../../../../components/inbox/inbox-view";

// The approval-metrics recorder seam (task E17-S04) — an OPTIONAL injected function whose
// shape mirrors E17-S02's RecordMetricInput (a metric name + a finite numeric value + an
// OPTIONAL open map of non-personal dimensions). The production root wires it to the guarded
// recorder (`recordMetric: (input) => recordMetricEvent(db, clock, input)`); an actions object
// built WITHOUT it records no metrics, so every behaviour that predates this seam (E12-S10) is
// unchanged.
export type RecordMetricSeam = (input: {
  readonly name: string;
  readonly value: number;
  readonly dimensions?: Record<string, unknown>;
}) => Promise<void>;

// The injected seams — no process.env (INV-103). `executeApprovedHold` is the
// pipeline's own single-shot runner for an approved held call (taken as a seam so
// the actions never re-implement it and a test can observe it running exactly once).
export interface InboxActionsDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly keyWrapper: KeyWrapper;
  readonly executeApprovedHold: (userId: string, approvalId: string) => Promise<ApprovedHoldResult>;
  readonly recordMetric?: RecordMetricSeam;
}

// A decision's result: success, or a refusal naming its reason (an id/approval
// that is not this person's, or a release awaiting a fresh step-up). Never a
// silent success. The page maps the reason code to plain copy.
export type ActionResult = { ok: true } | { ok: false; reason: string };

// The DATA slice of <InboxView>'s props the loader returns: the person's OWN pending
// approvals (newest-first) + their decision history, and — for a card release — their
// saved cards. The page adds the bound decision actions (approve / deny / ask) and the
// device-release trigger when it renders. The view (E12-S12) owns this shape.
export type InboxLoadData = Pick<InboxViewProps, "pending" | "history" | "savedCards">;

// The inbox decision actions the loader + its server-action wrappers drive.
export interface InboxActions {
  approveApproval(session: Session, approvalId: string): Promise<ActionResult>;
  denyApproval(session: Session, approvalId: string): Promise<ActionResult>;
  askForMoreDetail(session: Session, approvalId: string, question: string): Promise<ActionResult>;
  // Turn the verified session into the inbox view's data: the session person's OWN
  // pending approvals (newest-first) + their decision history, each pending request's
  // release kind mapped from its decrypted detail, and a card release's saved-card
  // picker. Marks every pending approval it shows OPENED (member-scoped), suppressing
  // its SMS/email fallback once the person has viewed their inbox. READ-ONLY.
  load(session: Session): Promise<InboxLoadData>;
}

// The refusal reason codes (mapped to copy by the page). Short, stable strings —
// the same vocabulary the sibling security actions use.
const NOT_FOUND = "not_found";
const STEP_UP_REQUIRED = "step_up_required";
// The approval was no longer pending when this decision landed: someone (another
// device, a double-click, a disconnect) decided it first, or its window had passed.
const ALREADY_DECIDED = "already_decided";
const EXPIRED = "expired";
// The approval landed, but Warthog could not carry out the held call (its agent was
// disconnected, the agent no longer has the permission, …). The agent is handed the
// same refusal through check_approval; the person is told nothing was done.
const APPROVED_NOT_RUN = "approved_not_run";

// The two metrics recorded for EVERY successful decision (task E17-S04; the tester's pinned
// contract, as `agent.request` / `agent.request.latency_ms` are E17-S03's): a response-time
// reading (created-to-decided ms) and an outcome-count increment. Approval response time is
// an explicit operational metric (brief "Operations readiness").
const RESPONSE_TIME_METRIC = "approval.response_time_ms";
const DECISION_METRIC = "approval.decision";

// A well-formed uuid: the only shape an approval id may take. A malformed value is
// rejected at the validation boundary (parseParams throws a 4xx HttpError) before
// it can reach `WHERE id = $1` as a cast (OBS-049).
const uuidSchema = z.uuid();

// The longest a more-detail question may be: a few sentences, not a payload. An
// empty/blank or over-long question is rejected at the boundary with a 4xx rather
// than escaping as a 500 from the state machine (which also forbids a blank one).
const MAX_QUESTION_CHARS = 2000;
const questionSchema = z
  .string()
  .min(1)
  .max(MAX_QUESTION_CHARS)
  .refine((value) => value.trim().length > 0);

// ─── loader mapping (pure; the view's already-formatted shapes) ───────────────────────

// A stored detail field as display text — "" when absent or not a string.
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// The release kind a pending request carries, from the SAME `detail.request`
// discriminator approveApproval gates step-up on (and the pipeline and check_approval
// read): "card" / "high_tier" → a device release; anything else → null (a routine held
// call's plain, server-verified Approve).
function releaseKind(detail: Record<string, unknown>): ReleaseKind | null {
  return isReleaseRequest(detail.request) ? detail.request : null;
}

// The recipients a held message goes to, as one line: the pipeline stores
// `recipients` (one address or a list); an older detail carried a single `recipient`.
function recipientsText(detail: Record<string, unknown>): string {
  const recipients = detail.recipients ?? detail.recipient;
  if (Array.isArray(recipients)) return recipients.map(text).filter(Boolean).join(", ");
  return text(recipients);
}

// The requested amount in its currency ("$149.99"); an older detail stored it as text.
function amountText(detail: Record<string, unknown>): string {
  if (typeof detail.amount === "number" && typeof detail.currency === "string") {
    return formatMoney(detail.amount, detail.currency);
  }
  return text(detail.amount);
}

// A foreign amount converted into the account currency, with the reference rate's date
// (brief "Currency": the approval shows both amounts and the rate's date).
function convertedText(detail: Record<string, unknown>): string {
  const converted = detail.converted as { amount?: unknown; currency?: unknown; rateDate?: unknown } | undefined;
  if (!converted || typeof converted.amount !== "number" || typeof converted.currency !== "string") return "";
  const date = text(converted.rateDate);
  const money = formatMoney(converted.amount, converted.currency);
  return date ? `${money} at the ${date} reference rate` : money;
}

// The exact lines under a request — recipients, amount (and its converted amount),
// merchant, field and purpose — each present only when the decrypted detail carries
// it (an omitted field drops out, exactly as it is stored).
function detailLines(detail: Record<string, unknown>): RequestDetail[] {
  const lines: RequestDetail[] = [];
  const account = text(detail.account);
  if (account) lines.push({ label: "Service account", value: account });
  const recipients = recipientsText(detail);
  if (recipients) lines.push({ label: "To", value: recipients });
  const amount = amountText(detail);
  if (amount) lines.push({ label: "Amount", value: amount });
  const converted = convertedText(detail);
  if (converted) lines.push({ label: "Converted", value: converted });
  const merchant = text(detail.merchant);
  if (merchant) lines.push({ label: "Merchant", value: merchant });
  const field = text(detail.field);
  if (field) lines.push({ label: "Field", value: highTierFieldLabel(field) });
  const purpose = text(detail.purpose);
  if (purpose) lines.push({ label: "Purpose", value: purpose });
  return lines;
}

// Time left before a pending request expires, in plain words (floored at expiry).
function timeLeftLabel(timeLeftMs: number): string {
  if (timeLeftMs <= 0) return "Expired";
  const minutes = Math.ceil(timeLeftMs / 60_000);
  return minutes === 1 ? "1 minute left" : `${minutes} minutes left`;
}

// A decided status as plain-words outcome copy (the view adds the per-status icon).
const OUTCOME: Record<DecidedStatus, string> = {
  approved: "You approved this",
  denied: "You turned this down",
  expired: "This expired before you decided",
  more_detail: "You asked for more detail",
};

// One pending approval → the view's already-formatted pending row.
function toPendingView(request: PendingApproval): PendingRequestView {
  return {
    id: request.id,
    agent: request.agent.displayName,
    sentence: text(request.detail.sentence),
    details: detailLines(request.detail),
    reason: text(request.detail.reason),
    rule: text(request.detail.rule),
    timeLeft: timeLeftLabel(request.timeLeftMs),
    release: releaseKind(request.detail),
  };
}

// One decided approval → the view's already-formatted history row.
function toDecidedView(entry: DecidedApproval, timeZone: string): DecidedRequestView {
  const view: DecidedRequestView = {
    id: entry.id,
    agent: entry.agent.displayName,
    sentence: text(entry.detail.sentence),
    status: entry.status,
    outcome: OUTCOME[entry.status],
    decidedAt: entry.decidedAt ? formatAccountTime(entry.decidedAt, timeZone) : "",
  };
  if (entry.question) view.question = entry.question;
  return view;
}

export function createInboxActions(deps: InboxActionsDeps): InboxActions {
  const { db, clock, keyWrapper, executeApprovedHold } = deps;

  // Record the two metrics for one successful decision (task E17-S04): a response-time
  // reading (created-to-decided ms, finite and ≥ 0) and an outcome-count increment (value 1),
  // BOTH tagged only with the decision's `outcome` (the landed status: approved / denied /
  // more_detail). The decision instant is the injected clock (never Date.now(); more_detail
  // never stamps `decided_at`, so the clock — not the stored row — is the created-to-decided
  // endpoint). An actions object built WITHOUT the seam records nothing. The dimensions are the
  // allowlisted, non-personal set only — NEVER approval detail, recipient, amount, merchant,
  // field, reason, question, agent id or user id.
  async function emitDecisionMetrics(decided: StoredApproval): Promise<void> {
    if (!deps.recordMetric) return;
    const elapsed = clock.now().getTime() - decided.createdAt.getTime();
    const responseMs = elapsed >= 0 ? elapsed : 0;
    const dimensions = { outcome: decided.status };
    await deps.recordMetric({ name: RESPONSE_TIME_METRIC, value: responseMs, dimensions });
    await deps.recordMetric({ name: DECISION_METRIC, value: 1, dimensions });
  }

  // Resolve the acting person's unwrapped DEK (to decrypt the approval detail and
  // the held args). Read the wrapped DEK member-scoped by `userId` (the session's,
  // never a client value) and unwrap it through the KeyWrapper seam. Throws when
  // the person has no row — never fails silently.
  async function dataKeyFor(userId: string): Promise<Uint8Array> {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("inbox actions: no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  }

  // Load the one approval with `id` OWNED BY the session's user, with its detail
  // decrypted under the person's DEK. Null when none is theirs — so another
  // person's id resolves to nothing and the caller refuses. `id` is assumed
  // already validated at the boundary.
  async function loadOwn(session: Session, id: string) {
    const dek = await dataKeyFor(session.userId);
    const approval = await getApproval(db, session.userId, id, dek);
    return approval ? { dek, approval } : null;
  }

  // Persist one decision as the store's compare-and-swap AND record it in the person's
  // activity feed ("every approval request and decision" — brief), in ONE transaction:
  // the decision and its audit entry commit together. Warthog writes the entry itself
  // (redacted, DEK-encrypted), attributed to the requesting agent. A decision that loses
  // — the approval was decided first, or it is past its window (stored expired at once)
  // — is refused in plain words rather than escaping as an error, records nothing, and
  // nothing runs.
  async function decideOwn(
    session: Session,
    id: string,
    dek: Uint8Array,
    decision: Decision,
  ): Promise<{ ok: true; decided: StoredApproval } | { ok: false; reason: string }> {
    return withTransaction(db, async (tx) => {
      let decided: StoredApproval;
      try {
        decided = await decide(tx, { userId: session.userId, id, decision }, dek, clock);
      } catch (error) {
        if (error instanceof ApprovalAlreadyDecidedError) {
          return { ok: false, reason: error.status === "expired" ? EXPIRED : ALREADY_DECIDED };
        }
        throw error;
      }
      const recorder = createRedactingRecorder({ db: tx, clock, dekFor: async () => dek });
      await recorder.record({
        userId: session.userId,
        kind: "approval_decision",
        source: "warthog",
        agentId: decided.agentId,
        connectorId: text(decided.detail.connector) || undefined,
        tool: text(decided.detail.tool) || undefined,
        outcome: decided.status,
        payload: {
          approvalId: decided.id,
          request: decided.detail.request,
          sentence: text(decided.detail.sentence) || undefined,
          question: decided.question,
        },
      });
      return { ok: true, decided };
    });
  }

  // Approve an approval. Validate the id shape at the boundary; load the one that
  // is this person's (refuse otherwise); gate a high-tier/card RELEASE on a fresh
  // step-up (refuse without one, approving nothing); then mark it opened, move it
  // to `approved`, and — for a held NON-release call only — trigger its single
  // execution through the pipeline (a release is collected separately, never run).
  async function approveApproval(session: Session, approvalId: string): Promise<ActionResult> {
    const id = parseParams(uuidSchema, approvalId);
    const own = await loadOwn(session, id);
    if (!own) return { ok: false, reason: NOT_FOUND };

    const isRelease = isReleaseRequest(own.approval.detail.request);
    if (isRelease && !requireStepUp(session, { clock })) {
      return { ok: false, reason: STEP_UP_REQUIRED };
    }

    await markOpened(db, { id, userId: session.userId }, clock);
    // Only the caller whose compare-and-swap won goes on to run the held call.
    const outcome = await decideOwn(session, id, own.dek, { status: "approved" });
    if (!outcome.ok) return outcome;
    await emitDecisionMetrics(outcome.decided);

    if (!isRelease) {
      // The run's outcome is stored for the agent's check_approval; a refusal is also
      // reported to the person, never a bare "Approved" for something that did not run.
      const ran = await executeApprovedHold(session.userId, id);
      if (ran.status === "refused") return { ok: false, reason: APPROVED_NOT_RUN };
    }
    return { ok: true };
  }

  // Deny an approval: validate, load the person's own (refuse otherwise), mark it
  // opened and move it to `denied`. Nothing is executed — the held call is left
  // waiting and can never run.
  async function denyApproval(session: Session, approvalId: string): Promise<ActionResult> {
    const id = parseParams(uuidSchema, approvalId);
    const own = await loadOwn(session, id);
    if (!own) return { ok: false, reason: NOT_FOUND };

    await markOpened(db, { id, userId: session.userId }, clock);
    const outcome = await decideOwn(session, id, own.dek, { status: "denied" });
    if (!outcome.ok) return outcome;
    await emitDecisionMetrics(outcome.decided);
    return { ok: true };
  }

  // Ask the agent for more detail: validate the id AND the question at the boundary
  // (both throw a 4xx before any db access), load the person's own approval (refuse
  // otherwise), mark it opened and move it to `more_detail`, recording the question.
  // Nothing is executed.
  async function askForMoreDetail(
    session: Session,
    approvalId: string,
    question: string,
  ): Promise<ActionResult> {
    const id = parseParams(uuidSchema, approvalId);
    const q = parseParams(questionSchema, question);
    const own = await loadOwn(session, id);
    if (!own) return { ok: false, reason: NOT_FOUND };

    await markOpened(db, { id, userId: session.userId }, clock);
    const outcome = await decideOwn(session, id, own.dek, { status: "more_detail", question: q });
    if (!outcome.ok) return outcome;
    await emitDecisionMetrics(outcome.decided);
    return { ok: true };
  }

  // The person's saved cards as a card release's picker shows them: the display label
  // (brand + last four — constitution 17, never a readable number) and the
  // device-decryptable number ciphertext the device needs to release. Member-scoped by
  // the session user id (both the list and each ciphertext read bind it), so one person
  // can never see another's cards.
  //
  // Review fix W6: each card also carries the non-secret details a checkout needs, which
  // the release hands over with the number and security code (the inbox never shows them):
  // the expiry, the name on the card (falling back to the person's saved name for a card
  // saved before names were kept) and the billing address text. The address is resolved
  // HERE, from the card's billing reference, through the person's OWN low-tier postal
  // addresses only (listIdentityFields binds the session user id and decrypts under their
  // DEK) — so a reference to someone else's field, to a non-address field or to nothing
  // resolves to null, never to another person's data.
  async function loadSavedCards(userId: string, dek: Uint8Array): Promise<SavedCardView[]> {
    const cards = await listCards(db, userId);
    if (cards.length === 0) return [];
    const fields = await listIdentityFields(db, userId, dek);
    const savedName = fields.find((field) => field.kind === "name")?.value ?? null;
    const addressById = new Map(
      fields.filter((field) => field.kind === "postal_address").map((field) => [field.id, field.value]),
    );
    const views: SavedCardView[] = [];
    for (const card of cards) {
      const ciphertext = await getCardCiphertext(db, userId, card.id);
      if (ciphertext === null) continue;
      views.push({
        id: card.id,
        label: `${card.brand} •••• ${card.lastFour}`,
        ciphertext,
        expiryMonth: card.expiryMonth,
        expiryYear: card.expiryYear,
        cardholderName: card.cardholderName ?? savedName,
        billingAddress: addressById.get(card.billingAddressId) ?? null,
      });
    }
    return views;
  }

  // The person's saved high-tier details as a high-tier release offers them: the
  // plaintext label and the device-decryptable ciphertext (never a readable value — the
  // server holds only ciphertext). Member-scoped by the session user id (both the list
  // and each ciphertext read bind it), so one person can never see another's details.
  async function loadHighTierFields(userId: string): Promise<{ type: string; view: HighTierFieldView }[]> {
    const fields = await listHighTierFields(db, userId);
    const loaded: { type: string; view: HighTierFieldView }[] = [];
    for (const field of fields) {
      const ciphertext = await getHighTierCiphertext(db, userId, field.id);
      if (ciphertext === null) continue;
      loaded.push({ type: field.type, view: { id: field.id, label: field.label, ciphertext } });
    }
    return loaded;
  }

  // A high-tier request's offered details: the ones matching the requested field first
  // (preselected), then the rest, so the person can still choose deliberately.
  function offerFor(
    request: PendingRequestView,
    detail: Record<string, unknown>,
    fields: readonly { type: string; view: HighTierFieldView }[],
  ): PendingRequestView {
    const wanted = text(detail.field);
    const matching = fields.filter((field) => wanted !== "" && field.type === wanted);
    const rest = fields.filter((field) => !(wanted !== "" && field.type === wanted));
    return { ...request, highTierFields: [...matching, ...rest].map((field) => field.view) };
  }

  // Turn the verified session into the inbox view's data. Reads ONLY the session
  // person's approvals (member-scoped by `session.userId` — never a client value): their
  // PENDING requests newest-first + their decision HISTORY (readInbox, E12-S11),
  // resolving the person's own DEK (getUserById + keyWrapper.unwrap) so the stored detail
  // decrypts and the time left comes from the injected clock. Marks every pending
  // approval it shows OPENED (member-scoped markOpened), so its SMS/email fallback is
  // suppressed once the person has viewed it. READ-ONLY: it never runs a held call
  // (executeApprovedHold is untouched). A card release additionally needs the saved cards.
  async function load(session: Session): Promise<InboxLoadData> {
    const dek = await dataKeyFor(session.userId);
    const timeZone = await timeZoneFor(db, session.userId, dek);
    const inbox = await readInbox(db, session.userId, dek, clock);

    for (const request of inbox.pending) {
      await markOpened(db, { id: request.id, userId: session.userId }, clock);
    }

    let pending = inbox.pending.map(toPendingView);
    // A high-tier release needs the person's saved detail to decrypt on their device.
    if (pending.some((request) => request.release === "high_tier")) {
      const fields = await loadHighTierFields(session.userId);
      pending = pending.map((request, index) =>
        request.release === "high_tier" ? offerFor(request, inbox.pending[index]!.detail, fields) : request,
      );
    }
    const history = inbox.history.map((entry) => toDecidedView(entry, timeZone));
    const data: InboxLoadData = { pending, history };

    if (pending.some((request) => request.release === "card")) {
      data.savedCards = await loadSavedCards(session.userId, dek);
    }
    return data;
  }

  return { approveApproval, denyApproval, askForMoreDetail, load };
}
