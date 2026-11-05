import * as React from "react";

import { Status, type StatusKey } from "@/components/ui/status";
import { EmptyState } from "@/components/ui/empty";

// E10-S10 — Agent list view component (src/components/agents/agent-list-view.tsx).
//
// The Agents screen is a primary-journey surface (brief "Agents screen"; design §6.1):
// it lists EVERY connected agent (CLAUDE.md vocabulary — an *agent* is a connected AI
// client, one row per connection) with its platform, status, connected date, last-active
// time, request count and the spend in its current budget period against its budget, and
// on each agent offers a Disconnect control (E10-S09 "one-click disconnect") and a link
// to that agent's FILTERED activity (the Activity feed keyed to this agent).
//
// This is the PURE, prop-driven VIEW — exactly like DashboardView / ActivityView: it
// renders the screen from already-formatted props so it can be pinned without a browser,
// a session or any server plumbing. The loader (a later task) reads/decrypts/formats and
// feeds it: dates/times arrive as pre-formatted LABELS, amounts as plain major-unit
// numbers, the per-agent filtered-activity URL as `activityHref`, and the Disconnect
// control is BOUND to the `disconnectAction` server action the page passes (exactly as
// ActivityView binds Dispute/Undo). The view reaches for no clock, locale, DB or config.
//
// Colour comes from the design tokens (globals.css), never a raw hex.

// One agent on the list. `connectedAt` / `lastActiveAt` are PRE-FORMATTED labels the
// loader produced (never a raw Date — the view reaches for no clock); `lastActiveAt` is
// null when the agent has never been active. `spendThisPeriod` / `budget` are plain
// major-unit amounts and `budgetPeriod` names the current period. `activityHref` is the
// ready-made URL to THIS agent's filtered activity. `status` is the shared StatusKey
// union the UI <Status> primitive renders (one source of truth with DashboardAgent).
export type AgentListItem = {
  id: string;
  name: string;
  platform: string;
  status: StatusKey;
  connectedAt: string;
  lastActiveAt: string | null;
  requestCount: number;
  spendThisPeriod: number;
  budget: number;
  budgetPeriod: "day" | "week" | "month";
  activityHref: string;
};

export type AgentListViewProps = {
  agents: readonly AgentListItem[];
  // E10-S09 — the Disconnect control is BOUND to this server action (the page passes an
  // inline `use server` wrapper that re-derives the session and calls disconnectAgent
  // with the submitted agent id). OPTIONAL: the loader's own props omit it (the page adds
  // it), so when it is NOT supplied the Disconnect control renders DISABLED with a
  // one-line reason rather than a live button over a missing action (constitution: no
  // dead controls — disable it and say why).
  disconnectAction?: (formData: FormData) => void | Promise<void>;
};

// The person's currency label — matches the dashboard's spend display ("A$42 of A$200").
const CURRENCY = "A$";

// Native action buttons mirror the shared Button primitive's look on the design tokens
// (≥44px target, token colour/radius/focus) but as native <button>s: the live Disconnect
// is ALWAYS live, so it deliberately omits the primitive's `disabled:` utility variants.
// Everything here is the neutral surface variant (the accent is reserved for a screen's
// one primary action). Styled through tokens, no raw colour. (Same pattern as ActivityView.)
const BTN_BASE =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-card px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const BTN_SECONDARY = `${BTN_BASE} border border-line bg-surface text-fg hover:bg-surface-muted`;
// A control that is present but not actionable (Disconnect when no action is configured):
// the neutral surface look, dimmed and non-interactive, the native `disabled` attribute
// doing the disabling. Styled through tokens, no raw colour.
const BTN_DISABLED = `${BTN_BASE} border border-line bg-surface text-fg-muted opacity-50`;

// Plain words for the budget period, so spend reads "A$42 of A$200 this month".
function periodLabel(period: AgentListItem["budgetPeriod"]): string {
  switch (period) {
    case "day":
      return "today";
    case "week":
      return "this week";
    case "month":
      return "this month";
  }
}

// The Disconnect control for one agent. LIVE (bound to `disconnectAction`, carrying THIS
// agent's id so the action disconnects the right one) when an action is supplied;
// otherwise DISABLED with a one-line reason — never a live button over a missing action
// (constitution: no dead controls — disable it and say why).
function DisconnectControl({
  agentId,
  disconnectAction,
}: {
  agentId: string;
  disconnectAction?: (formData: FormData) => void | Promise<void>;
}) {
  if (!disconnectAction) {
    return (
      <div className="flex flex-col gap-1">
        <button type="button" disabled className={BTN_DISABLED}>
          Disconnect
        </button>
        <p className="text-xs text-fg-muted">Disconnecting isn&apos;t available just now.</p>
      </div>
    );
  }
  return (
    <form action={disconnectAction}>
      <input type="hidden" name="agentId" value={agentId} />
      <button type="submit" className={BTN_SECONDARY}>
        Disconnect
      </button>
    </form>
  );
}

function AgentCard({
  agent,
  disconnectAction,
}: {
  agent: AgentListItem;
  disconnectAction?: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium text-fg">{agent.name}</span>
          <span className="text-sm text-fg-muted">{agent.platform}</span>
        </div>
        <Status status={agent.status} />
      </div>

      <p className="text-sm text-fg-muted">
        Connected {agent.connectedAt} ·{" "}
        {agent.lastActiveAt ? `Last active ${agent.lastActiveAt}` : "Never active"}
      </p>

      <p className="text-sm text-fg-muted">
        {agent.requestCount} request{agent.requestCount === 1 ? "" : "s"} · {CURRENCY}
        {agent.spendThisPeriod} of {CURRENCY}
        {agent.budget} {periodLabel(agent.budgetPeriod)}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <a href={agent.activityHref} className={BTN_SECONDARY}>
          View activity
        </a>
        <DisconnectControl agentId={agent.id} disconnectAction={disconnectAction} />
      </div>
    </li>
  );
}

export function AgentListView({ agents, disconnectAction }: AgentListViewProps) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Your agents</h1>

      {agents.length === 0 ? (
        <EmptyState
          heading="No agents connected yet"
          description="Connect an agent and it'll appear here with its status and spend."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} disconnectAction={disconnectAction} />
          ))}
        </ul>
      )}
    </div>
  );
}

export default AgentListView;
