"use client";

import * as React from "react";
import {
  Bell,
  ChevronDown,
  Clock,
  CheckCircle,
  CheckCircle2,
  History,
  XCircle,
  HelpCircle,
  type LucideIcon,
} from "lucide-react";

import { Button, buttonClasses } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { TextareaField } from "@/components/ui/field";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";
import { EmptyState } from "@/components/ui/empty";
import { Notice, PageNotice, type NoticeTone } from "@/components/ui/notice";
import { ViewPanels } from "@/components/ui/view-tabs";
import { ActiveFilters, FilterLinks, type AppliedFilter } from "@/components/ui/filter-links";
import { LIST_ROW, ListGroup } from "@/components/ui/list-group";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { WorkspaceHeading } from "@/components/shell/workspace-surfaces";
import { AgentMark } from "@/components/ui/brand-mark";
import { NOTHING_WAITING } from "@/domain/approvals/inbox-copy";
import { hrefWith } from "@/lib/href";
import type { UnlockRequest } from "@/client/vault/unlock";
import { ReleaseRejectedError } from "@/client/vault/release";
import { ReleaseApprove } from "./release-approve";

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
//      It is organised as two tabs, "Waiting on you (n)" and "History (n)", in the page's
//      heading band, whose panels both stay mounted so a half-written question survives a
//      switch; pending requests are one list group (one per agent when two or more agents
//      are asking), each request a divider row, and the history carries outcome and agent
//      filter links in one toolbar (the loader validates the filters and supplies the
//      counts). Every piece of text sits in the band, a list group, a toolbar, a notice
//      or an empty state, never on the canvas (UI/UX pass, rule 1).
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

// One of the person's saved high-tier details offered for a high-tier release: its
// plaintext label (e.g. "Passport") and the device-decryptable ciphertext — never a
// readable value (the server holds only ciphertext; the device decrypts it).
export type HighTierFieldView = {
  id: string;
  label: string;
  ciphertext: string;
};

// A pending request awaiting the person's decision, as the view renders it. A high-tier
// release carries the person's saved high-tier details (best match for the requested
// field first) so their device can decrypt the one they choose.
export type PendingRequestView = {
  id: string;
  // The requesting agent's id (the loader supplies it) — pending requests from two or
  // more agents are grouped by it. Absent, the display name groups them instead.
  agentId?: string;
  agent: string;
  agentPlatform?: string;
  sentence: string;
  // An email's subject and opening words (approval-card truth), shown under the sentence.
  preview?: { title: string; body?: string };
  details: readonly RequestDetail[];
  // The rest, behind "Details": account, everyone it goes to, links, why it's asked, where it came from.
  extras?: readonly RequestDetail[];
  // At most one gentle heads-up when something is unusual (hidden text, a first-time address).
  headsUp?: string;
  reason: string;
  rule: string;
  timeLeft: string;
  release: ReleaseKind | null;
  highTierFields?: readonly HighTierFieldView[];
};

export type DecidedStatus = "approved" | "denied" | "expired" | "more_detail";

// A past decision in the history section.
export type DecidedRequestView = {
  id: string;
  agent: string;
  agentPlatform?: string;
  sentence: string;
  status: DecidedStatus;
  outcome: string;
  decidedAt: string;
  question?: string;
};

// One of the person's saved cards offered in a card release's picker. The server stores
// only the device-decryptable `ciphertext`; the view shows the display `label` (brand +
// last four — constitution 17), never a readable card number.
//
// Review fix W6: a checkout needs more than the number and security code, so the card also
// carries its NON-SECRET checkout details, which the release hands to the agent alongside
// them and the inbox never shows: the expiry, the name on the card (the person's saved name
// for a card saved before names were kept; null when there is neither) and the billing
// address text (resolved server-side from the person's own postal addresses; null when the
// card's address is gone).
export type SavedCardView = {
  id: string;
  label: string;
  ciphertext: string;
  expiryMonth: number;
  expiryYear: number;
  cardholderName: string | null;
  billingAddress: string | null;
};

type InboxAction = (formData: FormData) => void | Promise<void>;

