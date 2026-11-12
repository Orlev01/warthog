// The connection aggregate's data access (CLAUDE.md vocabulary: a *connection* is a
// person's connected service; a *connector* is a catalogue entry; design §6.1, §7 —
// "Agents reach connected services only through Warthog"). A connection holds the
// provider CREDENTIALS and the live STATUS for one connected service. Every agent use
// of a service resolves through one connection, and management must see ALL of a
// person's connections regardless of status.
//
// The credentials carry PERSONAL CONTENT (provider OAuth tokens / API keys), so they
// are stored only DEK-ENCRYPTED (`../crypto/envelope`, design §4.1, §7): the id is
// generated up front so the envelope's associated data can bind the ciphertext to its
// exact (table, column, row) — the plaintext never lands in a column, and it is NEVER
// part of the Connection shape handed back to a client. The connector id, account
// label, status and connected date are PLAINTEXT METADATA (design §4.1) — needed for
// the list — so they are NOT encrypted.
//
// The `connectorId` is a catalogue slug (design §7 — text, not a uuid); it is bound by
// value with ownership enforced by the session's `user_id`, never a foreign key to the
// catalogue (which is a data file, not a table).
//
// Every statement is parameterized through the `Db` seam (INV-102): the ids, connector,
// label and credentials travel as BOUND values, never concatenated into the SQL text,
// so a value shaped like SQL is stored as data and cannot alter the query. Every read
// and write is member-scoped by the `user_id` the caller passes — the session's id,
// never a client value — so one person can never read or mutate another's connection.
// Time enters through the injected Clock (never SQL now()); the DEK is injected (this
// module reads no `process.env` and holds no key, INV-103).

import { randomUUID } from "node:crypto";

import { decrypt, encrypt } from "../crypto/envelope";
import type { Clock } from "../seams/clock";
import type { Db, Row } from "./index";

// The envelope's associated data binds each `credentials` ciphertext to its exact
// location, so a row lifted into another row/column/table fails to decrypt.
const TABLE = "connections";
const CREDENTIALS_COLUMN = "credentials";

// The columns every client-facing read returns, kept in one place so create, the
// lookups and updateConnectionStatus hand back the same shape. The `credentials`
// column is deliberately NOT selected here — it never reaches a Connection (AC2); the
// server-side credential accessor reads it separately.
const COLUMNS = "id, user_id, connector_id, account_label, status, connected_at";

// A connection is connected, needs the person to reconnect it (a failed refresh), or
// is in an error state — the three status values the store knows.
export type ConnectionStatus = "connected" | "needs_reconnect" | "error";

// What createConnection records: the owner (the session's id, never a client value),
// the connector slug of the connected service, the account label shown in the UI, the
// provider credentials to store DEK-encrypted, and an optional status (defaults to
// 'connected' for a freshly connected service).
export interface NewConnection {
  readonly userId: string;
  readonly connectorId: string;
  readonly accountLabel: string;
  readonly credentials: Record<string, unknown>;
  readonly status?: ConnectionStatus;
}

// A connection as handed back to a client / management. CREDENTIALS ARE NEVER PART OF
// THIS SHAPE (AC2) — only id, connector, account label, status and the connected date
// (= clock.now() on create).
export interface Connection {
  readonly id: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly accountLabel: string;
  readonly status: ConnectionStatus;
  readonly connectedAt: Date | string;
}

// What updateConnectionStatus needs: the person (member scope), the connection id and
// the new status.
export interface UpdateStatusInput {
  readonly userId: string;
  readonly id: string;
  readonly status: ConnectionStatus;
}

// What updateConnectionCredentials needs: the person (member scope), the connection id
// and the replacement credentials to store DEK-encrypted (e.g. a renewed OAuth token set).
export interface UpdateCredentialsInput {
  readonly userId: string;
  readonly id: string;
  readonly credentials: Record<string, unknown>;
}

// A stored instant comes back as a Date or an ISO/epoch representation depending on the
// driver; normalise to a Date.
function toDate(value: unknown): Date {
  return new Date(value as string | number | Date);
}

// Map a raw row to a Connection, translating the snake_case columns to the module's
// camelCase fields. The `credentials` column is never selected into a Connection.
function toConnection(row: Row): Connection {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    connectorId: row.connector_id as string,
    accountLabel: row.account_label as string,
    status: row.status as ConnectionStatus,
    connectedAt: toDate(row.connected_at),
  };
}

