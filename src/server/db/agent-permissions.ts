// The agent-permission-grants aggregate's data access (design §7 connector engine,
// §8 policy step 2, brief "Per-agent permissions page"). One connection's grants
// live in exactly one place here (constitution: one-source-of-truth): the consent
// screen and the per-agent permissions page read and write them, and the policy
// pipeline (§8 step 2) reads them on every agent call.
//
// A connection's grants are PLAINTEXT METADATA (design §4.1: connector ids,
// tool-class settings, booleans, the budget amount+currency+period, the request
// limit) — needed for the per-call permission check and for filtering — so, unlike
// held-request args or approval detail, they are NOT DEK-encrypted and this module
// holds no key and reads no `process.env` (config flows from `src/server/config.ts`
// alone, INV-103).
//
// Every statement is parameterized through the `Db` seam (INV-102): the user id,
// connection id and every grant value travel as BOUND values, never concatenated
// into the SQL text, so a value shaped like SQL is stored as data and cannot alter
// the query. Every read and write is member-scoped by the `userId` the caller
// passes — the session's id, never a client value — so one person can never read or
// change another's connection permissions by its connection id.

import type { AccountGrant } from "../../domain/permissions/account-access";
import { withTransaction, type Db, type Row } from "./index";

export type { AccountGrant };

// An account to grant, as a writer states it. The account's service is read from the
// person's own connections, never taken from the caller.
export type AccountGrantInput = Omit<AccountGrant, "connectorId">;

// The brief's budget periods and the change-making tool-class setting.
export type PeriodKind = "day" | "week" | "month";
export type ChangeTools = "off" | "allow" | "ask_first";

// An agent's card spending budget. `amount` is in major units, carried as a NUMBER
// (200 == A$200).
export interface CardBudget {
  readonly amount: number;
  readonly currency: string;
  readonly period: PeriodKind;
}

// What one connection's grants are: who they belong to, which connected accounts the
// agent may use (docs/adr/several-accounts-per-agent.md), its tool-class settings,
// identity / high-tier / card access (with its budget), skills scope, memory-read and
// sharing flags, its rules and its per-minute request limit.
export interface PermissionGrants {
  readonly identityFields?: string[] | null;
  // skillsWrite: whether it may save skills and suggest changes (docs/adr/agent-saved-skills.md); absent ⇒ yes.
  readonly resourceControls?: { tasksWrite?: boolean; recordsWrite?: boolean; skillsWrite?: boolean; recordIds?: string[] | null };
  readonly userId: string;
  readonly connectionId: string;
  // The accounts this agent may use, each with its own settings. Optional on WRITE: left
  // out, the stored accounts stay as they are; stated, they replace the stored ones.
  // Accounts that aren't the person's own are never granted.
  readonly accounts?: readonly AccountGrantInput[];
  // The agent-wide tool-class settings an account without its own follows.
  readonly readTools: boolean;
  readonly changeTools: ChangeTools;
  readonly identityAccess: boolean;
  readonly highTierAccess: boolean;
  readonly cardAccess: boolean;
  readonly cardBudget: CardBudget | null;
  readonly skillsScope: string[];
  readonly memoryRead: boolean;
  readonly memoryWrite?: boolean;
  readonly sharing: boolean;
  readonly rulesScope: string[];
  readonly rateLimit: number;
  // Review fix A2 — whether the agent may use the person's tasks and life-admin records.
  // Their own grants, not the connector tool classes above. Optional on WRITE so a caller
  // that only edits other grants never changes them by accident: an insert that leaves
  // them out derives them from the tool classes (the old gate), an update keeps the
  // stored value. Always present on READ.
  readonly tasksAccess?: boolean;
  readonly recordsAccess?: boolean;
}

// Read back in the same shape they were written, with the tasks and records grants
// always resolved, every granted account with its service, and the services those
// accounts belong to (a service is granted when at least one of its accounts is).
export type ConnectionPermissions = Omit<PermissionGrants, "accounts"> & {
  readonly tasksAccess: boolean;
  readonly memoryWrite?: boolean;
  readonly recordsAccess: boolean;
  readonly accounts: readonly AccountGrant[];
  readonly grantedConnectors: readonly string[];
};

