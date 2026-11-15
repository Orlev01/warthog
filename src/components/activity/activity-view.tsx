import * as React from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  CircleDot,
  Clock,
  Eye,
  KeyRound,
  Link2,
  MessageSquareText,
  PencilLine,
  Plug,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Undo2,
  UserCog,
  type LucideIcon,
} from "lucide-react";
import { ActionBar, WorkspaceHeading } from "@/components/shell/workspace-surfaces";

import { Button, buttonClasses } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Badge, CountBadge, type BadgeTone } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty";
import { PageNotice } from "@/components/ui/notice";
import { ActiveFilters, FilterLinks, type AppliedFilter, type FilterLink } from "@/components/ui/filter-links";
import { LIST_ROW, ListGroup } from "@/components/ui/list-group";
import { ListToolbar } from "@/components/ui/list-toolbar";
import { AgentMark, ServiceMark } from "@/components/ui/brand-mark";
import { SUPPORT_EMAIL } from "@/components/public/operator";
import type { IntegrityResult } from "@/server/activity/integrity";
import type { ActivityCategory, OutcomeGroup } from "@/domain/activity/category";
import type { EvidenceLine } from "@/domain/activity/evidence";

// E08-S08 — Activity view component (src/components/activity/activity-view.tsx), reorganised
// 12 November at the founder's request ("the audit log is one long thread"), and contained
// in the UI/UX pass the same day (no text loose on the canvas).
//
// The timeline is the product's trust surface (brief "Activity feed", design §9,
// constitution principle 14 "Warthog writes the record, not the agents"). This is ONE
// render-testable, prop-driven component that the page loader feeds already-formatted
// props: it reads nothing, reaches for no clock/locale/DB and decides nothing.
//
// The page, top to bottom: the heading band (with the record-wide Check integrity), the
// outcome notice, ONE toolbar holding everything that narrows the list (view switch, quick
// filters, search beside its Filters disclosure, applied filters, a status line), then the
// list itself — each day of the timeline, or each grouped view, is one list-group panel of
// divider rows — and the page links in a closing bar.
//
// Four views, switched by plain links (the loader builds every href, keeping filters):
//   • Timeline — entries newest-first (never reversed) under day headings, as compact rows;
//     each row's evidence, dispute history and Undo/Dispute controls sit in ONE
//     "View details" disclosure, open by default for a disputed entry or a permalink. The
//     evidence reads as labelled plain-English lines; the identifiers that make the entry
//     checkable sit in a collapsed "Technical details" list inside it.
//   • By agent / By type / By service — one row per group with exact counts, its type
//     split and anything that needs attention, each drilling into the filtered timeline.
//
// Trust rules carried into every view: agent-submitted summaries are labelled "Reported by
// <agent>" and never presented as fact; blocked/failed outcomes and disputes are visible on
// the collapsed row and on group rows; Dispute stays available on EVERY entry; Undo only
// where the entry's tool declares a reversal (`canUndo`), and an entry whose undo stands
// says so in its place (`undoStatus`) so Undo is never offered twice; the integrity check is
// record-wide and never shown per group. Controls are live forms or links, never dead
// buttons. Colour comes from the design tokens; meaning is always words plus an icon.

// One entry on the timeline. `source` is the activity vocabulary union: "warthog" is a
// fact Warthog recorded itself; "agent_reported" is a summary an agent submitted, shown
// labelled "Reported by <agent>" and never treated as the source of truth. `agent` is
// the connected AI client, `service` the connected service it touched (either may be
// absent). `canUndo` is true ⇔ the entry's tool declares a reversal and no undo of it
// stands; `undoStatus` says where a standing undo is, shown where the Undo button would be:
// "done" reads "Undone"; "waiting" reads "Undo waiting for your approval" with a link to
// that request in the Inbox (`approvalHref`). `title` is the
// row's headline in plain words — an agent call is titled by its tool ("Save a memory")
// — and `agent` is the agent's display name, never its raw id.
export type ActivityEntryView = {
  seq: number;
  kind: string; // display-ready, e.g. "Agent request"
  title?: string; // display-ready headline, e.g. "Save a memory" (absent ⇒ the kind)
  source: "warthog" | "agent_reported";
  agent?: string;
  agentHref?: string; // the timeline filtered to this agent
  agentRole?: "actor" | "subject"; // the agent acted, or an owner's change was about it
  changedBy?: "you"; // the entry records the account owner's own change
  service?: string;
  serviceId?: string; // the connected service's catalogue id, for its mark
  outcome: string; // display-ready, e.g. "Done"
  outcomeGroup?: OutcomeGroup;
  category?: ActivityCategory;
  categoryLabel?: string;
  at: string; // pre-formatted full time label
  dateTime?: string; // ISO instant for <time>
  time?: string; // time of day, e.g. "3:04 pm"
  dayKey?: string; // the calendar day it belongs to, for the day headings
  dayLabel?: string; // "Today", "Yesterday", "Mon 10 Nov"
  permalink?: string;
  summary: string; // one-line, already-redacted
  detail: string; // full detail as text, already-redacted (shown when there are no `facts`)
  facts?: readonly EvidenceLine[]; // labelled plain-English lines ("Warthog's decision: Allowed")
  technical?: readonly EvidenceLine[]; // identifiers and measurements, shown collapsed
  canUndo: boolean;
  undoStatus?: { readonly state: "done" } | { readonly state: "waiting"; readonly approvalHref: string };
  disputes?: readonly { note: string; at: string }[];
  via?: string; // the product the request came through, as reported ("Claude Code")
  conversation?: { id: string; label?: string }; // the agent conversation (run) it belongs to
  conversationHref?: string; // the timeline filtered to that conversation
};

