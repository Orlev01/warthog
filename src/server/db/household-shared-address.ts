// E15-S06 — the household shared postal address and the per-member follow choice
// (brief "Household sharing"; design §4.1).
//
// A household can share ONE postal address every member may edit (the owner has no
// special standing — any member of the household edits it, and each edit records a
// notification to every OTHER member through the configured sender). A member then
// chooses either to FOLLOW the shared address — their effective postal address then
// resolves to the shared one, including any upcoming address and moving date, with the
// date-swap applied — or to keep their own vault postal address.
//
// The address is PERSONAL CONTENT, so `current` and `upcoming` are stored only
// DEK-ENCRYPTED (`../crypto/envelope`, design §4.1): the household id is the row id, so
// each value's envelope binds the ciphertext to its exact (table, column, row) and the
// plaintext never lands in a column. `moving_on` is plaintext metadata (a bare calendar
// date for the date-swap, like a vault postal address's moving-on date).
//
// Every statement is parameterized through the `Db` seam (INV-102): the ids and every
// value travel as BOUND values, never concatenated into the SQL text, so a value shaped
// like SQL is stored as data and cannot alter the query. Every member-scoped read/write
// is scoped to the `userId`/`actorId` the caller passes — the session's id, never a
// client value — so a non-member can neither read nor edit the shared address nor set a
// follow choice. The DEK and the notifier are INJECTED (this module reads no
// `process.env` and holds no key, INV-103); notifications go through the injected sender
// seam (the dev outbox in dev, the real senders in prod — the composition root's choice),
// never a concrete Azure sender, exactly like the approval notifier's injected push seam.

import { decrypt, encrypt } from "../crypto/envelope";
import type { Clock } from "../seams/clock";
import type { Db } from "./index";
import { getHouseholdForMember, isHouseholdMember } from "./households";

// The envelope's associated data binds each encrypted value to its exact location, so a
// row lifted into another row/column/table fails to decrypt. The row id is the household
// id (one shared address per household).
const TABLE = "household_shared_address";
const CURRENT_COLUMN = "current";
const UPCOMING_COLUMN = "upcoming";

// The notification body sent to every other member on an edit. It carries NO address
// plaintext — personal content stays out of the channel; the member opens the app to see
// the new address. A fixed string, so nothing dynamic (and no ambient value) can leak.
const CHANGED_BODY = "Your household's shared address has been updated.";

// A household's one shared postal address, as handed back to a member (decrypted).
export interface SharedAddress {
  readonly householdId: string;
  readonly current: string; // the current shared address (DEK-encrypted at rest)
  readonly upcoming: string | null; // an optional upcoming address; null when none
  readonly movingOn: Date | string | null; // the moving-on date (ISO "YYYY-MM-DD"); null when none
}

// The narrow injected sender seam: one member at a time. The dev outbox (dev) and the
// real senders (prod) both satisfy it; which is wired is the composition root's job.
export interface SharedAddressNotifier {
  notifyMember(message: { userId: string; body: string }): Promise<void>;
}

// The injected dependency bag for an edit: just the notifier seam.
export interface SetSharedAddressDeps {
  readonly notify: SharedAddressNotifier;
}

// What setSharedAddress takes: the household, the ACTOR (the session user editing — must
// be a member), the current address and the optional upcoming address + moving-on date.
export interface SetSharedAddressInput {
  readonly householdId: string;
  readonly actorId: string;
  readonly current: string;
  readonly upcoming?: string | null;
  readonly movingOn?: string | null;
}

// The outcome of an edit: the stored address, or a refusal because the actor is not a
// member (in which case NOTHING is stored and NO notification is sent).
export type SetSharedAddressResult =
  | { ok: true; address: SharedAddress }
  | { ok: false; reason: "not_a_member" };

// A member's own vault postal address, as read by the caller and passed in — the record
// a member who keeps their own resolves to.
export interface OwnPostalAddress {
  readonly current: string;
  readonly upcoming?: string | null;
  readonly movingOn?: Date | string | null;
}

// A member's resolved effective postal address: which record won, plus the address.
export interface EffectivePostalAddress {
  readonly source: "household" | "own";
  readonly current: string;
  readonly upcoming: string | null;
  readonly movingOn: Date | string | null;
}

// Set (or replace) the household's ONE shared address. The owner OR any member may edit
// — the only gate is that the ACTOR is a member (bound as a parameter, never a client
// value); a non-member is refused "not_a_member" and nothing is stored or sent. `current`
// and `upcoming` are stored DEK-encrypted (the household id is the envelope's row id);
// the write upserts on household_id, so a later edit replaces the earlier one in place.
// Each successful edit records ONE notification per OTHER member (never the editor, never
// a non-member) through the injected notifier — the body carries no address plaintext.
export async function setSharedAddress(
  db: Db,
  input: SetSharedAddressInput,
  dek: Uint8Array,
  deps: SetSharedAddressDeps,
): Promise<SetSharedAddressResult> {
  if (!(await isHouseholdMember(db, input.householdId, input.actorId))) {
    return { ok: false, reason: "not_a_member" };
  }

  const upcoming = input.upcoming ?? null;
  const movingOn = input.movingOn ?? null;
  const currentEnvelope = await encrypt(dek, TABLE, CURRENT_COLUMN, input.householdId, input.current);
  const upcomingEnvelope =
    upcoming == null ? null : await encrypt(dek, TABLE, UPCOMING_COLUMN, input.householdId, upcoming);

  await db.query(
    `INSERT INTO household_shared_address (household_id, current, upcoming, moving_on)
     VALUES ($1, $2, $3, $4::date)
     ON CONFLICT (household_id) DO UPDATE
       SET current = EXCLUDED.current,
           upcoming = EXCLUDED.upcoming,
           moving_on = EXCLUDED.moving_on`,
    [input.householdId, currentEnvelope, upcomingEnvelope, movingOn],
  );

  // Notify every OTHER member of this household — never the editor, never a non-member.
  const members = await db.query(
    "SELECT user_id FROM household_members WHERE household_id = $1",
    [input.householdId],
  );
  for (const row of members.rows) {
    const memberId = String(row.user_id);
    if (memberId === input.actorId) continue;
    await deps.notify.notifyMember({ userId: memberId, body: CHANGED_BODY });
  }

  return {
    ok: true,
    address: { householdId: input.householdId, current: input.current, upcoming, movingOn },
  };
}

