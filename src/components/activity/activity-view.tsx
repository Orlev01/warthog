import * as React from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle,
  ChevronLeft,
  CircleDot,
  Clock,
  Eye,
  KeyRound,
  MessageSquareText,
  PencilLine,
  Plug,
  ShieldCheck,
  UserCog,
  type LucideIcon,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty";
import { Notice } from "@/components/ui/notice";
import { ActiveFilters, FilterLinks, type AppliedFilter, type FilterLink } from "@/components/ui/filter-links";
import { LIST_ROW } from "@/components/ui/list-group";
import type { IntegrityResult } from "@/server/activity/integrity";
import type { ActivityCategory, OutcomeGroup } from "@/domain/activity/category";

// E08-S08 — Activity view component (src/components/activity/activity-view.tsx), reorganised
// 12 November at the founder's request ("the audit log is one long thread").
//
// The timeline is the product's trust surface (brief "Activity feed", design §9,
// constitution principle 14 "Warthog writes the record, not the agents"). This is ONE
// render-testable, prop-driven component that the page loader feeds already-formatted
// props: it reads nothing, reaches for no clock/locale/DB and decides nothing.
//
// Four views, switched by plain links (the loader builds every href, keeping filters):
//   • Timeline — entries newest-first (never reversed) under day headings, as compact rows;
//     each row's full detail, dispute history and Undo/Dispute controls sit in ONE
//     "Details" disclosure, open by default for a disputed entry or a permalink.
//   • By agent / By type / By service — one row per group with exact counts, its type
//     split and anything that needs attention, each drilling into the filtered timeline.
//
// Trust rules carried into every view: agent-submitted summaries are labelled "Reported by
// <agent>" and never presented as fact; blocked/failed outcomes and disputes are visible on
// the collapsed row and on group rows; Dispute stays available on EVERY entry; Undo only
// where the entry's tool declares a reversal (`canUndo`); the integrity check is
// record-wide and never shown per group. Controls are live forms or links, never dead
// buttons. Colour comes from the design tokens; meaning is always words plus an icon.

// One entry on the timeline. `source` is the activity vocabulary union: "warthog" is a
// fact Warthog recorded itself; "agent_reported" is a summary an agent submitted, shown
// labelled "Reported by <agent>" and never treated as the source of truth. `agent` is
// the connected AI client, `service` the connected service it touched (either may be
// absent). `canUndo` is true ⇔ the entry's tool declares a reversal. `title` is the
// row's headline in plain words — an agent call is titled by its tool ("Save a memory")
// — and `agent` is the agent's display name, never its raw id.
export type ActivityEntryView = {
  seq: number;
  kind: string; // display-ready, e.g. "Tool call"
  title?: string; // display-ready headline, e.g. "Save a memory" (absent ⇒ the kind)
  source: "warthog" | "agent_reported";
  agent?: string;
  agentHref?: string; // the timeline filtered to this agent
  agentRole?: "actor" | "subject"; // the agent acted, or an owner's change was about it
  service?: string;
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
  detail: string; // full detail, already-redacted (the per-entry "open for detail")
  canUndo: boolean;
  disputes?: readonly { note: string; at: string }[];
};

export type ActivityViewKey = "timeline" | "agents" | "types" | "services";

// One group on the By agent / By type / By service views: exact counts, the type split and
// what needs attention, each linking into the filtered timeline.
export type ActivityGroupView = {
  readonly id: string;
  readonly label: string;
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
  timeZoneLabel?: string;
  groups?: readonly ActivityGroupView[];
  countsCaption?: string;
  singleEntry?: boolean;
};

const BTN_BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const BTN_PRIMARY = `${BTN_BASE} bg-accent text-accent-fg hover:bg-accent-hover`;
const BTN_SECONDARY = `${BTN_BASE} border border-line bg-surface text-fg hover:bg-surface-muted`;
const BTN_DISABLED = `${BTN_BASE} border border-line bg-surface text-fg-muted opacity-50`;
const LINK = "font-medium text-fg underline underline-offset-4 hover:text-fg-muted";
const BADGE = "inline-flex items-center gap-1 rounded-card bg-surface-muted px-2 py-0.5 text-xs font-medium text-fg";

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

