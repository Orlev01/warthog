// Sessions: the data access plus the cookie that gates the whole portal (design §5).
//
// A session is a random 256-bit id drawn through the `random` seam and handed to
// the browser in a `__Host-wh_session` cookie. The server stores only a one-way
// SHA-256 hash of that token (project rule: session ids are stored only as hashes),
// so this table never holds a value that could be replayed as a live cookie; the
// presented token verifies by re-hashing it and matching the stored hash.
//
// Two windows end a session, both measured against the injected Clock (never SQL
// now(), so expiry is deterministic and testable): a 14-day IDLE cap on
// `last_seen_at` (slid forward on every successful verify) and a 30-day ABSOLUTE
// cap on `created_at` (never slid). A session outside either window — or an
// unknown, tampered or malformed token — yields no session, never a throw.
//
// `stepped_up_at` records the last re-authentication (step-up); recordStepUp sets
// it so a later verify surfaces it. Every statement is parameterized (INV-102):
// the token reaches the query layer only as the bound hash, never woven into SQL.

import { createHash } from "node:crypto";

import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";
import type { Db, Row } from "../db/index";
import { HttpError } from "../http/validate";

// The cookie name is a `__Host-` prefix: the browser only accepts it when it is
// Secure, Path=/ and carries no Domain — host-locked to the serving application.
// Exported so sign-out reads and clears exactly this cookie (one source of truth).
export const COOKIE_NAME = "__Host-wh_session";

// A 256-bit session id (32 bytes of entropy), rendered to the client as hex.
const SESSION_ID_BYTES = 32;

const DAY_MS = 24 * 60 * 60 * 1000;
const IDLE_MS = 14 * DAY_MS; // no activity for longer than this ends the session
const ABSOLUTE_MS = 30 * DAY_MS; // a session may never live longer than this

// The columns every read returns, kept in one place so create, verify and step-up
// hand back the same shape.
const RETURNING = "id, user_id, created_at, last_seen_at, stepped_up_at";

// A session row, as handed back to callers. `steppedUpAt` is null until the person
// re-authenticates.
export interface Session {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly steppedUpAt: Date | null;
}

// What createSession returns: the stored session, the raw token the client holds,
// and the exact Set-Cookie header value that carries it.
export interface CreatedSession {
  readonly session: Session;
  readonly token: string;
  readonly cookie: string;
}

// The one-way form the token is stored and looked up as. SHA-256 is sufficient for
// a full-entropy 256-bit id (design §5: "stored hashed"): the raw token is never
// persisted, yet the presented token reproduces this digest to verify.
function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// Map a raw row to a Session, translating snake_case columns and a NULL step-up
// time to the module's camelCase shape.
function toSession(row: Row): Session {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    createdAt: new Date(row.created_at as string | number | Date),
    lastSeenAt: new Date(row.last_seen_at as string | number | Date),
    steppedUpAt:
      row.stepped_up_at == null ? null : new Date(row.stepped_up_at as string | number | Date),
  };
}

