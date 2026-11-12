import * as React from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty";
import type { IntegrityResult } from "@/server/activity/integrity";

// E08-S08 — Activity view component (src/components/activity/activity-view.tsx).
//
// The timeline is the product's trust surface (brief "Activity feed", design §9,
// constitution principle 14 "Warthog writes the record, not the agents"). This is ONE
// render-testable, prop-driven component — exactly like DashboardView / OutboxView —
// that the page loader (a later task) feeds already-formatted props: it reads nothing,
// reaches for no clock/locale/DB and decides nothing. It shows every entry newest-first
// (the order the loader hands in, never reversed), labels agent-submitted summaries
// "Reported by <agent>" (never counting them as fact), and carries the controls:
//   • Dispute on EVERY entry;
//   • Undo ONLY where the entry's tool declares a reversal (`canUndo`);
//   • the search box + per-facet filters + date range; and
//   • the record-wide Check-integrity control and its latest result.
//
// Controls are real, live form controls (the SignOutControl pattern), never dead
// buttons: the search/filter chrome is a GET form that re-queries the screen by URL, and
// the read-only Check-integrity is a GET form. Dispute and Undo (E08-S10) are BOUND to
// the server actions the page passes (`disputeAction` / `undoAction`), carrying the entry
// seq the action consumes; a reversible entry whose `undoAction` is not supplied (reversal
// execution not configured) renders Undo DISABLED with a one-line reason instead of a live
// control over a throwing executor (constitution: no dead controls). Every colour comes
// from the design tokens (globals.css); no raw hex, no new colour.

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
  service?: string;
  outcome: string; // display-ready, e.g. "Done"
  at: string; // pre-formatted time label, e.g. "two minutes ago"
  summary: string; // one-line, already-redacted
  detail: string; // full detail, already-redacted (the per-entry "open for detail")
  canUndo: boolean;
  disputes?: readonly { note: string; at: string }[];
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

// A filter choice as the value it posts and the label it shows.
function optionParts(option: ActivityFilterOption): { value: string; label: string } {
  return typeof option === "string" ? { value: option, label: option } : option;
}

// The applied filter values, keyed by the GET param each control posts.
export type ActivityActiveFilters = {
  agent?: string;
  service?: string;
  kind?: string;
  outcome?: string;
  from?: string; // "YYYY-MM-DD" (or an ISO date-time)
  to?: string; // "YYYY-MM-DD" (or an ISO date-time)
};

export type ActivityViewProps = {
  entries: readonly ActivityEntryView[];
  nextHref?: string;
  newestHref?: string;
  scannedCount?: number;
  filterOptions: ActivityFilterOptions;
  query: string; // the current search text (pre-fills the search box)
  // The facet/date filters currently applied (review fix G11): each pre-selects its
  // control, the Filters panel opens when any is set, a "Filtered by …" line names them
  // with a Clear link, and re-applying keeps them. Absent ⇒ nothing applied.
  activeFilters?: ActivityActiveFilters;
  integrity: IntegrityResult | null; // the latest Check-integrity result, if one has run
  // E08-S10 — the per-entry Dispute/Undo controls are BOUND to these server actions (the
  // page passes inline `use server` wrappers that re-derive the session, call
  // disputeEntry / undoEntry and redirect with a `?notice=` outcome). Both are OPTIONAL:
  // the loader's own props omit them (the page adds them), and when reversal EXECUTION is
  // not configured the page supplies NO `undoAction`, so a reversible entry's Undo renders
  // DISABLED with a one-line reason instead of a live control over a throwing executor
  // (constitution: no dead controls — disable it and say why).
  disputeAction?: (formData: FormData) => void | Promise<void>;
  undoAction?: (formData: FormData) => void | Promise<void>;
};


// The action buttons mirror the shared Button primitive's look on the design tokens
// (≥44px target, token colour/radius/focus) but as native <button>s: every control in
// this view is ALWAYS live (brief "no dead controls"), so they deliberately omit the
// primitive's `disabled:` utility variants. The accent fill is reserved for the one
// primary action on the screen (Check-integrity); everything else is the neutral
// surface variant.
const BTN_BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const BTN_PRIMARY = `${BTN_BASE} bg-accent text-accent-fg hover:bg-accent-hover`;
const BTN_SECONDARY = `${BTN_BASE} border border-line bg-surface text-fg hover:bg-surface-muted`;
// A control that is present but not actionable (e.g. Undo when reversal execution is not
// configured): the neutral surface look, dimmed and non-interactive, the native
// `disabled` attribute doing the disabling. Styled through tokens, no raw colour.
const BTN_DISABLED = `${BTN_BASE} border border-line bg-surface text-fg-muted opacity-50`;

