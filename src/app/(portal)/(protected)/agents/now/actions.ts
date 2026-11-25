// The Now view's loader (docs/adr/agent-runs.md, amendment of 25 November 2026): the person's
// agents and their conversations from the last day, grouped and formatted for
// <AgentsNowView/>. The injectable seam the thin `page.tsx` composes, as `../actions.ts` is.
//
// Only what Warthog itself recorded from calls made to it is read. Every read is member-scoped
// by `session.userId`, never a client value. The run descriptions are decrypted (at most
// MAX_RUN_LIST of them); every other column read is plaintext metadata.

import { listAgentsForUser } from "@/server/db/agents";
import { listRuns, MAX_RUN_LIST, type RunSummary } from "@/server/agents/runs";
import { summariseActivity } from "@/server/activity/list";
import { timeZoneFor } from "@/server/spending/time-zone";
import { groupNow, NOW_WINDOW_MS } from "@/domain/agents/now";
import { entryTitle } from "@/domain/activity/describe";
import { outcomeGroup, outcomeLabel } from "@/domain/activity/category";
import { agoText, timeOfDay } from "@/domain/display-time";
import type { AgentsNowViewProps, NowConversationView } from "@/components/agents/agents-now-view";
import type { Db } from "@/server/db/index";
import type { Clock } from "@/server/seams/clock";
import type { Session } from "@/server/auth/session";

export interface NowActionsDeps {
  readonly db: Db;
  readonly clock: Clock;
  // The person's unwrapped data key (run descriptions are encrypted under it).
  readonly dekFor: (userId: string) => Promise<Uint8Array>;
  // A connected service's name, through the connector catalogue.
  readonly nameOf?: (connectorId: string) => string | undefined;
}

export function createNowActions(deps: NowActionsDeps) {
  const { db, clock, dekFor, nameOf } = deps;

  async function load(session: Session): Promise<AgentsNowViewProps> {
    const now = clock.now();
    const since = new Date(now.getTime() - NOW_WINDOW_MS).toISOString();
    const dek = await dekFor(session.userId);
    const timeZone = await timeZoneFor(db, session.userId, dek);
    const agents = await listAgentsForUser(db, session.userId);
    const runs = await listRuns(db, session.userId, dek, { since, limit: MAX_RUN_LIST });
    // Each agent's own calls in the window that named no conversation.
    const unlinked = (await summariseActivity(db, session.userId, { noRun: true, from: since }, "agent"))
      .flatMap((group) => (group.key === null ? [] : [{ agentId: group.key, count: group.total, lastAt: group.lastAt }]));

    const grouping = groupNow(
      agents.map((agent) => ({ id: agent.id, name: agent.displayName, platform: agent.platform, status: agent.status })),
      runs,
      unlinked,
      now,
    );
    const ago = (iso: string) => agoText(new Date(iso), now);

    const conversation = ({ run, active }: { run: RunSummary; active: boolean }): NowConversationView => ({
      id: run.id,
      href: `/activity?run=${run.id}`,
      label: run.label ?? null,
      via: run.via ?? null,
      entries: run.actions,
      lastCall: ago(run.lastSeenAt),
      lastCallAt: run.lastSeenAt,
      statusChanged: run.labelChangedAt ? ago(run.labelChangedAt) : null,
      latest: run.latest
        ? {
            title: entryTitle(run.latest),
            outcome: outcomeLabel(run.latest.outcome),
            outcomeGroup: outcomeGroup(run.latest.outcome),
            service: run.latest.connectorId ? nameOf?.(run.latest.connectorId) ?? run.latest.connectorId : null,
          }
        : null,
      active,
    });

    return {
      providers: grouping.providers.map((provider) => ({
        key: provider.key,
        label: provider.label,
        agents: provider.agents.map(({ agent, conversations, unlinked: loose }) => ({
          id: agent.id,
          name: agent.name,
          platform: agent.platform,
          connected: agent.status === "connected",
          href: `/agents/${agent.id}`,
          conversations: conversations.map(conversation),
          unlinked: loose ? { count: loose.count, href: `/activity?agent=${agent.id}&run=none`, lastCall: ago(loose.lastAt) } : null,
        })),
      })),
      quiet: grouping.quiet.map((agent) => ({ id: agent.id, name: agent.name, href: `/agents/${agent.id}` })),
      activeCount: grouping.activeCount,
      updatedAt: timeOfDay(now.toISOString(), timeZone),
      updatedAtIso: now.toISOString(),
    };
  }

  return { load };
}
