// The preferences profile's data access (brief "Skills, preferences and shared
// memory"; design §4.1). A person's communication-style and preferences profile —
// tone, preferred length, language, units, time zone and how they like to be
// taught or briefed — is PERSONAL CONTENT shared freely with permitted agents via
// get_context, so every field is stored only DEK-ENCRYPTED (`../crypto/envelope`,
// design §4.1): each column holds a `v1:` envelope whose associated data binds the
// ciphertext to its exact (table, column, row), never the plaintext.
//
// One profile per person (unlike the low-tier identity store, where a person may
// hold several fields of a kind): the row is keyed on `user_id`, so a save UPSERTS
// in place and never duplicates. The envelope's row id is that same `user_id`.
//
// Every statement is parameterized through the `Db` seam (INV-102): the user id
// and every value travel as BOUND values, never concatenated into the SQL text, so
// a value shaped like SQL is stored as data and cannot alter the query. Every
// read/write is member-scoped by the `userId` the caller passes — the session's
// id, never a client value — so one person can never read or change another's
// profile. The DEK is injected (this module reads no `process.env` and holds no
// key, INV-103).

import { decrypt, encrypt } from "../crypto/envelope";
import type { Db } from "./index";

// The envelope's associated data binds each field's ciphertext to its exact
// location, so a row lifted into another row/column/table fails to decrypt. Each
// field is encrypted/decrypted under its own column name, so no field's envelope
// can be read back in another field's place.
const TABLE = "preferences";

// The profile as handed back to its owner (every field decrypted under the owner's
// DEK). `userId` is the person this profile belongs to.
export interface PreferencesProfile {
  readonly userId: string;
  readonly tone: string;
  readonly length: string;
  readonly language: string;
  readonly units: string;
  readonly timeZone: string;
  readonly briefing: string;
}

// What savePreferences records: the OWNER (the session's id, never a client value)
// and the six profile fields (each stored DEK-encrypted).
export interface SavePreferencesInput {
  readonly userId: string;
  readonly tone: string;
  readonly length: string;
  readonly language: string;
  readonly units: string;
  readonly timeZone: string;
  readonly briefing: string;
}

// Upsert the ONE profile row for input.userId (one profile per person): a second
// save OVERWRITES in place and never duplicates. Each field is stored DEK-encrypted
// under its own column, bound to the row by the person's id; the returned profile is
// assembled from the inputs (it does not depend on a RETURNING read). Member-scoped:
// the user id is bound, so a save writes the caller's OWN row and leaves every other
// person's untouched.
export async function savePreferences(
  db: Db,
  input: SavePreferencesInput,
  dek: Uint8Array,
): Promise<PreferencesProfile> {
  const [tone, length, language, units, timeZone, briefing] = await Promise.all([
    encrypt(dek, TABLE, "tone", input.userId, input.tone),
    encrypt(dek, TABLE, "length", input.userId, input.length),
    encrypt(dek, TABLE, "language", input.userId, input.language),
    encrypt(dek, TABLE, "units", input.userId, input.units),
    encrypt(dek, TABLE, "time_zone", input.userId, input.timeZone),
    encrypt(dek, TABLE, "briefing", input.userId, input.briefing),
  ]);

  await db.query(
    `INSERT INTO preferences (user_id, tone, length, language, units, time_zone, briefing)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id) DO UPDATE SET
       tone      = EXCLUDED.tone,
       length    = EXCLUDED.length,
       language  = EXCLUDED.language,
       units     = EXCLUDED.units,
       time_zone = EXCLUDED.time_zone,
       briefing  = EXCLUDED.briefing`,
    [input.userId, tone, length, language, units, timeZone, briefing],
  );

  return {
    userId: input.userId,
    tone: input.tone,
    length: input.length,
    language: input.language,
    units: input.units,
    timeZone: input.timeZone,
    briefing: input.briefing,
  };
}

// Read the profile for the person with this id (member-scoped: user_id bound as a
// parameter), every field DECRYPTED under the owner's `dek`. Returns null when the
// person has saved no profile — never another person's. A wrong DEK fails the GCM
// tag and rejects.
export async function getPreferences(
  db: Db,
  userId: string,
  dek: Uint8Array,
): Promise<PreferencesProfile | null> {
  const result = await db.query(
    `SELECT user_id, tone, length, language, units, time_zone, briefing
     FROM preferences WHERE user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const [tone, length, language, units, timeZone, briefing] = await Promise.all([
    decrypt(dek, TABLE, "tone", userId, row.tone as string),
    decrypt(dek, TABLE, "length", userId, row.length as string),
    decrypt(dek, TABLE, "language", userId, row.language as string),
    decrypt(dek, TABLE, "units", userId, row.units as string),
    decrypt(dek, TABLE, "time_zone", userId, row.time_zone as string),
    decrypt(dek, TABLE, "briefing", userId, row.briefing as string),
  ]);

  return { userId: row.user_id as string, tone, length, language, units, timeZone, briefing };
}
