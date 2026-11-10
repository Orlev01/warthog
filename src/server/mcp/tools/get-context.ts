// Review fix D7 — the `get_context` core tool (design §6.2 MCP core tools; brief "Agent
// context on connect — any agent can fetch, in one call, everything it has been granted:
// the person's low-tier profile, the skills and preferences scoped to it, the rules it must
// follow, the shared memory it may read, its open tasks, and Warthog's own house skill").
//
// The context is assembled for the CONNECTION's person and agent only, through the same
// member-scoped loader the pipeline's policy gate uses (`loadAgentContext`) plus the
// stores for each part, and each part is included only when the agent is granted it: the
// low-tier profile with identity access, the shared memory with memory access, tasks with
// the read-tools grant (the same gate list_tasks applies). The house skill always heads the
// skill index (its body comes from get_skill). Internal ids — the person's, the
// connection's, the agent's, a memory's — are never returned: a rule reads back as its
// sentence, a task assigned to this agent says "you". A task keeps its id, because
// update_task and complete_task take it.
//
// A SERVER module built purely from its INJECTED seams (db, keyWrapper, clock): it reads no
// `process.env` and holds no secret (INV-103). Every read is member-scoped by the session
// connection's user id and parameter-bound by the stores (INV-102).

import { buildSkillIndex, type SkillIndexEntry } from "../../../domain/skills/index";
import { ruleSentence } from "../../../domain/rules/rules";
import { listIdentityFields } from "../../db/identity-fields";
import { getPreferences } from "../../db/preferences";
import { skillsForAgent } from "../../db/skills";
import { memoriesForAgent } from "../../db/memories";
import { tasksForAgent } from "../../db/tasks";
import { getUserById } from "../../db/users";
import type { KeyWrapper } from "../../crypto/key-wrapper";
import type { Clock } from "../../seams/clock";
import type { Db } from "../../db/index";
import { loadAgentContext, type AgentConnection } from "../context";

export interface GetContextDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  readonly clock: Clock;
}

// One low-tier profile field as the agent sees it.
export interface ProfileField {
  readonly kind: string;
  readonly value: string;
  readonly movingOn?: string;
}

// Everything the agent has been granted, without internal ids.
export interface AgentContextView {
  readonly profile: readonly ProfileField[] | null;
  readonly preferences: Record<string, string> | null;
  readonly skills: readonly SkillIndexEntry[];
  readonly rules: readonly string[];
  readonly memory: ReadonlyArray<{ content: string; shared: boolean; savedAt: string }>;
  readonly tasks: ReadonlyArray<{ id: string; title: string; status: string; assignedTo: "you" | "any agent" }>;
  readonly permissions: {
    readonly services: readonly string[];
    readonly readTools: boolean;
    readonly changeTools: string;
    readonly profile: boolean;
    readonly highTierRequests: boolean;
    readonly cardRequests: boolean;
    readonly memory: boolean;
    readonly memoryWrite?: boolean;
    readonly sharing: boolean;
  };
  readonly card: { readonly budget: { amount: number; currency: string; period: string }; readonly spentThisPeriod: number } | null;
}

// A stored instant as an ISO-8601 string.
function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

export function createGetContextTool(deps: GetContextDeps): {
  handle(connection: AgentConnection): Promise<AgentContextView>;
} {
  const { db, keyWrapper, clock } = deps;

  async function dataKeyFor(userId: string): Promise<Uint8Array> {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("get_context: no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  }

  return {
    async handle(connection: AgentConnection): Promise<AgentContextView> {
      const { userId, agentId } = connection;
      const context = await loadAgentContext(connection, { db, keyWrapper, clock });
      const { permissions } = context;
      const dek = await dataKeyFor(userId);

      const profile = permissions.identityAccess
        ? (await listIdentityFields(db, userId, dek)).map((field) => ({
            kind: field.kind,
            value: field.value,
            ...(field.movingOn ? { movingOn: String(field.movingOn) } : {}),
          }))
        : null;

      const stored = await getPreferences(db, userId, dek);
      const preferences = stored
        ? {
            tone: stored.tone,
            length: stored.length,
            language: stored.language,
            units: stored.units,
            timeZone: stored.timeZone,
            briefing: stored.briefing,
          }
        : null;

      // The house skill first, then the person's enabled skills scoped to this agent.
      const personal = await skillsForAgent(db, userId, agentId, dek);
      const skills = [...buildSkillIndex([], agentId), ...personal];

      const memory = permissions.memoryRead
        ? (await memoriesForAgent(db, userId, agentId, dek)).map((m) => ({
            content: m.content,
            shared: m.scope === "shared",
            savedAt: iso(m.createdAt),
          }))
        : [];

      // The agent's own tasks grant (review fix A2 / W2.3), the one list_tasks checks and
      // the permissions page switches — not the connector read-tools class.
      const tasks = permissions.tasksAccess
        ? (await tasksForAgent(db, userId, agentId, dek))
            .filter((task) => task.status !== "done")
            .map((task) => ({
              id: task.id,
              title: task.title,
              status: task.status,
              assignedTo: task.assignee === agentId ? ("you" as const) : ("any agent" as const),
            }))
        : [];

      return {
        profile,
        preferences,
        skills,
        rules: context.rules.map((rule) => ruleSentence(rule)),
        memory,
        tasks,
        permissions: {
          services: permissions.grantedConnectors,
          readTools: permissions.readTools,
          changeTools: permissions.changeTools,
          profile: permissions.identityAccess,
          highTierRequests: permissions.highTierAccess,
          cardRequests: permissions.cardAccess,
          memory: permissions.memoryRead,
          memoryWrite: permissions.memoryWrite,
          sharing: permissions.sharing,
        },
        card:
          permissions.cardAccess && permissions.cardBudget
            ? {
                budget: {
                  amount: permissions.cardBudget.amount,
                  currency: permissions.cardBudget.currency,
                  period: permissions.cardBudget.period,
                },
                spentThisPeriod: context.spend,
              }
            : null,
      };
    },
  };
}