export type ActivityViewKey = "timeline" | "agents" | "types" | "services";

// One group on the By agent / By type / By service views: exact counts, the type split and
// what needs attention, each linking into the filtered timeline.
export type ActivityGroupView = {
  readonly id: string;
  readonly label: string;
  // What identifies the group visually: an agent's platform, a service's id or a type.
  readonly mark?: { readonly kind: "agent"; readonly platform?: string } | { readonly kind: "service"; readonly id: string } | { readonly kind: "type"; readonly type: ActivityCategory };
  readonly detail?: string; // platform, connection status/date, or the type's description
  readonly disconnected?: boolean;
  readonly total: number;
  readonly lastAt?: string;
  readonly lastAtIso?: string;
  readonly href?: string; // the drill-down (absent for an empty type: no dead link)
  readonly split: readonly { readonly label: string; readonly count: number; readonly href: string }[];
  readonly blocked: number;
  readonly failed: number;
  readonly disputed: number;
  readonly attentionHref?: string;
  readonly manageHref?: string;
  readonly top?: string; // "Claude 60 · ChatGPT 38" on the By type view
};

// One filter choice: a plain value shown as itself, or a value posted by the filter with
// a display label (an agent is filtered by its id but offered by its name).
export type ActivityFilterOption = string | { readonly value: string; readonly label: string };

// The values each filter dropdown offers (resolved display names / labels).
export type ActivityFilterOptions = {
  agents: readonly ActivityFilterOption[];
  services: readonly ActivityFilterOption[];
  kinds: readonly ActivityFilterOption[];
  outcomes: readonly ActivityFilterOption[];
};

function optionParts(option: ActivityFilterOption): { value: string; label: string } {
  return typeof option === "string" ? { value: option, label: option } : option;
}

// The applied filter values, keyed by the GET param each control posts.
export type ActivityActiveFilters = {
  agent?: string;
  service?: string;
  kind?: string;
  outcome?: string;
  type?: string;
  from?: string; // "YYYY-MM-DD" (or an ISO date-time)
  to?: string; // "YYYY-MM-DD" (or an ISO date-time)
};

// The outcome of the last Dispute or Undo, in plain words (the page resolves `?notice=`).
export type ActivityPageNotice = {
  readonly tone: "done" | "problem" | "waiting";
  readonly text: string;
  readonly action?: { readonly href: string; readonly label: string };
};

export type ActivityViewProps = {
  entries: readonly ActivityEntryView[];
  nextHref?: string;
  newestHref?: string;
  // Set only for a search: how many entries the search examined on this page.
  scannedCount?: number;
  filterOptions: ActivityFilterOptions;
  query: string; // the current search text (pre-fills the search box)
  activeFilters?: ActivityActiveFilters;
  integrity: IntegrityResult | null; // the latest Check-integrity result, if one has run
  notice?: ActivityPageNotice | null;
  disputeAction?: (formData: FormData) => void | Promise<void>;
  undoAction?: (formData: FormData) => void | Promise<void>;
  // The organisation chrome (all links built by the loader).
  view?: ActivityViewKey;
  viewLinks?: readonly FilterLink[];
  quickLinks?: readonly FilterLink[];
  appliedFilters?: readonly AppliedFilter[];
  clearHref?: string;
  breadcrumb?: { label: string; href: string };
  // The current view state, carried as hidden fields by the filter and integrity forms.
  formState?: Readonly<Record<string, string | undefined>>;
  timeZoneNote?: string; // "Times are Sydney time."
  groups?: readonly ActivityGroupView[];
  countsCaption?: string;
  singleEntry?: boolean;
  // False when the person has no agents yet, so a first-run screen offers to connect one.
  hasAgents?: boolean;
};

const CATEGORY_ICONS: Record<ActivityCategory, LucideIcon> = {
  read: Eye,
  change: PencilLine,
  approval: KeyRound,
  report: MessageSquareText,
  rejected: Ban,
  access: Plug,
  account: UserCog,
  other: CircleDot,
};