export type InboxViewProps = {
  pending: readonly PendingRequestView[];
  history: readonly DecidedRequestView[];
  // Decision controls for a NON-release held call, bound to the page's server actions.
  // Optional: an absent action renders its control disabled with a reason (no dead
  // controls). A card/high-tier release Approve runs the on-device hand-over in the
  // <ReleaseApprove> control the view mounts itself (E11-S17) — a server page cannot hand
  // a client a callback, so a release is LIVE BY CONSTRUCTION, never gated on a prop.
  approveAction?: InboxAction;
  denyAction?: InboxAction;
  moreDetailAction?: InboxAction;
  // The person's saved cards, offered in a card release's on-device picker.
  savedCards?: readonly SavedCardView[];
  // The approval a notification tap opened (/inbox?approval=<id>, review fix W4.2). The
  // view marks that request, scrolls to it and moves focus to it; one that was already
  // decided or is gone gets a plain notice. Compared against the loaded ids only — it is
  // never written into the page.
  focusApproval?: string;
  // The tab the address bar asked for (`?view=`, validated by the page). Absent, the tab
  // follows the opened approval: a decided one opens History, otherwise Waiting on you.
  initialView?: InboxViewKey;
  // The history filters in force (validated by the loader) and the counts behind the
  // History tab and its filter links. Absent, the history shows unfiltered with no links.
  historyFilter?: HistoryFilter;
  historySummary?: HistorySummary;
  // The opened approval when it is decided but not on the loaded history page (older
  // than the page, or hidden by a filter), so the notification still lands on it.
  openedEntry?: DecidedRequestView;
  // The outcome of the last decision, in plain words (the page maps its `?notice=`).
  notice?: InboxNotice;
  // Whether the person has connected an agent (the loader knows): an empty inbox then
  // points at connecting the first one rather than at rules. Absent, assumed connected.
  hasAgents?: boolean;
};

// The inbox's two tabs, keyed by the `?view=` parameter.
export type InboxViewKey = "pending" | "history";

// The history filters: one outcome and/or one of the person's own agents (by id).
export type HistoryFilter = { outcome?: DecidedStatus; agent?: string };

// Counts for the History tab and its filter links. Outcome counts are within the agent
// filter and agent counts within the outcome filter, so each link says what it would show.
export type HistorySummary = {
  total: number; // every decision the person has
  matching: number; // decisions matching both filters
  outcomes: readonly { status: DecidedStatus; count: number }[];
  allOutcomesCount: number;
  agents: readonly { id: string; name: string; count: number }[];
  allAgentsCount: number;
};

export type InboxNotice = { tone: NoticeTone; text: string };

// ─── decision controls ───────────────────────────────────────────────────────────────
//
// Every control comes from the shared primitives (Button, FormSubmit, TextareaField): one
// primary per request (Approve), 44px targets, the global focus outline. Each decision form
// is an ActionForm, so a double click or a repeated Enter sends exactly one decision and the
// pressed button says what it is doing ("Approving…") while focus stays put (UI/UX pass
// interaction-01).

// Every pending request repeats the same control words (Approve, Deny, Ask for more
// detail), so each control also names its request for screen readers: "Deny: Claude wants
// to send a note…". The visible label still leads the accessible name (voice control).
export function RequestContext({ request }: { request: Pick<PendingRequestView, "agent" | "sentence"> }) {
  const context = [request.agent, request.sentence].filter(Boolean).join(" ");
  return context ? <span className="sr-only">: {context}</span> : null;
}

// A present-but-not-actionable control: marked unavailable (aria-disabled, so it stays in
// the Tab order and is announced), with a one-line reason tied to it by aria-describedby
// (constitution: no dead controls; UI/UX pass a11y-18). It has no action to run.
function DisabledControl({
  label,
  reason,
  request,
}: {
  label: string;
  reason: string;
  request: PendingRequestView;
}) {
  const reasonId = React.useId();
  return (
    <div className="flex flex-col gap-1">
      <Button type="button" variant="secondary" aria-disabled={true} aria-describedby={reasonId}>
        {label}
        <RequestContext request={request} />
      </Button>
      <p id={reasonId} className="text-xs text-fg-muted">{reason}</p>
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
    return <DisabledControl label="Approve" reason="Approving isn't available just now." request={request} />;
  }
  return (
    <ActionForm action={approveAction}>
      <input type="hidden" name="id" value={request.id} />
      <FormSubmit variant="primary" pendingLabel="Approving…">
        Approve
        <RequestContext request={request} />
      </FormSubmit>
    </ActionForm>
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
    return <DisabledControl label="Deny" reason="Denying isn't available just now." request={request} />;
  }
  return (
    <ActionForm action={denyAction}>
      <input type="hidden" name="id" value={request.id} />
      <FormSubmit variant="secondary" pendingLabel="Denying…">
        Deny
        <RequestContext request={request} />
      </FormSubmit>
    </ActionForm>
  );
}