// Create a connection for `userId` with its DEK-encrypted credentials, recording the
// connector, account label and status (defaulting to 'connected') with connectedAt =
// clock.now(). The id is generated up front so the credentials' envelope can bind to
// it. Returns the created Connection assembled from its inputs — WITHOUT credentials
// (it does not depend on a RETURNING read).
export async function createConnection(
  db: Db,
  input: NewConnection,
  dek: Uint8Array,
  clock: Clock,
): Promise<Connection> {
  const id = randomUUID();
  const status: ConnectionStatus = input.status ?? "connected";
  const connectedAt = clock.now();
  const envelope = await encrypt(
    dek,
    TABLE,
    CREDENTIALS_COLUMN,
    id,
    JSON.stringify(input.credentials),
  );

  await db.query(
    `INSERT INTO connections (id, user_id, connector_id, account_label, status, credentials, connected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
    [
      id,
      input.userId,
      input.connectorId,
      input.accountLabel,
      status,
      envelope,
      connectedAt.toISOString(),
    ],
  );

  return {
    id,
    userId: input.userId,
    connectorId: input.connectorId,
    accountLabel: input.accountLabel,
    status,
    connectedAt,
  };
}

// Every connection OWNED BY `userId` (member-scoped: WHERE user_id bound), REGARDLESS
// OF STATUS — management must see them in any state — never another person's and never
// with credentials. Returns an empty array when the person has none. Oldest first, ties
// by id, so every page, chooser and export lists them in the same order on every read.
export async function listConnectionsForUser(db: Db, userId: string): Promise<Connection[]> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM connections WHERE user_id = $1 ORDER BY connected_at, id`,
    [userId],
  );
  return result.rows.map(toConnection);
}

// The one connection OWNED BY `userId` with this id (member-scoped: id AND user_id both
// bound), WITHOUT credentials; null when none for this user — so another person's
// connection id returns null.
export async function getConnectionById(
  db: Db,
  userId: string,
  id: string,
): Promise<Connection | null> {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM connections WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  const row = result.rows[0];
  return row ? toConnection(row) : null;
}

// The SERVER-SIDE accessor the connector engine resolves an agent's service use
// through — member-scoped (id AND user_id both bound), the credentials decrypted under
// the owner's `dek`; null when none for this user (another person cannot read them).
// This path is never wired to a client response — AC2 governs the Connection shape,
// which carries no credentials. Throws if the DEK is wrong or the ciphertext was
// tampered (the GCM tag fails to verify).
export async function getConnectionCredentials(
  db: Db,
  userId: string,
  id: string,
  dek: Uint8Array,
): Promise<Record<string, unknown> | null> {
  const result = await db.query(
    `SELECT id, credentials FROM connections WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const plaintext = await decrypt(dek, TABLE, CREDENTIALS_COLUMN, row.id as string, row.credentials as string);
  return JSON.parse(plaintext) as Record<string, unknown>;
}

// Set the owned connection's status (design §7 — a failed refresh marks a connection
// 'needs_reconnect'), leaving the credentials, connector, label and connected date
// untouched; returns the updated Connection (no credentials). Member-scoped (id AND
// user_id both bound). THROWS (never silently) when no connection with that id belongs
// to this user — so one person can never mutate another's connection.
export async function updateConnectionStatus(
  db: Db,
  { userId, id, status }: UpdateStatusInput,
): Promise<Connection> {
  const result = await db.query(
    `UPDATE connections
        SET status = $1
      WHERE id = $2 AND user_id = $3
      RETURNING ${COLUMNS}`,
    [status, id, userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`updateConnectionStatus: no connection ${id} for this user`);
  }
  return toConnection(row);
}

// Replace the owned connection's DEK-encrypted credentials (design §7 — a refresh job
// renews OAuth tokens before expiry), leaving the connector, label, status and connected
// date untouched. The ciphertext is re-bound to the SAME row id through the envelope's
// associated data, so it decrypts under the owner's DEK exactly as the original did.
// Member-scoped (id AND user_id both bound). THROWS (never silently) when no connection
// with that id belongs to this user, and returns the updated Connection (no credentials).
export async function updateConnectionCredentials(
  db: Db,
  { userId, id, credentials }: UpdateCredentialsInput,
  dek: Uint8Array,
): Promise<Connection> {
  const envelope = await encrypt(dek, TABLE, CREDENTIALS_COLUMN, id, JSON.stringify(credentials));
  const result = await db.query(
    `UPDATE connections
        SET credentials = $1
      WHERE id = $2 AND user_id = $3
      RETURNING ${COLUMNS}`,
    [envelope, id, userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`updateConnectionCredentials: no connection ${id} for this user`);
  }
  return toConnection(row);
}
