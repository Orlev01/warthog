"use client";

import * as React from "react";
import {
  Clock,
  CheckCircle,
  XCircle,
  HelpCircle,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty";
import type { UnlockRequest } from "@/client/vault/unlock";

// E12-S12 — Approval inbox view component (brief "Approval inbox" / "Agents wait
// safely"; design §6; constitution 17 "no readable card numbers or security codes on
// Warthog's side" + 18 "approvals only inside the signed-in app").
//
// This module exports the two seams the inbox needs, mirroring the repo's established
// split for a screen that is both render-testable AND interactive (DeviceView +
// createDeviceFlow, SignupView + createSignupFlow):
//
//   1. InboxView — the prop-driven view. It renders pending approvals newest-first (the
//      order the loader hands in, never reversed) and the history from already-formatted
//      props; it reaches for no clock, locale, DB or config. Decision controls for a
//      non-release held call (Approve, Deny, Ask for more detail) are BOUND to the server
//      actions the page passes (createInboxActions, E12-S10), exactly as ActivityView
//      binds Dispute/Undo; a control whose action is not supplied renders DISABLED with a
//      one-line reason rather than a dead button (constitution: no dead controls).
//
//   2. createReleaseFlow(deps) — the framework-free controller behind the card/high-tier
//      Approve path. On this device it unlocks the vault, decrypts the stored ciphertext
//      and posts the released value to the approval's release endpoint — so the plaintext
//      is handed over once and never stored server-side as plaintext at rest (design
//      §4.2; only ciphertext at rest server-side). It reports every outcome and never
//      leaks the released value or the security code back.

// ─── the prop contract this task introduces ─────────────────────────────────────────

// Whether a pending request is a one-time RELEASE of a sensitive value: "card" and
// "high_tier" take the device unlock-decrypt-release Approve path; `null` is a routine
// held call whose Approve is a plain server-verified decision.
export type ReleaseKind = "card" | "high_tier";

// One already-formatted detail line under a request (display-ready and already redacted).
export type RequestDetail = { label: string; value: string };

// A pending request awaiting the person's decision, as the view renders it.
export type PendingRequestView = {
  id: string;
  agent: string;
  sentence: string;
  details: readonly RequestDetail[];
  reason: string;
  rule: string;
  timeLeft: string;
  release: ReleaseKind | null;
};

export type DecidedStatus = "approved" | "denied" | "expired" | "more_detail";

// A past decision in the history section.
export type DecidedRequestView = {
  id: string;
  agent: string;
  sentence: string;
  status: DecidedStatus;
  outcome: string;
  decidedAt: string;
  question?: string;
};

// One of the person's saved cards offered in a card release's picker. The server stores
// only the device-decryptable `ciphertext`; the view shows the display `label` (brand +
// last four — constitution 17), never a readable card number.
export type SavedCardView = {
  id: string;
  label: string;
  ciphertext: string;
};

type InboxAction = (formData: FormData) => void | Promise<void>;

export type InboxViewProps = {
  pending: readonly PendingRequestView[];
  history: readonly DecidedRequestView[];
  // Decision controls for a NON-release held call, bound to the page's server actions.
  // Optional: an absent action renders its control disabled with a reason (no dead
  // controls). A card/high-tier release Approve runs the device flow instead (onRelease).
  approveAction?: InboxAction;
  denyAction?: InboxAction;
  moreDetailAction?: InboxAction;
  // The person's saved cards, offered in a card release's picker.
  savedCards?: readonly SavedCardView[];
  // Runs the device unlock-decrypt-and-release for a card/high-tier request (the page's
  // client binding gathers the chosen card + entered code and drives createReleaseFlow).
  onRelease?: (request: PendingRequestView) => void | Promise<void>;
};

// ─── styling (design tokens; no raw hex) ─────────────────────────────────────────────
//
// Native control classes on the tokens. They deliberately omit the shared Button's
// `disabled:` utility variants so a LIVE control's class never reads as "disabled"; the
// one DISABLED control carries the native `disabled` attribute instead (same approach as
// ActivityView). The accent fill is the per-request primary action (Approve / release);
// everything else is the neutral surface.
const BTN_BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-card px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const BTN_PRIMARY = `${BTN_BASE} bg-accent text-accent-fg hover:bg-accent-hover`;
const BTN_SECONDARY = `${BTN_BASE} border border-line bg-surface text-fg hover:bg-surface-muted`;
const BTN_DISABLED = `${BTN_BASE} border border-line bg-surface text-fg-muted opacity-50`;
const SELECT_CLASS =
  "min-h-11 w-full rounded-card border border-line bg-surface px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const TEXTAREA_CLASS =
  "min-h-11 w-full rounded-card border border-line bg-surface px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

// The sensitive-moment explainer — a plain "slow down for this one moment" panel shown
// only on a release (never a routine held call), in everyday words with no jargon.
const RELEASE_EXPLAINER =
  "This is a sensitive step, so take a moment before it goes ahead. Check the details are right, then approve to hand the value over just once.";

// ─── decision controls ───────────────────────────────────────────────────────────────

// A present-but-not-actionable control: the native `disabled` attribute does the
// disabling, and a one-line reason says why (constitution: no dead controls).
function DisabledControl({ label, reason }: { label: string; reason: string }) {
  return (
    <div className="flex flex-col gap-1">
      <button type="button" disabled className={BTN_DISABLED}>
        {label}
      </button>
      <p className="text-xs text-fg-muted">{reason}</p>
    </div>
  );
}

// The Approve control for a NON-release held call: a form bound to approveAction,
// carrying the request id the action consumes. Disabled with a reason when unbound.
function ApproveControl({
  request,
  approveAction,
}: {
  request: PendingRequestView;
  approveAction?: InboxAction;
}) {
  if (!approveAction) {
    return <DisabledControl label="Approve" reason="Approving isn't available just now." />;
  }
  return (
    <form action={approveAction}>
      <input type="hidden" name="id" value={request.id} />
      <button type="submit" className={BTN_PRIMARY}>
        Approve
      </button>
    </form>
  );
}

function DenyControl({
  request,
  denyAction,
}: {
  request: PendingRequestView;
  denyAction?: InboxAction;
}) {
  if (!denyAction) {
    return <DisabledControl label="Deny" reason="Denying isn't available just now." />;
  }
  return (
    <form action={denyAction}>
      <input type="hidden" name="id" value={request.id} />
      <button type="submit" className={BTN_SECONDARY}>
        Deny
      </button>
    </form>
  );
}

// Ask for more detail: a disclosure whose form (bound to moreDetailAction) carries the
// request id and a free-text question field. Disabled with a reason when unbound.
function AskControl({
  request,
  moreDetailAction,
}: {
  request: PendingRequestView;
  moreDetailAction?: InboxAction;
}) {
  if (!moreDetailAction) {
    return (
      <DisabledControl
        label="Ask for more detail"
        reason="Asking for more detail isn't available just now."
      />
    );
  }
  const questionId = `inbox-ask-${request.id}`;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium text-accent">Ask for more detail</summary>
      <form action={moreDetailAction} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="id" value={request.id} />
        <Label htmlFor={questionId}>What would you like to ask?</Label>
        <textarea id={questionId} name="question" required={true} rows={2} className={TEXTAREA_CLASS} />
        <div>
          <button type="submit" className={BTN_SECONDARY}>
            Ask for more detail
          </button>
        </div>
      </form>
    </details>
  );
}

