// The person aggregate's data access: create a user and look one up by id or by
// email. Every member-scoped table hangs off this `id` (the session's `userId`),
// so this is the foundational read/write seam.
//
// An address is one address whatever its case or surrounding spaces (review fix B8):
// every email is stored and looked up through `normaliseEmail` (trimmed, lower-cased),
// lookups match on lower(email) so rows written before normalisation are still found,
// and a unique index on lower(email) (0048) refuses a second account for a case
// variant.
//
// Each statement is parameterized through the `Db` seam (INV-102): the email, id
// and wrapped-DEK reference travel as BOUND values, never concatenated into the
// SQL text, so a value shaped like SQL is stored as data and cannot alter the
// query. The wrapped-DEK reference is opaque here — the real wrapped form comes
// from the KeyWrapper seam; this module only stores and returns it verbatim
// (design §4.1: the per-person DEK is stored only WRAPPED).

import type { Db, Row } from "./index";

// A person row, as handed back to callers. `wrappedDek` is the wrapped-DEK
// reference (ciphertext to the app); `role` governs what a later admin app may
// report and defaults to 'member'.
export interface User {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly wrappedDek: string;
}

// What createUser needs: the email and the wrapped-DEK reference. `role` is not
// taken here — a new person is always a 'member' (the column's default).
export interface NewUser {
  readonly email: string;
  readonly wrappedDek: string;
}

// The columns every read returns, kept in one place so create and the lookups
// hand back the same shape.
const RETURNING = "id, email, role, wrapped_dek";

// The canonical form of an email address: surrounding whitespace dropped, lower-cased.
// Every boundary that takes an address (sign-up, sign-in, recovery, new-device, email
// codes) uses this, so case or spacing never splits one person into two.
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Map a raw row to a User, translating the snake_case `wrapped_dek` column to the
// module's camelCase field.
function toUser(row: Row): User {
  return {
    id: row.id as string,
    email: row.email as string,
    role: row.role as string,
    wrappedDek: row.wrapped_dek as string,
  };
}

// Create a person row storing the normalised email and the wrapped-DEK reference;
// `role` falls to its column default ('member'). Returns the created user (with its
// generated id). An address already taken, in any case, is refused by the database.
export async function createUser(db: Db, user: NewUser): Promise<User> {
  const result = await db.query(
    `INSERT INTO users (email, wrapped_dek)
     VALUES ($1, $2)
     RETURNING ${RETURNING}`,
    [normaliseEmail(user.email), user.wrappedDek],
  );
  const row = result.rows[0];
  if (!row) throw new Error("createUser: INSERT returned no row");
  return toUser(row);
}

// Read the one person with this id (bound as a parameter), or null when none.
export async function getUserById(db: Db, id: string): Promise<User | null> {
  const result = await db.query(`SELECT ${RETURNING} FROM users WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row ? toUser(row) : null;
}

// Look a person up by email, in any case or spacing (normalised, then bound as a
// parameter, never woven into the SQL text), or null when none.
export async function getUserByEmail(db: Db, email: string): Promise<User | null> {
  const result = await db.query(`SELECT ${RETURNING} FROM users WHERE lower(email) = $1`, [
    normaliseEmail(email),
  ]);
  const row = result.rows[0];
  return row ? toUser(row) : null;
}
