import * as React from "react";
import { AgentMark } from "@/components/ui/brand-mark";
import { Bot, Plus } from "lucide-react";
import { WorkspaceHeading } from "@/components/shell/workspace-surfaces";

import { Status, type StatusKey } from "@/components/ui/status";
import { EmptyState } from "@/components/ui/empty";
import { PageNotice, type NoticeTone } from "@/components/ui/notice";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { ActionForm, FormSubmit } from "@/components/ui/form-submit";
import { formatMoney } from "@/domain/approvals/request-sentence";
import { platformLabel } from "./platform-label";

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
  // The outcome of the last disconnect, shown once in the page's notice slot.
  notice?: { tone: NoticeTone; text: string } | null;
};

// Plain words for the budget period, so spend reads "$42.00 of $200.00 approved this month".
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

// A disconnected agent ("Reconnect needed") can't be disconnected again: it offers the way
// back instead (interaction-08). Every other state keeps its live Disconnect.
function isDisconnected(agent: AgentListItem): boolean {
  return agent.status === "needs-reconnect";
}

// The Disconnect control for one agent. LIVE (bound to `disconnectAction`, carrying THIS
// agent's id so the action disconnects the right one) when an action is supplied;
// otherwise DISABLED with a one-line reason — never a live button over a missing action
// (constitution: no dead controls — disable it and say why). It is the entry point to a
// destructive step, so it carries the danger treatment; the confirm dialog follows.
function DisconnectControl({
  agent,
  disconnectAction,
}: {
  agent: AgentListItem;
  disconnectAction?: (formData: FormData) => void | Promise<void>;
}) {
  if (!disconnectAction) {
    return (
      <div className="flex flex-col gap-1">
        <Button type="button" variant="danger" disabled>
          Disconnect
        </Button>
        <p className="text-xs text-fg-muted">
          Disconnecting isn&apos;t available just now.
        </p>
      </div>
    );
  }
  return (
    <ActionForm action={disconnectAction}>
      <input type="hidden" name="agentId" value={agent.id} />
      <FormSubmit variant="danger" pendingLabel="Disconnecting…">
        Disconnect<span className="sr-only"> {agent.name}</span>
      </FormSubmit>
    </ActionForm>
  );
}

function spendLine(agent: AgentListItem): string {
  if (agent.hasBudget === false) return "No card budget";
  const currency = agent.currency ?? "AUD";
  return `Card budget: ${formatMoney(agent.spendThisPeriod, currency)} of ${formatMoney(agent.budget, currency)} approved ${periodLabel(agent.budgetPeriod)}`;
}

function AgentCard({
  agent,
  disconnectAction,
}: {
  agent: AgentListItem;
  disconnectAction?: (formData: FormData) => void | Promise<void>;
}) {
  const platform = platformLabel(agent.platform);
  const disconnected = isDisconnected(agent);
  return (
    <li className="wh-surface wh-agent-row">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="wh-agent-row-heading">
          <AgentMark platform={agent.platform} name={agent.name} size="md" />
          <div className="flex min-w-0 flex-1 flex-col gap-1 [overflow-wrap:anywhere]">
            {/* The full name always shows: two agents can share a long prefix. */}
            <a
              href={`/agents/${agent.id}`}
              className="inline-flex min-h-11 items-center self-start font-medium text-fg underline underline-offset-2 lg:min-h-0"
            >
              {agent.name}
            </a>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted sm:gap-x-2">
              <Status status={agent.status} />
              {platform ? <><span aria-hidden className="hidden sm:inline">·</span><span>{platform}</span></> : null}
            </span>
          </div>
        </div>

        <p className="text-sm text-fg-muted">
          Connected {agent.connectedAt} ·{" "}
          {agent.lastActiveAt
            ? `Last active ${agent.lastActiveAt}`
            : "Never active"}
        </p>

        <p className="text-sm text-fg-muted">
          {agent.requestCount} request{agent.requestCount === 1 ? "" : "s"} · {spendLine(agent)}
          {agent.spendIncomplete
            ? " · Total incomplete: exchange rate unavailable"
            : null}
        </p>
      </div>
      <div className="wh-agent-row-actions">
        <ButtonLink href={`/agents/${agent.id}`}>
          {disconnected ? "View agent" : "Manage agent"}
          <span className="sr-only">: {agent.name}</span>
        </ButtonLink>
        <ButtonLink href={agent.activityHref}>
          View activity<span className="sr-only">: {agent.name}</span>
        </ButtonLink>
        {disconnected ? (
          <ButtonLink href="/agents/connect">
            Connect it again<span className="sr-only">: {agent.name}</span>
          </ButtonLink>
        ) : (
          <DisconnectControl agent={agent} disconnectAction={disconnectAction} />
        )}
      </div>
    </li>
  );
}

export function AgentListView({
  agents,
  disconnectAction,
  notice,
}: AgentListViewProps) {
  const empty = agents.length === 0;
  return (
    <div className="wh-page">
      <WorkspaceHeading
        title="Your agents"
        description={
          empty
            ? "The AI assistants you connect to Warthog appear here, each with its own permissions and activity."
            : "Choose an agent to manage its connectors, vault access, skills, memory, spending and activity."
        }
        meta={empty ? undefined : agentSummary(agents)}
      >
        {/* With no agents the empty state carries the one call to action (newcomer-19). */}
        {empty ? null : (
          <>
            <ButtonLink href="/agents/connect" variant="primary">
              <Plus aria-hidden className="h-4 w-4 shrink-0" />
              Connect an agent
            </ButtonLink>
            <ButtonLink href="/settings/agents">Agent defaults</ButtonLink>
          </>
        )}
      </WorkspaceHeading>

      {notice ? <PageNotice tone={notice.tone}>{notice.text}</PageNotice> : null}

      {empty ? (
        <EmptyState
          icon={Bot}
          heading="No agents connected yet"
          description="Agents are AI assistants like Claude or ChatGPT. Connect one and it gets its own permissions, card budget and activity record."
          action={
            <ButtonLink href="/agents/connect" variant="primary">
              Connect your first agent
            </ButtonLink>
          }
        />
      ) : (
        <ul className="wh-agent-list">
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
