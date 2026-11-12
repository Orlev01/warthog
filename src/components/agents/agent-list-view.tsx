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
  currency?: string;
  hasBudget?: boolean;
  spendIncomplete?: boolean;
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
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
const BTN_PRIMARY = `${BTN_BASE} bg-accent text-accent-fg hover:bg-accent-hover`;
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

// The one-line summary under the heading: how many agents, then how many need
// attention, in words ("3 agents · 1 needs reconnecting"), or "all connected". The
// rows keep the order the loader gives — agents needing reconnection first, then the
// most recently active (listAgentsForUser's ORDER BY).
export function agentSummary(agents: readonly AgentListItem[]): string {
  const total = `${agents.length} agent${agents.length === 1 ? "" : "s"}`;
  const count = (status: StatusKey) => agents.filter((agent) => agent.status === status).length;
  const reconnect = count("needs-reconnect");
  const errors = count("error");
  const pending = count("pending");
  const parts = [
    reconnect ? `${reconnect} ${reconnect === 1 ? "needs" : "need"} reconnecting` : null,
    errors ? `${errors} ${errors === 1 ? "has an error" : "have errors"}` : null,
    pending ? `${pending} pending` : null,
  ].filter((part): part is string => part !== null);
  return [total, ...(parts.length ? parts : ["all connected"])].join(" · ");
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
        <p className="text-xs text-fg-muted">
          Disconnecting isn&apos;t available just now.
        </p>
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
    <li className="grid min-w-0 gap-4 py-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 [overflow-wrap:anywhere]">
            <a
              href={`/agents/${agent.id}`}
              className="line-clamp-2 font-medium text-fg underline underline-offset-2"
            >
              {agent.name}
            </a>
            <span className="text-sm text-fg-muted">{agent.platform}</span>
          </div>
          <Status status={agent.status} />
        </div>

        <p className="text-sm text-fg-muted">
          Connected {agent.connectedAt} ·{" "}
          {agent.lastActiveAt
            ? `Last active ${agent.lastActiveAt}`
            : "Never active"}
        </p>

        <p className="text-sm text-fg-muted">
          {agent.requestCount} request{agent.requestCount === 1 ? "" : "s"} ·{" "}
          {agent.hasBudget === false
            ? "No card budget"
            : `${agent.currency ?? CURRENCY} ${agent.spendThisPeriod} of ${agent.currency ?? CURRENCY} ${agent.budget} ${periodLabel(agent.budgetPeriod)} approved`}
          {agent.spendIncomplete
            ? " · Total incomplete: exchange rate unavailable"
            : null}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 md:max-w-80 md:justify-end">
        <a href={`/agents/${agent.id}`} className={BTN_SECONDARY}>
          Manage agent
        </a>
        <a href={agent.activityHref} className={BTN_SECONDARY}>
          View activity
        </a>
        <DisconnectControl
          agentId={agent.id}
          disconnectAction={disconnectAction}
        />
      </div>
    </li>
  );
}

export function AgentListView({
  agents,
  disconnectAction,
}: AgentListViewProps) {
  return (
    <div className="wh-page flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-fg">
          Your agents
        </h1>
        <p className="text-sm text-fg-muted">
          Choose an agent to manage its connectors, vault access, skills,
          memory, spending and audit log.
        </p>
        {agents.length > 0 ? (
          <p className="text-sm font-medium text-fg">{agentSummary(agents)}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <a href="/agents/connect" className={BTN_PRIMARY}>
            Connect an agent
          </a>
          <a href="/settings/agents" className={BTN_SECONDARY}>
            Global agent settings
          </a>
        </div>
      </header>

      {agents.length === 0 ? (
        <EmptyState
          heading="No agents connected yet"
          description="Connect an agent and it'll appear here with its status and spend."
          action={
            <a href="/agents/connect" className={BTN_PRIMARY}>
              Connect an agent
            </a>
          }
        />
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {agents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              disconnectAction={disconnectAction}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export default AgentListView;