const OUTCOME_BADGES: Record<OutcomeGroup, { icon?: LucideIcon; tone: BadgeTone }> = {
  done: { icon: CheckCircle, tone: "success" },
  waiting: { icon: Clock, tone: "warning" },
  blocked: { icon: Ban, tone: "danger" },
  failed: { icon: AlertTriangle, tone: "danger" },
  other: { tone: "neutral" },
};

// Each activity type's tone: reads blue, changes amber, approvals in the accent, rejected
// requests red; the rest stay neutral (docs/adr/brand-marks-and-accent.md).
const CATEGORY_TONES: Record<ActivityCategory, string> = {
  read: "wh-tone-info",
  change: "wh-tone-warning",
  approval: "wh-tone-tint",
  report: "wh-tone-neutral",
  rejected: "wh-tone-danger",
  access: "wh-tone-tint",
  account: "wh-tone-neutral",
  other: "wh-tone-neutral",
};

type FormAction = (formData: FormData) => void | Promise<void>;

// The outcome in words, with a tone icon (the icon carries colour, the word carries meaning).
function OutcomeBadge({ outcome, group }: { outcome: string; group?: OutcomeGroup }) {
  if (!outcome) return null;
  const badge = OUTCOME_BADGES[group ?? "other"];
  return (
    <Badge tone={badge.tone} icon={badge.icon}>
      {outcome}
    </Badge>
  );
}

function HiddenState({ state, omit = [] }: { state?: Readonly<Record<string, string | undefined>>; omit?: readonly string[] }) {
  if (!state) return null;
  return (
    <>
      {Object.entries(state)
        .filter(([key, value]) => value !== undefined && !omit.includes(key))
        .map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />)}
    </>
  );
}

type Facet = {
  name: keyof ActivityActiveFilters;
  label: string;
  all: string;
  options: readonly ActivityFilterOption[];
  value?: string;
};

