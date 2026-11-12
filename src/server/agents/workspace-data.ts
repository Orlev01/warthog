import { readClientObservation } from "../mcp/client-observation";
import { activityEvidence } from "@/domain/activity/evidence";
import { getAgentById } from "../db/agents";
import { getConnectionPermissions } from "../db/agent-permissions";
import { pageMemories } from "../db/memories";
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
      ? (
          await pageMemories(db, userId, dek, { agentId: agent.id, limit: 50 })
        ).items.map((item) => ({
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
          ...activityEvidence(entry),
          outcome: entry.outcome ? humanise(entry.outcome) : "",
          reported: entry.source === "agent_reported",
          at: formatAccountTime(entry.occurredAt, timeZone),
        }))
      : [];
  const recent = section === "overview" ? await listActivity(db, userId, { agentId: agent.id, kind: "tool_call" }, dek, { limit: 100 }) : [];
  const measured = recent.filter(entry => {
    const payload = entry.payload as { durationMs?: unknown; resultEvidence?: unknown };
    return entry.outcome !== "pending_approval" && typeof payload?.durationMs === "number" && payload.resultEvidence != null;
  });
  const durations = measured.map(entry => (entry.payload as {durationMs:number}).durationMs).sort((a,b)=>a-b);
  const performance = { examined: recent.length, measured: measured.length,
    failed: measured.filter(entry => entry.outcome === "failed").length,
    unknown: measured.filter(entry => entry.outcome === "unknown").length,
    refused: measured.filter(entry => ["refused","denied","rate_limited"].includes(entry.outcome ?? "")).length,
    p95Ms: durations.length ? Math.round(durations[Math.ceil(durations.length * 0.95) - 1]!) : null };
  const clientObservation = await readClientObservation(db, userId, agent.id, dek);
  return {
    performance,
    agent,
    clientObservation: clientObservation ? { ...clientObservation, displayObservedAt: formatAccountTime(clientObservation.observedAt, timeZone) } : null,
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