// Ask for more detail: a disclosure whose form (bound to moreDetailAction) carries the
// request id and a free-text question field. Opened, it takes the row's full width so the
// question has room. Disabled with a reason when unbound.
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
        request={request}
      />
    );
  }
  return (
    <details className="group min-w-0 open:basis-full">
      <summary className={buttonClasses({ variant: "ghost", size: "sm" })}>
        Ask for more detail
        <RequestContext request={request} />
        <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <ActionForm action={moreDetailAction} className="mt-2 flex max-w-xl flex-col items-start gap-3 rounded-[var(--wh-radius-inset)] bg-surface-muted p-3">
        <input type="hidden" name="id" value={request.id} />
        <TextareaField
          label="What would you like to ask?"
          hint="The agent sees your question and can send the request again with more detail."
          name="question"
          required={true}
          rows={2}
          maxLength={2000}
          className="w-full"
        />
        <FormSubmit variant="secondary" pendingLabel="Sending…">
          Ask the agent
          <RequestContext request={request} />
        </FormSubmit>
      </ActionForm>
    </details>
  );
}

// ─── the approval a notification opened (review fix W4.2) ────────────────────────────
//
// A push notification opens /inbox?approval=<id> (public/sw.js). That request is marked
// in words and an icon (never colour alone), scrolled into view and given focus once the
// page has mounted, so the person lands straight on it. A request that was already
// decided, or that is gone, gets a plain notice instead.

// The element id every request's list item carries, so the opened one can be found.
function approvalElementId(id: string): string {
  return `approval-${id}`;
}

// The opened row's highlight: an inset accent ring on top of the words below (never colour
// alone), drawn inside the row so it never spills past the list group's edge.
const FOCUSED_ROW = "rounded-field ring-2 ring-inset ring-accent focus:outline-none";

function OpenedTag() {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-accent">
      <Bell aria-hidden={true} className="h-3.5 w-3.5 shrink-0" />
      From your notification
    </span>
  );
}

// The minimal DOM this needs, as a seam so it is testable without a browser.
type FocusTarget = {
  scrollIntoView(options?: ScrollIntoViewOptions): void;
  focus(options?: FocusOptions): void;
};
type FocusDocument = { getElementById(id: string): FocusTarget | null };

// Scroll the opened request into view and move focus to it (so a keyboard or screen
// reader user lands on it too). False when it is not on the page — never an error.
export function focusApprovalElement(doc: FocusDocument, approvalId: string): boolean {
  const element = doc.getElementById(approvalElementId(approvalId));
  if (!element) return false;
  element.scrollIntoView({ block: "center" });
  element.focus({ preventScroll: true });
  return true;
}

// Where the opened approval stands among the loaded requests.
type OpenedState = "pending" | "decided" | "expired" | "gone";

function openedStateOf(
  id: string,
  pending: readonly PendingRequestView[],
  history: readonly DecidedRequestView[],
  openedEntry?: DecidedRequestView,
): OpenedState {
  if (pending.some((request) => request.id === id)) return "pending";
  const decided = history.find((entry) => entry.id === id) ?? (openedEntry?.id === id ? openedEntry : undefined);
  if (!decided) return "gone";
  return decided.status === "expired" ? "expired" : "decided";
}

