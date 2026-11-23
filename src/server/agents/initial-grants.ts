import {
  permissionTemplate,
  type PermissionTemplate,
} from "../../domain/permissions/templates";
import type { PermissionGrants, CardBudget } from "../db/agent-permissions";

/**
 * Shared mapping for OAuth consent and access-key onboarding. `defaultAccounts` is the
 * person's accounts that are on for new agents ({ service: account id },
 * docs/adr/default-services.md): each granted service that has one is set to that account.
 */
export function initialGrants(
  userId: string,
  connectionId: string,
  input: {
    template: PermissionTemplate;
    tickedServices?: readonly string[];
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
  explicitServices?: string[],
  defaultAccounts?: Readonly<Record<string, string>>,
): PermissionGrants {
  const set = permissionTemplate(input.template, input.tickedServices ?? []);
  const services = explicitServices ?? set.services.map((s) => s.service);
  const cardAccess = input.card === true;
  const pinned = services.flatMap((service) => {
    const account = defaultAccounts?.[service];
    return account ? [[service, account] as const] : [];
  });
  return {
    userId,
    connectionId,
    grantedConnectors: services,
    ...(pinned.length > 0 ? { connectorAccounts: Object.fromEntries(pinned) } : {}),
    readTools: services.length > 0,
    changeTools: services.length > 0 ? "ask_first" : "off",
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