// The columns every read returns, kept in one place so the lookup hands back the
// same shape. The collection and structured fields are jsonb (round-tripped
// structurally); the rest are scalar metadata columns. The granted accounts come from
// agent_account_grants in the same statement, each with its service from the person's
// own connection row.
const COLUMNS =
  "user_id, connection_id, read_tools, change_tools, " +
  "identity_access, high_tier_access, card_access, card_budget, skills_scope, " +
  "memory_read, sharing, rules_scope, rate_limit, tasks_access, records_access, memory_write, identity_fields, resource_controls, " +
  `(SELECT COALESCE(jsonb_agg(jsonb_build_object('accountId', g.account_id, 'connectorId', c.connector_id,
       'readTools', g.read_tools, 'changeTools', g.change_tools, 'allowedTools', g.allowed_tools)
       ORDER BY c.connector_id, g.account_id), '[]'::jsonb)
     FROM agent_account_grants g JOIN connections c ON c.user_id = g.user_id AND c.id = g.account_id
    WHERE g.user_id = agent_permissions.user_id AND g.agent_connection_id = agent_permissions.connection_id) AS accounts`;

// A stored grant with its unset settings left out, so "the same as this agent" reads as absent.
function toAccountGrant(raw: Record<string, unknown>): AccountGrant {
  return {
    accountId: String(raw.accountId),
    connectorId: String(raw.connectorId),
    ...(typeof raw.readTools === "boolean" ? { readTools: raw.readTools } : {}),
    ...(raw.changeTools === "off" || raw.changeTools === "allow" || raw.changeTools === "ask_first" ? { changeTools: raw.changeTools } : {}),
    ...(Array.isArray(raw.allowedTools) ? { allowedTools: raw.allowedTools.map(String) } : {}),
  };
}

// The services an agent's accounts belong to, each once, in a stable order.
export function servicesOf(accounts: readonly AccountGrant[]): string[] {
  return [...new Set(accounts.map((account) => account.connectorId))].sort();
}

// Map a raw row to the grants shape, translating the snake_case columns to the
// module's camelCase fields. jsonb comes back already parsed (so the connector /
// skill / rule lists are arrays and the card budget is an object or null); the
// scalar columns come back as their JS types (boolean, number).
function toPermissions(row: Row): ConnectionPermissions {
  const accounts = ((row.accounts ?? []) as Record<string, unknown>[]).map(toAccountGrant);
  return {
    userId: row.user_id as string,
    connectionId: row.connection_id as string,
    accounts,
    grantedConnectors: servicesOf(accounts),
    identityFields: (row.identity_fields ?? null) as string[] | null,
    resourceControls: (row.resource_controls ?? {}) as NonNullable<PermissionGrants["resourceControls"]>,
    readTools: row.read_tools as boolean,
    changeTools: row.change_tools as ChangeTools,
    identityAccess: row.identity_access as boolean,
    highTierAccess: row.high_tier_access as boolean,
    cardAccess: row.card_access as boolean,
    cardBudget: (row.card_budget as CardBudget | null) ?? null,
    skillsScope: row.skills_scope as string[],
    memoryRead: row.memory_read as boolean,
    memoryWrite: (row.memory_write ?? row.memory_read) as boolean,
    sharing: row.sharing as boolean,
    rulesScope: row.rules_scope as string[],
    rateLimit: Number(row.rate_limit),
    tasksAccess: row.tasks_access as boolean,
    recordsAccess: row.records_access as boolean,
  };
}