// The four facet filters, each keyed to its resolved option list and its applied value.
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

// "Filtered by Agent: Claude · From 1 Mar 2026 (UTC)" — explicit filter zone;
// named by its option's label (an agent by its name, never the id the filter posts).
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

// The Check-integrity result panel: a status read with WORDS and an icon, never colour
// alone. An intact result names how many entries verified; a failed result reads as a
// failure and advises exporting the record and contacting the operator.
function IntegrityPanel({ result }: { result: IntegrityResult }) {
  return (
    <div className="flex items-start gap-2 rounded-card border border-line bg-surface p-3 text-sm text-fg">
      {result.intact ? (
        <>
          <ShieldCheck aria-hidden={true} className="mt-0.5 h-5 w-5 shrink-0 text-success" />
          <p>
            Retained record intact — all {result.checked} entries checked and verified.
            This checks the consistency of retained entries. It cannot prove every action was logged or detect a privileged deletion of the end of the record.
          </p>
        </>
      ) : (
        <>
          <ShieldAlert aria-hidden={true} className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
          <p>
            Integrity check failed — entry {result.brokenSeq} of {result.checked} does
            not match the record and may have been tampered with. Export your activity
            record and contact the operator.
          </p>
        </>
      )}
    </div>
  );
}

// The Undo control for a reversible entry. LIVE (bound to `undoAction`, carrying the
// entry seq) when an undoAction is supplied; otherwise DISABLED with a one-line reason —
// never a live control over an executor that would throw (constitution: no dead controls).
function UndoControl({
  seq,
  undoAction,
}: {
  seq: number;
  undoAction?: (formData: FormData) => void | Promise<void>;
}) {
  if (!undoAction) {
    return (
      <div className="flex flex-col gap-1">
        <button type="button" disabled className={BTN_DISABLED}>
          Undo
        </button>
        <p className="text-xs text-fg-muted">Undoing isn&apos;t available just now.</p>
      </div>
    );
  }
  return (
    <form action={undoAction}>
      <input type="hidden" name="seq" value={String(seq)} />
      <button type="submit" className={BTN_SECONDARY}>
        Undo
      </button>
    </form>
  );
}

// The Dispute control, offered on EVERY entry. LIVE (bound to `disputeAction`, carrying
// the entry seq and a note field so a person can say why) when a disputeAction is
// supplied; otherwise DISABLED with a one-line reason.
function DisputeControl({
  seq,
  disputeAction,
}: {
  seq: number;
  disputeAction?: (formData: FormData) => void | Promise<void>;
}) {
  if (!disputeAction) {
    return (
      <div className="flex flex-col gap-1">
        <button type="button" disabled className={BTN_DISABLED}>
          Dispute
        </button>
        <p className="text-xs text-fg-muted">Disputing isn&apos;t available just now.</p>
      </div>
    );
  }
  const noteId = `activity-dispute-note-${seq}`;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium text-accent">Dispute</summary>
      <form action={disputeAction} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="seq" value={String(seq)} />
        <Label htmlFor={noteId}>Tell us what&apos;s wrong</Label>
        <textarea
          id={noteId}
          name="note"
          required={true}
          rows={2}
          className="min-h-11 w-full rounded-card border border-line bg-surface px-3 py-2 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        />
        <div>
          <button type="submit" className={BTN_SECONDARY}>
            Dispute
          </button>
        </div>
      </form>
    </details>
  );
}