// Plain words for an opened approval that can no longer be decided. A decided one opens
// the History tab, where it is marked.
const OPENED_NOTICE: Record<Exclude<OpenedState, "pending">, string> = {
  decided: "That request has already been decided. You'll find it marked in History.",
  expired: "That request expired before it was decided. You'll find it marked in History.",
  gone: "We couldn't find that request. It may have expired or been removed.",
};

// ─── the pending list ────────────────────────────────────────────────────────────────

// A detail value (and any free-text line) may be one long unbroken string — an email
// address, a merchant name. It must wrap rather than widen the row past a 320px phone
// (brief: usable from 360px with no horizontal scrolling).
const WRAP_ANYWHERE = "min-w-0 [overflow-wrap:anywhere]";

// One pending request as a divider row of its list group: the request in one sentence,
// its exact details, the agent's reason, the rule and the time left, then the decision.
const PENDING_ROW = "flex min-w-0 flex-col gap-3 border-b border-line py-4 last:border-0";

function PendingItem({
  request,
  approveAction,
  denyAction,
  moreDetailAction,
  savedCards,
  focused,
}: {
  request: PendingRequestView;
  approveAction?: InboxAction;
  denyAction?: InboxAction;
  moreDetailAction?: InboxAction;
  savedCards?: readonly SavedCardView[];
  focused: boolean;
}) {
  const isRelease = request.release !== null;
  return (
    <li
      id={approvalElementId(request.id)}
      tabIndex={focused ? -1 : undefined}
      className={focused ? `${PENDING_ROW} ${FOCUSED_ROW}` : PENDING_ROW}
    >
      {focused ? <OpenedTag /> : null}
      <p className={`text-base text-fg ${WRAP_ANYWHERE}`}>
        <InlineAgentMark platform={request.agentPlatform} name={request.agent} />
        <span className="font-semibold">{request.agent}</span> {request.sentence}
      </p>
      {request.preview ? (
        <div className="min-w-0 border-l-2 border-line pl-3 text-sm">
          <p className={`font-medium text-fg ${WRAP_ANYWHERE}`}>{request.preview.title}</p>
          {request.preview.body ? <p className={`line-clamp-2 text-fg-muted ${WRAP_ANYWHERE}`}>{request.preview.body}</p> : null}
        </div>
      ) : null}
      {request.details.length || request.rule ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          {request.details.map((detail, index) => (
            <React.Fragment key={`${request.id}-detail-${index}`}>
              <dt className="text-fg-muted">{detail.label}</dt>
              <dd className={`text-fg ${WRAP_ANYWHERE}`}>{detail.value}</dd>
            </React.Fragment>
          ))}
          {request.rule ? (
            <>
              <dt className="text-fg-muted">Your rule</dt>
              <dd className={`text-fg ${WRAP_ANYWHERE}`}>{request.rule}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <p className={`text-sm text-fg-muted ${WRAP_ANYWHERE}`}>
        {request.reason ? (
          <>
            <span>{request.agent} says </span>
            <span className="text-fg">“{request.reason}”</span>
          </>
        ) : (
          <span>{request.agent} gave no reason</span>
        )}
        <span aria-hidden={true}> · </span>
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <Clock aria-hidden={true} className="h-4 w-4 shrink-0" />
          <span className="sr-only">Time left: </span>
          {request.timeLeft}
        </span>
      </p>
      {request.headsUp ? (
        <Notice tone="info" announce={false}>
          {request.headsUp}
        </Notice>
      ) : null}
      {request.extras && request.extras.length ? (
        <details className="group text-sm">
          <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-fg-muted [&::-webkit-details-marker]:hidden">
            <span>Details</span>
            <RequestContext request={request} />
            <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
            {request.extras.map((detail, index) => (
              <React.Fragment key={`${request.id}-extra-${index}`}>
                <dt className="text-fg-muted">{detail.label}</dt>
                {/* The full message keeps its line breaks, as it will be sent. */}
                <dd className={`whitespace-pre-line text-fg ${WRAP_ANYWHERE}`}>{detail.value}</dd>
              </React.Fragment>
            ))}
          </dl>
        </details>
      ) : null}
      {isRelease ? (
        <ReleaseApprove
          request={request}
          savedCards={savedCards}
          secondaryActions={
            <>
              <DenyControl request={request} denyAction={denyAction} />
              <AskControl request={request} moreDetailAction={moreDetailAction} />
            </>
          }
        />
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <ApproveControl request={request} approveAction={approveAction} />
          <DenyControl request={request} denyAction={denyAction} />
          <AskControl request={request} moreDetailAction={moreDetailAction} />
        </div>
      )}
    </li>
  );
}

// ─── the pending panel ───────────────────────────────────────────────────────────────

type PendingControls = {
  approveAction?: InboxAction;
  denyAction?: InboxAction;
  moreDetailAction?: InboxAction;
  savedCards?: readonly SavedCardView[];
  focusApproval?: string;
};

// The requesting agent's mark, set into the request sentence just before its name.
function InlineAgentMark({ platform, name }: { platform?: string; name: string }) {
  if (!name) return null;
  return (
    <span className="me-1.5 inline-flex align-[-0.2em]">
      <AgentMark platform={platform} name={name} size="xs" />
    </span>
  );
}

type AgentGroup = { key: string; name: string; requests: PendingRequestView[] };

// Group pending requests by their agent, keeping the loader's newest-first order: the
// group with the newest request leads, and requests stay newest-first within a group.
function groupByAgent(pending: readonly PendingRequestView[]): AgentGroup[] {
  const groups = new Map<string, AgentGroup>();
  for (const request of pending) {
    const key = request.agentId ?? `name:${request.agent}`;
    const group = groups.get(key) ?? { key, name: request.agent || "Unknown agent", requests: [] };
    group.requests.push(request);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function PendingPanel({ pending, ...controls }: PendingControls & { pending: readonly PendingRequestView[] }) {
  if (pending.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        heading={NOTHING_WAITING.heading}
        description={NOTHING_WAITING.description}
        action={<ButtonLink href={hrefWith(INBOX_PATH, { view: "history" }, {})}>See past decisions</ButtonLink>}
      />
    );
  }
  const item = (request: PendingRequestView) => (
    <PendingItem
      key={request.id}
      request={request}
      approveAction={controls.approveAction}
      denyAction={controls.denyAction}
      moreDetailAction={controls.moreDetailAction}
      savedCards={controls.savedCards}
      focused={request.id === controls.focusApproval}
    />
  );
  const groups = groupByAgent(pending);
  // One agent asking: one list group. Two or more: one titled group per agent.
  if (groups.length < 2) {
    return (
      <ListGroup id="inbox-pending" title="Requests to decide" count={pending.length} summary="Newest first. Each request waits until you decide or it runs out of time.">
        {pending.map(item)}
      </ListGroup>
    );
  }
  return (
    <>
      {groups.map((group, index) => (
        <ListGroup key={group.key} id={`inbox-agent-${index}`} title={group.name} count={group.requests.length}>
          {group.requests.map(item)}
        </ListGroup>
      ))}
    </>
  );
}

// ─── the history panel ───────────────────────────────────────────────────────────────

// Each decided status reads as WORDS (the loader's display-ready `outcome`) plus an icon,
// never colour alone; the icon is decorative and inherits the tone token via currentColor.
const HISTORY_META: Record<DecidedStatus, { Icon: LucideIcon; tone: string }> = {
  approved: { Icon: CheckCircle, tone: "text-success" },
  denied: { Icon: XCircle, tone: "text-danger" },
  expired: { Icon: Clock, tone: "text-fg-muted" },
  more_detail: { Icon: HelpCircle, tone: "text-fg-muted" },
};

// The words each outcome filter reads as (one verb pair: Approved / Denied).
const OUTCOME_FILTER_LABEL: Record<DecidedStatus, string> = {
  approved: "Approved",
  denied: "Denied",
  expired: "Expired",
  more_detail: "Asked for more detail",
};

function HistoryItem({ entry, focused }: { entry: DecidedRequestView; focused: boolean }) {
  const { Icon, tone } = HISTORY_META[entry.status];
  return (
    <li
      id={approvalElementId(entry.id)}
      tabIndex={focused ? -1 : undefined}
      className={focused ? `${LIST_ROW} ${FOCUSED_ROW}` : LIST_ROW}
    >
      {focused ? <OpenedTag /> : null}
      <p className={`text-fg ${WRAP_ANYWHERE}`}>
        <InlineAgentMark platform={entry.agentPlatform} name={entry.agent} />
        <span className="font-medium">{entry.agent}</span> {entry.sentence}
      </p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={["inline-flex items-center gap-1.5 text-sm font-medium", tone].join(" ")}>
          <Icon aria-hidden={true} className="h-4 w-4 shrink-0" />
          {entry.outcome}
        </span>
        {entry.decidedAt ? <span className="text-xs text-fg-muted">{entry.decidedAt}</span> : null}
      </div>
      {entry.question ? <p className={`text-sm text-fg-muted ${WRAP_ANYWHERE}`}>Your question: {entry.question}</p> : null}
    </li>
  );
}

const INBOX_PATH = "/inbox";

// Every history link keeps the History tab and the other filter, and drops one-off state
// (a notice, the notification's approval id) — only this fixed path is ever emitted.
function historyHref(filter: HistoryFilter, patch: HistoryFilter): string {
  return hrefWith(INBOX_PATH, { view: "history", outcome: filter.outcome, agent: filter.agent }, patch);
}

// Everything that narrows the history, in one bounded toolbar: the outcome chips, the agent
// chips (only when there is a choice) and the applied filters with "Clear all".
function HistoryFilters({ filter, summary }: { filter: HistoryFilter; summary: HistorySummary }) {
  const agentName = (id: string) => summary.agents.find((agent) => agent.id === id)?.name ?? "Unknown agent";
  const applied: AppliedFilter[] = [];
  if (filter.outcome) {
    applied.push({ label: `Outcome: ${OUTCOME_FILTER_LABEL[filter.outcome]}`, removeHref: historyHref(filter, { outcome: undefined }) });
  }
  if (filter.agent) {
    applied.push({ label: `Agent: ${agentName(filter.agent)}`, removeHref: historyHref(filter, { agent: undefined }) });
  }
  return (
    <ListToolbar
      label="Filter decisions"
      filters={
        <div className="flex min-w-0 flex-col gap-3">
          <FilterLinks
            label="Filter decisions by outcome"
            variant="scroll"
            items={[
              {
                label: "All",
                href: historyHref(filter, { outcome: undefined }),
                active: filter.outcome === undefined,
                count: summary.allOutcomesCount,
              },
              ...summary.outcomes.map((option) => ({
                label: OUTCOME_FILTER_LABEL[option.status],
                href: historyHref(filter, { outcome: option.status }),
                active: filter.outcome === option.status,
                count: option.count,
              })),
            ]}
          />
          {summary.agents.length >= 2 || filter.agent ? (
            <FilterLinks
              label="Filter decisions by agent"
              variant="scroll"
              items={[
                {
                  label: "All agents",
                  href: historyHref(filter, { agent: undefined }),
                  active: filter.agent === undefined,
                  count: summary.allAgentsCount,
                },
                ...summary.agents.map((agent) => ({
                  label: agent.name,
                  href: historyHref(filter, { agent: agent.id }),
                  active: filter.agent === agent.id,
                  count: agent.count,
                })),
              ]}
            />
          ) : null}
        </div>
      }
      applied={<ActiveFilters filters={applied} clearHref={historyHref(filter, { outcome: undefined, agent: undefined })} />}
    />
  );
}

function HistoryPanel({
  history,
  filter,
  summary,
  openedEntry,
  focusApproval,
}: {
  history: readonly DecidedRequestView[];
  filter: HistoryFilter;
  summary?: HistorySummary;
  openedEntry?: DecidedRequestView;
  focusApproval?: string;
}) {
  const total = summary?.total ?? history.length;
  const matching = summary?.matching ?? history.length;
  const filtered = filter.outcome !== undefined || filter.agent !== undefined;
  const extra = openedEntry && !history.some((entry) => entry.id === openedEntry.id) ? openedEntry : undefined;
  const clearHref = historyHref(filter, { outcome: undefined, agent: undefined });
  return (
    <>
      {extra ? (
        <ListGroup id="inbox-opened" title="The request you opened">
          <HistoryItem entry={extra} focused={extra.id === focusApproval} />
        </ListGroup>
      ) : null}
      {summary && total > 0 ? <HistoryFilters filter={filter} summary={summary} /> : null}
      {history.length === 0 ? (
        filtered ? (
          <EmptyState
            heading="No decisions match"
            description="Try another outcome or agent, or clear the filters to see every decision."
            action={<ButtonLink href={clearHref}>Clear filters</ButtonLink>}
          />
        ) : extra ? null : (
          <EmptyState
            icon={History}
            heading="No decisions yet"
            description="Requests you approve, deny or ask about are listed here, and every decision is also kept in Activity."
            action={<ButtonLink href={INBOX_PATH}>See what&apos;s waiting</ButtonLink>}
          />
        )
      ) : (
        <ListGroup
          id="inbox-history"
          title="Recent decisions"
          count={matching}
          summary={
            matching > history.length ? (
              <>
                Showing the {history.length} most recent of {matching}. Choose an outcome or agent to narrow
                the list; every decision is also kept in <a href="/activity" className="underline underline-offset-4">Activity</a>.
              </>
            ) : undefined
          }
        >
          {history.map((entry) => (
            <HistoryItem key={entry.id} entry={entry} focused={entry.id === focusApproval} />
          ))}
        </ListGroup>
      )}
    </>
  );
}

// ─── the view ────────────────────────────────────────────────────────────────────────

const INBOX_HEADING = {
  title: "Inbox",
  description: "Requests from your agents that need your decision. Nothing goes ahead until you approve it.",
};

export function InboxView({
  pending,
  history,
  approveAction,
  denyAction,
  moreDetailAction,
  savedCards,
  focusApproval,
  initialView,
  historyFilter = {},
  historySummary,
  openedEntry,
  notice,
  hasAgents = true,
}: InboxViewProps) {
  const historyTotal = historySummary?.total ?? history.length;
  const isEmpty = pending.length === 0 && historyTotal === 0 && !openedEntry;
  const opened = focusApproval ? openedStateOf(focusApproval, pending, history, openedEntry) : null;
  // Once mounted, bring the opened request into view and give it focus.
  React.useEffect(() => {
    if (focusApproval && opened !== "gone") focusApprovalElement(document, focusApproval);
  }, [focusApproval, opened]);
  // A decided approval from a notification opens History; anything else opens Waiting on
  // you. An explicit `?view=` wins. Both panels stay mounted, so drafts survive a switch.
  const openedView: InboxViewKey = opened === "decided" || opened === "expired" ? "history" : "pending";
  const firstView = initialView ?? openedView;
  // The outcome of the last action (and where an opened approval went) is the page's one
  // notice slot: straight under the heading band — on a tabbed page, first in the tab that
  // opens. A decision notice leaves the address bar once shown; the opened approval stays
  // so a refresh still lands on it.
  const notices =
    notice || (opened !== null && opened !== "pending") ? (
      <>
        {notice ? <PageNotice tone={notice.tone}>{notice.text}</PageNotice> : null}
        {opened !== null && opened !== "pending" ? (
          <PageNotice tone="info" clearParams={[]}>{OPENED_NOTICE[opened]}</PageNotice>
        ) : null}
      </>
    ) : null;
  if (isEmpty) {
    return (
      <div className="wh-page">
        <WorkspaceHeading title={INBOX_HEADING.title} description={INBOX_HEADING.description} />
        {notices}
        <EmptyState
          icon={CheckCircle2}
          heading={NOTHING_WAITING.heading}
          description={
            hasAgents
              ? NOTHING_WAITING.description
              : "Once you connect an agent, anything it asks you to approve waits here until you decide."
          }
          action={
            hasAgents ? (
              <ButtonLink href="/rules">Choose what needs your approval</ButtonLink>
            ) : (
              <ButtonLink href="/agents/connect" variant="primary">Connect your first agent</ButtonLink>
            )
          }
        />
      </div>
    );
  }
  return (
    <div className="wh-page">
      <ViewPanels
        label="Inbox"
        heading={INBOX_HEADING}
        defaultTab={openedView}
        initialTab={firstView}
        tabs={[
          {
            key: "pending",
            label: `Waiting on you (${pending.length})`,
            content: (
              <>
                {firstView === "pending" ? notices : null}
                <PendingPanel
                  pending={pending}
                  approveAction={approveAction}
                  denyAction={denyAction}
                  moreDetailAction={moreDetailAction}
                  savedCards={savedCards}
                  focusApproval={focusApproval}
                />
              </>
            ),
          },
          {
            key: "history",
            label: `History (${historyTotal})`,
            content: (
              <>
                {firstView === "history" ? notices : null}
                <HistoryPanel
                  history={history}
                  filter={historyFilter}
                  summary={historySummary}
                  openedEntry={openedEntry}
                  focusApproval={focusApproval}
                />
              </>
            ),
          },
        ]}
      />
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
  readonly postRelease: (approvalId: string, value: string, fieldId?:string) => Promise<void>;
}

// The chosen card's NON-SECRET checkout details (review fix W6), from the loader's
// SavedCardView: they travel with the decrypted number and the typed security code so the
// agent can complete a checkout.
export type CardCheckoutDetails = Pick<
  SavedCardView,
  "expiryMonth" | "expiryYear" | "cardholderName" | "billingAddress"
>;

export interface ReleaseInput {
  readonly fieldId?:string;
  readonly approvalId: string;
  readonly unlockRequest: UnlockRequest;
  readonly ciphertext: string;
  // The freshly-entered card security code (card releases only); never stored anywhere.
  readonly securityCode?: string;
  // The chosen card's checkout details (card releases only).
  readonly card?: CardCheckoutDetails;
}

// A failed release carries plain copy and, when the server refused it, the server's
// stable reason (e.g. "step_up_required") so the control can offer the next step.
export type ReleaseResult = { ok: true } | { ok: false; error: string; reason?: string };

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

// Plain copy for each reason the server refuses a release with — what happened and what
// to do next (never "try again" when trying again cannot help).
const REFUSAL_COPY: Record<string, string> = {
  step_up_required: "Please confirm it's you first, then approve and release again.",
  over_budget: "This would put the agent over its card budget, so nothing was handed over.",
  over_member_budget: "This would put you over your household spending limit, so nothing was handed over.",
  over_household_budget: "This would put your household over its shared budget, so nothing was handed over.",
  household_rate_unavailable: "A reference rate is missing for household spending. Nothing was handed over; try again after rates are available.",
  agent_rate_unavailable: "A reference rate is missing for earlier agent spending. Nothing was handed over; try again after rates are available.",
  household_period_unavailable: "Earlier household release dates need checking before the budget can be confirmed. Nothing was handed over; contact support.",
  expired: "This request expired before you approved it, so nothing was handed over.",
  already_released: "This has already been handed over to the agent.",
  not_releasable: "This request can no longer be approved and released, so nothing was handed over.",
};

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
    // security code (which is never stored) and the card's non-secret checkout details —
    // expiry, name on card, billing address (review fix W6; an unknown one is null, so
    // the agent always gets the same shape); a high-tier release hands over the value
    // alone. The plaintext travels only in this single request.
    const payload =
      input.securityCode === undefined
        ? value
        : JSON.stringify({
            number: value,
            securityCode: input.securityCode,
            expiryMonth: input.card?.expiryMonth ?? null,
            expiryYear: input.card?.expiryYear ?? null,
            cardholderName: input.card?.cardholderName ?? null,
            billingAddress: input.card?.billingAddress ?? null,
          });

    // 3. Post the released value to the approval's release endpoint. A refusal with a
    //    known reason is reported in its own plain words (with the reason, so the
    //    control can offer e.g. "Confirm it's you"); anything else is the generic copy.
    try {
      if(input.fieldId) await deps.postRelease(input.approvalId,payload,input.fieldId);
      else await deps.postRelease(input.approvalId, payload);
    } catch (error) {
      const reason = error instanceof ReleaseRejectedError ? error.code : null;
      if (reason !== null && REFUSAL_COPY[reason] !== undefined) {
        return { ok: false, error: REFUSAL_COPY[reason], reason };
      }
      return { ok: false, error: RELEASE_FAILED_COPY };
    }

    return { ok: true };
  }

  return { release };
}
