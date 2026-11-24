// Home's "Build your profile" block (docs/adr/profile-build.md): which of the person's agents can
// build it (reads email, calendar or files through Warthog's own connectors, and saves to Life
// admin), and what waits for the person to check. Counts and names only: nothing is decrypted.
// Every read is member-scoped by the session's `userId`.

import { profileBuildView, type ProfileBuildAgent, type ProfileBuildView } from "../../domain/home/profile-build";
import { readableSourceNames } from "../../domain/life-admin/profile-sources";
import { accountPolicy } from "../../domain/permissions/account-access";
import { getConnectionPermissions } from "../db/agent-permissions";
import { listAgentsForUser } from "../db/agents";
import { listConnectionsForUser } from "../db/connections";
import { countIdentitySuggestions } from "../db/identity-suggestions";
import { countRecordReview } from "../db/life-admin-records";
import type { Db } from "../db/index";

const time = (value: Date | string | null): number => (value === null ? 0 : new Date(value).getTime());

export async function loadProfileBuild(db: Db, userId: string, done: boolean): Promise<ProfileBuildView | null> {
  if (done) return null;
  const connections = await listConnectionsForUser(db, userId);
  const connected = new Map(connections.map((account) => [account.id, account] as const));
  const agents = (await listAgentsForUser(db, userId))
    .filter((agent) => agent.status === "connected")
    .sort((a, b) => time(b.lastActiveAt) - time(a.lastActiveAt) || time(b.connectedAt) - time(a.connectedAt));
  const views: ProfileBuildAgent[] = [];
  for (const agent of agents) {
    const permissions = await getConnectionPermissions(db, userId, agent.connectionId);
    if (!permissions) continue;
    const sources = readableSourceNames(permissions.accounts.map((grant) => ({
      connectorId: grant.connectorId,
      connected: connected.get(grant.accountId)?.status === "connected",
      reads: accountPolicy(grant, permissions).readTools,
    })));
    views.push({ id: agent.id, name: agent.displayName, savesRecords: permissions.recordsAccess && permissions.resourceControls?.recordsWrite !== false, sources });
  }
  const records = await countRecordReview(db, userId);
  return profileBuildView({ done, agents: views, waitingRecords: records.waiting, waitingAboutYou: await countIdentitySuggestions(db, userId) });
}
