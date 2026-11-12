// The rules aggregate's data access (design §8 policy engine, brief "Rules and
// approvals"). A rule is a plain-language `ask_first` or `never_allow` instruction,
// scoped to all agents or a chosen agent, over one of the brief's actions, with an
// optional condition. The policy engine (§8 steps 3 & 6) reads the rules APPLICABLE
// to a connection and action on every agent call; the rules screen manages them.
//
// The rule model is the EXISTING pure domain one (`../../domain/rules/rules`),
// reused here (constitution: one-source-of-truth) — this store persists it and
// reads it back.
//
// The kind, scope and action are PLAINTEXT METADATA (design §4.1) — needed to
// filter the applicable set — so, like a connection's grants, they are NOT
// encrypted. The `condition` carries PERSONAL CONTENT (a recipient address, a
// merchant list), so it is stored only DEK-ENCRYPTED (`../crypto/envelope`): the id
// is generated up front so the envelope's associated data can bind the ciphertext
// to its exact (table, column, row) — the plaintext never lands in a column.
//
// Every statement is parameterized through the `Db` seam (INV-102): the ids and
// every value travel as BOUND values, never concatenated into the SQL text, so a
// value shaped like SQL is stored as data and cannot alter the query. Every read
// and write is member-scoped by the `userId` the caller passes — the session's id,
// never a client value — so one person can never read or change another's rules by
// id. The DEK is injected (this module reads no `process.env` and holds no key,
// INV-103).

import { randomUUID } from "node:crypto";

import type {
  RuleAction,
  RuleCondition,
  RuleKind,
  RuleScope,
} from "../../domain/rules/rules";
import { decrypt, encrypt } from "../crypto/envelope";
import type { Db, Row } from "./index";

// The envelope's associated data binds each `condition` ciphertext to its exact
// location, so a row lifted into another row/column/table fails to decrypt.
const TABLE = "rules";
const CONDITION_COLUMN = "condition";

// The columns every read returns, kept in one place so the lookups hand back the
// same shape. `action` comes back as a parsed object (jsonb); `condition` comes
// back as ciphertext and is decrypted separately before it reaches a caller.
const COLUMNS =
  "id, user_id, kind, scope_type, scope_agent_id, scope_agent_name, action, condition, status";

// A rule is either active (enforced, in the applicable set) or paused (persisted
// but excluded) — the two lifecycle values the store knows.
export type RuleStatus = "active" | "paused";

// What createRule writes: the person (the session's id, never a client value) and
// the rule's content. The condition is optional and stored DEK-encrypted when
// present.
export interface NewRule {
  readonly userId: string;
  readonly kind: RuleKind;
  readonly scope: RuleScope;
  readonly action: RuleAction;
  readonly condition?: RuleCondition;
}

// The new content updateRule applies — a full replace of the rule's content. No
// userId: the user is the member scope, bound separately.
export interface RuleEdits {
  readonly kind: RuleKind;
  readonly scope: RuleScope;
  readonly action: RuleAction;
  readonly condition?: RuleCondition;
}

// A rule as handed back to callers: its generated id and lifecycle status on top of
// its content, with the condition DECRYPTED under the injected DEK.
export interface StoredRule extends NewRule {
  readonly id: string;
  readonly status: RuleStatus;
}

// The scope's filterable parts: the type, and for a chosen agent its id and name
// (both null for an all-agents rule).
interface ScopeColumns {
  readonly type: RuleScope["type"];
  readonly agentId: string | null;
  readonly name: string | null;
}

function decomposeScope(scope: RuleScope): ScopeColumns {
  if (scope.type === "agent") {
    return { type: "agent", agentId: scope.agentId, name: scope.name };
  }
  return { type: "any_agent", agentId: null, name: null };
}

function toScope(row: Row): RuleScope {
  if (row.scope_type === "agent") {
    return {
      type: "agent",
      agentId: row.scope_agent_id as string,
      name: row.scope_agent_name as string,
    };
  }
  return { type: "any_agent" };
}

// Map a raw row to a StoredRule, decrypting its condition (when present) under
// `dek`, bound to that row's id. Throws if the DEK is wrong or the ciphertext was
// tampered (the GCM tag fails to verify).
async function toStored(row: Row, dek: Uint8Array): Promise<StoredRule> {
  const id = row.id as string;
  const condition =
    row.condition != null
      ? (JSON.parse(
          await decrypt(dek, TABLE, CONDITION_COLUMN, id, row.condition as string),
        ) as RuleCondition)
      : undefined;
  return {
    id,
    userId: row.user_id as string,
    kind: row.kind as RuleKind,
    scope: toScope(row),
    action: row.action as RuleAction,
    status: row.status as RuleStatus,
    condition,
  };
}

// Encrypt a condition into a `v1:` envelope bound to `id`, or null when there is
// no condition.
async function encryptCondition(
  dek: Uint8Array,
  id: string,
  condition: RuleCondition | undefined,
): Promise<string | null> {
  if (condition === undefined) return null;
  return encrypt(dek, TABLE, CONDITION_COLUMN, id, JSON.stringify(condition));
}

