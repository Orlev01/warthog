// The connector-request aggregate's data access (brief "Request a connector", design
// §7). A connector REQUEST is a person asking for a service that is not yet in the
// catalogue: it is recorded 'requested' for that person and, when a catalogue entry
// whose name/aliases match is LATER added, marked 'matched' (recording which catalogue
// slug satisfied it). The match-notify that drives the transition lives in the
// connectors service — this is only its store.
//
// A person sees ONLY their own requests (member-scoped: `listConnectorRequestsForUser`
// binds the session's `userId`, never a client value). The match-notify needs EVERY
// person's still-pending request, so `listPendingConnectorRequests` is a distinct
// system primitive (conventions: "list all" is never the member "list visible") — it
// spans users because it is a system job, not a session.
//
// The requested `service_name` is free text the person typed, stored VERBATIM. Every
// statement is parameterized through the `Db` seam (INV-102): the id, user id, service
// name and connector slug travel as BOUND values, never concatenated into the SQL text,
// so a value shaped like SQL is stored as data and cannot alter the query. Time enters
// through the injected Clock (never SQL now()); this module reads no `process.env` and
// holds no secret (INV-103).

import { randomUUID } from "node:crypto";

import type { Clock } from "../seams/clock";
import type { Db, Row } from "./index";
import type { ContactTopic } from "../../domain/contact/topics";

// The columns every read returns, kept in one place so the lookups and the mark
// transition hand back the same shape.
const COLUMNS =
  "id, user_id, kind, service_name, connector_id, topic, message, status, requested_at, matched_connector_id, matched_at, handled_at";

// A request is still pending ('requested') or has been satisfied by a catalogue entry
// ('matched') — the two status values the store knows.
export type ConnectorRequestStatus = "requested" | "matched";

// What a person asked the operator for (migrations 0115 and 0116): a service that isn't in the
// catalogue, Google early access for a gated Google service, or a "Contact us" message.
export type ConnectorRequestKind = "service" | "google_early_access" | "contact";

// What a "Contact us" message is about (migration 0116; the list lives in the domain).
export { CONTACT_TOPICS, type ContactTopic } from "../../domain/contact/topics";

// What createConnectorRequest records: the owner (the session's id, never a client
// value), the service name (the person's own words, or the catalogue's name for early
// access, or the topic's label for a message), for early access the catalogue entry asked
// about, and for a message its topic and text. The kind defaults to a service request.
export interface NewConnectorRequest {
  readonly userId: string;
  readonly serviceName: string;
  readonly kind?: ConnectorRequestKind;
  readonly connectorId?: string | null;
  readonly topic?: ContactTopic | null;
  readonly message?: string | null;
}

// A request as handed back. `serviceName` is the name the person typed, stored
// verbatim. `matchedConnectorId` / `matchedAt` are null until the request is matched.
export interface ConnectorRequest {
  readonly id: string;
  readonly userId: string;
  readonly kind: ConnectorRequestKind;
  readonly serviceName: string;
  readonly connectorId: string | null;
  // A "Contact us" message's topic and (already cleaned) text; null for every other kind.
  readonly topic: ContactTopic | null;
  readonly message: string | null;
  readonly status: ConnectorRequestStatus;
  readonly requestedAt: Date | string;
  readonly matchedConnectorId: string | null;
  readonly matchedAt: Date | string | null;
  // When the operator marked it done in the admin portal; null while it waits.
  readonly handledAt: Date | string | null;
}

// What markConnectorRequestMatched needs: the request id and the catalogue slug that
// satisfied it.
export interface MatchConnectorRequestInput {
  readonly id: string;
  readonly connectorId: string;
}

// A stored instant comes back as a Date or an ISO/epoch representation depending on the
// driver; normalise to a Date. A NULL stays null.
function toDate(value: unknown): Date | null {
  return value == null ? null : new Date(value as string | number | Date);
}

// Map a raw row to a ConnectorRequest, translating the snake_case columns to the
// module's camelCase fields.
function toConnectorRequest(row: Row): ConnectorRequest {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    kind: row.kind as ConnectorRequestKind,
    serviceName: row.service_name as string,
    connectorId: (row.connector_id as string | null) ?? null,
    topic: (row.topic as ContactTopic | null) ?? null,
    message: (row.message as string | null) ?? null,
    status: row.status as ConnectorRequestStatus,
    requestedAt: toDate(row.requested_at) ?? new Date(NaN),
    matchedConnectorId: (row.matched_connector_id as string | null) ?? null,
    matchedAt: toDate(row.matched_at),
    handledAt: toDate(row.handled_at),
  };
}

