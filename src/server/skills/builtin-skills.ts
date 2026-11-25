// Warthog's own skills for one person and agent (docs/adr/editable-builtin-skills.md): the
// person's settings over Warthog's registry, and the gates an agent passes. Member-scoped by
// the session's user id; the gates come from the connection's own permissions.
import { BUILTIN_SKILLS, effectiveBuiltin, type EffectiveBuiltin } from "../../domain/skills/builtins";
import type { AgentGates, SkillGate } from "../../domain/skills/gates";
import { readableSources, type SourceKind } from "../../domain/life-admin/profile-sources";
import { accountPolicy } from "../../domain/permissions/account-access";
import { listBuiltinSkillSettings } from "../db/builtin-skills";
import { listConnectionsForUser } from "../db/connections";
import type { ConnectionPermissions } from "../db/agent-permissions";
import type { Db } from "../db/index";

// Every Warthog skill as it stands for this person, in Warthog's order.
export async function builtinSkillsFor(db: Db, userId: string, dek: Uint8Array): Promise<EffectiveBuiltin[]> {
  const settings = await listBuiltinSkillSettings(db, userId, dek);
  return BUILTIN_SKILLS.map((def) => effectiveBuiltin(def, settings.get(def.key)));
}

// What this agent can read through Warthog's own mail, calendar and file connectors.
export async function readableSourcesFor(db: Db, userId: string, permissions: ConnectionPermissions): Promise<SourceKind[]> {
  const connected = new Set((await listConnectionsForUser(db, userId)).filter((account) => account.status === "connected").map((account) => account.id));
  return readableSources(permissions.accounts.map((grant) => ({
    connectorId: grant.connectorId,
    connected: connected.has(grant.accountId),
    reads: accountPolicy(grant, permissions).readTools,
  })));
}

// The gates an agent passes, from its permissions and what it can read.
export async function agentGatesFor(db: Db, userId: string, permissions: ConnectionPermissions): Promise<AgentGates> {
  const passes = new Set<SkillGate>();
  if (permissions.recordsAccess) passes.add("records_read");
  if (permissions.recordsAccess && permissions.resourceControls?.recordsWrite !== false) passes.add("records_write");
  if (permissions.tasksAccess) passes.add("tasks");
  if (permissions.cardAccess) passes.add("cards");
  if (permissions.identityAccess) passes.add("profile");
  if (permissions.highTierAccess) passes.add("high_tier");
  if (permissions.memoryRead) passes.add("memory");
  const sources = await readableSourcesFor(db, userId, permissions);
  if (sources.includes("mail")) passes.add("mail_read");
  if (sources.includes("calendar")) passes.add("calendar_read");
  return { passes };
}
