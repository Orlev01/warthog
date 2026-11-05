// The agent aggregate's data access (CLAUDE.md vocabulary: an *agent* is a
// connected AI client, `agentId`, ONE ROW PER CONNECTION; design §6.1 — the agent
// is born from its OAuth connection). The agent list, Home and the spending view
// read an agent's identity (display name, platform, status, connected date) and
// its activity (last-active time, request count).
//
// These fields are PLAINTEXT METADATA (design §4.1) — needed for the list and for
// filtering — so, unlike held-request args or approval detail, they are NOT
// DEK-encrypted: this module holds no key and reads no `process.env` (config flows
// from `src/server/config.ts` alone, INV-103).
//
// Every statement is parameterized through the `Db` seam (INV-102): the ids, name
// and platform travel as BOUND values, never concatenated into the SQL text, so a
// value shaped like SQL is stored as data and cannot alter the query. Every read
// and write is member-scoped by the `user_id` the caller passes — the session's /
// connection's id, never a client value — so one person can never read or mutate
// another's agent. Time enters through the injected Clock (never SQL now()).

import { randomUUID } from "node:crypto";

import type { Clock } from "../seams/clock";
import type { Db, Row } from "./index";

// A connected agent vs. a disconnected (revoked) one — the two status values the
// store knows.
export type AgentStatus = "connected" | "disconnected";

// What createAgent records: the owner (the session's / connection's id, never a
// client value), the OAuth connection this agent IS (one row per connection), its
// display name and platform, and an optional status (defaults to 'connected' for a
// freshly connected agent).
export interface NewAgent {
  readonly userId: string;
  readonly connectionId: string;
  readonly displayName: string;
  readonly platform: string;
  readonly status?: AgentStatus;
}

// An agent as handed back to callers. `connectedAt` is the connected date
// (= clock.now() on create); `lastActiveAt` is null until the first recorded tool
// call; `requestCount` is 0 on create and bumped once per recordAgentActivity.
export interface Agent {
  readonly id: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly displayName: string;
  readonly platform: string;
  readonly status: AgentStatus;
  readonly connectedAt: Date | string;
  readonly lastActiveAt: Date | string | null;
  readonly requestCount: number;
}

// What recordAgentActivity needs: the person (member scope) and the agent id.
export interface RecordActivityInput {
  readonly userId: string;
  readonly id: string;
}

// The columns every read returns, kept in one place so the lookups and the
// activity bump hand back the same shape.
const COLUMNS =
  "id, user_id, connection_id, display_name, platform, status, connected_at, last_active_at, request_count";

// A stored instant comes back as a Date or an ISO/epoch representation depending
// on the driver; normalise to a Date.
function toDate(value: unknown): Date {
  return new Date(value as string | number | Date);
}

// Map a raw row to an Agent, translating the snake_case columns to the module's
// camelCase fields.
function toAgent(row: Row): Agent {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    connectionId: row.connection_id as string,
    displayName: row.display_name as string,
    platform: row.platform as string,
    status: row.status as AgentStatus,
    connectedAt: toDate(row.connected_at),
    lastActiveAt: row.last_active_at != null ? toDate(row.last_active_at) : null,
    requestCount: Number(row.request_count),
  };
}

// Create an agent for `userId` linked to `connectionId`, recording its name,
// platform and status (defaulting to 'connected') with connectedAt = clock.now(),
// requestCount 0 and no last-active time yet. The id is generated up front, so the
// returned Agent is assembled from its inputs (it does not depend on a RETURNING
// read). Returns the created Agent carrying the generated id.
export async function createAgent(db: Db, input: NewAgent, clock: Clock): Promise<Agent> {
  const id = randomUUID();
  const status: AgentStatus = input.status ?? "connected";
  const connectedAt = clock.now();

  await db.query(
    `INSERT INTO agents (id, user_id, connection_id, display_name, platform, status, connected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
    [
      id,
      input.userId,
      input.connectionId,
      input.displayName,
      input.platform,
      status,
      connectedAt.toISOString(),
    ],
  );

  return {
    id,
    userId: input.userId,
    connectionId: input.connectionId,
    displayName: input.displayName,
    platform: input.platform,
    status,
    connectedAt,
    lastActiveAt: null,
    requestCount: 0,
  };
}

// Every agent OWNED BY `userId` (member-scoped: WHERE user_id bound), never another
// person's. Returns an empty array when the person has none.
export async function listAgentsForUser(db: Db, userId: string): Promise<Agent[]> {
  const result = await db.query(`SELECT ${COLUMNS} FROM agents WHERE user_id = $1`, [userId]);
  return result.rows.map(toAgent);
}

// The one agent OWNED BY `userId` with this id (member-scoped: id AND user_id both
// bound); null when none for this user — so another person's agent id returns null.
export async function getAgentById(db: Db, userId: string, id: string): Promise<Agent | null> {
  const result = await db.query(`SELECT ${COLUMNS} FROM agents WHERE id = $1 AND user_id = $2`, [
    id,
    userId,
  ]);
  const row = result.rows[0];
  return row ? toAgent(row) : null;
}

// Record that the owned agent called a tool: increment its request count by 1 and
// stamp lastActiveAt = clock.now() (connectedAt and the rest untouched),
// member-scoped so only `userId`'s own agent can be bumped. THROWS (never silently)
// when no agent with that id belongs to this user — so one person can never mutate
// another's agent. Returns the updated Agent.
export async function recordAgentActivity(
  db: Db,
  { userId, id }: RecordActivityInput,
  clock: Clock,
): Promise<Agent> {
  const lastActiveAt = clock.now();
  const result = await db.query(
    `UPDATE agents
        SET request_count = request_count + 1,
            last_active_at = $1::timestamptz
      WHERE id = $2 AND user_id = $3
      RETURNING ${COLUMNS}`,
    [lastActiveAt.toISOString(), id, userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`recordAgentActivity: no agent ${id} for this user`);
  }
  return toAgent(row);
}