// The grants for this connection OWNED BY `userId` (member-scoped: user_id AND
// connection_id both bound as parameters); null when none for this user — so
// another user's connection id returns null (they cannot read it).
export async function getConnectionPermissions(
  db: Db,
  userId: string,
  connectionId: string,
  options: { lock?: boolean } = {},
): Promise<ConnectionPermissions | null> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM agent_permissions WHERE user_id = $1 AND connection_id = $2${options.lock ? " FOR UPDATE" : ""}`,
    [userId, connectionId],
  );
  const row = result.rows[0];
  return row ? toPermissions(row) : null;
}

// Write the grants for (grants.userId, grants.connectionId), INSERTing a fresh
// record or UPDATEing the one already there — keyed on the (user, connection) pair,
// so a second upsert overwrites in place and never duplicates. Member-scoped: the
// user id is bound, so an upsert on another person's connection id writes the
// caller's OWN row and leaves the other person's grants untouched.
//
// The tasks and records grants are written only when stated (review fix A2): an insert
// that leaves one out derives it from the tool classes — read tools on, or change tools
// not off, the gate those tools used before — and an update that leaves one out keeps
// the stored value. The granted accounts work the same way: stated, they replace the
// stored ones in the same transaction; left out, they stay.
//
// REFUSES (throws, never silently) when card access is on but no budget is set —
// the check runs BEFORE any query, so a refused upsert writes no row (never a
// silent half-write). Returns the stored grants.
export async function upsertPermissions(
  db: Db,
  grants: PermissionGrants,
): Promise<ConnectionPermissions> {
  if (grants.cardAccess && grants.cardBudget === null) {
    throw new Error("upsertPermissions: card access cannot be enabled without a budget");
  }
  const write = async (tx: Db): Promise<ConnectionPermissions> => {
    const accounts = grants.accounts === undefined ? undefined : await ownAccounts(tx, grants.userId, grants.accounts);
    // Until the old columns are dropped, they keep a copy an earlier release can read: a
    // service with one granted account is set to it; a service with several is left
    // without one, which that release refuses rather than guess (it only ever narrows).
    const legacy = accounts === undefined ? undefined : legacyCopy(accounts);
    await tx.query(
      `INSERT INTO agent_permissions (
         user_id, connection_id, granted_connectors, read_tools, change_tools,
         identity_access, high_tier_access, card_access, card_budget,
         skills_scope, memory_read, sharing, rules_scope, rate_limit,
         tasks_access, records_access, memory_write, connector_accounts, identity_fields, connector_policies, resource_controls
       ) VALUES (
         $1, $2, COALESCE($3::jsonb, '[]'::jsonb), $4, $5,
         $6, $7, $8, $9::jsonb,
         $10::jsonb, $11, $12, $13::jsonb, $14,
         COALESCE($15::boolean, $4 OR $5 <> 'off'),
         COALESCE($16::boolean, $4 OR $5 <> 'off'),
         COALESCE($17::boolean, $11),
         COALESCE($18::jsonb, '{}'::jsonb), $19::jsonb, COALESCE($20::jsonb, '{}'::jsonb), COALESCE($21::jsonb, '{}'::jsonb)
       )
       ON CONFLICT (user_id, connection_id) DO UPDATE SET
         granted_connectors = COALESCE($3::jsonb, agent_permissions.granted_connectors),
         read_tools         = EXCLUDED.read_tools,
         change_tools       = EXCLUDED.change_tools,
         identity_access    = EXCLUDED.identity_access,
         high_tier_access   = EXCLUDED.high_tier_access,
         card_access        = EXCLUDED.card_access,
         card_budget        = EXCLUDED.card_budget,
         skills_scope       = EXCLUDED.skills_scope,
         memory_read        = EXCLUDED.memory_read,
         sharing            = EXCLUDED.sharing,
         rules_scope        = EXCLUDED.rules_scope,
         rate_limit         = EXCLUDED.rate_limit,
         tasks_access       = COALESCE($15::boolean, agent_permissions.tasks_access),
         records_access     = COALESCE($16::boolean, agent_permissions.records_access),
         memory_write       = COALESCE($17::boolean, agent_permissions.memory_write),
         connector_accounts = COALESCE($18::jsonb, agent_permissions.connector_accounts),
         identity_fields = COALESCE($19::jsonb, agent_permissions.identity_fields),
         resource_controls = COALESCE($21::jsonb, agent_permissions.resource_controls),
         connector_policies = COALESCE($20::jsonb, agent_permissions.connector_policies)`,
      [
        grants.userId,
        grants.connectionId,
        legacy === undefined ? null : JSON.stringify(legacy.services),
        grants.readTools,
        grants.changeTools,
        grants.identityAccess,
        grants.highTierAccess,
        grants.cardAccess,
        grants.cardBudget === null ? null : JSON.stringify(grants.cardBudget),
        JSON.stringify(grants.skillsScope),
        grants.memoryRead,
        grants.sharing,
        JSON.stringify(grants.rulesScope),
        grants.rateLimit,
        grants.tasksAccess ?? null,
        grants.recordsAccess ?? null,
        grants.memoryWrite ?? null,
        legacy === undefined ? null : JSON.stringify(legacy.chosen),
        grants.identityFields === undefined ? null : JSON.stringify(grants.identityFields),
        legacy === undefined ? null : JSON.stringify(legacy.policies),
        grants.resourceControls === undefined ? null : JSON.stringify(grants.resourceControls),
      ],
    );
    if (accounts !== undefined) await replaceAccountGrants(tx, grants.userId, grants.connectionId, accounts);
    const stored = await getConnectionPermissions(tx, grants.userId, grants.connectionId);
    if (!stored) throw new Error("upsertPermissions: the grants were not stored");
    return stored;
  };
  return db.inTransaction ? write(db) : withTransaction(db, write);
}

// The stated accounts that are the person's own, with each one's service from its
// connection row (member-scoped; an id that isn't theirs is dropped, never granted).
async function ownAccounts(db: Db, userId: string, accounts: readonly AccountGrantInput[]): Promise<AccountGrant[]> {
  const ids = [...new Set(accounts.map((account) => account.accountId))].filter((id) => UUID.test(id));
  if (ids.length === 0) return [];
  const found = await db.query("SELECT id, connector_id FROM connections WHERE user_id = $1 AND id = ANY($2::uuid[])", [userId, ids]);
  const service = new Map(found.rows.map((row) => [String(row.id), String(row.connector_id)]));
  const out: AccountGrant[] = [];
  for (const account of accounts) {
    const connectorId = service.get(account.accountId);
    if (!connectorId || out.some((kept) => kept.accountId === account.accountId)) continue;
    out.push(toAccountGrant({ ...account, connectorId }));
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The copy of the granted accounts in the old service-keyed columns.
function legacyCopy(accounts: readonly AccountGrant[]): { services: string[]; chosen: Record<string, string>; policies: Record<string, object> } {
  const services = servicesOf(accounts);
  const chosen: Record<string, string> = {};
  const policies: Record<string, object> = {};
  for (const service of services) {
    const of = accounts.filter((account) => account.connectorId === service);
    if (of.length !== 1) continue;
    const { accountId, connectorId: _service, ...settings } = of[0]!;
    chosen[service] = accountId;
    if (Object.keys(settings).length > 0) policies[service] = settings;
  }
  return { services, chosen, policies };
}

// Make the agent's granted accounts exactly `accounts`: grants not listed are removed, the
// listed ones are added or have their settings replaced. Member-scoped on both keys.
async function replaceAccountGrants(db: Db, userId: string, agentConnectionId: string, accounts: readonly AccountGrant[]): Promise<void> {
  await db.query(
    "DELETE FROM agent_account_grants WHERE user_id = $1 AND agent_connection_id = $2 AND NOT (account_id = ANY($3::uuid[]))",
    [userId, agentConnectionId, accounts.map((account) => account.accountId)],
  );
  if (accounts.length === 0) return;
  await db.query(
    `INSERT INTO agent_account_grants (user_id, agent_connection_id, account_id, read_tools, change_tools, allowed_tools)
     SELECT $1, $2, x.account_id, x.read_tools, x.change_tools, x.allowed_tools
       FROM jsonb_to_recordset($3::jsonb) AS x(account_id uuid, read_tools boolean, change_tools text, allowed_tools jsonb)
     ON CONFLICT (user_id, agent_connection_id, account_id) DO UPDATE SET
       read_tools = EXCLUDED.read_tools, change_tools = EXCLUDED.change_tools, allowed_tools = EXCLUDED.allowed_tools`,
    [userId, agentConnectionId, JSON.stringify(accounts.map((account) => ({
      account_id: account.accountId,
      ...(account.readTools !== undefined ? { read_tools: account.readTools } : {}),
      ...(account.changeTools !== undefined ? { change_tools: account.changeTools } : {}),
      ...(account.allowedTools ? { allowed_tools: account.allowedTools } : {}),
    })))],
  );
}

// The agents that may use one account, for the Connectors page's "Used by". Member-scoped.
export async function agentsUsingAccount(db: Db, userId: string): Promise<Map<string, string[]>> {
  const result = await db.query(
    "SELECT account_id, agent_connection_id FROM agent_account_grants WHERE user_id = $1 ORDER BY account_id, agent_connection_id",
    [userId],
  );
  const byAccount = new Map<string, string[]>();
  for (const row of result.rows) {
    const list = byAccount.get(String(row.account_id)) ?? [];
    list.push(String(row.agent_connection_id));
    byAccount.set(String(row.account_id), list);
  }
  return byAccount;
}

// Bring the old service columns' copy back in line with the person's account grants, for every
// one of their agents. Disconnecting an account removes its grants by cascade without touching
// that copy, and an earlier release reading a stale copy could give an agent the service's
// remaining account (a service listed with no account chosen and one account left). Callers run
// it in the same transaction as the delete. Member-scoped.
export async function refreshServiceCopy(db: Db, userId: string): Promise<void> {
  const agents = await db.query("SELECT connection_id FROM agent_permissions WHERE user_id = $1", [userId]);
  for (const row of agents.rows) {
    const stored = await getConnectionPermissions(db, userId, String(row.connection_id));
    if (!stored) continue;
    const legacy = legacyCopy(stored.accounts);
    await db.query(
      `UPDATE agent_permissions SET granted_connectors = $3::jsonb, connector_accounts = $4::jsonb, connector_policies = $5::jsonb
        WHERE user_id = $1 AND connection_id = $2`,
      [userId, stored.connectionId, JSON.stringify(legacy.services), JSON.stringify(legacy.chosen), JSON.stringify(legacy.policies)],
    );
  }
}
