import { getAgentById } from "../../db/agents";
import { savedByResolver } from "../../agents/saved-by";
import { listConnectionsForUser } from "../../db/connections";
import { selectConnectorAccount } from "../../connectors/tool-routing";
import { HOUSE_SKILL_BODY } from "./get-skill";
import { z } from "zod";
import { parseParams } from "../../http/validate";
import { pageMemories } from "../../db/memories";
import { pageSkillsForAgent } from "../../db/skills";
import { isPageCursor } from "../../db/pagination";
export const getContextSchema = z.object({
  // An agent is told its cursor is wrong rather than silently restarting at the first page,
  // which could loop a client that follows next.* until null.
  memory_cursor: z.string().max(256).refine(isPageCursor, "Invalid page cursor. Start from the first page.").optional(),
  skill_cursor: z.string().max(256).refine(isPageCursor, "Invalid page cursor. Start from the first page.").optional(),
  limit: z.number().int().min(1).max(100).optional(),
  reason: z.string().max(2000).optional(),
  // Runs (docs/adr/agent-runs.md): a short description of the conversation's work, kept with
  // the run this call starts, and the run to continue when the agent already has one.
  // Both are lenient: a malformed value is dropped, never a reason to withhold the context.
  working_on: z
    .string()
    .max(2000)
    .optional()
    .catch(undefined)
    .describe("A few words on what you are working on in this conversation, for example \"Fixing the website tests\". The person sees it next to everything this conversation does."),
  run: z
    .string()
    .max(64)
    .optional()
    .catch(undefined)
    .describe("The run id an earlier get_context in this conversation gave you. Omit it at the start of a conversation."),
});
import { vaultFieldAllowed } from "../../agents/resource-access";
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

import {
  buildSkillIndex,
  type SkillIndexEntry,
} from "../../../domain/skills/index";
import { ruleSentence } from "../../../domain/rules/rules";
import { listIdentityFields } from "../../db/identity-fields";
import { getPreferences } from "../../db/preferences";
import { tasksForAgent } from "../../db/tasks";
import { getUserById } from "../../db/users";
import type { KeyWrapper } from "../../crypto/key-wrapper";
import type { Clock } from "../../seams/clock";
import type { Db } from "../../db/index";
import { loadAgentContext, type AgentConnection } from "../context";
import { requestObservation } from "../client-observation";
import { startRun, type RunRef } from "../../agents/runs";
import { releasedValueMatcher } from "../../crypto/hmac";
import { lookupForUser } from "../../db/release-fingerprints";

// What the agent is told to do with its run.
export const RUN_NOTE = "Pass this id as run on every Warthog call you make in this conversation, so the person can see this conversation's actions together. A new conversation starts its own run: call get_context without run.";

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

// Granted context with bounded skill/memory pages and opaque continuation cursors.
export interface AgentContextView {
  readonly connection: { agentId: string; name: string; platform: string; identitySource: string };
  // This conversation's run (docs/adr/agent-runs.md). Null only while paging without one.
  readonly run: { id: string; workingOn: string | null; note: string } | null;
  readonly instructions: string;
  readonly serviceAccounts: readonly { service: string; accountId: string | null; label: string | null; status: string }[];
  readonly profile: readonly ProfileField[] | null;
  readonly next?: { memory: string | null; skills: string | null };
  readonly preferences: Record<string, string> | null;
  readonly skills: readonly SkillIndexEntry[];
  readonly rules: readonly string[];
  readonly memory: ReadonlyArray<{
    content: string;
    shared: boolean;
    savedAt: string;
  }>;
  readonly tasks: ReadonlyArray<{
    id: string;
    title: string;
    status: string;
    assignedTo: "you" | "any agent";
  }>;
  readonly permissions: {
    readonly resources?: { tasks: { read: boolean; write: boolean }; records: { read: boolean; write: boolean; scope: string } };
    readonly services: readonly string[];
    readonly servicePolicies?: Record<
      string,
      { readTools?: boolean; changeTools?: string }
    >;
    readonly vaultScope?: "all" | "chosen";
    readonly readTools: boolean;
    readonly changeTools: string;
    readonly profile: boolean;
    readonly highTierRequests: boolean;
    readonly cardRequests: boolean;
    readonly memory: boolean;
    readonly memoryWrite?: boolean;
    readonly sharing: boolean;
  };
  readonly card: {
    readonly budget: { amount: number; currency: string; period: string };
    readonly spentThisPeriod: number;
  } | null;
}