const OUTCOME_ICONS: Partial<Record<OutcomeGroup, { Icon: LucideIcon; tone: string }>> = {
  done: { Icon: CheckCircle, tone: "text-success" },
  waiting: { Icon: Clock, tone: "text-fg-muted" },
  blocked: { Icon: Ban, tone: "text-danger" },
  failed: { Icon: AlertTriangle, tone: "text-danger" },
};

// The outcome in words, with a tone icon (the icon carries colour, the word carries meaning).
function OutcomeBadge({ outcome, group }: { outcome: string; group?: OutcomeGroup }) {
  if (!outcome) return null;
  const icon = group ? OUTCOME_ICONS[group] : undefined;
  return (
    <span className={BADGE}>
      {icon ? <icon.Icon aria-hidden={true} className={`h-3.5 w-3.5 shrink-0 ${icon.tone}`} /> : null}
      {outcome}
    </span>
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
    <div className="flex flex-col gap-1.5">
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

// "Filtered by Agent: Claude · From 1 Mar 2026 (UTC)" — the plain-text summary used when
// the loader supplies no chip list (named by each option's label, never the posted id).
function filterSummary(facets: readonly Facet[], active: ActivityActiveFilters): string[] {
  const labelOf = (facet: Facet, value: string): string =>
    facet.options.map(optionParts).find((option) => option.value === value)?.label ?? value;
  const parts = facets
    .filter((facet) => active[facet.name] !== undefined)
    .map((facet) => `${facet.label}: ${labelOf(facet, active[facet.name]!)}`);
  if (active.from) parts.push(`From ${active.from} (UTC)`);
  if (active.to) parts.push(`To ${active.to} (UTC)`);
  return parts;
}

// The record-wide Check-integrity result, in words plus an icon. A failure is announced.
function IntegrityPanel({ result }: { result: IntegrityResult }) {
  return result.intact ? (
    <Notice tone="success">
      Retained record intact — all {result.checked} entries checked and verified. This checks
      the consistency of retained entries. It cannot prove every action was logged or detect a
      privileged deletion of the end of the record. Disputes are notes alongside the record and
      are not part of this check.
    </Notice>
  ) : (
    <Notice tone="error">
      Integrity check failed — entry {result.brokenSeq} of {result.checked} does not match the
      record and may have been tampered with. Export your activity record and contact the operator.
    </Notice>
  );
}

function UndoControl({ entry, undoAction }: { entry: ActivityEntryView; undoAction?: (formData: FormData) => void | Promise<void> }) {
  const context = <span className="sr-only"> {entry.title ?? entry.kind}, {entry.at}</span>;
  if (!undoAction) {
    return (
      <div className="flex flex-col gap-1">
        <button type="button" disabled className={BTN_DISABLED}>
          Undo{context}
        </button>
        <p className="text-xs text-fg-muted">Undoing isn&apos;t available just now.</p>
      </div>
    );
  }
  return (
    <form action={undoAction}>
      <input type="hidden" name="seq" value={String(entry.seq)} />
      <button type="submit" className={BTN_SECONDARY}>
        Undo{context}
      </button>
    </form>
  );
}

function DisputeControl({ entry, disputeAction }: { entry: ActivityEntryView; disputeAction?: (formData: FormData) => void | Promise<void> }) {
  const context = <span className="sr-only"> {entry.title ?? entry.kind}, {entry.at}</span>;
  if (!disputeAction) {
    return (
      <div className="flex flex-col gap-1">
        <button type="button" disabled className={BTN_DISABLED}>
          Dispute{context}
        </button>
        <p className="text-xs text-fg-muted">Disputing isn&apos;t available just now.</p>
      </div>
    );
  }
  const noteId = `activity-dispute-note-${entry.seq}`;
  return (
    <form action={disputeAction} className="flex w-full flex-col gap-2 sm:max-w-md">
      <input type="hidden" name="seq" value={String(entry.seq)} />
      <Label htmlFor={noteId}>Dispute this entry: tell us what&apos;s wrong</Label>
      <textarea
        id={noteId}
        name="note"
        required={true}
        rows={2}
        className="min-h-11 w-full rounded-field border border-line-input bg-surface px-3 py-2 text-base text-fg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:text-sm"
      />
      <div>
        <button type="submit" className={BTN_SECONDARY}>
          Dispute{context}
        </button>
      </div>
    </form>
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
  disputeAction?: (formData: FormData) => void | Promise<void>;
  undoAction?: (formData: FormData) => void | Promise<void>;
}) {
  const Icon = entry.category ? CATEGORY_ICONS[entry.category] : CircleDot;
  const disputed = (entry.disputes?.length ?? 0) > 0;
  const reported = entry.source === "agent_reported";
  const agentText = entry.agent ? (entry.agentHref ? <a href={entry.agentHref} className="underline underline-offset-2">{entry.agent}</a> : entry.agent) : null;
  // Who: an agent acted, a person's change was about an agent, or the agent reported it.
  const who = reported ? null : agentText ? (entry.agentRole === "subject" ? <>About {agentText}</> : agentText) : null;
  const meta = [who, entry.service, entry.time ? null : entry.at].filter(Boolean);
  return (
    <li id={`entry-${entry.seq}`} className={LIST_ROW}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 items-start gap-2">
          <Icon aria-hidden={true} className="mt-1 h-4 w-4 shrink-0 text-fg-muted" />
          <div className="min-w-0">
            <h3 className="font-medium text-fg">{entry.title ?? entry.kind}</h3>
            <p className="text-sm text-fg-muted">
              {entry.categoryLabel ? <span>{entry.categoryLabel}</span> : null}
              {meta.map((part, index) => (
                <React.Fragment key={index}>
                  {entry.categoryLabel || index > 0 ? " · " : null}
                  {part}
                </React.Fragment>
              ))}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-sm text-fg-muted">
          <OutcomeBadge outcome={entry.outcome} group={entry.outcomeGroup} />
          {disputed ? (
            <span className={BADGE}>
              <AlertTriangle aria-hidden={true} className="h-3.5 w-3.5 shrink-0 text-warning" />
              Disputed
            </span>
          ) : null}
          {entry.time ? <time dateTime={entry.dateTime} title={entry.at}>{entry.time}</time> : null}
        </div>
      </div>
      <p className="ps-6 text-fg">{entry.summary}</p>
      {reported ? <p className="ps-6 text-sm text-fg-muted">Reported by {entry.agent}. Warthog did not observe this.</p> : null}
      <details open={open || disputed} className="group ps-6 text-sm">
        <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-fg underline underline-offset-4">
          View details<span className="sr-only"> for {entry.title ?? entry.kind}, {entry.at}</span>
        </summary>
        <div className="flex flex-col gap-3 pb-2">
          <p className="whitespace-pre-wrap text-fg-muted">{entry.detail}</p>
          {entry.time ? <p className="text-fg-muted">Recorded {entry.at}</p> : null}
          {disputed ? (
            <div aria-label="Dispute history" role="group" className="border-l-2 border-warning pl-3">
              <p className="font-medium">Your disputes</p>
              {entry.disputes!.map((note, index) => (
                <p key={index} className="whitespace-pre-wrap">
                  {note.note}
                  <span className="block text-fg-muted">{note.at}</span>
                </p>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap items-start gap-3">
            {entry.canUndo ? <UndoControl entry={entry} undoAction={undoAction} /> : null}
            <DisputeControl entry={entry} disputeAction={disputeAction} />
          </div>
          {entry.permalink ? (
            <a href={entry.permalink} className={`${LINK} self-start`}>
              Link to this entry<span className="sr-only">: {entry.title ?? entry.kind}, {entry.at}</span>
            </a>
          ) : null}
        </div>
      </details>
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

function Timeline({
  entries,
  singleEntry,
  disputeAction,
  undoAction,
}: {
  entries: readonly ActivityEntryView[];
  singleEntry: boolean;
  disputeAction?: (formData: FormData) => void | Promise<void>;
  undoAction?: (formData: FormData) => void | Promise<void>;
}) {
  const days = byDay(entries);
  if (days.length === 1 && days[0]!.label === undefined) {
    return (
      <ol role="list" className="flex flex-col">
        {entries.map((entry) => (
          <ActivityEntryItem key={entry.seq} entry={entry} open={singleEntry} disputeAction={disputeAction} undoAction={undoAction} />
        ))}
      </ol>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {days.map((day, index) => (
        <section key={`${day.key}-${index}`} aria-labelledby={`day-${day.key}-${index}`} className="flex min-w-0 flex-col">
          <div className="flex flex-wrap items-baseline gap-2 border-b border-line-strong pb-2">
            <h2 id={`day-${day.key}-${index}`} className="text-lg font-semibold text-fg">
              <time dateTime={day.key}>{day.label}</time>
            </h2>
            <span className="text-sm text-fg-muted">
              {day.entries.length} {day.entries.length === 1 ? "entry" : "entries"}{index === 0 || index === days.length - 1 ? " on this page" : ""}
            </span>
          </div>
          <ol role="list" className="flex flex-col">
            {day.entries.map((entry) => (
              <ActivityEntryItem key={entry.seq} entry={entry} open={singleEntry} disputeAction={disputeAction} undoAction={undoAction} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function GroupRow({ group }: { group: ActivityGroupView }) {
  const attention = [
    group.blocked ? `${group.blocked} blocked` : "",
    group.failed ? `${group.failed} failed` : "",
    group.disputed ? `${group.disputed} disputed` : "",
  ].filter(Boolean).join(" · ");
  return (
    <li id={group.id} className={`${LIST_ROW} gap-2`}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-fg">
            {group.href && group.total > 0 ? <a href={group.href} className="underline underline-offset-4 hover:text-fg-muted">{group.label}</a> : group.label}
          </h3>
          {group.detail ? <p className="text-sm text-fg-muted">{group.detail}</p> : null}
        </div>
        <p className="shrink-0 text-sm text-fg-muted">
          <span className="font-semibold tabular-nums text-fg">{group.total}</span> {group.total === 1 ? "entry" : "entries"}
          {group.lastAt ? <> · last <time dateTime={group.lastAtIso}>{group.lastAt}</time></> : null}
        </p>
      </div>
      {group.split.length > 0 ? (
        <ul role="list" aria-label={`${group.label} by type`} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {group.split.map((part) => (
            <li key={part.label}>
              <a href={part.href} className="text-fg-muted underline underline-offset-2 hover:text-fg">
                <span className="tabular-nums text-fg">{part.count}</span> {part.label.toLowerCase()}
                <span className="sr-only"> by {group.label}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {group.top ? <p className="text-sm text-fg-muted">Most active: {group.top}</p> : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
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
  return (
    <section aria-labelledby="activity-groups-heading" className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-2 border-b border-line-strong pb-2">
        <h2 id="activity-groups-heading" className="text-lg font-semibold text-fg">{GROUP_HEADINGS[view]}</h2>
        <span className="text-sm text-fg-muted">
          {view === "types" ? plural(populated.length, "type", "types") : view === "agents" ? plural(groups.length, "group", "groups") : plural(groups.length, "service", "services")}
        </span>
      </div>
      {caption ? <p className="text-sm text-fg-muted">{caption}</p> : null}
      <ul role="list" className="flex flex-col">
        {groups.map((group) => <GroupRow key={group.id} group={group} />)}
      </ul>
    </section>
  );
}

export function ActivityView({
  entries,
  filterOptions,
  query,
  integrity,
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
  timeZoneLabel,
  groups,
  countsCaption,
  singleEntry = false,
}: ActivityViewProps) {
  const facets: Facet[] = [
    { name: "agent", label: "Agent", all: "All agents", options: filterOptions.agents, value: activeFilters.agent },
    { name: "service", label: "Service", all: "All services", options: filterOptions.services, value: activeFilters.service },
    { name: "kind", label: "Kind", all: "All kinds", options: filterOptions.kinds, value: activeFilters.kind },
    { name: "outcome", label: "Outcome", all: "All outcomes", options: filterOptions.outcomes, value: activeFilters.outcome },
  ];
  const summary = filterSummary(facets, activeFilters);
  const appliedCount = appliedFilters?.length ?? summary.length;
  const grouped = view !== "timeline" && groups !== undefined;
  const nothingAtAll = entries.length === 0 && !query && appliedCount === 0 && !newestHref && !grouped;

  return (
    <div className="wh-page flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">Activity</h1>
          <p className="text-sm text-fg-muted">
            What your agents did through Warthog, and changes to your account.
            {timeZoneLabel ? <> Times in {timeZoneLabel}.</> : null}
          </p>
        </div>
        <form method="get">
          <HiddenState state={formState} omit={["verify"]} />
          <input type="hidden" name="verify" value="1" />
          <button type="submit" className={BTN_PRIMARY}>
            <ShieldCheck aria-hidden={true} className="h-4 w-4 shrink-0" />
            Check integrity
          </button>
        </form>
      </div>

      {integrity ? <IntegrityPanel result={integrity} /> : null}

      {viewLinks ? (
        <div className="flex flex-col gap-1">
          <FilterLinks label="Activity views" items={viewLinks} />
          {quickLinks ? <FilterLinks label="Quick filters" items={quickLinks} variant="chips" /> : null}
        </div>
      ) : null}

      <form method="get" className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4">
        <HiddenState state={formState} omit={["agent", "service", "kind", "outcome", "type", "from", "to", "q"]} />
        {view === "timeline" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="activity-search">Search</Label>
            <Input id="activity-search" type="search" name="q" defaultValue={query} placeholder="Search activity" />
          </div>
        ) : null}
        {!appliedFilters && summary.length > 0 ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg">
            <span>
              <span className="font-medium">Filtered by</span> {summary.join(" · ")}
            </span>
            <a href="/activity" className={LINK}>
              Clear filters
            </a>
          </p>
        ) : null}
        <details open={query.length > 0 || appliedCount > 0}>
          <summary className="inline-flex min-h-11 cursor-pointer items-center font-medium text-fg">
            Filters{appliedCount > 0 ? ` (${appliedCount} applied)` : ""}
          </summary>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {facets.map((facet) => (
              <FacetFilter key={facet.name} {...facet} />
            ))}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="activity-from">From (UTC)</Label>
              <Input id="activity-from" type="date" name="from" defaultValue={activeFilters.from?.slice(0, 10) ?? ""} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="activity-to">To (UTC)</Label>
              <Input id="activity-to" type="date" name="to" defaultValue={activeFilters.to?.slice(0, 10) ?? ""} />
            </div>
          </div>
          {activeFilters.type ? <input type="hidden" name="type" value={activeFilters.type} /> : null}
        </details>
        <div>
          <button type="submit" className={BTN_SECONDARY}>
            Apply filters
          </button>
        </div>
      </form>

      {breadcrumb ? (
        <a href={breadcrumb.href} className="inline-flex min-h-11 items-center gap-1 self-start text-sm font-medium text-fg underline underline-offset-4">
          <ChevronLeft aria-hidden={true} className="h-4 w-4 shrink-0" />
          {breadcrumb.label}
        </a>
      ) : null}
      {appliedFilters && clearHref ? <ActiveFilters filters={appliedFilters} clearHref={clearHref} /> : null}

      {grouped ? (
        groups.length === 0 ? (
          <EmptyState heading="No activity matches these filters" description="Remove a filter to see more. Recorded requests and changes through Warthog appear here." />
        ) : (
          <Groups view={view as Exclude<ActivityViewKey, "timeline">} groups={groups} caption={countsCaption} />
        )
      ) : (
        <>
          {scannedCount !== undefined ? (
            <p className="text-sm text-fg-muted">
              Search looked through the {scannedCount} newest matching entries on this page. Continue to older entries to search earlier history.
            </p>
          ) : null}
          {singleEntry && entries.length > 0 ? <p className="text-sm text-fg-muted">Showing one entry.</p> : null}
          {entries.length === 0 ? (
            <EmptyState
              heading={nothingAtAll ? "No activity yet" : query ? "No matches on this page" : "No activity matches these filters"}
              description={nothingAtAll
                ? "Actions your agents take through Warthog, and changes to your account, appear here."
                : "Try other filters or continue to older entries. Recorded requests and changes through Warthog appear here."}
            />
          ) : (
            <Timeline entries={entries} singleEntry={singleEntry} disputeAction={disputeAction} undoAction={undoAction} />
          )}
        </>
      )}
      {nextHref || newestHref ? (
        <nav aria-label="Activity pages" className="flex flex-wrap gap-3">
          {nextHref ? <a className={BTN_SECONDARY} href={nextHref}>Older entries</a> : null}
          {newestHref ? <a className={BTN_SECONDARY} href={newestHref}>{singleEntry ? "Back to the timeline" : "Newest entries"}</a> : null}
        </nav>
      ) : null}
    </div>
  );
}