// Create an ACTIVE rule for `input.userId`, its condition DEK-encrypted when
// present. The id is generated up front so the condition's envelope can bind to it.
// Returns the StoredRule carrying the generated id (with the plaintext condition).
export async function createRule(
  db: Db,
  input: NewRule,
  dek: Uint8Array,
): Promise<StoredRule> {
  const id = randomUUID();
  const scope = decomposeScope(input.scope);
  const condition = await encryptCondition(dek, id, input.condition);

  await db.query(
    `INSERT INTO rules
       (id, user_id, kind, scope_type, scope_agent_id, scope_agent_name, action, condition, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'active')`,
    [
      id,
      input.userId,
      input.kind,
      scope.type,
      scope.agentId,
      scope.name,
      JSON.stringify(input.action),
      condition,
    ],
  );

  return {
    id,
    userId: input.userId,
    kind: input.kind,
    scope: input.scope,
    action: input.action,
    status: "active",
    condition: input.condition,
  };
}

// Replace an owned rule's content in place (same id), the condition re-encrypted.
// Member-scoped: the id AND user_id are both bound, so a rule that does not belong
// to `userId` matches no row. THROWS (never silently) when there is no such rule
// for this user. Returns the updated StoredRule.
export async function updateRule(
  db: Db,
  userId: string,
  id: string,
  edits: RuleEdits,
  dek: Uint8Array,
): Promise<StoredRule> {
  const scope = decomposeScope(edits.scope);
  const condition = await encryptCondition(dek, id, edits.condition);

  const result = await db.query(
    `UPDATE rules
        SET kind = $1, scope_type = $2, scope_agent_id = $3, scope_agent_name = $4,
            action = $5::jsonb, condition = $6
      WHERE id = $7 AND user_id = $8
      RETURNING status`,
    [
      edits.kind,
      scope.type,
      scope.agentId,
      scope.name,
      JSON.stringify(edits.action),
      condition,
      id,
      userId,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`updateRule: no rule ${id} for this user`);
  }

  return {
    id,
    userId,
    kind: edits.kind,
    scope: edits.scope,
    action: edits.action,
    status: row.status as RuleStatus,
    condition: edits.condition,
  };
}

// Mark an owned rule paused (it persists, it is not deleted). Member-scoped: the id
// AND user_id are both bound. THROWS when there is no such rule for this user.
export async function pauseRule(db: Db, userId: string, id: string): Promise<void> {
  const result = await db.query(
    `UPDATE rules SET status = 'paused' WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId],
  );
  if (!result.rows[0]) {
    throw new Error(`pauseRule: no rule ${id} for this user`);
  }
}

// Delete an owned rule. Member-scoped: the id AND user_id are both bound. Returns
// true when a row was removed, false when there was none for this user (so another
// user's delete is a no-op). RETURNING tells removal from no-op through the seam.
export async function deleteRule(db: Db, userId: string, id: string): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM rules WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId],
  );
  return result.rows.length > 0;
}

// The user's ACTIVE rules (member-scoped: user_id bound), conditions decrypted
// under `dek`.
export async function listRules(
  db: Db,
  userId: string,
  dek: Uint8Array,
): Promise<StoredRule[]> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM rules WHERE user_id = $1 AND status = 'active'`,
    [userId],
  );
  return Promise.all(result.rows.map((row) => toStored(row, dek)));
}

// The order every full list is read back in, so the Rules page and exports never shuffle
// between reads: rules for all agents first, then a chosen agent's by its stored name (and
// id, for two agents sharing a name), active before paused, ask-first before never-allow,
// and the rule id as the final tie-break. The table has no creation time to sort on.
const LIST_ORDER =
  "ORDER BY (scope_type = 'agent'), scope_agent_name, scope_agent_id, status, kind, id";

// The user's rules — ACTIVE and PAUSED (member-scoped: user_id bound), conditions
// decrypted under `dek`, in LIST_ORDER. DISTINCT from listRules/applicableRules
// (active-only, for enforcement): the Rules PAGE must also show paused rules so the
// person can see them. Never returns another person's rules.
export async function listAllRules(
  db: Db,
  userId: string,
  dek: Uint8Array,
): Promise<StoredRule[]> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM rules WHERE user_id = $1 ${LIST_ORDER}`,
    [userId],
  );
  return Promise.all(result.rows.map((row) => toStored(row, dek)));
}

// The user's ACTIVE rules (member-scoped: user_id bound) whose scope covers
// `connectionId` (an all-agents rule OR one scoped to that chosen agent) AND whose
// action matches `action` (canonical jsonb equality), conditions decrypted under
// `dek`. Returns BOTH kinds (never_allow + ask_first) — the policy engine
// partitions them. A paused rule is excluded (status = 'active').
export async function applicableRules(
  db: Db,
  userId: string,
  connectionId: string,
  action: RuleAction,
  dek: Uint8Array,
): Promise<StoredRule[]> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM rules
      WHERE user_id = $1
        AND status = 'active'
        AND (scope_type = 'any_agent' OR scope_agent_id = $2)
        AND action = $3::jsonb`,
    [userId, connectionId, JSON.stringify(action)],
  );
  return Promise.all(result.rows.map((row) => toStored(row, dek)));
}
