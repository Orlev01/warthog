import { getAgentById } from "../db/agents";
import { getConnectionPermissions } from "../db/agent-permissions";
import { memoriesForAgent } from "../db/memories";
import { listActivity } from "../activity/list";
import { readAgentSpending } from "../spending/agent-spending";
import { timeZoneFor } from "../spending/time-zone";
import { formatAccountTime } from "../display-time";
import { entryTitle, humanise } from "@/domain/activity/describe";
import type { AgentSection } from "@/domain/permissions/workspace";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";

export async function agentWorkspaceData(
  db: Db,
  userId: string,
  agentId: string,
  dek: Uint8Array,
  clock: Clock,
  section: AgentSection,
) {
  const agent = await getAgentById(db, userId, agentId);
  if (!agent) return null;
  const grants = await getConnectionPermissions(db, userId, agent.connectionId);
  if (!grants) return null;
  const timeZone = await timeZoneFor(db, userId, dek);
  const spending =
    grants.cardBudget && (section === "overview" || section === "spending")
      ? await readAgentSpending(
          db,
          userId,
          agent.connectionId,
          grants.cardBudget,
          clock.now(),
          timeZone,
        )
      : null;
  const memory =
    section === "memory" && grants.memoryRead && agent.status === "connected"
      ? (await memoriesForAgent(db, userId, agent.id, dek))
          .slice(-50)
          .reverse()
          .map((item) => ({
            id: item.id,
            content: item.content,
            scope: item.scope,
            own: item.sourceAgentId === agent.id,
            savedAt: formatAccountTime(item.createdAt, timeZone),
          }))
      : [];
  const activity =
    section === "activity"
      ? (
          await listActivity(db, userId, { agentId: agent.id }, dek, {
            limit: 50,
          })
        ).map((entry) => ({
          seq: entry.seq,
          title: entryTitle(entry),
          outcome: entry.outcome ? humanise(entry.outcome) : "",
          reported: entry.source === "agent_reported",
          at: formatAccountTime(entry.occurredAt, timeZone),
        }))
      : [];
  return {
    agent,
    spending,
    memory,
    activity,
    memoryRead: grants.memoryRead,
    budget: grants.cardBudget,
  };
}
export type AgentWorkspaceData = NonNullable<
  Awaited<ReturnType<typeof agentWorkspaceData>>
>;