// A stored instant as an ISO-8601 string.
function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

export function createGetContextTool(deps: GetContextDeps): {
  handle(
    connection: AgentConnection,
    input?: unknown,
  ): Promise<AgentContextView>;
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
    async handle(
      connection: AgentConnection,
      input: unknown = {},
    ): Promise<AgentContextView> {
      const pageInput = parseParams(getContextSchema, input);
      const { userId, agentId } = connection;
      const context = await loadAgentContext(connection, {
        db,
        keyWrapper,
        clock,
      });
      const { permissions } = context;
      const dek = await dataKeyFor(userId);

      const profile = permissions.identityAccess
        ? (await listIdentityFields(db, userId, dek))
            .filter((field) => vaultFieldAllowed(permissions, field.id))
            .map((field) => ({
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
      const skillPage = await pageSkillsForAgent(db, userId, agentId, dek, {
        cursor: pageInput.skill_cursor,
        limit: pageInput.limit,
      });
      const skills = [...buildSkillIndex([], agentId), ...skillPage.items];
      const memoryPage = permissions.memoryRead
        ? await pageMemories(db, userId, dek, {
            agentId,
            cursor: pageInput.memory_cursor,
            limit: pageInput.limit,
          })
        : { items: [], nextCursor: null };

      // Who saved each memory and task (write provenance): the person, this agent, or another
      // agent by name — so a note another agent copied from content isn't read as the person's.
      const savedBy = permissions.memoryRead || permissions.tasksAccess ? await savedByResolver(db, userId, agentId) : () => ({ kind: "person" as const });
      const memory = permissions.memoryRead
        ? memoryPage.items.map((m) => ({
            id: m.id,
            content: m.content,
            shared: m.scope === "shared",
            savedAt: iso(m.createdAt),
            savedBy: savedBy(m.sourceAgentId),
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
              assignedTo:
                task.assignee === agentId
                  ? ("you" as const)
                  : ("any agent" as const),
              savedBy: savedBy(task.createdBy.kind === "agent" ? task.createdBy.agentId : null),
            }))
        : [];

      // The conversation's run: the one this call named (already checked to be this agent's
      // by the MCP layer), else a new one — except while paging, which continues a
      // conversation that already has a run and must not start a stray one.
      const observed = requestObservation.getStore();
      let run: RunRef | undefined = observed?.run;
      if (!run && pageInput.memory_cursor === undefined && pageInput.skill_cursor === undefined) {
        // A run is bookkeeping, not permission: if one can't be started the context is still
        // returned (without a run), and the failure is logged without any content.
        try {
          const matches = releasedValueMatcher(dek, await lookupForUser(db, userId, clock));
          run = await startRun(db, connection, { label: pageInput.working_on, via: observed?.via }, dek, clock, matches);
          if (observed) observed.run = run;
        } catch {
          console.error("[warthog mcp] a conversation run could not be started");
        }
      }

      const agent = await getAgentById(db, connection.userId, connection.agentId);
      const accounts = await listConnectionsForUser(db, connection.userId);
      return {
        connection: { agentId: connection.agentId, name: agent?.displayName ?? "This connection", platform: agent?.platform ?? "other", identitySource: "Warthog credential; display name and platform are owner supplied, not verification of the chat user or model." },
        run: run ? { id: run.id, workingOn: run.label ?? null, note: RUN_NOTE } : null,
        instructions: HOUSE_SKILL_BODY,
        serviceAccounts: permissions.grantedConnectors.map(service => {
          const selected = selectConnectorAccount(accounts, service, permissions.connectorAccounts?.[service]);
          return { service, accountId: selected?.id ?? null, label: selected?.accountLabel ?? null, status: selected?.status ?? "selection_required" };
        }),
        profile,
        next: { memory: memoryPage.nextCursor, skills: skillPage.nextCursor },
        preferences,
        skills,
        rules: context.rules.map((rule) => ruleSentence(rule)),
        memory,
        tasks,
        permissions: {
          services: permissions.grantedConnectors,
          resources: { tasks: { read: permissions.tasksAccess, write: permissions.tasksAccess && permissions.resourceControls?.tasksWrite !== false }, records: { read: permissions.recordsAccess, write: permissions.recordsAccess && permissions.resourceControls?.recordsWrite !== false, scope: permissions.resourceControls?.recordIds == null ? "all" : "chosen_and_created_by_this_agent" } },
          servicePolicies: permissions.connectorPolicies ?? {},
          vaultScope: permissions.identityFields == null ? "all" : "chosen",
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
