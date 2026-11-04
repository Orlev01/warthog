// E03-S09 — Moving-address resolution (brief "Moving-house helper" / "Household").
//
// When the person adds a new address with a moving date, agent context returns
// BOTH the current address and the upcoming one with its date until the moving
// date, when the upcoming address automatically becomes the current one;
// household members who follow the shared address see the same.
//
// Pure domain module: no React, no DB, no fetch, no process.env, no Date.now.
// Time enters ONLY as an injected `now: Date` — the caller passes `clock.now()`
// in, so this module never reaches across the domain boundary into the server's
// Clock seam.

/**
 * A postal address value. OPAQUE to this module — a structured low-tier value it
 * carries verbatim and never inspects; the field composition is another task's
 * concern. This module only decides WHICH address is current for a given instant.
 */
export type Address = Record<string, unknown>;

/** An upcoming move: the address being moved to and the day it takes effect. */
export interface UpcomingMove {
  address: Address;
  /** The "moving on" instant (start of the move day). */
  movingDate: Date;
}

/** A stored postal-address record: the current address and an optional move. */
export interface AddressRecord {
  current: Address;
  upcoming?: UpcomingMove;
}

/**
 * A member's address situation: their own record, whether they follow the shared
 * household address, and the shared household record (when there is one).
 */
export interface MemberAddress {
  own: AddressRecord;
  following?: boolean;
  shared?: AddressRecord | null;
}

/**
 * The moment of an instant in epoch milliseconds. Accepts a `Date` (per the
 * contract) but tolerates an epoch-ms or ISO-string representation too, so a
 * reasonable representation choice never compares wrong.
 */
const ms = (value: Date | number | string): number =>
  new Date(value as never).getTime();

/**
 * The address record a member's agents see NOW.
 *
 * Selection: a following member (`following === true` WITH a shared record)
 * resolves the SHARED record; otherwise their OWN record — following is opt-in.
 *
 * Date swap, applied to whichever record is effective:
 *  - no upcoming move           -> { current } only.
 *  - now BEFORE movingDate      -> { current, upcoming } unchanged.
 *  - now ON OR AFTER movingDate -> the upcoming address becomes current and no
 *                                  upcoming remains (the boundary is inclusive).
 *
 * Pure: returns a fresh record and mutates neither the input nor `now`.
 */
export function resolve(member: MemberAddress, now: Date): AddressRecord {
  const effective =
    member.following === true && member.shared ? member.shared : member.own;

  const { current, upcoming } = effective;

  if (upcoming && ms(now) >= ms(upcoming.movingDate)) {
    return { current: upcoming.address };
  }

  if (upcoming) {
    return { current, upcoming: { address: upcoming.address, movingDate: upcoming.movingDate } };
  }

  return { current };
}