// Read the household's shared address — but ONLY when `userId` is a member of it
// (member-scoped: the EXISTS gate and the row both bind the same ids, so a non-member, or
// an unset address, reads null and one household's address never leaks into another's).
// Each value is decrypted under the injected `dek`; a wrong DEK fails the GCM tag and
// rejects rather than returning other bytes.
export async function getSharedAddress(
  db: Db,
  input: { householdId: string; userId: string },
  dek: Uint8Array,
): Promise<SharedAddress | null> {
  const result = await db.query(
    `SELECT a.current, a.upcoming, a.moving_on::text AS moving_on
       FROM household_shared_address a
      WHERE a.household_id = $1
        AND EXISTS (
          SELECT 1 FROM household_members m
           WHERE m.household_id = $1 AND m.user_id = $2
        )`,
    [input.householdId, input.userId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const current = await decrypt(dek, TABLE, CURRENT_COLUMN, input.householdId, row.current as string);
  const upcoming =
    row.upcoming == null
      ? null
      : await decrypt(dek, TABLE, UPCOMING_COLUMN, input.householdId, row.upcoming as string);

  return {
    householdId: input.householdId,
    current,
    upcoming,
    movingOn: (row.moving_on as string | null) ?? null,
  };
}

// Set the SESSION user's OWN follow choice for a household they belong to: `follow = true`
// to use the household address, false to keep their own. A non-member is refused
// "not_a_member" and nothing is written. Upserts on (household_id, user_id), so a later
// choice overwrites in place; member-scoped by the bound user id.
export async function setFollowChoice(
  db: Db,
  input: { householdId: string; userId: string; follow: boolean },
): Promise<{ ok: true; follow: boolean } | { ok: false; reason: "not_a_member" }> {
  if (!(await isHouseholdMember(db, input.householdId, input.userId))) {
    return { ok: false, reason: "not_a_member" };
  }

  await db.query(
    `INSERT INTO household_follow_choice (household_id, user_id, follow)
     VALUES ($1, $2, $3)
     ON CONFLICT (household_id, user_id) DO UPDATE SET follow = EXCLUDED.follow`,
    [input.householdId, input.userId, input.follow],
  );

  return { ok: true, follow: input.follow };
}

// The member's follow choice for a household (member-scoped: user_id bound). Defaults to
// false (keep own) until set; a non-member — who has no row — reads false.
export async function getFollowChoice(
  db: Db,
  input: { householdId: string; userId: string },
): Promise<boolean> {
  const result = await db.query(
    "SELECT follow FROM household_follow_choice WHERE household_id = $1 AND user_id = $2",
    [input.householdId, input.userId],
  );
  const row = result.rows[0];
  return row ? Boolean(row.follow) : false;
}

// Resolve `userId`'s effective postal address AT `clock.now()`. When the member belongs
// to a household, follows it AND a shared address exists, the SHARED record wins (source
// "household"); otherwise their OWN record (source "own"). `own` is the member's vault
// postal address (read by the caller); when the effective record is own and own is null,
// the result is null. The date-swap is applied to whichever record is effective: an
// upcoming address whose moving-on date is on or after passed becomes the current one
// (the boundary is inclusive, mirroring the moving-address domain's resolve).
export async function getEffectivePostalAddress(
  db: Db,
  input: { userId: string; own: OwnPostalAddress | null },
  dek: Uint8Array,
  clock: Clock,
): Promise<EffectivePostalAddress | null> {
  const now = clock.now();

  const household = await getHouseholdForMember(db, input.userId);
  if (household) {
    const follows = await getFollowChoice(db, { householdId: household.id, userId: input.userId });
    if (follows) {
      const shared = await getSharedAddress(db, { householdId: household.id, userId: input.userId }, dek);
      if (shared) {
        return applyDateSwap("household", shared.current, shared.upcoming, shared.movingOn, now);
      }
    }
  }

  if (!input.own) return null;
  return applyDateSwap("own", input.own.current, input.own.upcoming ?? null, input.own.movingOn ?? null, now);
}

// The moment of an instant in epoch ms, tolerant of a Date or an ISO-string moving-on
// date (either is a reasonable representation of a bare calendar date).
function msOf(value: Date | string | number): number {
  return new Date(value as never).getTime();
}

// Apply the date-swap to one effective record: on or after the moving-on date the upcoming
// address becomes current and no upcoming/moving-on remains; before it, both are kept.
function applyDateSwap(
  source: "household" | "own",
  current: string,
  upcoming: string | null,
  movingOn: Date | string | null,
  now: Date,
): EffectivePostalAddress {
  if (upcoming != null && movingOn != null && now.getTime() >= msOf(movingOn)) {
    return { source, current: upcoming, upcoming: null, movingOn: null };
  }
  return { source, current, upcoming, movingOn };
}
