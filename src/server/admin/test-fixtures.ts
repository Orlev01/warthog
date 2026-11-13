// Shared fixtures for the admin portal's tests: a live admin (or member) account with an
// app session minted through the real session seam, and a steerable clock. Test-only.
import { createSession, recordStepUp, type Session } from "../auth/session";
import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import { systemRandom } from "../seams/random";

export function steerableClock(start: Date): Clock & { advance(ms: number): void; set(instant: Date): void } {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => { current += ms; },
    set: (instant) => { current = instant.getTime(); },
  };
}

export async function createAccount(
  db: Db,
  options: { email?: string; role?: "admin" | "member"; tombstone?: boolean } = {},
): Promise<{ userId: string }> {
  const email = options.email ?? `person-${Math.random().toString(36).slice(2)}@example.test`;
  const result = await db.query(
    "INSERT INTO users (email, wrapped_dek, role) VALUES ($1, $2, $3) RETURNING id",
    [email, options.tombstone ? "" : "wrapped", options.role ?? "member"],
  );
  return { userId: result.rows[0]!.id as string };
}

export async function signIn(
  db: Db,
  userId: string,
  clock: Clock,
  options: { stepUp?: boolean } = {},
): Promise<{ session: Session; token: string }> {
  const created = await createSession(db, userId, { clock, random: systemRandom });
  const session = options.stepUp === false ? created.session : await recordStepUp(db, created.session.id, { clock });
  return { session, token: created.token };
}
