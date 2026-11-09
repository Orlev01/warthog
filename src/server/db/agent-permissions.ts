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

import type { Db, Row } from "./index";

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

// What one connection's grants are: who they belong to, which connected services
// the agent may use, its tool-class settings, identity / high-tier / card access
// (with its budget), skills scope, memory-read and sharing flags, its rules and its
// per-minute request limit.
export interface PermissionGrants {
  readonly userId: string;
  readonly connectionId: string;
  readonly grantedConnectors: string[];
  readonly readTools: boolean;
  readonly changeTools: ChangeTools;
  readonly identityAccess: boolean;
  readonly highTierAccess: boolean;
  readonly cardAccess: boolean;
  readonly cardBudget: CardBudget | null;
  readonly skillsScope: string[];
  readonly memoryRead: boolean;
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
// always resolved.
export type ConnectionPermissions = PermissionGrants & {
  readonly tasksAccess: boolean;
  readonly recordsAccess: boolean;
};

// The columns every read returns, kept in one place so the lookup hands back the
// same shape. The collection and structured fields are jsonb (round-tripped
// structurally); the rest are scalar metadata columns.
const COLUMNS =
  "user_id, connection_id, granted_connectors, read_tools, change_tools, " +
  "identity_access, high_tier_access, card_access, card_budget, skills_scope, " +
  "memory_read, sharing, rules_scope, rate_limit, tasks_access, records_access";

// Map a raw row to the grants shape, translating the snake_case columns to the
// module's camelCase fields. jsonb comes back already parsed (so the connector /
// skill / rule lists are arrays and the card budget is an object or null); the
// scalar columns come back as their JS types (boolean, number).
function toPermissions(row: Row): ConnectionPermissions {
  return {
    userId: row.user_id as string,
    connectionId: row.connection_id as string,
    grantedConnectors: row.granted_connectors as string[],
    readTools: row.read_tools as boolean,
    changeTools: row.change_tools as ChangeTools,
    identityAccess: row.identity_access as boolean,
    highTierAccess: row.high_tier_access as boolean,
    cardAccess: row.card_access as boolean,
    cardBudget: (row.card_budget as CardBudget | null) ?? null,
    skillsScope: row.skills_scope as string[],
    memoryRead: row.memory_read as boolean,
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
// the stored value.
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

  const result = await db.query(
    `INSERT INTO agent_permissions (
       user_id, connection_id, granted_connectors, read_tools, change_tools,
       identity_access, high_tier_access, card_access, card_budget,
       skills_scope, memory_read, sharing, rules_scope, rate_limit,
       tasks_access, records_access
     ) VALUES (
       $1, $2, $3::jsonb, $4, $5,
       $6, $7, $8, $9::jsonb,
       $10::jsonb, $11, $12, $13::jsonb, $14,
       COALESCE($15::boolean, $4 OR $5 <> 'off'),
       COALESCE($16::boolean, $4 OR $5 <> 'off')
     )
     ON CONFLICT (user_id, connection_id) DO UPDATE SET
       granted_connectors = EXCLUDED.granted_connectors,
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
       records_access     = COALESCE($16::boolean, agent_permissions.records_access)
     RETURNING tasks_access, records_access`,
    [
      grants.userId,
      grants.connectionId,
      JSON.stringify(grants.grantedConnectors),
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
    ],
  );
  const stored = result.rows[0];

  return {
    userId: grants.userId,
    connectionId: grants.connectionId,
    grantedConnectors: grants.grantedConnectors,
    readTools: grants.readTools,
    changeTools: grants.changeTools,
    identityAccess: grants.identityAccess,
    highTierAccess: grants.highTierAccess,
    cardAccess: grants.cardAccess,
    cardBudget: grants.cardBudget,
    skillsScope: grants.skillsScope,
    memoryRead: grants.memoryRead,
    sharing: grants.sharing,
    rulesScope: grants.rulesScope,
    rateLimit: grants.rateLimit,
    tasksAccess: stored?.tasks_access as boolean,
    recordsAccess: stored?.records_access as boolean,
  };
}
