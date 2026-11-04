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

// The cookie name is a `__Host-` prefix: the browser only accepts it when it is
// Secure, Path=/ and carries no Domain — i.e. host-locked to warthog.com.au.
const COOKIE_NAME = "__Host-wh_session";

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
// script (HttpOnly), HTTPS-only (Secure), SameSite=Lax, Path=/ and no Domain.
function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax`;
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
     VALUES ($1, $2, $3::timestamptz, $4::timestamptz)
     RETURNING ${RETURNING}`,
    [userId, hashToken(token), now, now],
  );
  const row = result.rows[0];
  if (!row) throw new Error("createSession: INSERT returned no row");
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
  const found = await db.query(
    `SELECT ${RETURNING} FROM sessions WHERE token_hash = $1`,
    [hashToken(token)],
  );
  const row = found.rows[0];
  if (!row) return null;

  const session = toSession(row);
  const now = deps.clock.now().getTime();
  if (now - session.lastSeenAt.getTime() > IDLE_MS) return null;
  if (now - session.createdAt.getTime() > ABSOLUTE_MS) return null;

  const slid = await db.query(
    `UPDATE sessions SET last_seen_at = $2::timestamptz WHERE id = $1 RETURNING ${RETURNING}`,
    [session.id, deps.clock.now().toISOString()],
  );
  const updated = slid.rows[0];
  return updated ? toSession(updated) : session;
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
