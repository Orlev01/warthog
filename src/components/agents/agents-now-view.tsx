import * as React from "react";
import { Activity, MessagesSquare } from "lucide-react";

import { AgentMark } from "@/components/ui/brand-mark";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty";
import { LIST_ROW } from "@/components/ui/list-group";
import { Status } from "@/components/ui/status";
import { WorkspaceHeading, WorkspacePanel } from "@/components/shell/workspace-surfaces";
import { OutcomeBadge } from "@/components/activity/activity-view";
import type { OutcomeGroup } from "@/domain/activity/category";

// The Now view (/agents/now; docs/adr/agent-runs.md, amendment of 25 November 2026): every
// agent's conversations from the last day, grouped by provider, each with what the agent says
// it is working on and the latest thing it asked Warthog to do. Only calls made to Warthog
// show here; the page says so, and never calls an agent "live" or "running".
//
// Pure: the loader (`app/(portal)/(protected)/agents/now/actions.ts`) reads and formats; the
// view reaches for no clock or database. The page passes the one client piece, the
// auto-refresh (`components/ui/auto-refresh.tsx`), as `refresh`.

export interface NowConversationView {
  readonly id: string;
  readonly href: string;
  // What the agent said the conversation is for, in its own words; null when it said nothing.
  readonly label: string | null;
  readonly via: string | null;
  readonly entries: number;
  readonly lastCall: string;
  readonly lastCallAt: string;
  // "2 min ago" when the agent changed its description, else null.
  readonly statusChanged: string | null;
  readonly latest: { readonly title: string; readonly outcome: string; readonly outcomeGroup: OutcomeGroup; readonly service: string | null } | null;
  readonly active: boolean;
}

export interface NowAgentView {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly connected: boolean;
  readonly href: string;
  readonly conversations: readonly NowConversationView[];
  // Its calls in the last day that weren't in any conversation.
  readonly unlinked: { readonly count: number; readonly href: string; readonly lastCall: string } | null;
}

export interface AgentsNowViewProps {
  readonly providers: readonly { readonly key: string; readonly label: string; readonly agents: readonly NowAgentView[] }[];
  // Connected agents with nothing in the last day.
  readonly quiet: readonly { readonly id: string; readonly name: string; readonly href: string }[];
  readonly activeCount: number;
  readonly updatedAt: string;
  readonly updatedAtIso: string;
  // The auto-refresh control; without it the view says when it was loaded.
  readonly refresh?: React.ReactNode;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function summary(props: AgentsNowViewProps): string {
  const conversations = props.providers.reduce((sum, provider) => sum + provider.agents.reduce((n, agent) => n + agent.conversations.length, 0), 0);
  return `${plural(conversations, "conversation", "conversations")} in the last day · ${props.activeCount} active`;
}

export function AgentsNowView(props: AgentsNowViewProps) {
  const empty = props.providers.length === 0;
  return (
    <div className="wh-page">
      <WorkspaceHeading
        title="Now"
        description="What your agents have asked Warthog to do in the last day, by conversation. Active means it called Warthog in the last 15 minutes. Warthog only sees calls made to it, so it can’t tell whether an app is still running or what it does elsewhere."
        meta={empty ? undefined : summary(props)}
      >
        {props.refresh ?? (
          <p className="text-sm text-fg-muted">
            Updated <time dateTime={props.updatedAtIso}>{props.updatedAt}</time>
          </p>
        )}
      </WorkspaceHeading>

      {empty ? (
        <EmptyState
          icon={MessagesSquare}
          heading="No conversations in the last day"
          description="When an agent checks in with Warthog at the start of a chat or session, its conversation shows here with what it says it’s working on."
        />
      ) : (
        props.providers.map((provider) => (
          <WorkspacePanel key={provider.key} title={provider.label}>
            <div className="flex flex-col gap-5">
              {provider.agents.map((agent) => <AgentConversations key={agent.id} agent={agent} />)}
            </div>
          </WorkspacePanel>
        ))
      )}

      {props.quiet.length > 0 ? (
        <p className="text-sm text-fg-muted">
          Nothing in the last day from{" "}
          {props.quiet.map((agent, index) => (
            <React.Fragment key={agent.id}>
              {index > 0 ? (index === props.quiet.length - 1 ? " and " : ", ") : null}
              <a href={agent.href} className="underline underline-offset-4">{agent.name}</a>
            </React.Fragment>
          ))}
          .
        </p>
      ) : null}
    </div>
  );
}

function AgentConversations({ agent }: { agent: NowAgentView }) {
  return (
    <section aria-labelledby={`now-agent-${agent.id}`} className="flex flex-col gap-1">
      <div className="flex min-w-0 items-center gap-3">
        <AgentMark platform={agent.platform} name={agent.name} size="sm" />
        <h3 id={`now-agent-${agent.id}`} className="min-w-0 font-medium [overflow-wrap:anywhere]">
          <a href={agent.href} className="underline underline-offset-4">{agent.name}</a>
        </h3>
        {agent.connected ? null : <Status status="disconnected" />}
      </div>
      <ul className="flex flex-col text-sm">
        {agent.conversations.map((conversation) => (
          <li key={conversation.id} className={LIST_ROW}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <a href={conversation.href} className="font-medium text-fg underline underline-offset-4">
                {conversation.label === null ? (
                  "Untitled conversation"
                ) : (
                  <>
                    <span className="sr-only">{agent.name}’s description: </span>“{conversation.label}”
                  </>
                )}
              </a>
              {conversation.active ? <Badge tone="success" icon={Activity}>Active</Badge> : null}
            </div>
            <p className="text-fg-muted">
              {[conversation.via ? `via ${conversation.via}` : null, plural(conversation.entries, "entry", "entries")].filter(Boolean).join(" · ")}
              {" · last call "}
              <time dateTime={conversation.lastCallAt}>{conversation.lastCall}</time>
              {conversation.statusChanged ? ` · description changed ${conversation.statusChanged}` : null}
            </p>
            {conversation.latest ? (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fg-muted">
                <span>
                  Latest: <span className="text-fg">{conversation.latest.title}</span>
                  {conversation.latest.service ? ` · ${conversation.latest.service}` : null}
                </span>
                <OutcomeBadge outcome={conversation.latest.outcome} group={conversation.latest.outcomeGroup} />
              </p>
            ) : null}
          </li>
        ))}
        {agent.unlinked ? (
          <li className={LIST_ROW}>
            <a href={agent.unlinked.href} className="font-medium text-fg underline underline-offset-4">
              {plural(agent.unlinked.count, "action", "actions")} not in a conversation
            </a>
            <p className="text-fg-muted">
              It didn’t say which conversation these were for · last {agent.unlinked.lastCall}
            </p>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