// Record a 'requested' row for `userId` with requestedAt = clock.now() and null matched
// fields. The id is generated up front, so the result is assembled from its inputs and
// does not depend on a RETURNING read (like createConnection). Returns the created
// ConnectorRequest.
export async function createConnectorRequest(
  db: Db,
  input: NewConnectorRequest,
  clock: Clock,
): Promise<ConnectorRequest> {
  const id = randomUUID();
  const requestedAt = clock.now();
  const kind = input.kind ?? "service";
  const connectorId = input.connectorId ?? null;
  const topic = input.topic ?? null;
  const message = input.message ?? null;

  await db.query(
    `INSERT INTO connector_requests (id, user_id, kind, service_name, connector_id, topic, message, status, requested_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'requested', $8::timestamptz)`,
    [id, input.userId, kind, input.serviceName, connectorId, topic, message, requestedAt.toISOString()],
  );

  return {
    id,
    userId: input.userId,
    kind,
    serviceName: input.serviceName,
    connectorId,
    topic,
    message,
    status: "requested",
    requestedAt,
    matchedConnectorId: null,
    matchedAt: null,
    handledAt: null,
  };
}

// Every request OWNED BY `userId` (member-scoped: WHERE user_id bound), REGARDLESS OF
// STATUS — never another person's. Returns an empty array when the person has none.
export async function listConnectorRequestsForUser(
  db: Db,
  userId: string,
): Promise<ConnectorRequest[]> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM connector_requests WHERE user_id = $1 ORDER BY requested_at`,
    [userId],
  );
  return result.rows.map(toConnectorRequest);
}

// EVERY person's still-'requested' service request, across all users — the system scan
// the match-notify runs when a catalogue entry is added. NOT member-scoped (a system job,
// not a session). A matched request is excluded, and so is early access: it names a
// service that is already in the catalogue.
export async function listPendingConnectorRequests(db: Db): Promise<ConnectorRequest[]> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM connector_requests WHERE status = 'requested' AND kind = 'service' ORDER BY requested_at`,
  );
  return result.rows.map(toConnectorRequest);
}

// EVERY person's still-'requested' Google early-access request, across all users — the system
// scan the arrivals sweep runs to tell people they're on the list. NOT member-scoped.
export async function listPendingEarlyAccessRequests(db: Db): Promise<ConnectorRequest[]> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM connector_requests WHERE status = 'requested' AND kind = 'google_early_access' ORDER BY requested_at`,
  );
  return result.rows.map(toConnectorRequest);
}

// The address of each requester whose account still exists (a deleted account's key is gone),
// for the arrivals sweep — a system read across users, not a member read.
export async function listLiveRequesterEmails(db: Db, userIds: readonly string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const result = await db.query("SELECT id, email FROM users WHERE id = ANY($1::uuid[]) AND wrapped_dek <> ''", [userIds]);
  return new Map(result.rows.map((row) => [row.id as string, row.email as string]));
}

// How many "Contact us" messages `userId` has sent at or after `since` (member-scoped), so a
// burst of messages can be turned away.
export async function countContactMessagesSince(db: Db, userId: string, since: Date): Promise<number> {
  const result = await db.query(
    "SELECT count(*)::int AS n FROM connector_requests WHERE user_id = $1 AND kind = 'contact' AND requested_at >= $2::timestamptz",
    [userId, since.toISOString()],
  );
  return Number(result.rows[0]?.n ?? 0);
}

// Claim a request for the arrivals sweep: mark it 'matched' by `connectorId` only if it is
// still 'requested', so two sweeps (a rolling deploy runs two replicas) tell the person once.
// Returns the claimed request, or null when another sweep claimed it first.
export async function claimArrivedRequest(
  db: Db,
  { id, connectorId }: MatchConnectorRequestInput,
  clock: Clock,
): Promise<ConnectorRequest | null> {
  const result = await db.query(
    `UPDATE connector_requests
        SET status = 'matched', matched_connector_id = $1, matched_at = $2::timestamptz
      WHERE id = $3 AND status = 'requested' AND kind <> 'contact'
      RETURNING ${COLUMNS}`,
    [connectorId, clock.now().toISOString(), id],
  );
  const row = result.rows[0];
  return row ? toConnectorRequest(row) : null;
}

// Transition the request with `id` from 'requested' to 'matched', recording
// matchedConnectorId = connectorId and matchedAt = clock.now() and leaving serviceName /
// requestedAt / userId intact. Only a row that is STILL 'requested' is affected (the
// WHERE binds `status = 'requested'`), so a re-match of an already-matched request —
// or a mark of a non-existent id — finds no row and THROWS rather than silently marking
// a second time. Returns the updated ConnectorRequest.
export async function markConnectorRequestMatched(
  db: Db,
  { id, connectorId }: MatchConnectorRequestInput,
  clock: Clock,
): Promise<ConnectorRequest> {
  const matchedAt = clock.now();
  const result = await db.query(
    `UPDATE connector_requests
        SET status = 'matched', matched_connector_id = $1, matched_at = $2::timestamptz
      WHERE id = $3 AND status = 'requested'
      RETURNING ${COLUMNS}`,
    [connectorId, matchedAt.toISOString(), id],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`markConnectorRequestMatched: no pending request ${id} to mark`);
  }
  return toConnectorRequest(row);
}
