// The authorization server's data access: store and read back the four things an
// OAuth 2.1 flow outlives a request with — the agent platform's client
// registration, one-time authorization codes, access/refresh tokens, and per-agent
// access keys (design §6.1).
//
// Every credential (code, token, key) is kept ONLY as its hash: the hash is the
// table's natural key, so a lookup by hash is a primary-key read and the raw bearer
// is never a stored column — looking the plaintext up finds nothing. A client, by
// contrast, is a SHARED registration (one claude.ai registration serves many
// people), so it is keyed by its `client_id` and is not connection-bound; codes,
// tokens and keys each carry the one `connection_id` they are bound to.
//
// Each statement is parameterized through the `Db` seam (INV-102): every id, hash
// and value travels as a BOUND value, never concatenated into the SQL text, so a
// value shaped like SQL (a client id with a trailing `; DROP TABLE …`) is stored as
// data and cannot alter the query. `redirect_uris` round-trips structurally as
// jsonb; `expires_at` is written and read as a timestamptz instant.

import type { Db, Row } from "../db/index";

// --- Clients -----------------------------------------------------------------------

// How a client registered: CIMD (client_id is an https metadata-document URL) or
// DCR (client_id is the id we issued at /oauth/register).
export type Registration = "cimd" | "dcr";

// A client registration row, as handed back to callers.
export interface Client {
  readonly clientId: string;
  readonly registration: Registration;
  readonly redirectUris: string[];
}

// What createClient needs. `clientId` is stored verbatim (this module never
// interprets it — it is data); `redirectUris` is the client's allowed redirect URIs.
export interface NewClient {
  readonly clientId: string;
  readonly registration: Registration;
  readonly redirectUris: string[];
}

const CLIENT_RETURNING = "client_id, registration, redirect_uris";

// Map a raw row to a Client. jsonb comes back already parsed, so `redirect_uris` is
// the string array it was stored as.
function toClient(row: Row): Client {
  return {
    clientId: row.client_id as string,
    registration: row.registration as Registration,
    redirectUris: row.redirect_uris as string[],
  };
}

// Store a client registration; returns the created client.
export async function createClient(db: Db, client: NewClient): Promise<Client> {
  const result = await db.query(
    `INSERT INTO oauth_clients (client_id, registration, redirect_uris)
     VALUES ($1, $2, $3::jsonb)
     RETURNING ${CLIENT_RETURNING}`,
    [client.clientId, client.registration, JSON.stringify(client.redirectUris)],
  );
  const row = result.rows[0];
  if (!row) throw new Error("createClient: INSERT returned no row");
  return toClient(row);
}

