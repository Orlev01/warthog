import {
  permissionTemplate,
  type PermissionTemplate,
} from "../../domain/permissions/templates";
import type { PermissionGrants, CardBudget } from "../db/agent-permissions";
import { listConnectionsForUser } from "../db/connections";
import type { Db } from "../db/index";

// An account the person ticked on the consent or access-key screen, already checked to be one
// of their own connected accounts.
export interface TickedAccount {
  readonly id: string;
  readonly connectorId: string;
}

// The ticked account ids that are `userId`'s own connected accounts, each with its service
// (member-scoped; the user id is the session's). Ids that aren't theirs are dropped.
export async function tickedOwnAccounts(db: Db, userId: string, ids: readonly string[]): Promise<TickedAccount[]> {
  const own = new Map((await listConnectionsForUser(db, userId)).map((c) => [c.id, c.connectorId]));
  return [...new Set(ids)].flatMap((id) => {
    const connectorId = own.get(id);
    return connectorId ? [{ id, connectorId }] : [];
  });
}

/**
 * Shared mapping for OAuth consent and access-key onboarding. The person ticks accounts, not
 * services (docs/adr/several-accounts-per-agent.md); the template decides whether services are
 * granted at all, and each ticked account of a granted service is given to the agent with the
 * agent's own settings.
 */
export function initialGrants(
  userId: string,
  connectionId: string,
  input: {
    template: PermissionTemplate;
    tickedAccounts?: readonly TickedAccount[];
    identity?: boolean;
    highTier?: boolean;
    memoryRead?: boolean;
    memoryWrite?: boolean;
    tasks?: boolean;
    records?: boolean;
    card?: boolean;
    cardBudget?: CardBudget | null;
    learningSharing?: boolean;
  },
): PermissionGrants {
  const ticked = input.tickedAccounts ?? [];
  const set = permissionTemplate(input.template, [...new Set(ticked.map((account) => account.connectorId))]);
  const services = new Set(set.services.map((s) => s.service));
  const accounts = ticked.filter((account, index) => services.has(account.connectorId) && ticked.findIndex((a) => a.id === account.id) === index);
  const cardAccess = input.card === true;
  return {
    userId,
    connectionId,
    accounts: accounts.map((account) => ({ accountId: account.id })),
    readTools: accounts.length > 0,
    changeTools: accounts.length > 0 ? "ask_first" : "off",
    identityAccess: input.identity ?? set.lowTierProfile,
    highTierAccess: input.highTier === true,
    cardAccess,
    cardBudget: cardAccess ? (input.cardBudget ?? null) : null,
    skillsScope: [],
    memoryRead: input.memoryRead ?? set.sharedMemoryRead,
    memoryWrite: input.memoryWrite ?? set.ownMemorySave,
    sharing: input.learningSharing === true,
    rulesScope: [],
    rateLimit: 120,
    tasksAccess: input.tasks ?? set.tasks,
    recordsAccess: input.records ?? set.lifeAdmin,
  };
}
