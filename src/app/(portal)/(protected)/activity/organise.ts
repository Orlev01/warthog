// How the Activity screen organises the audit log (the founder's 12 November request: the
// log was "one long thread"). Four views over the same filtered record:
//
//   • Timeline   — every entry, newest first, under day headings ("Today", "Yesterday" …);
//   • By agent   — one row per agent (plus "Account and Warthog" for entries with no agent),
//                  each drilling into that agent's timeline;
//   • By type    — reads, changes, approvals & releases, agent reports …;
//   • By service — one row per connected service.
//
// This module turns the GET parameters into a validated state, the state into the filters
// the SQL reads, and builds every same-page link (view tabs, quick filters, removable
// chips, drill-downs, breadcrumbs) from that state with `hrefWith`, so unrelated filters
// always survive and a crafted parameter can never be echoed or linked unvalidated.
// Pure: no DB, no clock (the caller passes "now" for day labels).

import { hrefWith, resolveKey, type QueryState } from "@/lib/href";
import {
  ACTIVITY_CATEGORIES,
  CATEGORY_DESCRIPTIONS,
  CATEGORY_LABELS,
  isActivityCategory,
  type ActivityCategory,
} from "@/domain/activity/category";
import { outcomeLabel } from "@/domain/activity/category";
import { kindLabel } from "@/domain/activity/describe";
import type { ActivityFilters, ActivityGroupSummary } from "@/server/activity/list";
import type { FilterLink, AppliedFilter } from "@/components/ui/filter-links";
import type { ActivityGroupView, ActivityViewKey } from "@/components/activity/activity-view";

export type { ActivityGroupView, ActivityViewKey };

export const ACTIVITY_PATH = "/activity";
export const ACTIVITY_VIEWS: readonly ActivityViewKey[] = ["timeline", "agents", "types", "services"];
const VIEW_LABELS: Record<ActivityViewKey, string> = {
  timeline: "Timeline",
  agents: "By agent",
  types: "By type",
  services: "By service",
};
const DRILL_VIA = ["agents", "types", "services"] as const;
type DrillVia = (typeof DRILL_VIA)[number];

// One-off parameters a same-page link never carries forward: the page cursor, a single-entry
// permalink, the integrity run and a finished action's notice.
export const TRANSIENT_PARAMS: readonly string[] = ["before", "entry", "verify", "notice"];

// The "no agent" / "no service" sentinel a group drills into.
export const NONE = "none";

export interface ActivityState {
  view: ActivityViewKey;
  via?: DrillVia;
  agent?: string; // an agent id, or NONE
  service?: string; // a connector id, or NONE
  kind?: string;
  outcome?: string;
  from?: string;
  to?: string;
  q?: string;
  type?: ActivityCategory;
  attention?: boolean;
}

type Params = Record<string, string | string[] | undefined>;

function first(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && value.length > 0 ? value : undefined;
}

// An id-shaped value (agent ids are uuids, connector ids are slugs) or nothing. A value of
// any other shape is ignored rather than echoed into chips and links.
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
function shaped(value: string | undefined, pattern: RegExp): string | undefined {
  return value !== undefined && pattern.test(value) ? value : undefined;
}

/** The validated screen state from the GET parameters (dates are validated by the caller). */
export function readActivityState(params: Params, validDate: (value: string | undefined) => string | undefined): ActivityState {
  const via = first(params.via);
  const type = first(params.type);
  const q = (first(params.q) ?? "").slice(0, 2000);
  return {
    view: resolveKey(first(params.view), ACTIVITY_VIEWS, "timeline"),
    via: via !== undefined && (DRILL_VIA as readonly string[]).includes(via) ? (via as DrillVia) : undefined,
    agent: shaped(first(params.agent), ID),
    service: shaped(first(params.service), ID),
    kind: shaped(first(params.kind), CODE),
    outcome: shaped(first(params.outcome), CODE),
    from: validDate(first(params.from)),
    to: validDate(first(params.to)),
    q: q.length > 0 ? q : undefined,
    type: isActivityCategory(type) ? type : undefined,
    attention: first(params.attention) === "1" ? true : undefined,
  };
}

/** The state as link parameters: the default view and absent values are omitted. */
export function stateQuery(state: ActivityState): QueryState {
  return {
    view: state.view === "timeline" ? undefined : state.view,
    via: state.via,
    agent: state.agent,
    service: state.service,
    kind: state.kind,
    outcome: state.outcome,
    from: state.from,
    to: state.to,
    q: state.q,
    type: state.type,
    attention: state.attention ? "1" : undefined,
  };
}