// The Set-Cookie value for a session token: host-locked (`__Host-`), unreadable to
// script (HttpOnly), HTTPS-only (Secure), SameSite=Lax, Path=/ and no Domain. It lives
// for the 30-day absolute window (Max-Age), so the browser keeps it across restarts —
// an installed web app drops a plain session cookie whenever it is closed — while the
// server still enforces the idle and absolute windows on every verify.
function sessionCookie(token: string): string {
  const maxAgeSeconds = Math.floor(ABSOLUTE_MS / 1000);
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

// Authentication transactions that mutate existing factor/session rows take this
// first, preserving account -> factors/sessions lock order with deletion/purge.
export async function lockActiveAccount(tx: Db, userId: string): Promise<void> {
  const active = await tx.query("SELECT id FROM users WHERE id = $1 AND wrapped_dek <> '' FOR SHARE", [userId]);
  if (!active.rows[0]) throw new HttpError(401, "Authentication failed");
}

// Create a session for `userId`: draw a 256-bit id, store it hashed, anchor both
// timers at the clock, and return the session together with the raw token and its
// cookie. `stepped_up_at` is left unset.
export async function createSession(
  db: Db,
  userId: string,
  deps: { clock: Clock; random: Random },
): Promise<CreatedSession> {
  const token = Buffer.from(deps.random.randomBytes(SESSION_ID_BYTES)).toString("hex");
  const now = deps.clock.now().toISOString();
  const result = await db.query(
    `INSERT INTO sessions (user_id, token_hash, created_at, last_seen_at)
     SELECT id, $2, $3::timestamptz, $4::timestamptz FROM users
     WHERE id = $1 AND wrapped_dek <> ''
     FOR SHARE
     RETURNING ${RETURNING}`,
    [userId, hashToken(token), now, now],
  );
  const row = result.rows[0];
  // Deletion keeps a crypto-shredded user row until purge. Retained passkeys,
  // recovery material or a pending first factor must not reopen that account.
  // FOR SHARE serializes minting with deletion's user-row update: either the
  // new session is revoked by deletion, or this insert observes the tombstone.
  if (!row) throw new HttpError(401, "Authentication failed");
  return { session: toSession(row), token, cookie: sessionCookie(token) };
}

// Verify a presented token: hash it, find the matching session, and return it only
// when it is within BOTH the idle and the absolute window. A successful verify
// slides the idle timer (last_seen_at = now). An unknown, tampered, malformed or
// expired token yields null, never a throw.
export async function verifySession(
  db: Db,
  token: string,
  deps: { clock: Clock },
): Promise<Session | null> {
  const now = deps.clock.now().getTime();
  // Verification and idle renewal are one guarded write. A separate SELECT plus
  // UPDATE can return a previously read session after logout/recovery deleted it.
  const slid = await db.query(
    `UPDATE sessions SET last_seen_at = GREATEST(last_seen_at, $2::timestamptz)
     WHERE token_hash = $1
       AND last_seen_at >= $3::timestamptz
       AND created_at >= $4::timestamptz
       AND EXISTS (SELECT 1 FROM users WHERE users.id = sessions.user_id AND wrapped_dek <> '')
     RETURNING ${RETURNING}`,
    [hashToken(token), new Date(now).toISOString(), new Date(now - IDLE_MS).toISOString(),
      new Date(now - ABSOLUTE_MS).toISOString()],
  );
  const updated = slid.rows[0];
  return updated ? toSession(updated) : null;
}

// Delete exactly the session the presented token identifies (sign-out): re-hash the
// token the SAME way create/verify do and delete the matching row, so the old token
// no longer verifies and ONLY that session ends — the person's other devices keep
// their rows. The token reaches the query bound as its hash (parameterized, INV-102),
// so a SQL-shaped token is looked up as data and matches nothing, never alters the
// statement. An unknown/garbage token matches no row and deletes nothing.
export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

// The Set-Cookie value that CLEARS the session cookie: the same host-locked
// `__Host-wh_session` (Path=/, Secure, HttpOnly, SameSite=Lax) as `sessionCookie`,
// with an empty value and Max-Age=0 so the browser drops it immediately.
export function clearedSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// Record a step-up (re-authentication) on a session, stamping stepped_up_at at the
// clock and returning the updated session so a later verify surfaces it.
export async function recordStepUp(
  db: Db,
  sessionId: string,
  deps: { clock: Clock },
): Promise<Session> {
  const result = await db.query(
    `UPDATE sessions SET stepped_up_at = $2::timestamptz WHERE id = $1 RETURNING ${RETURNING}`,
    [sessionId, deps.clock.now().toISOString()],
  );
  const row = result.rows[0];
  if (!row) throw new Error("recordStepUp: no session with that id");
  return toSession(row);
}
