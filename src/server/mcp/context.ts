// E07-S09 — Agent policy-context loader (design §6.1 pipeline, §8 policy engine).
//
// The agent-call pipeline (E07-S10) passes ONE context object to the PURE policy
// engine `evaluate(call, ctx)` (E03-S13). Assembling that object in one place —
// a connection's permission grants (E07-S05), the rules applicable to it
// (E07-S06) and its approved-release spend for the current budget period
// (E07-S07) — keeps the engine pure and testable.
//
// This is a SERVER module: it reads through the injected `Db` seam, resolves the
// person's data key through the injected `KeyWrapper` seam (to decrypt rule
// conditions, the totp-store idiom) and reads the current instant through the
// injected `Clock` seam (for the budget-period key). It reads no `process.env`
// and holds no secret (INV-103): all configuration flows in as injected seams.
//
// Every read is member-scoped by the connection's OWNING user id — never a value
// from the client (INV-102; project rule: every member-scoped read takes userId
// from the session/connection). Each underlying store binds its ids and values as
// parameters, so an id shaped like SQL travels as data and cannot alter a query.

import {
  getConnectionPermissions,
  type ConnectionPermissions,
  type PeriodKind,
} from "../db/agent-permissions";
import { periodKeyFor, sumForConnectionPeriod } from "../db/card-spend-ledger";
import type { Db } from "../db/index";
import { listRules, type StoredRule } from "../db/rules";
import { getUserById } from "../db/users";
import type { KeyWrapper } from "../crypto/key-wrapper";
import type { Clock } from "../seams/clock";
import {
  resolveCardRequestContext,
  type CardRequest,
  type CardRequestContext,
} from "../spending/household-context";

// The default account currency when no budget currency is set (brief: amounts
// default to AUD).
const DEFAULT_CURRENCY = "AUD";
// The budget period to sum spend over when the connection has no card budget.
const DEFAULT_PERIOD: PeriodKind = "month";

// The resolved connection the loader reads for. `userId` is the OWNING person
// (member scope) — from the session/connection, NEVER a client value.
export interface AgentConnection {
  readonly userId: string;
  readonly connectionId: string;
  readonly agentId: string;
  readonly active: boolean;
}

// The injected seams — no process.env.
export interface LoadAgentContextDeps {
  readonly db: Db;
  readonly keyWrapper: KeyWrapper;
  readonly clock: Clock;
}

// The assembled context the pipeline hands the pure engine. For a CARD request the
// loader additionally carries the resolved household + currency context (the member's
// account currency, the converted amount with its rate date, the per-member monthly
// limit and the shared household monthly budget with spend-to-date) — the fields the
// pure engine enforces (design §8 step 4). Absent when the call is not a card request.
export interface AgentContext {
  readonly permissions: ConnectionPermissions;
  readonly rules: StoredRule[];
  readonly spend: number;
  readonly accountCurrency: string;
  readonly cardRequest?: CardRequestContext;
}

// The current budget-period bucket key is derived by `periodKeyFor` in the
// card-spend-ledger store — the one source of truth for the ledger's bucket keys,
// so this loader and the spending read can never drift from how releases were
// bucketed when they were written.

// Is this rule's scope applicable to the given connection? An all-agents rule
// covers every connection; a chosen-agent rule covers only its own agent (the
// same id space as the connection/agent id). The per-call action match is the
// pure engine's job, not the loader's.
function appliesTo(rule: StoredRule, connection: AgentConnection): boolean {
  return (
    rule.scope.type === "any_agent" ||
    (rule.scope.type === "agent" && rule.scope.agentId === connection.connectionId)
  );
}

// Resolve the person's unwrapped 256-bit DEK: read their wrapped DEK (bound by
// userId through the users store) and unwrap it through the KeyWrapper seam.
// Throws when the person has no row (never fails silently).
async function dataKeyFor(
  db: Db,
  keyWrapper: KeyWrapper,
  userId: string,
): Promise<Uint8Array> {
  const user = await getUserById(db, userId);
  if (!user) {
    throw new Error("loadAgentContext: no data key for this user");
  }
  return keyWrapper.unwrap(user.wrappedDek);
}

// Assemble the policy context for `connection`: its granted permissions, the
// active rules applicable to it (conditions decrypted) and its approved-release
// spend for the current budget period, every read member-scoped by
// `connection.userId`. Amounts default to AUD when no budget currency is set.
export async function loadAgentContext(
  connection: AgentConnection,
  deps: LoadAgentContextDeps,
  cardRequest?: CardRequest,
): Promise<AgentContext> {
  const { db, keyWrapper, clock } = deps;

  // Resolve the person's data key first (the member-scoped reads below need it to
  // decrypt rule conditions).
  const dek = await dataKeyFor(db, keyWrapper, connection.userId);

  const permissions = await getConnectionPermissions(db, connection.userId, connection.connectionId);
  if (!permissions) {
    throw new Error("loadAgentContext: no permissions for this connection");
  }

  // The active rules for this person, conditions decrypted, narrowed to those
  // whose scope covers this connection.
  const allRules = await listRules(db, connection.userId, dek);
  const rules = allRules.filter((rule) => appliesTo(rule, connection));

  // The current budget-period spend for THIS connection: the budget's period, or
  // the month bucket when no budget is set.
  const budget = permissions.cardBudget;
  const period = budget?.period ?? DEFAULT_PERIOD;
  const spend = await sumForConnectionPeriod(
    db,
    connection.userId,
    connection.connectionId,
    period,
    periodKeyFor(period, clock.now()),
  );

  const accountCurrency = budget?.currency ?? DEFAULT_CURRENCY;

  // A card request additionally resolves the household + currency context for the
  // connection's OWNING user (never a client value), delegating to the household-context
  // resolver so the pure engine can enforce the member limit and the household budget.
  if (cardRequest) {
    const resolved = await resolveCardRequestContext(connection.userId, cardRequest, { db, clock });
    return { permissions, rules, spend, accountCurrency, cardRequest: resolved };
  }

  return { permissions, rules, spend, accountCurrency };
}