// Read the one client with this id (bound as a parameter), or null when none.
export async function getClient(db: Db, clientId: string): Promise<Client | null> {
  const result = await db.query(
    `SELECT ${CLIENT_RETURNING} FROM oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  const row = result.rows[0];
  return row ? toClient(row) : null;
}

// --- Authorization codes -----------------------------------------------------------

// An authorization-code row, as handed back to callers. The code itself is never
// stored — only `codeHash` — so this row carries the consent it binds to (its
// connection, client, PKCE challenge, redirect URI and resource) and its expiry.
export interface AuthCode {
  readonly codeHash: string;
  readonly connectionId: string;
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly expiresAt: Date;
}

// What createAuthCode needs: the stored hash plus the consent it binds to.
export interface NewAuthCode {
  readonly codeHash: string;
  readonly connectionId: string;
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly expiresAt: Date;
}

const AUTH_CODE_RETURNING =
  "code_hash, connection_id, client_id, code_challenge, redirect_uri, resource, expires_at";

function toAuthCode(row: Row): AuthCode {
  return {
    codeHash: row.code_hash as string,
    connectionId: row.connection_id as string,
    clientId: row.client_id as string,
    codeChallenge: row.code_challenge as string,
    redirectUri: row.redirect_uri as string,
    resource: row.resource as string,
    expiresAt: new Date(row.expires_at as string | number | Date),
  };
}

// Store an authorization code (by its hash) bound to its consent's connection;
// returns the created row.
export async function createAuthCode(db: Db, code: NewAuthCode): Promise<AuthCode> {
  const result = await db.query(
    `INSERT INTO oauth_auth_codes
       (code_hash, connection_id, client_id, code_challenge, redirect_uri, resource, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
     RETURNING ${AUTH_CODE_RETURNING}`,
    [
      code.codeHash,
      code.connectionId,
      code.clientId,
      code.codeChallenge,
      code.redirectUri,
      code.resource,
      code.expiresAt.toISOString(),
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("createAuthCode: INSERT returned no row");
  return toAuthCode(row);
}

// Resolve a code hash to its consent (bound as a parameter), or null when none.
export async function getAuthCode(db: Db, codeHash: string): Promise<AuthCode | null> {
  const result = await db.query(
    `SELECT ${AUTH_CODE_RETURNING} FROM oauth_auth_codes WHERE code_hash = $1`,
    [codeHash],
  );
  const row = result.rows[0];
  return row ? toAuthCode(row) : null;
}

// Resolve AND remove a code by its hash in ONE statement (review fix A3): only one
// caller ever gets the row back, so a code is single-use even under concurrent
// redemption; a replayed or unknown code resolves to null.
export async function consumeAuthCode(db: Db, codeHash: string): Promise<AuthCode | null> {
  const result = await db.query(
    `DELETE FROM oauth_auth_codes WHERE code_hash = $1 RETURNING ${AUTH_CODE_RETURNING}`,
    [codeHash],
  );
  const row = result.rows[0];
  return row ? toAuthCode(row) : null;
}

// --- Access & refresh tokens -------------------------------------------------------

// Which bearer this is: a short-lived access token or a long-lived refresh token.
export type TokenKind = "access" | "refresh";

// A token row, as handed back to callers. The opaque bearer is never stored — only
// its hash — so this carries the connection it is bound to and its kind.
export interface Token {
  readonly tokenHash: string;
  readonly connectionId: string;
  readonly kind: TokenKind;
  readonly expiresAt: Date;
}

// What createToken needs: the stored hash, the connection it binds to, its kind and
// its expiry.
export interface NewToken {
  readonly tokenHash: string;
  readonly connectionId: string;
  readonly kind: TokenKind;
  readonly expiresAt: Date;
}

const TOKEN_RETURNING = "token_hash, connection_id, kind, expires_at";

function toToken(row: Row): Token {
  return {
    tokenHash: row.token_hash as string,
    connectionId: row.connection_id as string,
    kind: row.kind as TokenKind,
    expiresAt: new Date(row.expires_at as string | number | Date),
  };
}

// Store a token (by its SHA-256 hash) bound to one connection; returns the created
// row.
export async function createToken(db: Db, token: NewToken): Promise<Token> {
  const result = await db.query(
    `INSERT INTO oauth_tokens (token_hash, connection_id, kind, expires_at)
     VALUES ($1, $2, $3, $4::timestamptz)
     RETURNING ${TOKEN_RETURNING}`,
    [token.tokenHash, token.connectionId, token.kind, token.expiresAt.toISOString()],
  );
  const row = result.rows[0];
  if (!row) throw new Error("createToken: INSERT returned no row");
  return toToken(row);
}

// Resolve a token hash to its connection (bound as a parameter), or null when none.
export async function resolveToken(db: Db, tokenHash: string): Promise<Token | null> {
  const result = await db.query(
    `SELECT ${TOKEN_RETURNING} FROM oauth_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  const row = result.rows[0];
  return row ? toToken(row) : null;
}

// --- Access keys -------------------------------------------------------------------

// An access-key row, as handed back to callers. The `wh_ak_…` bearer is never stored
// — only its hash — so this carries the connection it is bound to. Access keys have
// no expiry (they are revoked by disconnecting the connection).
export interface AccessKey {
  readonly keyHash: string;
  readonly connectionId: string;
}

// What createAccessKey needs: the stored hash and the connection it binds to.
export interface NewAccessKey {
  readonly keyHash: string;
  readonly connectionId: string;
}

const ACCESS_KEY_RETURNING = "key_hash, connection_id";

function toAccessKey(row: Row): AccessKey {
  return {
    keyHash: row.key_hash as string,
    connectionId: row.connection_id as string,
  };
}

// Store an access key (by its hash) bound to one connection; returns the created row.
export async function createAccessKey(db: Db, key: NewAccessKey): Promise<AccessKey> {
  const result = await db.query(
    `INSERT INTO oauth_access_keys (key_hash, connection_id)
     VALUES ($1, $2)
     RETURNING ${ACCESS_KEY_RETURNING}`,
    [key.keyHash, key.connectionId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("createAccessKey: INSERT returned no row");
  return toAccessKey(row);
}

// Resolve a key hash to its connection (bound as a parameter), or null when none.
export async function resolveAccessKey(db: Db, keyHash: string): Promise<AccessKey | null> {
  const result = await db.query(
    `SELECT ${ACCESS_KEY_RETURNING} FROM oauth_access_keys WHERE key_hash = $1`,
    [keyHash],
  );
  const row = result.rows[0];
  return row ? toAccessKey(row) : null;
}
