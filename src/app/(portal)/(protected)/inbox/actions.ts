import { vaultFieldAllowed } from "../../../../server/agents/resource-access";
import { getAgentById, listAgentsForUser, type Agent } from "../../../../server/db/agents";
import { getConnectionPermissions } from "../../../../server/db/agent-permissions";
import { formatAccountTime } from "@/server/display-time";
import { agoText } from "@/domain/display-time";
// Time left before a pending request expires, in plain words: minutes under an hour, then
// hours and minutes (the person's expiry runs up to 24 hours).
import { timeLeftLabel } from "@/domain/approvals/expiry-copy";
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
  DECIDED_STATUSES,
  countDecidedForUser,
  decide,
  getApproval,
  listDecidedForUser,
  type DecidedCount,
  type Decision,
  type StoredApproval,
} from "../../../../server/db/approvals";
import { firstParam } from "@/lib/href";
import { markOpened } from "../../../../server/approvals/opened";
import {
  readInbox,
  type PendingApproval,
  type DecidedApproval,
} from "../../../../server/approvals/inbox-read";
import { getCardCiphertext, listCards } from "../../../../server/db/cards";
import { getHighTierCiphertext, listHighTierFields } from "../../../../server/db/high-tier-fields";
import { getUserById } from "../../../../server/db/users";
import { listConnectionsForUser } from "../../../../server/db/connections";
import { listIdentityFields } from "../../../../server/db/identity-fields";
import { resolveCardBilling } from "../../../../server/vault/card-billing";
import { withTransaction } from "../../../../server/db/index";
import { createRedactingRecorder } from "../../../../server/mcp/recorder";
import { isReleaseRequest } from "../../../../domain/approvals/release-kind";
import { formatMoney, highTierFieldLabel, requestSentence } from "../../../../domain/approvals/request-sentence";
import type { OutgoingDetail } from "../../../../domain/approvals/outgoing";
import type { Session } from "../../../../server/auth/session";
import type { Clock } from "../../../../server/seams/clock";
import type { KeyWrapper } from "../../../../server/crypto/key-wrapper";
import type { Db } from "../../../../server/db/index";
import type { ApprovedHoldResult } from "../../../../server/mcp/pipeline";
import type {
  DecidedRequestView,
  DecidedStatus,
  HighTierFieldView,
  HistoryFilter,
  HistorySummary,
  InboxViewKey,
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
  // Names a connected service through the connector catalogue ("google-gmail" → "Gmail"),
  // so a request reads in the person's words. Absent (or unknown), the id is tidied.
  readonly serviceName?: (connectorId: string) => string | undefined;
}

// A decision's result: success, or a refusal naming its reason (an id/approval
// that is not this person's, or a release awaiting a fresh step-up). Never a
// silent success. The page maps the reason code to plain copy.
export type ActionResult = { ok: true } | { ok: false; reason: string };

// The DATA slice of <InboxView>'s props the loader returns: the person's OWN pending
// approvals (newest-first) + their decision history, and — for a card release — their
// saved cards. The page adds the bound decision actions (approve / deny / ask) and the
// device-release trigger when it renders. The view (E12-S12) owns this shape.
// It also carries the history organisation: the validated filters in force, the counts
// behind the History tab and its filter links, and — when a notification opened a decided
// approval that is not on the loaded page — that one decision.
export type InboxLoadData = Pick<
  InboxViewProps,
  "pending" | "history" | "savedCards" | "historyFilter" | "historySummary" | "openedEntry" | "hasAgents"
>;

// What the inbox address bar may ask for, as raw strings. `load` validates every value:
// an outcome must be a known one, an agent must be one of the SESSION person's own agents
// and an opened approval must be theirs — anything else is ignored, never trusted.
export interface InboxLoadOptions {
  readonly outcome?: string;
  readonly agent?: string;
  readonly focusApproval?: string;
}

// The inbox query: the validated tab plus the raw filters and opened approval `load`
// checks. A notice and any unknown parameter are left to the page.
export type InboxQuery = InboxLoadOptions & { readonly initialView?: InboxViewKey };

