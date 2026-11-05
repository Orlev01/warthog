import * as React from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/field";
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
// buttons: the search/filter chrome is a GET form that re-queries the screen by URL,
// the read-only Check-integrity is a GET form, and Dispute/Undo are POST forms carrying
// the entry seq + intent. Binding those submissions to the E08-S07 server actions is
// the thin loader's job — this view invents no action props, keeping the cross-task
// prop contract exactly as documented. Every colour comes from the design tokens
// (globals.css); no raw hex, no new colour.

// One entry on the timeline. `source` is the activity vocabulary union: "warthog" is a
// fact Warthog recorded itself; "agent_reported" is a summary an agent submitted, shown
// labelled "Reported by <agent>" and never treated as the source of truth. `agent` is
// the connected AI client, `service` the connected service it touched (either may be
// absent). `canUndo` is true ⇔ the entry's tool declares a reversal.
export type ActivityEntryView = {
  seq: number;
  kind: string; // display-ready, e.g. "Tool call"
  source: "warthog" | "agent_reported";
  agent?: string;
  service?: string;
  outcome: string; // display-ready, e.g. "Done"
  at: string; // pre-formatted time label, e.g. "two minutes ago"
  summary: string; // one-line, already-redacted
  detail: string; // full detail, already-redacted (the per-entry "open for detail")
  canUndo: boolean;
};

// The values each filter dropdown offers (resolved display names / labels).
export type ActivityFilterOptions = {
  agents: readonly string[];
  services: readonly string[];
  kinds: readonly string[];
  outcomes: readonly string[];
};

export type ActivityViewProps = {
  entries: readonly ActivityEntryView[];
  filterOptions: ActivityFilterOptions;
  query: string; // the current search text (pre-fills the search box)
  integrity: IntegrityResult | null; // the latest Check-integrity result, if one has run
};

// A native select styled on the design tokens (there is no Select primitive yet): same
// surface, border, radius, touch target (≥44px) and focus ring as the Input primitive.
const SELECT_CLASS =
  "min-h-11 w-full rounded-card border border-line bg-surface px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

// The action buttons mirror the shared Button primitive's look on the design tokens
// (≥44px target, token colour/radius/focus) but as native <button>s: every control in
// this view is ALWAYS live (brief "no dead controls"), so they deliberately omit the
// primitive's `disabled:` utility variants. The accent fill is reserved for the one
// primary action on the screen (Check-integrity); everything else is the neutral
// surface variant.
const BTN_BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-card px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const BTN_PRIMARY = `${BTN_BASE} bg-accent text-accent-fg hover:bg-accent-hover`;
const BTN_SECONDARY = `${BTN_BASE} border border-line bg-surface text-fg hover:bg-surface-muted`;

// The four facet filters, each keyed to its resolved option list.
type Facet = {
  name: string;
  label: string;
  all: string;
  options: readonly string[];
};

function FacetFilter({ name, label, all, options }: Facet) {
  const id = `activity-filter-${name}`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} name={name} defaultValue="" className={SELECT_CLASS}>
        <option value="">{all}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
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
            Record intact — all {result.checked} entries checked and verified.
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

function ActivityEntryItem({ entry }: { entry: ActivityEntryView }) {
  // An agent-reported summary is attributed by "Reported by <agent>"; a Warthog-recorded
  // entry names its agent in the meta line and carries no such label.
  const metaParts =
    entry.source === "agent_reported"
      ? [entry.service, entry.at]
      : [entry.agent, entry.service, entry.at];
  const meta = metaParts.filter(Boolean).join(" · ");

  return (
    <li className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-fg">{entry.kind}</span>
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
        <p className="mt-2 text-fg-muted">{entry.detail}</p>
      </details>
      <div className="flex flex-wrap gap-2">
        {entry.canUndo ? (
          <form method="post">
            <input type="hidden" name="intent" value="undo" />
            <input type="hidden" name="seq" value={String(entry.seq)} />
            <button type="submit" className={BTN_SECONDARY}>
              Undo
            </button>
          </form>
        ) : null}
        <form method="post">
          <input type="hidden" name="intent" value="dispute" />
          <input type="hidden" name="seq" value={String(entry.seq)} />
          <button type="submit" className={BTN_SECONDARY}>
            Dispute
          </button>
        </form>
      </div>
    </li>
  );
}

export function ActivityView({ entries, filterOptions, query, integrity }: ActivityViewProps) {
  const facets: Facet[] = [
    { name: "agent", label: "Agent", all: "All agents", options: filterOptions.agents },
    { name: "service", label: "Service", all: "All services", options: filterOptions.services },
    { name: "kind", label: "Kind", all: "All kinds", options: filterOptions.kinds },
    { name: "outcome", label: "Outcome", all: "All outcomes", options: filterOptions.outcomes },
  ];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {facets.map((facet) => (
            <FacetFilter key={facet.name} {...facet} />
          ))}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="activity-from">From</Label>
            <Input id="activity-from" type="date" name="from" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="activity-to">To</Label>
            <Input id="activity-to" type="date" name="to" />
          </div>
        </div>
        <div>
          <button type="submit" className={BTN_SECONDARY}>
            Apply filters
          </button>
        </div>
      </form>

      {entries.length === 0 ? (
        <EmptyState
          heading="No activity yet"
          description="Everything your agents do through Warthog will show up here."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {entries.map((entry) => (
            <ActivityEntryItem key={entry.seq} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  );
}
