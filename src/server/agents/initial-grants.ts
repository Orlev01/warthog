import {
  permissionTemplate,
  type PermissionTemplate,
} from "../../domain/permissions/templates";
import type { PermissionGrants, CardBudget } from "../db/agent-permissions";

/** Shared mapping for OAuth consent and access-key onboarding. */
export function initialGrants(
  userId: string,
  connectionId: string,
  input: {
    template: PermissionTemplate;
    tickedServices?: readonly string[];
    identity?: boolean;
    highTier?: boolean;
    memoryRead?: boolean;
    tasks?: boolean;
    records?: boolean;
    card?: boolean;
    cardBudget?: CardBudget | null;
    learningSharing?: boolean;
  },
  explicitServices?: string[],
): PermissionGrants {
  const set = permissionTemplate(input.template, input.tickedServices ?? []);
  const services = explicitServices ?? set.services.map((s) => s.service);
  const cardAccess = input.card === true;
  return {
    userId,
    connectionId,
    grantedConnectors: services,
    readTools: services.length > 0,
    changeTools: services.length > 0 ? "ask_first" : "off",
    identityAccess: input.identity ?? set.lowTierProfile,
    highTierAccess: input.highTier === true,
    cardAccess,
    cardBudget: cardAccess ? (input.cardBudget ?? null) : null,
    skillsScope: [],
    memoryRead: input.memoryRead ?? set.sharedMemoryRead,
    memoryWrite: set.ownMemorySave,
    sharing: input.learningSharing === true,
    rulesScope: [],
    rateLimit: 120,
    tasksAccess: input.tasks ?? set.tasks,
    recordsAccess: input.records ?? set.lifeAdmin,
  };
}