export function inboxQueryFrom(params: Record<string, string | string[] | undefined>): InboxQuery {
  const view = firstParam(params.view);
  const outcome = firstParam(params.outcome);
  const agent = firstParam(params.agent);
  const focusApproval = firstParam(params.approval);
  return {
    ...(view === "pending" || view === "history" ? { initialView: view } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(focusApproval !== undefined ? { focusApproval } : {}),
  };
}

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
  // The optional address-bar options narrow the history and resolve an opened approval.
  load(session: Session, options?: InboxLoadOptions): Promise<InboxLoadData>;
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

// The held call's outgoing summary (approval-card truth), when the detail carries one.
function outgoingOf(detail: Record<string, unknown>): OutgoingDetail | undefined {
  const outgoing = detail.outgoing as { kind?: unknown } | undefined;
  return outgoing && typeof outgoing === "object" && typeof outgoing.kind === "string" ? (detail.outgoing as OutgoingDetail) : undefined;
}

function recipientArray(detail: Record<string, unknown>): string[] {
  const recipients = detail.recipients ?? detail.recipient;
  if (Array.isArray(recipients)) return recipients.map(text).filter(Boolean);
  const one = text(recipients);
  return one ? [one] : [];
}

// "sarah@acme.com.au, tom@acme.com.au and 1 more" (the full list is in the details).
function guestText(guests: readonly string[]): string {
  if (guests.length <= 2) return guests.join(" and ");
  return `${guests.slice(0, 2).join(", ")} and ${guests.length - 2} more`;
}

// What goes out, up front (approval-card truth): the email's subject and opening words, the
// invitation's guests, the post's opening words, the request a service would receive, or a
// provider tool's main fields.
function outgoingLines(outgoing: OutgoingDetail | undefined, timeZone?: string | null): RequestDetail[] {
  if (!outgoing) return [];
  switch (outgoing.kind) {
    case "email":
      // Shown as the card's preview block instead (subject, then the opening words).
      return [];
    case "invite":
      return [
        ...(outgoing.start ? [{ label: "When", value: /T/.test(outgoing.start) ? formatAccountTime(outgoing.start, timeZone) : outgoing.start }] : []),
        ...(outgoing.guests.length ? [{ label: "Guests", value: guestText(outgoing.guests) }] : []),
      ];
    case "request":
      return [{ label: "Request", value: `${outgoing.method} ${outgoing.path}${outgoing.queryKeys.length ? ` (with ${outgoing.queryKeys.join(", ")})` : ""}` }];
    case "provider":
      return outgoing.arguments.slice(0, 3).map((arg) => ({ label: arg.key, value: arg.preview }));
    case "post":
      return [
        { label: "Post", value: outgoing.excerpt },
        ...(outgoing.linkDomain ? [{ label: "Links to", value: outgoing.linkDomain }] : []),
        ...(outgoing.linkTitle ? [{ label: "Link title", value: outgoing.linkTitle }] : []),
      ];
    case "post_delete":
      return [{ label: "Post", value: outgoing.url }];
    case "core":
      // Every line, so a change's due date or status is never cut off (code review).
      return outgoing.lines.slice(0, 8).map((line) => ({ label: line.key, value: line.preview }));
  }
}

// The services the person has more than one account of: a card for one of them names its
// account in its sentence, since "Gmail" alone no longer says which inbox it sends from
// (docs/adr/google-published-and-accounts.md).
export type SharedServices = ReadonlySet<string>;

// The exact lines up front — what goes out, then amount (and its converted amount), merchant,
// field and purpose — each present only when the decrypted detail carries it.
function detailLines(detail: Record<string, unknown>, timeZone?: string | null): RequestDetail[] {
  const lines: RequestDetail[] = [...outgoingLines(outgoingOf(detail), timeZone)];
  // Recipients are in the sentence for an email; anything else with recipients lists them here.
  if (!outgoingOf(detail)) {
    const recipients = recipientsText(detail);
    if (recipients) lines.push({ label: "To", value: recipients });
  }
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

// The lines behind "Details": which account, everyone it goes to, link domains, the default
// rule, and which conversation and app it came from (both claims, so they say whose words
// they are — docs/adr/agent-runs.md).
function extraLines(detail: Record<string, unknown>): RequestDetail[] {
  const lines: RequestDetail[] = [];
  const account = text(detail.account);
  if (account) lines.push({ label: "Service account", value: account });
  const outgoing = outgoingOf(detail);
  if (outgoing) {
    const recipients = recipientArray(detail);
    if (outgoing.kind === "email") {
      if (outgoing.to.length) lines.push({ label: "To", value: outgoing.to.join(", ") });
      if (outgoing.cc.length) lines.push({ label: "Copy", value: outgoing.cc.join(", ") });
      if (outgoing.bcc.length) lines.push({ label: "Blind copy", value: outgoing.bcc.join(", ") });
      if (outgoing.linkDomains.length) lines.push({ label: "Links to", value: outgoing.linkDomains.join(", ") });
      if (outgoing.text) lines.push({ label: "Full message", value: outgoing.text });
    } else if (outgoing.kind === "post") {
      lines.push({ label: "Full post", value: outgoing.text });
      if (outgoing.link) lines.push({ label: "Link", value: outgoing.link });
      if (outgoing.linkDescription) lines.push({ label: "Link description", value: outgoing.linkDescription });
    } else if (recipients.length) {
      lines.push({ label: outgoing.kind === "invite" ? "All guests" : "Goes to", value: recipients.join(", ") });
    }
    if (outgoing.kind === "provider" && outgoing.arguments.length > 3) {
      for (const arg of outgoing.arguments.slice(3)) lines.push({ label: arg.key, value: arg.preview });
    }
  }
  const fresh = Array.isArray(detail.newRecipients) ? detail.newRecipients.map(text).filter(Boolean) : [];
  if (fresh.length > 1) lines.push({ label: "First time emailing", value: fresh.join(", ") });
  const unchecked = Array.isArray(detail.uncheckedRecipients) ? detail.uncheckedRecipients.map(text).filter(Boolean) : [];
  if (detail.recipientsUnchecked === true) lines.push({ label: "Sent mail", value: "Warthog couldn't check whether you've emailed these addresses before." });
  else if (unchecked.length) lines.push({ label: "Sent mail", value: `Warthog couldn't check whether you've emailed ${unchecked.join(", ")} before.` });
  const rule = text(detail.rule);
  // A card held because of what the agent just read already says so in its heads-up.
  if (rule && detail.ruleSource !== "person" && detail.readCheck !== true) lines.push({ label: "Why you're asked", value: rule });
  const run = detail.run !== null && typeof detail.run === "object" ? (detail.run as Record<string, unknown>) : undefined;
  if (run && typeof run.id === "string") lines.push({ label: "Conversation (as the agent described it)", value: text(run.label) || "Untitled conversation" });
  const via = text(detail.via);
  if (via) lines.push({ label: "Came through (as the app reported it)", value: via });
  return lines;
}

// An email's subject and opening words, shown as a two-line preview under the sentence.
function emailPreview(detail: Record<string, unknown>): { title: string; body?: string } | undefined {
  const outgoing = outgoingOf(detail);
  if (outgoing?.kind !== "email") return undefined;
  const title = outgoing.subject || (outgoing.reply ? "A reply in the same conversation" : "No subject");
  return outgoing.excerpt ? { title, body: outgoing.excerpt } : { title };
}

// What the agent recently read from someone else, from the approval's stored detail.
interface RecentRead {
  readonly at: Date;
  readonly sources: readonly { service?: string; kind?: string; sender?: string; account?: string }[];
}

function recentReadOf(detail: Record<string, unknown>): RecentRead | undefined {
  const recent = detail.recentRead as { at?: unknown; sources?: unknown } | undefined;
  if (!recent || typeof recent.at !== "string" || !Array.isArray(recent.sources)) return undefined;
  const at = new Date(recent.at);
  return Number.isFinite(at.getTime()) ? { at, sources: recent.sources as RecentRead["sources"] } : undefined;
}

// "an email from billing@x.co", "an email from billing@x.co in levyoren1@gmail.com" (the inbox
// it was read in), "an event from sam@x.co", "a file in Google Drive".
function sourceText(source: RecentRead["sources"][number]): string {
  const from = source.sender ? ` from ${source.sender}${source.account ? ` in ${source.account}` : ""}`
    : source.service ? ` in ${source.service}` : "";
  switch (source.kind) {
    case "email": return `an email${from}`;
    case "event": return `an event${from}`;
    case "file": return `a file${from}`;
    case "message": return `a message${from}`;
    default: return `something${from}`;
  }
}

// The Details line: what the agent read from others in the last hour, each with its own time.
function recentReadLine(detail: Record<string, unknown>, agent: string, now: Date): RequestDetail | undefined {
  const recent = recentReadOf(detail);
  if (!recent || recent.sources.length === 0) return undefined;
  const timed = recent.sources.map((source, index) => {
    const at = typeof (source as { at?: unknown }).at === "string" ? new Date((source as { at: string }).at) : index === 0 ? recent.at : undefined;
    return at && Number.isFinite(at.getTime()) ? `${sourceText(source)}, ${agoText(at, now)}` : sourceText(source);
  });
  return { label: `${agent} recently read`, value: timed.join("; ") };
}

// At most one gentle heads-up, only when something is unusual: the first email to an address
// (with what the agent just read, when it read something from someone else), or a send held
// because the agent just read someone else's content. (Warthog sends exactly the plain text
// the card shows, so nothing in an email is hidden from its recipient.)
function headsUpFor(detail: Record<string, unknown>, agent: string, now: Date): string | undefined {
  const fresh = Array.isArray(detail.newRecipients) ? detail.newRecipients.map(text).filter(Boolean) : [];
  const recent = recentReadOf(detail);
  const latest = recent?.sources[0];
  const read = recent && latest ? `${agent} read ${sourceText(latest)} ${agoText(recent.at, now)}.` : "";
  if (fresh.length) {
    const first = fresh.length === 1 ? `You haven't emailed ${fresh[0]} before.` : `You haven't emailed ${fresh.length} of these addresses before.`;
    if (!read) return first;
    if (fresh.length === 1 && latest?.sender === fresh[0]) return `${first} They sent the email ${agent} read ${agoText(recent!.at, now)}. Worth a second look if you didn't ask for this.`;
    return `${first} ${read} Worth a second look if you didn't ask for this.`;
  }
  if (detail.readCheck === true && read) return `${read} Warthog is checking with you before this goes out.`;
  return undefined;
}

// A decided status as plain-words outcome copy (the view adds the per-status icon). One
// verb pair everywhere: Approve / Deny, Approved / Denied (UI/UX pass content-12).
const OUTCOME: Record<DecidedStatus, string> = {
  approved: "You approved this",
  denied: "You denied this",
  expired: "This expired before you decided",
  more_detail: "You asked for more detail",
};

// What a request reads as, rebuilt from its stored detail at read time so every request —
// including ones stored before the wording improved — names its tool and service in words
// ("wants to use “Send” in Gmail", never the raw ids; UI/UX pass content-02). A detail
// without the call's fields (an older shape) keeps its stored sentence.
type ServiceNamer = (connectorId: string) => string | undefined;

function sentenceFor(detail: Record<string, unknown>, serviceName: ServiceNamer, shared: SharedServices = new Set()): string {
  if (typeof detail.tool !== "string" || detail.tool === "") return text(detail.sentence);
  const connector = text(detail.connector) || undefined;
  const account = connector && shared.has(connector) ? text(detail.account) : "";
  return requestSentence({
    ...(account ? { account } : {}),
    tool: detail.tool,
    connector,
    service: connector ? serviceName(connector) : undefined,
    request: isReleaseRequest(detail.request) ? detail.request : undefined,
    amount: typeof detail.amount === "number" ? detail.amount : undefined,
    currency: text(detail.currency) || undefined,
    merchant: text(detail.merchant) || undefined,
    field: text(detail.field) || undefined,
    recipients: recipientArray(detail),
    outgoing: outgoingOf(detail),
  });
}

// One pending approval → the view's already-formatted pending row.
function toPendingView(request: PendingApproval, serviceName: ServiceNamer, timeZone: string | null | undefined, now: Date, shared: SharedServices = new Set()): PendingRequestView {
  const recent = recentReadLine(request.detail, request.agent.displayName, now);
  const headsUp = headsUpFor(request.detail, request.agent.displayName, now);
  return {
    id: request.id,
    agentId: request.agent.id,
    agent: request.agent.displayName,
    agentPlatform: request.agent.platform,
    sentence: sentenceFor(request.detail, serviceName, shared),
    details: detailLines(request.detail, timeZone),
    extras: [...extraLines(request.detail), ...(recent ? [recent] : [])],
    ...(emailPreview(request.detail) ? { preview: emailPreview(request.detail) } : {}),
    ...(headsUp ? { headsUp } : {}),
    reason: text(request.detail.reason),
    // A rule the person wrote stays up front; the default "ask me first" (and any approval held
    // before Warthog recorded which it was) sits in the details.
    rule: request.detail.ruleSource === "person" ? text(request.detail.rule) : "",
    timeLeft: timeLeftLabel(request.timeLeftMs),
    expiresAtMs: now.getTime() + request.timeLeftMs,
    release: releaseKind(request.detail),
  };
}

// One decided approval → the view's already-formatted history row.
function toDecidedView(entry: DecidedApproval, timeZone: string, serviceName: ServiceNamer): DecidedRequestView {
  const view: DecidedRequestView = {
    id: entry.id,
    agent: entry.agent.displayName,
    agentPlatform: entry.agent.platform,
    sentence: sentenceFor(entry.detail, serviceName),
    status: entry.status,
    outcome: OUTCOME[entry.status],
    decidedAt: entry.decidedAt ? formatAccountTime(entry.decidedAt, timeZone) : "",
  };
  if (entry.question) view.question = entry.question;
  return view;
}

// A stored decided approval (read directly when the history is filtered, or for an opened
// approval) in the inbox read's shape, named from the person's own agents.
function asDecided(row: StoredApproval, nameById: ReadonlyMap<string, string>): DecidedApproval {
  return {
    id: row.id,
    agent: { id: row.agentId, displayName: nameById.get(row.agentId) ?? "" },
    detail: row.detail,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    question: row.question,
    status: row.status as DecidedApproval["status"],
  };
}

// The history filters the address bar asked for, kept only when valid: a known decided
// outcome, and an agent that is one of the person's OWN agents (by id).
function historyFilterFrom(options: InboxLoadOptions, agents: readonly Agent[]): HistoryFilter {
  const filter: HistoryFilter = {};
  const outcome = DECIDED_STATUSES.find((status) => status === options.outcome);
  if (outcome) filter.outcome = outcome;
  const agent = agents.find((candidate) => candidate.id === options.agent);
  if (agent) filter.agent = agent.id;
  return filter;
}

// The counts behind the History tab and its filters, from the grouped decision counts:
// each outcome counted within the agent filter, each agent within the outcome filter. Only
// outcomes and the person's own agents that have decisions are offered (plus an applied
// filter, so it can be seen and removed).
function historySummaryFrom(
  counts: readonly DecidedCount[],
  agents: readonly Agent[],
  filter: HistoryFilter,
): HistorySummary {
  const sum = (rows: readonly DecidedCount[]) => rows.reduce((total, row) => total + row.count, 0);
  const inAgent = (row: DecidedCount) => filter.agent === undefined || row.agentId === filter.agent;
  const inOutcome = (row: DecidedCount) => filter.outcome === undefined || row.status === filter.outcome;
  return {
    total: sum(counts),
    matching: sum(counts.filter((row) => inAgent(row) && inOutcome(row))),
    outcomes: DECIDED_STATUSES.filter(
      (status) => status === filter.outcome || counts.some((row) => row.status === status),
    ).map((status) => ({ status, count: sum(counts.filter((row) => row.status === status && inAgent(row))) })),
    allOutcomesCount: sum(counts.filter(inAgent)),
    agents: agents
      .filter((agent) => agent.id === filter.agent || counts.some((row) => row.agentId === agent.id))
      .map((agent) => ({
        id: agent.id,
        name: agent.displayName || "Unknown agent",
        count: sum(counts.filter((row) => row.agentId === agent.id && inOutcome(row))),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    allAgentsCount: sum(counts.filter(inOutcome)),
  };
}

export function createInboxActions(deps: InboxActionsDeps): InboxActions {
  const { db, clock, keyWrapper, executeApprovedHold } = deps;
  const serviceName: ServiceNamer = (connectorId) => deps.serviceName?.(connectorId);

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
  // HERE, from the card's billing reference, through the person's OWN postal addresses or
  // their own card-only addresses (resolveCardBilling binds the session user id and decrypts
  // under their DEK; docs/adr/card-billing-addresses.md) — so a reference to someone else's
  // address, to a non-address field or to nothing resolves to null, never to another
  // person's data.
  async function loadSavedCards(userId: string, dek: Uint8Array): Promise<SavedCardView[]> {
    const cards = await listCards(db, userId);
    if (cards.length === 0) return [];
    const fields = await listIdentityFields(db, userId, dek);
    const savedName = fields.find((field) => field.kind === "name")?.value ?? null;
    const billing = await resolveCardBilling(db, userId, cards, dek, { identityFields: fields });
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
        billingAddress: billing.get(card.id)?.text ?? null,
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
  async function load(session: Session, options: InboxLoadOptions = {}): Promise<InboxLoadData> {
    const dek = await dataKeyFor(session.userId);
    const timeZone = await timeZoneFor(db, session.userId, dek);
    const [inbox, agents, counts, connections] = await Promise.all([
      readInbox(db, session.userId, dek, clock),
      listAgentsForUser(db, session.userId),
      countDecidedForUser(db, session.userId),
      listConnectionsForUser(db, session.userId),
    ]);
    const perService = new Map<string, number>();
    for (const connection of connections) perService.set(connection.connectorId, (perService.get(connection.connectorId) ?? 0) + 1);
    const shared: SharedServices = new Set([...perService].filter(([, count]) => count > 1).map(([connectorId]) => connectorId));

    for (const request of inbox.pending) {
      await markOpened(db, { id: request.id, userId: session.userId }, clock);
    }

    const now = clock.now();
    let pending = inbox.pending.map((request) => toPendingView(request, serviceName, timeZone, now, shared));
    // A high-tier release needs the person's saved detail to decrypt on their device.
    if (pending.some((request) => request.release === "high_tier")) {
      const fields = await loadHighTierFields(session.userId);
      pending = await Promise.all(pending.map(async(request,index)=>{
        if(request.release !== "high_tier") return request;
        const original=inbox.pending[index]!;
        const agent=await getAgentById(db,session.userId,original.agent.id);
        const grants=agent ? await getConnectionPermissions(db,session.userId,agent.connectionId) : null;
        return offerFor(request,original.detail,grants?.highTierAccess ? fields.filter(f=>vaultFieldAllowed(grants,f.view.id)) : []);
      }));
    }

    // The history: the inbox read's newest page, or — with a valid filter — that page of
    // matching decisions (still member-scoped by the session user id, bound in SQL).
    const nameById = new Map(agents.map((agent) => [agent.id, agent.displayName]));
    const historyFilter = historyFilterFrom(options, agents);
    const decided =
      historyFilter.outcome !== undefined || historyFilter.agent !== undefined
        ? (
            await listDecidedForUser(db, session.userId, dek, {
              status: historyFilter.outcome,
              agentId: historyFilter.agent,
            })
          ).map((row) => asDecided(row, nameById))
        : inbox.history;
    const history = decided.map((entry) => toDecidedView(entry, timeZone, serviceName));
    const data: InboxLoadData = {
      pending,
      history,
      historyFilter,
      historySummary: historySummaryFrom(counts, agents, historyFilter),
      // Whether the person has connected an agent yet: an empty inbox then points at
      // connecting one rather than at rules.
      hasAgents: agents.length > 0,
    };

    // A notification can open a decided approval that is not on this page (older, or
    // hidden by a filter): load that one decision — only if it is the person's own.
    const focus = options.focusApproval;
    if (
      focus !== undefined &&
      uuidSchema.safeParse(focus).success &&
      !pending.some((request) => request.id === focus) &&
      !history.some((entry) => entry.id === focus)
    ) {
      const opened = await getApproval(db, session.userId, focus, dek);
      if (opened && opened.status !== "pending") {
        data.openedEntry = toDecidedView(asDecided(opened, nameById), timeZone, serviceName);
      }
    }

    if (pending.some((request) => request.release === "card")) {
      data.savedCards = await loadSavedCards(session.userId, dek);
    }
    return data;
  }

  return { approveApproval, denyApproval, askForMoreDetail, load };
}
