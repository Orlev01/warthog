// The admin portal's handoff and session (docs/design/admin-portal.md §2). The admin host
// authenticates nobody: the app host, for a signed-in admin with a fresh step-up, MINTS a
// single-use 60-second handoff; the admin host EXCHANGES it once for its own host-locked
// `__Host-wh_admin` session (12 hours absolute, 60 minutes idle). Both live in one
// admin_sessions row (0111) that cascades from the app session, so every existing way of
// ending that session ends admin access too.
//
// Tokens are 256-bit values from the `random` seam, stored only as SHA-256 (exactly the
// app session's discipline), so this table never holds a replayable value. Every window is
// judged against the injected Clock, never SQL now(). Every statement binds its values
// (INV-102); a malformed token hashes to nothing and matches no row, never throws.

import { createHash } from "node:crypto";

import type { Clock } from "../seams/clock";
import type { Random } from "../seams/random";
import type { Db, Row } from "../db/index";
import { IDLE_MS as APP_IDLE_MS, ABSOLUTE_MS as APP_ABSOLUTE_MS } from "../auth/session";

export const ADMIN_COOKIE_NAME = "__Host-wh_admin";

const TOKEN_BYTES = 32;
const MINUTE_MS = 60 * 1000;
export const HANDOFF_TTL_MS = MINUTE_MS;
export const ADMIN_IDLE_MS = 60 * MINUTE_MS;
export const ADMIN_ABSOLUTE_MS = 12 * 60 * MINUTE_MS;

const RETURNING = "id, session_id, user_id, created_at, last_seen_at";

export interface AdminSession {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}

export interface ExchangedAdminSession {
  readonly session: AdminSession;
  readonly token: string;
  readonly cookie: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function toAdminSession(row: Row): AdminSession {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    userId: row.user_id as string,
    createdAt: new Date(row.created_at as string | number | Date),
    lastSeenAt: new Date(row.last_seen_at as string | number | Date),
  };
}

function newToken(random: Random): string {
  return Buffer.from(random.randomBytes(TOKEN_BYTES)).toString("hex");
}

// Host-locked, unreadable to script, HTTPS-only, Lax (the portal is read-only and every
// POST checks Origin), Path=/ and no Domain; lives for the absolute window.
export function adminSessionCookie(token: string): string {
  return `${ADMIN_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ADMIN_ABSOLUTE_MS / 1000)}`;
}

export function clearedAdminCookie(): string {
  return `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// The live-app-session-and-admin-role condition every exchange and verify re-checks: the
// person is still an admin, not a tombstone, and the app session is within its own windows.
const APP_SESSION_LIVE = `EXISTS (
  SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
   WHERE s.id = admin_sessions.session_id
     AND u.role = 'admin' AND u.wrapped_dek <> ''
     AND s.last_seen_at >= $APP_IDLE::timestamptz AND s.created_at >= $APP_ABS::timestamptz)`;

function liveCondition(idleParam: number, absParam: number): string {
  return APP_SESSION_LIVE.replace("$APP_IDLE", `$${idleParam}`).replace("$APP_ABS", `$${absParam}`);
}

/**
 * Mint a handoff for an app session: replaces that session's unexchanged handoff (one live
 * proof per session) and returns the raw token (hex) with its expiry. The caller has already
 * verified the session, the admin role and a fresh step-up.
 */
export async function mintHandoff(
  db: Db,
  target: { sessionId: string; userId: string },
  deps: { clock: Clock; random: Random },
): Promise<{ token: string; expiresAt: Date }> {
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + HANDOFF_TTL_MS);
  const token = newToken(deps.random);
  await db.query("DELETE FROM admin_sessions WHERE session_id = $1 AND token_hash IS NULL", [target.sessionId]);
  await db.query(
    `INSERT INTO admin_sessions (session_id, user_id, handoff_hash, handoff_expires_at, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $5::timestamptz)`,
    [target.sessionId, target.userId, hashToken(token), expiresAt.toISOString(), now.toISOString()],
  );
  return { token, expiresAt };
}

/**
 * Exchange a handoff for an admin session: ONE conditional UPDATE consumes the proof
 * (unexpired, unused, its app session live, its person still an admin), stamps the session
 * token and restarts both windows at the exchange instant. Exactly one concurrent exchange
 * can win; every other outcome is null with nothing changed.
 */
export async function exchangeHandoff(
  db: Db,
  handoffToken: string,
  deps: { clock: Clock; random: Random },
): Promise<ExchangedAdminSession | null> {
  const now = deps.clock.now();
  const token = newToken(deps.random);
  const result = await db.query(
    `UPDATE admin_sessions
        SET token_hash = $2, handoff_hash = NULL, exchanged_at = $3::timestamptz,
            created_at = $3::timestamptz, last_seen_at = $3::timestamptz
      WHERE handoff_hash = $1 AND token_hash IS NULL AND handoff_expires_at >= $3::timestamptz
        AND ${liveCondition(4, 5)}
      RETURNING ${RETURNING}`,
    [
      hashToken(handoffToken), hashToken(token), now.toISOString(),
      new Date(now.getTime() - APP_IDLE_MS).toISOString(), new Date(now.getTime() - APP_ABSOLUTE_MS).toISOString(),
    ],
  );
  const row = result.rows[0];
  return row ? { session: toAdminSession(row), token, cookie: adminSessionCookie(token) } : null;
}

/**
 * Verify a presented admin token: within both admin windows AND its app session still live
 * for an admin. A successful verify slides the admin idle timer (never the app session's).
 */
export async function verifyAdminSession(db: Db, token: string, deps: { clock: Clock }): Promise<AdminSession | null> {
  const now = deps.clock.now().getTime();
  const result = await db.query(
    `UPDATE admin_sessions SET last_seen_at = GREATEST(last_seen_at, $2::timestamptz)
      WHERE token_hash = $1 AND token_hash IS NOT NULL
        AND last_seen_at >= $3::timestamptz AND created_at >= $4::timestamptz
        AND ${liveCondition(5, 6)}
      RETURNING ${RETURNING}`,
    [
      hashToken(token), new Date(now).toISOString(),
      new Date(now - ADMIN_IDLE_MS).toISOString(), new Date(now - ADMIN_ABSOLUTE_MS).toISOString(),
      new Date(now - APP_IDLE_MS).toISOString(), new Date(now - APP_ABSOLUTE_MS).toISOString(),
    ],
  );
  const row = result.rows[0];
  return row ? toAdminSession(row) : null;
}

/** End exactly the admin session the token names (sign out of admin); the app session stays. */
export async function deleteAdminSession(db: Db, token: string): Promise<void> {
  await db.query("DELETE FROM admin_sessions WHERE token_hash = $1", [hashToken(token)]);
}
