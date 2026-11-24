// A test fixture for grants written the older way, by service
// (docs/adr/several-accounts-per-agent.md). Agents are given accounts now; a test about
// something else (a policy, an approval, a result) usually only needs "this agent may use
// Gmail". `grantServices` turns that into account grants with the same rule migration 0122
// used: a service's chosen account, or its only account, with the service's settings. When
// the person has no account of a service yet, a stand-in account is connected for it, so the
// grant has something to point at. A service with several accounts and none chosen gives no
// access, as before.
import { randomBytes } from "node:crypto";

import { upsertPermissions, type AccountGrantInput, type ConnectionPermissions, type PermissionGrants } from "../server/db/agent-permissions";
import { createConnection } from "../server/db/connections";
import type { Db } from "../server/db/index";

type ServicePolicy = { readTools?: boolean; changeTools?: "off" | "allow" | "ask_first"; allowedTools?: string[] | null };

export type ServiceGrants = Omit<PermissionGrants, "accounts"> & {
  readonly accounts?: readonly AccountGrantInput[];
  readonly grantedConnectors?: readonly string[];
  readonly connectorAccounts?: Readonly<Record<string, string>>;
  readonly connectorPolicies?: Readonly<Record<string, ServicePolicy>>;
};

const clock = { now: () => new Date("2026-11-24T00:00:00Z") };

export async function grantServices(db: Db, grants: ServiceGrants): Promise<ConnectionPermissions> {
  const { grantedConnectors, connectorAccounts, connectorPolicies, accounts, ...rest } = grants;
  const byService = connectorAccounts !== undefined || connectorPolicies !== undefined || (grantedConnectors !== undefined && accounts === undefined);
  if (!byService || grantedConnectors === undefined) return upsertPermissions(db, { ...rest, ...(accounts ? { accounts } : {}) });
  const translated: AccountGrantInput[] = [];
  for (const service of grantedConnectors) {
    const own = await db.query(
      "SELECT id FROM connections WHERE user_id = $1 AND connector_id = $2 ORDER BY connected_at, id",
      [grants.userId, service],
    );
    const ids = own.rows.map((row) => String(row.id));
    let accountId = connectorAccounts?.[service] ?? (ids.length === 1 ? ids[0] : undefined);
    if (accountId === undefined && ids.length === 0) {
      accountId = (await createConnection(db, { userId: grants.userId, connectorId: service, accountLabel: `${service}@example.test`, credentials: { access_token: "test" } }, randomBytes(32), clock)).id;
    }
    if (accountId === undefined) continue;
    const policy = connectorPolicies?.[service] ?? {};
    translated.push({
      accountId,
      ...(policy.readTools !== undefined ? { readTools: policy.readTools } : {}),
      ...(policy.changeTools !== undefined ? { changeTools: policy.changeTools } : {}),
      ...(policy.allowedTools ? { allowedTools: policy.allowedTools } : {}),
    });
  }
  return upsertPermissions(db, { ...rest, accounts: translated });
}

// A test that grants a service before it connects the account: once the real account is
// connected, every agent on the stand-in account moves to it and the stand-in goes, as if the
// service had been connected first.
export async function adoptStandIn(db: Db, userId: string, connectorId: string, accountId: string): Promise<void> {
  const standIn = `${connectorId}@example.test`;
  await db.query(
    `UPDATE agent_account_grants g SET account_id = $3
       FROM connections c
      WHERE g.user_id = $1 AND c.user_id = $1 AND c.id = g.account_id AND c.connector_id = $2 AND c.account_label = $4`,
    [userId, connectorId, accountId, standIn],
  );
  await db.query("DELETE FROM connections WHERE user_id = $1 AND connector_id = $2 AND account_label = $3", [userId, connectorId, standIn]);
}