function FacetFilter({ name, label, all, options, value }: Facet) {
  const id = `activity-filter-${name}`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select id={id} name={name} defaultValue={value ?? ""}>
        <option value="">{all}</option>
        {options.map(optionParts).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

// "Filtered by Agent: Claude · From 2026-03-01" — the plain-text summary used when the
// loader supplies no chip list (named by each option's label, never the posted id).
function filterSummary(facets: readonly Facet[], active: ActivityActiveFilters): string[] {
  const labelOf = (facet: Facet, value: string): string =>
    facet.options.map(optionParts).find((option) => option.value === value)?.label ?? value;
  const parts = facets
    .filter((facet) => active[facet.name] !== undefined)
    .map((facet) => `${facet.label}: ${labelOf(facet, active[facet.name]!)}`);
  if (active.from) parts.push(`From ${active.from.slice(0, 10)}`);
  if (active.to) parts.push(`To ${active.to.slice(0, 10)}`);
  return parts;
}

// The record-wide Check-integrity result, in words plus an icon. A failure is announced. The
// check walks the hash chain over the stored entries, so the copy says what it does and
// doesn't show; a failure points at the first entry that doesn't match.
function IntegrityResultNotice({ result }: { result: IntegrityResult }) {
  if (result.intact) {
    return (
      <PageNotice tone="success" clearParams={[]}>
        <p className="font-medium">Your record checks out.</p>
        <p className="mt-1 max-w-prose text-fg-muted">
          All {result.checked} {result.checked === 1 ? "entry is" : "entries are"} intact: each is still linked to the one before
          it, exactly as it was written. The check can&apos;t show whether something was never recorded, or whether the newest
          entries were removed by someone with direct access to Warthog&apos;s database. Your disputes are kept alongside the
          record and aren&apos;t part of this check.
        </p>
      </PageNotice>
    );
  }
  return (
    <PageNotice tone="error" clearParams={[]}>
      <p className="font-medium">The integrity check failed.</p>
      <p className="mt-1 max-w-prose">
        {result.brokenSeq !== null ? (
          <>
            <a href={`/activity?entry=${result.brokenSeq}#entry-${result.brokenSeq}`} className="font-medium underline underline-offset-4">
              Entry {result.brokenSeq}
            </a>{" "}
            doesn&apos;t match the record and may have been changed.
          </>
        ) : (
          "An entry doesn't match the record and may have been changed."
        )}{" "}
        <a href="/settings/data" className="font-medium underline underline-offset-4">Export your activity</a>, then email{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="font-medium underline underline-offset-4">{SUPPORT_EMAIL}</a>.
      </p>
    </PageNotice>
  );
}

const NOTICE_TONES = { done: "success", waiting: "info", problem: "error" } as const;

function UndoControl({ entry, undoAction }: { entry: ActivityEntryView; undoAction?: FormAction }) {
  const context = <span className="sr-only"> {entry.title ?? entry.kind}, {entry.at}</span>;
  if (!undoAction) {
    return (
      <div className="flex flex-col gap-1">
        <Button type="button" variant="secondary" size="sm" disabled className="self-start">
          Undo{context}
        </Button>
        <p className="text-xs text-fg-muted">Undoing isn&apos;t available just now.</p>
      </div>
    );
  }
  return (
    <ActionForm action={undoAction}>
      <input type="hidden" name="seq" value={String(entry.seq)} />
      <FormSubmit variant="secondary" size="sm" pendingLabel="Undoing…">
        Undo{context}
      </FormSubmit>
    </ActionForm>
  );
}

// Where a standing undo is, in place of a second Undo button: done, or waiting for the
// person's approval with a link to that request in the Inbox. Words plus an icon, never
// colour alone; each status is a badge, so its words sit inside a bounded component.
function UndoStatus({ entry, status }: { entry: ActivityEntryView; status: NonNullable<ActivityEntryView["undoStatus"]> }) {
  if (status.state === "done") {
    return <Badge tone="neutral" icon={Undo2} className="self-start">Undone</Badge>;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 self-start">
      <Badge tone="warning" icon={Clock}>Undo waiting for your approval</Badge>
      <a href={status.approvalHref} className="inline-flex min-h-11 items-center font-medium text-fg underline underline-offset-4 lg:min-h-0">
        Review approval<span className="sr-only"> to undo {entry.title ?? entry.kind}, {entry.at}</span>
      </a>
    </div>
  );
}

function DisputeControl({ entry, disputeAction }: { entry: ActivityEntryView; disputeAction?: FormAction }) {
  const context = <span className="sr-only"> {entry.title ?? entry.kind}, {entry.at}</span>;
  if (!disputeAction) {
    return (
      <div className="flex flex-col gap-1">
        <Button type="button" variant="secondary" size="sm" disabled className="self-start">
          Dispute{context}
        </Button>
        <p className="text-xs text-fg-muted">Disputing isn&apos;t available just now.</p>
      </div>
    );
  }
  const noteId = `activity-dispute-note-${entry.seq}`;
  return (
    <ActionForm action={disputeAction} className="flex w-full min-w-0 flex-col gap-2 sm:max-w-md">
      <input type="hidden" name="seq" value={String(entry.seq)} />
      <Label htmlFor={noteId}>Dispute this entry: tell us what&apos;s wrong</Label>
      <Textarea id={noteId} name="note" required={true} rows={2} />
      <FormSubmit variant="secondary" size="sm" pendingLabel="Recording your dispute…" className="self-start">
        Dispute{context}
      </FormSubmit>
    </ActionForm>
  );
}

// Labelled lines: the label above its value on phones, beside it from 640px.
function EvidenceList({ lines, compact = false }: { lines: readonly EvidenceLine[]; compact?: boolean }) {
  return (
    <dl className="flex min-w-0 flex-col gap-2">
      {lines.map((line, index) => (
        <div key={`${line.label}-${index}`} className="grid min-w-0 gap-0.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-x-4">
          <dt className="text-fg-muted">{line.label}</dt>
          <dd className={`min-w-0 max-w-[72ch] whitespace-pre-line text-fg [overflow-wrap:anywhere] ${compact ? "font-mono text-xs leading-5" : ""}`}>{line.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ActivityEntryItem({
  entry,
  open,
  disputeAction,
  undoAction,
}: {
  entry: ActivityEntryView;
  open: boolean;
  disputeAction?: FormAction;
  undoAction?: FormAction;
}) {
  const Icon = entry.category ? CATEGORY_ICONS[entry.category] : CircleDot;
  const title = entry.title ?? entry.kind;
  const disputed = (entry.disputes?.length ?? 0) > 0;
  const reported = entry.source === "agent_reported";
  const agentText = entry.agent ? (
    entry.agentHref ? (
      <a href={entry.agentHref} className="underline underline-offset-2 hover:text-fg">
        <span className="sr-only">Show activity by </span>
        {entry.agent}
      </a>
    ) : (
      entry.agent
    )
  ) : null;
  // Who: the agent that acted (or the agent a change was about), and whether it was you —
  // with the product the request came through, as the app reported it.
  const who = reported || !agentText ? null : entry.via ? <>{agentText} via {entry.via}</> : agentText;
  // The agent conversation it belongs to, linking to everything else recorded in it.
  const conversationName = entry.conversation ? entry.conversation.label ?? "Untitled conversation" : null;
  const conversation = conversationName === null ? null : entry.conversationHref ? (
    <a href={entry.conversationHref} className="underline underline-offset-2 hover:text-fg">
      <span className="sr-only">Show the conversation </span>
      {conversationName}
    </a>
  ) : conversationName;
  const service = entry.service ? (
    <span className="inline-flex items-center gap-1 align-middle">
      {entry.serviceId ? <ServiceMark id={entry.serviceId} name={entry.service} size="xs" /> : null}
      {entry.service}
    </span>
  ) : null;
  const meta = [entry.categoryLabel ?? null, who, conversation, service, entry.changedBy === "you" ? "Changed by you" : null, entry.time ? null : entry.at].filter(Boolean);
  const facts: readonly EvidenceLine[] = entry.facts && entry.facts.length > 0 ? [{ label: "Recorded", value: entry.at }, ...entry.facts] : [];
  return (
    <li id={`entry-${entry.seq}`} className={LIST_ROW}>
      <div className="flex min-w-0 items-start gap-3">
        <span className={`mt-0.5 inline-grid h-6 w-6 shrink-0 place-items-center rounded-md ${entry.category ? CATEGORY_TONES[entry.category] : "wh-tone-neutral"}`} style={{ background: "var(--wh-tone-soft)" }}>
          <Icon aria-hidden={true} className="h-3.5 w-3.5 wh-tone-icon" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-start justify-between gap-x-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="font-medium text-fg">{title}</h3>
              <OutcomeBadge outcome={entry.outcome} group={entry.outcomeGroup} />
              {disputed ? (
                <Badge tone="warning" icon={AlertTriangle}>
                  Disputed
                </Badge>
              ) : null}
            </div>
            {entry.time ? (
              <time dateTime={entry.dateTime} title={entry.at} className="shrink-0 text-sm tabular-nums text-fg-muted">
                {entry.time}
              </time>
            ) : null}
          </div>
          {meta.length > 0 ? (
            <p className="text-sm text-fg-muted">
              {meta.map((part, index) => (
                <React.Fragment key={index}>
                  {index > 0 ? " · " : null}
                  {part}
                </React.Fragment>
              ))}
            </p>
          ) : null}
          {entry.summary !== title ? <p className="max-w-[72ch] text-fg">{entry.summary}</p> : null}
          {reported ? <p className="text-sm text-fg-muted">Reported by {entry.agent}. Warthog did not observe this.</p> : null}
          <details open={open || disputed} className="group text-sm">
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 self-start font-medium text-fg underline underline-offset-4 lg:pointer-fine:min-h-8 [&::-webkit-details-marker]:hidden">
              View details<span className="sr-only"> for {title}, {entry.at}</span>
              <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180" />
            </summary>
            <div className="flex min-w-0 flex-col gap-4 rounded-field bg-surface-muted p-3 sm:p-4">
              {facts.length > 0 ? <EvidenceList lines={facts} /> : (
                <>
                  <p className="max-w-[72ch] whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">{entry.detail}</p>
                  {entry.time ? <p className="text-fg-muted">Recorded {entry.at}</p> : null}
                </>
              )}
              {disputed ? (
                <div aria-label="Dispute history" role="group" className="flex flex-col gap-2 border-l-2 border-warning pl-3">
                  <p className="font-medium">Your disputes</p>
                  {entry.disputes!.map((note, index) => (
                    <p key={index} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                      {note.note}
                      <span className="block text-fg-muted">{note.at}</span>
                    </p>
                  ))}
                </div>
              ) : null}
              {entry.technical && entry.technical.length > 0 ? (
                <details className="group/technical">
                  <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 font-medium text-fg lg:pointer-fine:min-h-8 [&::-webkit-details-marker]:hidden">
                    Technical details<span className="sr-only"> for {title}</span>
                    <ChevronDown aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted transition-transform group-open/technical:rotate-180" />
                  </summary>
                  <div className="flex flex-col gap-3 pt-1">
                    <p className="max-w-prose text-fg-muted">
                      These identify the entry in Warthog&apos;s tamper-evident record. Support may ask for them.
                    </p>
                    <EvidenceList lines={entry.technical} compact={true} />
                  </div>
                </details>
              ) : null}
              <div className="flex flex-col gap-3 border-t border-line pt-3 sm:flex-row sm:flex-wrap sm:items-start">
                {entry.canUndo ? <UndoControl entry={entry} undoAction={undoAction} />
                  : entry.undoStatus ? <UndoStatus entry={entry} status={entry.undoStatus} /> : null}
                <DisputeControl entry={entry} disputeAction={disputeAction} />
              </div>
              {entry.permalink ? (
                <a href={entry.permalink} className="inline-flex min-h-11 items-center gap-1.5 self-start font-medium text-fg underline underline-offset-4 lg:min-h-0">
                  <Link2 aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted" />
                  Link to this entry<span className="sr-only">: {title}, {entry.at}</span>
                </a>
              ) : null}
            </div>
          </details>
        </div>
      </div>
    </li>
  );
}

// Consecutive entries on the same calendar day, in the order given.
function byDay(entries: readonly ActivityEntryView[]): { key: string; label?: string; entries: ActivityEntryView[] }[] {
  const days: { key: string; label?: string; entries: ActivityEntryView[] }[] = [];
  for (const entry of entries) {
    const key = entry.dayKey ?? "all";
    const last = days.at(-1);
    if (last && last.key === key) last.entries.push(entry);
    else days.push({ key, label: entry.dayLabel, entries: [entry] });
  }
  return days;
}

// Each day is one list-group panel of divider rows (entries without a day go in one group).
function Timeline({
  entries,
  singleEntry,
  disputeAction,
  undoAction,
}: {
  entries: readonly ActivityEntryView[];
  singleEntry: boolean;
  disputeAction?: FormAction;
  undoAction?: FormAction;
}) {
  return (
    <>
      {byDay(entries).map((day, index) => (
        <ListGroup
          key={`${day.key}-${index}`}
          id={`day-${day.key}-${index}`}
          ordered
          title={day.label === undefined ? "Entries" : <time dateTime={day.key}>{day.label}</time>}
          count={singleEntry ? undefined : day.entries.length}
        >
          {day.entries.map((entry) => (
            <ActivityEntryItem key={entry.seq} entry={entry} open={singleEntry} disputeAction={disputeAction} undoAction={undoAction} />
          ))}
        </ListGroup>
      ))}
    </>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function GroupMark({ group }: { group: ActivityGroupView }) {
  const mark = group.mark;
  if (!mark) return null;
  if (mark.kind === "agent") return <AgentMark platform={mark.platform} name={group.label} size="md" />;
  if (mark.kind === "service") return <ServiceMark id={mark.id} name={group.label} size="md" />;
  const Icon = CATEGORY_ICONS[mark.type];
  return (
    <span aria-hidden={true} className={`inline-grid h-9 w-9 shrink-0 place-items-center rounded-card ${CATEGORY_TONES[mark.type]}`} style={{ background: "var(--wh-tone-soft)" }}>
      <Icon className="h-[18px] w-[18px] wh-tone-icon" />
    </span>
  );
}

function GroupRow({ group }: { group: ActivityGroupView }) {
  const attention = [
    group.blocked ? `${group.blocked} blocked` : "",
    group.failed ? `${group.failed} failed` : "",
    group.disputed ? `${group.disputed} disputed` : "",
  ].filter(Boolean).join(" · ");
  return (
    <li id={group.id} className={`${LIST_ROW} gap-2`}>
      <div className="flex min-w-0 items-start gap-3">
        <GroupMark group={group} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 className="text-base font-semibold text-fg">
              {group.href && group.total > 0 ? (
                <a href={group.href} className="inline-flex min-h-11 items-center underline underline-offset-4 hover:text-fg-muted lg:min-h-0">
                  {group.label}
                </a>
              ) : (
                group.label
              )}
            </h3>
            <p className="text-sm text-fg-muted">
              <span className="font-semibold tabular-nums text-fg">{group.total}</span> {group.total === 1 ? "entry" : "entries"}
              {group.lastAt ? <> · last <time dateTime={group.lastAtIso}>{group.lastAt}</time></> : null}
            </p>
          </div>
          {group.detail ? <p className="max-w-[72ch] text-sm text-fg-muted">{group.detail}</p> : null}
          {group.split.length > 0 ? (
            <ul role="list" aria-label={`${group.label} by type`} className="mt-1 flex flex-wrap gap-2">
              {group.split.map((part) => (
                <li key={part.label}>
                  <a href={part.href} className={buttonClasses({ variant: "secondary", size: "sm" })}>
                    {part.label}
                    <CountBadge count={part.count} />
                    <span className="sr-only"> by {group.label}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          {group.top ? <p className="text-sm text-fg-muted">Most active: {group.top}</p> : null}
          {(attention && group.attentionHref) || group.manageHref ? (
            <div className="flex flex-wrap items-center gap-x-4 text-sm">
              {attention && group.attentionHref ? (
                <a href={group.attentionHref} className="inline-flex min-h-11 items-center gap-1.5 font-medium text-fg underline underline-offset-4">
                  <AlertTriangle aria-hidden={true} className="h-4 w-4 shrink-0 text-warning" />
                  Needs attention: {attention}<span className="sr-only"> for {group.label}</span>
                </a>
              ) : null}
              {group.manageHref ? (
                <a href={group.manageHref} className="inline-flex min-h-11 items-center text-fg-muted underline underline-offset-4 hover:text-fg">
                  Manage agent<span className="sr-only"> {group.label}</span>
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

const GROUP_HEADINGS: Record<Exclude<ActivityViewKey, "timeline">, string> = {
  agents: "Activity by agent",
  types: "Activity by type",
  services: "Activity by service",
};

function Groups({ view, groups, caption }: { view: Exclude<ActivityViewKey, "timeline">; groups: readonly ActivityGroupView[]; caption?: string }) {
  const populated = groups.filter((group) => group.total > 0);
  const counted = view === "types" ? plural(populated.length, "type", "types") : view === "agents" ? plural(groups.length, "group", "groups") : plural(groups.length, "service", "services");
  return (
    <ListGroup id="activity-groups" title={GROUP_HEADINGS[view]} summary={caption ? `${counted}. ${caption}` : counted}>
      {groups.map((group) => <GroupRow key={group.id} group={group} />)}
    </ListGroup>
  );
}

export function ActivityView({
  entries,
  filterOptions,
  query,
  integrity,
  notice,
  activeFilters = {},
  nextHref,
  newestHref,
  scannedCount,
  disputeAction,
  undoAction,
  view = "timeline",
  viewLinks,
  quickLinks,
  appliedFilters,
  clearHref,
  breadcrumb,
  formState,
  timeZoneNote,
  groups,
  countsCaption,
  singleEntry = false,
  hasAgents,
}: ActivityViewProps) {
  const facets: Facet[] = [
    { name: "agent", label: "Agent", all: "All agents", options: filterOptions.agents, value: activeFilters.agent },
    { name: "service", label: "Service", all: "All services", options: filterOptions.services, value: activeFilters.service },
    { name: "kind", label: "Event", all: "All events", options: filterOptions.kinds, value: activeFilters.kind },
    { name: "outcome", label: "Outcome", all: "All outcomes", options: filterOptions.outcomes, value: activeFilters.outcome },
  ];
  const summary = filterSummary(facets, activeFilters);
  const appliedCount = appliedFilters?.length ?? summary.length;
  const grouped = view !== "timeline" && groups !== undefined;
  // A brand-new record: no entries, nothing to narrow, no other page. The list tools would
  // only push the empty state down, so the page shows the empty state alone.
  const nothingAtAll = entries.length === 0 && !query && appliedCount === 0 && !newestHref && !nextHref && !grouped && !singleEntry;

  const search = (
    <form method="get" className="flex min-w-0 flex-wrap items-start gap-2">
      <HiddenState state={formState} omit={["agent", "service", "kind", "outcome", "type", "from", "to", "q"]} />
      {activeFilters.type ? <input type="hidden" name="type" value={activeFilters.type} /> : null}
      {view === "timeline" ? (
        <div className="flex min-w-0 flex-[1_1_10rem] gap-2">
          <Label htmlFor="activity-search" className="sr-only">
            Search
          </Label>
          <Input id="activity-search" type="search" name="q" defaultValue={query} placeholder="Search" />
          <Button type="submit" variant="secondary" className="shrink-0 px-3 sm:px-4">
            <Search aria-hidden={true} className="h-4 w-4 shrink-0" />
            <span className="sr-only sm:not-sr-only">Search</span>
          </Button>
        </div>
      ) : null}
      {/* Applied filters already show as removable chips, so with chips the panel stays
          closed (it would push the entries down on a phone); without them it opens when
          anything is applied, so the applied values are visible. */}
      <details open={appliedFilters ? false : query.length > 0 || appliedCount > 0} className="group min-w-0 open:basis-full">
        <summary className={buttonClasses({ variant: "secondary", size: "md", className: "min-w-11 list-none px-3 [&::-webkit-details-marker]:hidden" })}>
          <SlidersHorizontal aria-hidden={true} className="h-4 w-4 shrink-0 text-fg-muted" />
          {/* The narrowest phones keep search and Filters on one line: the word is read out. */}
          <span className="max-[359px]:sr-only">Filters</span>
          {appliedCount > 0 ? <CountBadge count={appliedCount} label={`${appliedCount} applied`} /> : null}
          <ChevronDown aria-hidden={true} className="hidden h-4 w-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180 sm:block" />
        </summary>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {facets.map((facet) => (
            <FacetFilter key={facet.name} {...facet} />
          ))}
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="activity-from">From</Label>
            <Input id="activity-from" type="date" name="from" defaultValue={activeFilters.from?.slice(0, 10) ?? ""} />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor="activity-to">To</Label>
            <Input id="activity-to" type="date" name="to" defaultValue={activeFilters.to?.slice(0, 10) ?? ""} />
          </div>
        </div>
        <div className="mt-4">
          <Button type="submit" variant="secondary">
            Apply filters
          </Button>
        </div>
      </details>
    </form>
  );

  const backLink = breadcrumb ? (
    <a href={breadcrumb.href} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-fg underline underline-offset-4">
      <ChevronLeft aria-hidden={true} className="h-4 w-4 shrink-0" />
      {breadcrumb.label}
    </a>
  ) : null;
  const chips = appliedFilters && clearHref ? <ActiveFilters filters={appliedFilters} clearHref={clearHref} /> : null;
  const plainSummary = !appliedFilters && summary.length > 0 ? (
    <p className="flex flex-wrap items-center gap-x-3 text-sm text-fg">
      <span>
        <span className="font-medium">Filtered by</span> {summary.join(" · ")}
      </span>
      <a href="/activity" className="inline-flex min-h-11 items-center font-medium underline underline-offset-4">
        Clear filters
      </a>
    </p>
  ) : null;
  const applied = backLink || (appliedFilters?.length ?? 0) > 0 || plainSummary ? (
    <div className="flex min-w-0 flex-col gap-1">
      {backLink}
      {chips}
      {plainSummary}
    </div>
  ) : null;
  const status = !grouped && scannedCount !== undefined
    ? `Search looked through the ${scannedCount} newest matching ${scannedCount === 1 ? "entry" : "entries"} on this page. Continue to older entries to search earlier history.`
    : !grouped && singleEntry && entries.length > 0
      ? "Showing one entry."
      : undefined;

  // Nothing recorded yet: one sentence on what will appear, and the next step.
  const firstRun = hasAgents === false ? (
    <EmptyState
      heading="No activity yet"
      description="Activity appears once you connect an agent and it starts using Warthog. Changes you make to your account show here too."
      action={<ButtonLink href="/agents/connect" variant="primary">Connect your first agent</ButtonLink>}
    />
  ) : (
    <EmptyState
      heading="No activity yet"
      description="Actions your agents take through Warthog, and changes to your account, appear here."
      action={hasAgents ? <ButtonLink href="/agents">See your agents</ButtonLink> : undefined}
    />
  );

  let empty: React.ReactNode = null;
  if (grouped && groups.length === 0) {
    empty = appliedCount === 0 ? firstRun : (
      <EmptyState
        heading="No activity matches these filters"
        description="Remove a filter to see more. Requests and changes recorded through Warthog appear here."
        action={clearHref ? <ButtonLink href={clearHref}>Clear all filters</ButtonLink> : undefined}
      />
    );
  } else if (!grouped && entries.length === 0) {
    if (singleEntry) {
      empty = (
        <EmptyState
          heading="We couldn't find that activity entry"
          description="It may belong to another account, or the link may be incomplete."
          action={newestHref ? <ButtonLink href={newestHref}>Back to the timeline</ButtonLink> : undefined}
        />
      );
    } else if (nothingAtAll) {
      empty = firstRun;
    } else if (query) {
      empty = (
        <EmptyState
          heading="No matches on this page"
          description="Search looks through the newest entries on this page. Try other words, or continue to older entries."
          action={nextHref ? <ButtonLink href={nextHref}>Search older entries</ButtonLink> : undefined}
        />
      );
    } else {
      empty = (
        <EmptyState
          heading="No activity matches these filters"
          description="Try other filters or continue to older entries. Requests and changes recorded through Warthog appear here."
          action={clearHref && (appliedFilters?.length ?? 0) > 0 ? <ButtonLink href={clearHref}>Clear all filters</ButtonLink> : undefined}
        />
      );
    }
  }

  return (
    <div className="wh-page">
      <WorkspaceHeading
        title="Activity"
        description={`What your agents did through Warthog, and changes to your account.${timeZoneNote ? ` ${timeZoneNote}` : ""}`}
      >
        <form method="get">
          <HiddenState state={formState} omit={["verify"]} />
          <input type="hidden" name="verify" value="1" />
          <Button type="submit" variant="secondary" size="sm">
            <ShieldCheck aria-hidden={true} className="h-4 w-4 shrink-0" />
            Check integrity
          </Button>
        </form>
      </WorkspaceHeading>

      {notice ? (
        <PageNotice tone={NOTICE_TONES[notice.tone]}>
          {notice.text}
          {notice.action ? (
            <>
              {" "}
              <a href={notice.action.href} className="font-medium underline underline-offset-4">
                {notice.action.label}
              </a>
            </>
          ) : null}
        </PageNotice>
      ) : null}
      {integrity ? <IntegrityResultNotice result={integrity} /> : null}

      {nothingAtAll ? null : (
        <ListToolbar
          label="Find activity"
          views={viewLinks ? <FilterLinks label="Activity views" items={viewLinks} /> : undefined}
          filters={quickLinks ? <FilterLinks label="Quick filters" items={quickLinks} variant="scroll" /> : undefined}
          search={search}
          applied={applied}
          status={status}
        />
      )}

      {empty ?? (grouped ? (
        <Groups view={view as Exclude<ActivityViewKey, "timeline">} groups={groups} caption={countsCaption} />
      ) : (
        <Timeline entries={entries} singleEntry={singleEntry} disputeAction={disputeAction} undoAction={undoAction} />
      ))}

      {(nextHref || newestHref) && !(singleEntry && entries.length === 0) ? (
        <nav aria-label="Activity pages">
          <ActionBar>
            {nextHref ? <ButtonLink href={nextHref}>Older entries</ButtonLink> : null}
            {newestHref ? <ButtonLink href={newestHref}>{singleEntry ? "Back to the timeline" : "Newest entries"}</ButtonLink> : null}
          </ActionBar>
        </nav>
      ) : null}
    </div>
  );
}