/**
 * The SQL filters the state selects. A date-only `to` covers the whole of that day; the
 * caller's `widenTo` / `widenFrom` place a calendar date in the account's time zone.
 */
export function filtersFor(
  state: ActivityState,
  widenTo: (to: string) => string,
  widenFrom: (from: string) => string = (from) => from,
): ActivityFilters {
  const filters: ActivityFilters = {};
  if (state.agent === NONE) filters.noAgent = true;
  else if (state.agent !== undefined) filters.agentId = state.agent;
  if (state.service === NONE) filters.noService = true;
  else if (state.service !== undefined) filters.connectorId = state.service;
  if (state.kind !== undefined) filters.kind = state.kind;
  if (state.outcome !== undefined) filters.outcome = state.outcome;
  if (state.from !== undefined) filters.from = widenFrom(state.from);
  if (state.to !== undefined) filters.to = widenTo(state.to);
  if (state.type !== undefined) filters.category = state.type;
  if (state.attention) filters.attention = true;
  return filters;
}

export function activityHref(state: ActivityState, patch: QueryState = {}, drop: readonly string[] = []): string {
  return hrefWith(ACTIVITY_PATH, stateQuery(state), patch, [...TRANSIENT_PARAMS, ...drop]);
}

/** The view tabs. Every filter survives a switch; grouped views drop the page-only search. */
export function viewLinks(state: ActivityState): FilterLink[] {
  return ACTIVITY_VIEWS.map((view) => ({
    label: VIEW_LABELS[view],
    href: activityHref(state, { view: view === "timeline" ? undefined : view, via: undefined }, view === "timeline" ? [] : ["q"]),
    active: state.view === view,
  }));
}

/** Quick filters: everything, needs attention, or one common type. */
export function quickLinks(state: ActivityState): FilterLink[] {
  const plain = !state.attention && state.type === undefined;
  const links: FilterLink[] = [
    { label: "All activity", href: activityHref(state, { attention: undefined, type: undefined }), active: plain },
    { label: "Needs attention", href: activityHref(state, { attention: "1", type: undefined }), active: state.attention === true && state.type === undefined },
  ];
  for (const type of ["read", "change", "approval", "report"] as const) {
    links.push({
      label: CATEGORY_LABELS[type],
      href: activityHref(state, { type, attention: undefined }),
      active: state.type === type && !state.attention,
    });
  }
  return links;
}

// ---------------------------------------------------------------------------------
// Calendar-day filters in the account's time zone. The date inputs post a calendar day
// ("2026-11-12"); the page states its times in the account's zone, so "To 12 Nov" means the
// end of 12 November there, not in UTC (content-47: a Sydney member's "To 12 Nov" dropped
// everything after 11 am local time).
// ---------------------------------------------------------------------------------

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

// How far `zone` is ahead of UTC at `instant`, in milliseconds.
function zoneOffset(instant: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The first instant of a calendar day in `zone`, as an ISO instant. A non-day value is returned as given. */
export function dayStartIn(day: string, zone: string): string {
  if (!DAY.test(day)) return day;
  const midnight = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(midnight)) return day;
  // Twice, so a day that starts on a daylight-saving change still lands on its local midnight.
  const first = midnight - zoneOffset(midnight, zone);
  return new Date(midnight - zoneOffset(first, zone)).toISOString();
}

/** The last instant of a calendar day in `zone` (inclusive), as an ISO instant. */
export function dayEndIn(day: string, zone: string): string {
  if (!DAY.test(day)) return day;
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  return new Date(Date.parse(dayStartIn(next, zone)) - 1).toISOString();
}