// The card/high-tier Approve path: the sensitive-moment explainer, the saved-card picker
// and the security-code field (cards only — "where relevant"), and the live control that
// runs the device unlock-decrypt-and-release. Disabled with a reason when onRelease is
// not supplied (no dead controls).
function ReleaseControl({
  request,
  savedCards,
  onRelease,
}: {
  request: PendingRequestView;
  savedCards?: readonly SavedCardView[];
  onRelease?: (request: PendingRequestView) => void | Promise<void>;
}) {
  if (!onRelease) {
    return (
      <DisabledControl label="Approve and release" reason="Releasing isn't available just now." />
    );
  }
  const isCard = request.release === "card";
  const cards = savedCards ?? [];
  const cardFieldId = `inbox-card-${request.id}`;
  const codeFieldId = `inbox-code-${request.id}`;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 rounded-card border border-line bg-surface-muted p-3 text-sm text-fg">
        <ShieldAlert aria-hidden={true} className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
        <p>{RELEASE_EXPLAINER}</p>
      </div>
      {isCard ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={cardFieldId}>Which card</Label>
            <select id={cardFieldId} name="card" className={SELECT_CLASS}>
              {cards.map((card) => (
                <option key={card.id} value={card.id}>
                  {card.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={codeFieldId}>Security code</Label>
            <Input id={codeFieldId} name="securityCode" inputMode="numeric" autoComplete="off" />
          </div>
        </>
      ) : null}
      <div>
        <button
          type="button"
          className={BTN_PRIMARY}
          onClick={() => {
            void onRelease(request);
          }}
        >
          Approve and release
        </button>
      </div>
    </div>
  );
}

// ─── the pending list ────────────────────────────────────────────────────────────────

function PendingItem({
  request,
  approveAction,
  denyAction,
  moreDetailAction,
  savedCards,
  onRelease,
}: {
  request: PendingRequestView;
  approveAction?: InboxAction;
  denyAction?: InboxAction;
  moreDetailAction?: InboxAction;
  savedCards?: readonly SavedCardView[];
  onRelease?: (request: PendingRequestView) => void | Promise<void>;
}) {
  const isRelease = request.release !== null;
  return (
    <li className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <p className="text-fg">
        <span className="font-medium">{request.agent}</span> {request.sentence}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {request.details.map((detail, index) => (
          <React.Fragment key={`${request.id}-detail-${index}`}>
            <dt className="text-fg-muted">{detail.label}</dt>
            <dd className="text-fg">{detail.value}</dd>
          </React.Fragment>
        ))}
        <dt className="text-fg-muted">Why</dt>
        <dd className="text-fg">{request.reason}</dd>
        <dt className="text-fg-muted">Rule</dt>
        <dd className="text-fg">{request.rule}</dd>
        <dt className="text-fg-muted">Time left</dt>
        <dd className="text-fg">
          <span className="inline-flex items-center gap-1.5">
            <Clock aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted" />
            {request.timeLeft}
          </span>
        </dd>
      </dl>
      {isRelease ? (
        <ReleaseControl request={request} savedCards={savedCards} onRelease={onRelease} />
      ) : (
        <ApproveControl request={request} approveAction={approveAction} />
      )}
      <div className="flex flex-wrap items-start gap-2">
        <DenyControl request={request} denyAction={denyAction} />
        <AskControl request={request} moreDetailAction={moreDetailAction} />
      </div>
    </li>
  );
}

// ─── the history section ─────────────────────────────────────────────────────────────

// Each decided status reads as WORDS (the loader's display-ready `outcome`) plus an icon,
// never colour alone; the icon is decorative and inherits the tone token via currentColor.
const HISTORY_META: Record<DecidedStatus, { Icon: LucideIcon; tone: string }> = {
  approved: { Icon: CheckCircle, tone: "text-success" },
  denied: { Icon: XCircle, tone: "text-danger" },
  expired: { Icon: Clock, tone: "text-fg-muted" },
  more_detail: { Icon: HelpCircle, tone: "text-fg-muted" },
};

function HistoryItem({ entry }: { entry: DecidedRequestView }) {
  const { Icon, tone } = HISTORY_META[entry.status];
  return (
    <li className="flex flex-col gap-1 rounded-card border border-line bg-surface p-4">
      <p className="text-fg">
        <span className="font-medium">{entry.agent}</span> {entry.sentence}
      </p>
      <span className={["inline-flex items-center gap-1.5 text-sm font-medium", tone].join(" ")}>
        <Icon aria-hidden={true} className="h-4 w-4 shrink-0" />
        {entry.outcome}
      </span>
      {entry.question ? <p className="text-sm text-fg-muted">{entry.question}</p> : null}
      <p className="text-xs text-fg-muted">{entry.decidedAt}</p>
    </li>
  );
}

// ─── the view ────────────────────────────────────────────────────────────────────────

export function InboxView({
  pending,
  history,
  approveAction,
  denyAction,
  moreDetailAction,
  savedCards,
  onRelease,
}: InboxViewProps) {
  const isEmpty = pending.length === 0 && history.length === 0;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Inbox</h1>
      {isEmpty ? (
        <EmptyState
          heading="Nothing waiting"
          description="When an agent needs your say-so, the request will wait for you here."
        />
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-fg">Waiting on you</h2>
            {pending.length === 0 ? (
              <p className="text-sm text-fg-muted">No requests are waiting right now.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {pending.map((request) => (
                  <PendingItem
                    key={request.id}
                    request={request}
                    approveAction={approveAction}
                    denyAction={denyAction}
                    moreDetailAction={moreDetailAction}
                    savedCards={savedCards}
                    onRelease={onRelease}
                  />
                ))}
              </ul>
            )}
          </section>
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-fg">History</h2>
            {history.length === 0 ? (
              <p className="text-sm text-fg-muted">Nothing decided yet.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {history.map((entry) => (
                  <HistoryItem key={entry.id} entry={entry} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ─── createReleaseFlow — the device unlock → decrypt → release controller ────────────

export interface ReleaseFlowDeps {
  // Unlock the vault from the opaque unlock material, recovering the vault key in memory
  // (client/vault unlockVault).
  readonly unlock: (request: UnlockRequest) => Promise<Uint8Array>;
  // Decrypt a stored ciphertext under the recovered vault key (client/vault decryptValue).
  readonly decrypt: (vaultKey: Uint8Array, ciphertext: string) => Promise<string>;
  // Post the released plaintext to the approval's release endpoint (client/vault
  // postRelease). The server stores only ciphertext at rest; this is the single hand-over.
  readonly postRelease: (approvalId: string, value: string) => Promise<void>;
}

export interface ReleaseInput {
  readonly approvalId: string;
  readonly unlockRequest: UnlockRequest;
  readonly ciphertext: string;
  // The freshly-entered card security code (card releases only); never stored anywhere.
  readonly securityCode?: string;
}

export type ReleaseResult = { ok: true } | { ok: false; error: string };

export interface ReleaseFlow {
  release(input: ReleaseInput): Promise<ReleaseResult>;
}

// Plain-English failure copy — a real sentence a person can act on, with no crypto /
// protocol jargon and never the released value or the security code (brief design_ux.copy;
// constitution 18 / INV-22). One message per stage so the person knows what to try next.
const UNLOCK_FAILED_COPY =
  "We couldn't unlock your vault on this device. Check how you unlocked it, then try again.";
const DECRYPT_FAILED_COPY =
  "We couldn't open that saved value on your device. Please try again.";
const RELEASE_FAILED_COPY =
  "We couldn't complete the release just now. Please try again.";

export function createReleaseFlow(deps: ReleaseFlowDeps): ReleaseFlow {
  async function release(input: ReleaseInput): Promise<ReleaseResult> {
    // 1. Unlock the vault. A wrong secret / tampered envelope rejects here; nothing is
    //    decrypted or released, and the person is told in plain words.
    let vaultKey: Uint8Array;
    try {
      vaultKey = await deps.unlock(input.unlockRequest);
    } catch {
      return { ok: false, error: UNLOCK_FAILED_COPY };
    }

    // 2. Decrypt the stored ciphertext on the device. A value that does not verify
    //    rejects here; nothing is released.
    let value: string;
    try {
      value = await deps.decrypt(vaultKey, input.ciphertext);
    } catch {
      return { ok: false, error: DECRYPT_FAILED_COPY };
    }

    // A card release hands over the decrypted number together with the freshly-entered
    // security code (which is never stored); a high-tier release hands over the value
    // alone. The plaintext travels only in this single request.
    const payload =
      input.securityCode === undefined
        ? value
        : JSON.stringify({ number: value, securityCode: input.securityCode });

    // 3. Post the released value to the approval's release endpoint.
    try {
      await deps.postRelease(input.approvalId, payload);
    } catch {
      return { ok: false, error: RELEASE_FAILED_COPY };
    }

    return { ok: true };
  }

  return { release };
}