function ActivityEntryItem({
  entry,
  disputeAction,
  undoAction,
}: {
  entry: ActivityEntryView;
  disputeAction?: (formData: FormData) => void | Promise<void>;
  undoAction?: (formData: FormData) => void | Promise<void>;
}) {
  // An agent-reported summary is attributed by "Reported by <agent>"; a Warthog-recorded
  // entry names its agent in the meta line and carries no such label.
  const metaParts =
    entry.source === "agent_reported"
      ? [entry.service, entry.at]
      : [entry.agent, entry.service, entry.at];
  const meta = metaParts.filter(Boolean).join(" · ");

  return (
    <li id={`entry-${entry.seq}`} className="flex min-w-0 flex-col gap-2 rounded-card border border-line bg-surface p-4 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-fg">{entry.title ?? entry.kind}</span>
        <span className="rounded-card bg-surface-muted px-2 py-0.5 text-xs font-medium text-fg-muted">
          {entry.outcome}
        </span>
      </div>
      <p className="text-fg">{entry.summary}</p>
      {meta ? <p className="text-sm text-fg-muted">{meta}</p> : null}
      {entry.source === "agent_reported" ? (
        <p className="text-sm text-fg-muted">Reported by {entry.agent}</p>
      ) : null}
      <details className="text-sm">
        <summary className="cursor-pointer font-medium text-accent">View details</summary>
        <p className="mt-2 whitespace-pre-wrap text-fg-muted">{entry.detail}</p>
      </details>
      {entry.disputes?.length ? <section aria-label="Dispute history" className="border-l-2 border-warning pl-3">
        <h3 className="font-medium">Disputed</h3>
        {entry.disputes.map((note, index) => <p key={index} className="whitespace-pre-wrap text-sm">{note.note}<span className="block text-fg-muted">{note.at}</span></p>)}
      </section> : null}
      <div className="flex flex-wrap items-start gap-2">
        {entry.canUndo ? <UndoControl seq={entry.seq} undoAction={undoAction} /> : null}
        <DisputeControl seq={entry.seq} disputeAction={disputeAction} />
      </div>
    </li>
  );
}

export function ActivityView({
  entries,
  filterOptions,
  query,
  integrity,
  activeFilters = {},
  nextHref, newestHref, scannedCount,
  disputeAction,
  undoAction,
}: ActivityViewProps) {
  const facets: Facet[] = [
    { name: "agent", label: "Agent", all: "All agents", options: filterOptions.agents, value: activeFilters.agent },
    { name: "service", label: "Service", all: "All services", options: filterOptions.services, value: activeFilters.service },
    { name: "kind", label: "Kind", all: "All kinds", options: filterOptions.kinds, value: activeFilters.kind },
    { name: "outcome", label: "Outcome", all: "All outcomes", options: filterOptions.outcomes, value: activeFilters.outcome },
  ];
  const applied = filterSummary(facets, activeFilters);

  return (
    <div className="wh-page flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Activity</h1>
        <form method="get">
          <input type="hidden" name="verify" value="1" />
          <button type="submit" className={BTN_PRIMARY}>
            <ShieldCheck aria-hidden={true} className="h-4 w-4 shrink-0" />
            Check integrity
          </button>
        </form>
      </div>

      {integrity ? <IntegrityPanel result={integrity} /> : null}

      <form method="get" className="flex flex-col gap-4 rounded-card border border-line bg-surface p-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="activity-search">Search</Label>
          <Input
            id="activity-search"
            type="search"
            name="q"
            defaultValue={query}
            placeholder="Search activity"
          />
        </div>
        {/* On narrow screens the facet + date filters fill the viewport before any
            entry shows, so they collapse behind a 'Filters' disclosure — open when a
            search or any filter is applied, collapsed otherwise. (A <details> still
            emits its contents when closed, so the server-rendered facets stay readable
            to the whole-markup checks.) */}
        {applied.length > 0 ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg">
            <span>
              <span className="font-medium">Filtered by</span> {applied.join(" · ")}
            </span>
            <a href="/activity" className="font-medium text-accent underline underline-offset-2">
              Clear filters
            </a>
          </p>
        ) : null}
        <details open={query.length > 0 || applied.length > 0}>
          <summary className="cursor-pointer font-medium text-fg">Filters</summary>
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
        </details>
        <div>
          <button type="submit" className={BTN_SECONDARY}>
            Apply filters
          </button>
        </div>
      </form>

      {scannedCount !== undefined ? <p className="text-sm text-fg-muted">{scannedCount} entries examined on this page. Search applies to this page; continue to older entries to search earlier history.</p> : null}
      {entries.length === 0 ? (
        <EmptyState
          heading={!query && !applied.length && !newestHref ? "No activity yet" : "No matching activity on this page"}
          description="Try other filters or continue to older entries. Recorded requests and changes through Warthog appear here."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {entries.map((entry) => (
            <ActivityEntryItem
              key={entry.seq}
              entry={entry}
              disputeAction={disputeAction}
              undoAction={undoAction}
            />
          ))}
        </ul>
      )}
      <nav aria-label="Activity pages" className="flex flex-wrap gap-3">
        {nextHref ? <a className={BTN_SECONDARY} href={nextHref}>Older entries</a> : null}
        {newestHref ? <a className={BTN_SECONDARY} href={newestHref}>Newest entries</a> : null}
      </nav>
    </div>
  );
}