/** A filter date as people write it: "2026-03-01" → "1 Mar 2026" (an ISO date-time keeps its date). */
export function filterDate(value: string): string {
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const date = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return day;
  return new Intl.DateTimeFormat("en-AU", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(date);
}

/** The applied filters as removable chips, each linking to the screen without that filter. */
export function appliedFilters(
  state: ActivityState,
  names: { agent?: string; service?: string },
): { filters: AppliedFilter[]; clearHref: string } {
  const filters: AppliedFilter[] = [];
  const chip = (label: string, param: keyof ActivityState, extra: readonly string[] = []) =>
    filters.push({ label, removeHref: activityHref(state, { [param]: undefined }, extra) });
  // Removing the drilled-into group also leaves the drill-down (its breadcrumb).
  if (state.agent !== undefined) chip(`Agent: ${state.agent === NONE ? "No agent" : names.agent ?? state.agent}`, "agent", state.via === "agents" ? ["via"] : []);
  if (state.service !== undefined) chip(`Service: ${state.service === NONE ? "No service" : names.service ?? state.service}`, "service", state.via === "services" ? ["via"] : []);
  if (state.type !== undefined) chip(`Type: ${CATEGORY_LABELS[state.type]}`, "type", state.via === "types" ? ["via"] : []);
  if (state.attention) chip("Needs attention", "attention");
  if (state.kind !== undefined) chip(`Event: ${kindLabel(state.kind)}`, "kind");
  if (state.outcome !== undefined) chip(`Outcome: ${outcomeLabel(state.outcome)}`, "outcome");
  // Dates are calendar days in the account's time zone, which the page states once.
  if (state.from !== undefined) chip(`From ${filterDate(state.from)}`, "from");
  if (state.to !== undefined) chip(`To ${filterDate(state.to)}`, "to");
  if (state.q !== undefined) chip(`Search: “${state.q}”`, "q");
  // "Clear all" keeps the current view.
  return { filters, clearHref: hrefWith(ACTIVITY_PATH, { view: stateQuery(state).view }) };
}

/** The way back from a drill-down to the grouped view it came from. */
export function breadcrumb(state: ActivityState): { label: string; href: string } | undefined {
  if (state.view !== "timeline" || state.via === undefined) return undefined;
  const param = state.via === "agents" ? "agent" : state.via === "services" ? "service" : "type";
  const label = state.via === "agents" ? "All agents" : state.via === "services" ? "All services" : "All types";
  return { label, href: activityHref(state, { view: state.via, via: undefined, [param]: undefined }, ["q"]) };
}

// Day headings and times of day live with the shared display-time formatting.
export { dayOf, timeOfDay } from "@/domain/display-time";

// ---------------------------------------------------------------------------------
// Grouped views.
// ---------------------------------------------------------------------------------


export interface AgentFacts {
  readonly name: string;
  readonly platform?: string; // as stored, for the agent's mark
  readonly platformName?: string | null; // in words; null when there is nothing worth showing
  readonly disconnected?: boolean;
  readonly connectedOn?: string; // "10 Nov 2026"
  readonly exists: boolean;
}

function split(summary: ActivityGroupSummary, drill: (type: ActivityCategory) => string) {
  return ACTIVITY_CATEGORIES.filter((type) => summary.byCategory[type] > 0).map((type) => ({
    label: CATEGORY_LABELS[type],
    count: summary.byCategory[type],
    href: drill(type),
  }));
}

function attentionOf(summary: ActivityGroupSummary) {
  return { blocked: summary.byOutcome.blocked, failed: summary.byOutcome.failed, disputed: summary.disputed };
}

// The platform line under an agent's name: in words, and only when it adds to the name.
function shownPlatform(f: AgentFacts): string | undefined {
  const platform = f.platformName === undefined ? f.platform : f.platformName ?? undefined;
  return platform && platform.toLowerCase() !== f.name.toLowerCase() ? platform : undefined;
}

export function agentGroups(
  summaries: readonly ActivityGroupSummary[],
  facts: (id: string) => AgentFacts,
  state: ActivityState,
  when: (iso: string) => string,
): ActivityGroupView[] {
  const named = summaries.map((summary) => ({ summary, facts: summary.key === null ? undefined : facts(summary.key) }));
  const nameCounts = new Map<string, number>();
  for (const { facts: f } of named) if (f) nameCounts.set(f.name, (nameCounts.get(f.name) ?? 0) + 1);
  const rows = named.map(({ summary, facts: f }): ActivityGroupView => {
    const agent = summary.key ?? NONE;
    const drill = (patch: QueryState = {}) => activityHref(state, { view: undefined, via: "agents", agent, ...patch }, ["q"]);
    const details = f
      ? [shownPlatform(f), f.disconnected ? "Disconnected" : undefined, (nameCounts.get(f.name) ?? 0) > 1 && f.connectedOn ? `connected ${f.connectedOn}` : undefined]
      : ["Your own account changes and Warthog's events, with no agent involved"];
    const attention = attentionOf(summary);
    return {
      id: `agent-${agent}`,
      label: f ? f.name : "Account and Warthog",
      mark: f ? { kind: "agent", platform: f.platform } : undefined,
      detail: details.filter(Boolean).join(" · ") || undefined,
      disconnected: f?.disconnected,
      total: summary.total,
      lastAt: when(summary.lastAt),
      lastAtIso: summary.lastAt,
      href: drill(),
      split: split(summary, (type) => drill({ type })),
      ...attention,
      attentionHref: attention.blocked + attention.failed + attention.disputed > 0 ? drill({ attention: "1" }) : undefined,
      manageHref: f?.exists && summary.key ? `/agents/${encodeURIComponent(summary.key)}?section=activity` : undefined,
    };
  });
  // Agents first (most recently active first, as summarised); "Account and Warthog" last.
  return [...rows.filter((row) => row.id !== `agent-${NONE}`), ...rows.filter((row) => row.id === `agent-${NONE}`)];
}

export function typeGroups(
  summaries: readonly ActivityGroupSummary[],
  byAgent: readonly ActivityGroupSummary[],
  agentName: (id: string | null) => string,
  state: ActivityState,
  when: (iso: string) => string,
): ActivityGroupView[] {
  return ACTIVITY_CATEGORIES.map((type): ActivityGroupView => {
    const summary = summaries.find((s) => s.key === type);
    const drill = (patch: QueryState = {}) => activityHref(state, { view: undefined, via: "types", type, ...patch }, ["q"]);
    const top = byAgent
      .filter((group) => group.byCategory[type] > 0)
      .sort((a, b) => b.byCategory[type] - a.byCategory[type])
      .slice(0, 3)
      .map((group) => `${agentName(group.key)} ${group.byCategory[type]}`)
      .join(" · ");
    if (!summary) {
      return { id: `type-${type}`, label: CATEGORY_LABELS[type], mark: { kind: "type", type }, detail: CATEGORY_DESCRIPTIONS[type], total: 0, split: [], blocked: 0, failed: 0, disputed: 0 };
    }
    const attention = attentionOf(summary);
    return {
      id: `type-${type}`,
      label: CATEGORY_LABELS[type],
      mark: { kind: "type", type },
      detail: CATEGORY_DESCRIPTIONS[type],
      total: summary.total,
      lastAt: when(summary.lastAt),
      lastAtIso: summary.lastAt,
      href: drill(),
      split: [],
      ...attention,
      attentionHref: attention.blocked + attention.failed + attention.disputed > 0 ? drill({ attention: "1" }) : undefined,
      top: top || undefined,
    };
  });
}

export function serviceGroups(
  summaries: readonly ActivityGroupSummary[],
  serviceName: (id: string) => string,
  state: ActivityState,
  when: (iso: string) => string,
): ActivityGroupView[] {
  const rows = summaries.map((summary): ActivityGroupView => {
    const service = summary.key ?? NONE;
    const drill = (patch: QueryState = {}) => activityHref(state, { view: undefined, via: "services", service, ...patch }, ["q"]);
    const attention = attentionOf(summary);
    return {
      id: `service-${service}`,
      label: summary.key === null ? "No service: Warthog itself" : serviceName(summary.key),
      mark: summary.key === null ? undefined : { kind: "service", id: summary.key },
      detail: summary.key === null ? "Memory, tasks, records, approvals and account changes" : undefined,
      total: summary.total,
      lastAt: when(summary.lastAt),
      lastAtIso: summary.lastAt,
      href: drill(),
      split: split(summary, (type) => drill({ type })),
      ...attention,
      attentionHref: attention.blocked + attention.failed + attention.disputed > 0 ? drill({ attention: "1" }) : undefined,
    };
  });
  return [...rows.filter((row) => row.id !== `service-${NONE}`), ...rows.filter((row) => row.id === `service-${NONE}`)];
}

/** What the grouped counts cover, in words. */
export function countsCaption(state: ActivityState): string {
  const range = state.from || state.to
    ? `Counts cover ${state.from ? filterDate(state.from) : "the start of your record"} to ${state.to ? filterDate(state.to) : "now"}`
    : "Counts cover your whole record";
  return `${range}, within the filters shown. They include everything your agents did through Warthog, counting each change once. Warthog can't see what an agent does elsewhere.`;
}
