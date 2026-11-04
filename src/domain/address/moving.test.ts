// E03-S09 — Moving-address resolution (`src/domain/address/moving.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// below fails. That is intentional — the implementation is written afterwards to
// make these pass. Do NOT add the module to turn these green; the builder does
// that. The tests pin BEHAVIOUR (the record a resolution yields for a given
// instant — which address is current, whether an upcoming one remains, and its
// date), never the source text of the module, so a later rename that keeps
// behaviour leaves them untouched.
//
// This is a pure domain module (CLAUDE.md / conventions: `src/domain/**` has no
// React, no DB, no fetch, no process.env, no Date.now — "take a clock"). Time
// enters ONLY as an injected `now: Date` — a plain instant — so the module never
// reaches across the domain boundary into the server's Clock seam; the caller
// passes `clock.now()` in.
//
// Brief "Moving-house helper": when the person adds a new address with a moving
// date, agent context returns BOTH the current address and the upcoming one with
// its date until the moving date, when the upcoming address automatically becomes
// the current one; household members sharing the address see the same. Brief
// "Household": a member chooses either "use the household address" (their vault
// postal address then follows the shared one, INCLUDING any upcoming address and
// moving date) or to keep their own.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
// A postal address value is OPAQUE to this module — a structured low-tier value
// it carries verbatim and never inspects (the field composition is another
// task's concern). So `Address` is a plain `Record<string, unknown>`; the
// module's job is to decide WHICH address is current for a given instant and
// whether an upcoming move still lies ahead — never to read inside an address.
//
//   type Address = Record<string, unknown>;
//
//   // An upcoming move: the address being moved to and the day it takes effect.
//   interface UpcomingMove {
//     address: Address;
//     movingDate: Date;          // the "moving on" instant (start of the move day)
//   }
//
//   // A stored postal-address record: the current address and an optional move.
//   interface AddressRecord {
//     current: Address;
//     upcoming?: UpcomingMove;
//   }
//
//   // A member's address situation: their own record, whether they follow the
//   // shared household address, and the shared household record (when there is one).
//   interface MemberAddress {
//     own: AddressRecord;
//     following?: boolean;
//     shared?: AddressRecord | null;
//   }
//
//   // resolve(member, now): the address record a member's agents see NOW.
//   //  - Selection: a following member (following === true WITH a shared record)
//   //    resolves the SHARED record; otherwise their OWN record. Following is
//   //    opt-in — a member who keeps their own ignores the shared address.
//   //  - Date swap, applied to whichever record is effective:
//   //      * no upcoming move          -> { current } only.
//   //      * now BEFORE movingDate     -> { current, upcoming } unchanged (both,
//   //                                      with the date).
//   //      * now ON OR AFTER movingDate -> the upcoming address becomes current
//   //                                      and NO upcoming remains.
//   function resolve(member: MemberAddress, now: Date): AddressRecord;
//
// resolve is PURE: it returns a record and mutates neither the input nor the
// injected `now`. The boundary is INCLUSIVE of the moving instant (now >=
// movingDate swaps), matching the AC's "On or after the moving date". Instant
// comparison goes through an `ms()`-style helper that accepts a Date (per the
// contract) but tolerates an epoch-ms or ISO-string representation too, so a
// reasonable representation choice never reddens a test for the wrong reason —
// hence the tests compare the MOMENT of a returned date, not its representation.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolve,
  type AddressRecord,
  type MemberAddress,
  type Address,
} from "./moving";

// ---------------------------------------------------------------------------
// Helpers and fixtures — compare the moment, not the representation.
// ---------------------------------------------------------------------------

const ms = (value: Date | number | string): number =>
  new Date(value as never).getTime();

// Opaque low-tier postal addresses. The tests only ever deep-equal a whole
// address value, never read a field, so the inner shape is NOT pinned onto the
// builder — these are distinct object literals so an accidental shared reference
// can never make an assertion pass by luck.
const OLD_ADDRESS: Address = {
  line1: "12 Banksia St",
  suburb: "Carlton",
  state: "VIC",
  postcode: "3053",
  country: "AU",
};
const NEW_ADDRESS: Address = {
  line1: "88 Wattle Rd",
  suburb: "Fitzroy",
  state: "VIC",
  postcode: "3065",
  country: "AU",
};
const SHARED_ADDRESS: Address = {
  line1: "5 Kookaburra Ct",
  suburb: "Brunswick",
  state: "VIC",
  postcode: "3056",
  country: "AU",
};
const SHARED_NEW_ADDRESS: Address = {
  line1: "140 Lygon St",
  suburb: "Coburg",
  state: "VIC",
  postcode: "3058",
  country: "AU",
};

// "Moving on 1 December" — stored as the start-of-day instant.
const MOVING_DATE = new Date("2026-12-01T00:00:00.000Z");
const BEFORE = new Date("2026-11-20T09:00:00.000Z"); // well before the move
const ON = new Date(MOVING_DATE); // exactly the moving instant
const AFTER = new Date("2026-12-05T09:00:00.000Z"); // well after the move

// A member who keeps their own record, mid-move.
function ownMoving(): MemberAddress {
  return {
    own: {
      current: OLD_ADDRESS,
      upcoming: { address: NEW_ADDRESS, movingDate: MOVING_DATE },
    },
  };
}

// ===========================================================================
// AC1 — before the moving date, resolve returns BOTH the current and the
// upcoming address, with the date.
// ===========================================================================

test("before the moving date the current address is still the old one", () => {
  const r = resolve(ownMoving(), BEFORE);
  assert.deepEqual(
    r.current,
    OLD_ADDRESS,
    "until the move the person's current address is where they still live",
  );
});

test("before the moving date the upcoming address and its date are both returned", () => {
  const r = resolve(ownMoving(), BEFORE);
  const up = r.upcoming;
  assert.ok(up, "an upcoming move is still ahead, so it is returned");
  assert.deepEqual(up.address, NEW_ADDRESS, "the upcoming address is the one being moved to");
  assert.equal(ms(up.movingDate), ms(MOVING_DATE), "the upcoming move carries its moving date");
});

test("a millisecond before the moving instant the upcoming address has not taken over", () => {
  const justBefore = new Date(ms(MOVING_DATE) - 1);
  const r = resolve(ownMoving(), justBefore);
  assert.deepEqual(r.current, OLD_ADDRESS, "a millisecond early, the old address is still current");
  assert.ok(r.upcoming, "a millisecond early, the upcoming move still lies ahead");
});

// ===========================================================================
// AC2 — on or after the moving date, the upcoming address becomes current and
// no upcoming remains.
// ===========================================================================

test("exactly on the moving instant the upcoming address becomes current", () => {
  const r = resolve(ownMoving(), ON);
  assert.deepEqual(r.current, NEW_ADDRESS, "reaching the moving instant makes the new address current");
  assert.equal(r.upcoming, undefined, "once moved, no upcoming move remains on the record");
});

test("after the moving date the new address is current and no upcoming remains", () => {
  const r = resolve(ownMoving(), AFTER);
  assert.deepEqual(r.current, NEW_ADDRESS, "well after the move the new address is the current one");
  assert.equal(r.upcoming, undefined, "the move is done, so there is no upcoming address left");
});

test("a record with no upcoming move resolves to just its current address, at any time", () => {
  const settled: MemberAddress = { own: { current: OLD_ADDRESS } };
  for (const now of [BEFORE, ON, AFTER]) {
    const r = resolve(settled, now);
    assert.deepEqual(r.current, OLD_ADDRESS, "someone not moving always resolves to their one current address");
    assert.equal(r.upcoming, undefined, "someone not moving has no upcoming address");
  }
});

// ===========================================================================
// AC3 — a household-following member resolves to the SHARED address (and sees
// the shared upcoming/swap too); following is opt-in.
// ===========================================================================

test("a following member resolves to the shared household address, not their own", () => {
  const member: MemberAddress = {
    own: { current: OLD_ADDRESS },
    following: true,
    shared: { current: SHARED_ADDRESS },
  };
  const r = resolve(member, BEFORE);
  assert.deepEqual(r.current, SHARED_ADDRESS, "a following member's current address is the shared one");
});

test("a following member sees the shared upcoming address and its date before the shared move", () => {
  const member: MemberAddress = {
    // A decoy move on the member's OWN record — it must be ignored while following.
    own: { current: OLD_ADDRESS, upcoming: { address: NEW_ADDRESS, movingDate: MOVING_DATE } },
    following: true,
    shared: {
      current: SHARED_ADDRESS,
      upcoming: { address: SHARED_NEW_ADDRESS, movingDate: MOVING_DATE },
    },
  };
  const r = resolve(member, BEFORE);
  assert.deepEqual(r.current, SHARED_ADDRESS, "before the shared move the shared current address is current");
  const up = r.upcoming;
  assert.ok(up, "the shared record's upcoming move is surfaced to the following member");
  assert.deepEqual(up.address, SHARED_NEW_ADDRESS, "the upcoming address is the shared one being moved to");
  assert.equal(ms(up.movingDate), ms(MOVING_DATE), "the shared move's date rides along");
});

test("a following member swaps to the shared upcoming address on or after the shared moving date", () => {
  const member: MemberAddress = {
    // The member's own record even has a move to a DIFFERENT address — proving the
    // following member's result comes entirely from the shared record, not their own.
    own: {
      current: OLD_ADDRESS,
      upcoming: { address: NEW_ADDRESS, movingDate: new Date("2030-01-01T00:00:00.000Z") },
    },
    following: true,
    shared: {
      current: SHARED_ADDRESS,
      upcoming: { address: SHARED_NEW_ADDRESS, movingDate: MOVING_DATE },
    },
  };
  const r = resolve(member, AFTER);
  assert.deepEqual(r.current, SHARED_NEW_ADDRESS, "after the shared move the shared new address is current");
  assert.equal(r.upcoming, undefined, "after the shared move no upcoming address remains");
  assert.notDeepEqual(r.current, NEW_ADDRESS, "the member's OWN upcoming address is never used while following");
});

test("following is opt-in: a member who keeps their own ignores the shared address", () => {
  const sharedRecord: AddressRecord = { current: SHARED_ADDRESS };

  const keptOwn: MemberAddress = { own: { current: OLD_ADDRESS }, following: false, shared: sharedRecord };
  assert.deepEqual(
    resolve(keptOwn, BEFORE).current,
    OLD_ADDRESS,
    "a member who did not opt in keeps their own current address",
  );

  const notChosen: MemberAddress = { own: { current: OLD_ADDRESS }, shared: sharedRecord };
  assert.deepEqual(
    resolve(notChosen, BEFORE).current,
    OLD_ADDRESS,
    "with no follow choice made, a shared record present does not take over",
  );
});

// ===========================================================================
// Purity — resolve returns a view and mutates neither its input nor `now`.
// ===========================================================================

test("resolve does not mutate the input record when it swaps the address", () => {
  const member = ownMoving();
  resolve(member, AFTER); // past the move — the swap path

  assert.deepEqual(member.own.current, OLD_ADDRESS, "the stored record's current address is untouched");
  const up = member.own.upcoming;
  assert.ok(up, "the stored record still carries its upcoming move (resolution is a view, not a write)");
  assert.deepEqual(up.address, NEW_ADDRESS, "the stored upcoming address is unchanged");
  assert.equal(ms(up.movingDate), ms(MOVING_DATE), "the stored moving date is unchanged");
});

test("resolve does not mutate the injected now", () => {
  const now = new Date(BEFORE);
  const before = now.getTime();
  resolve(ownMoving(), now);
  assert.equal(now.getTime(), before, "the injected instant is left exactly as it was passed in");
});

test("resolve is deterministic for the same inputs", () => {
  const a = resolve(ownMoving(), BEFORE);
  const b = resolve(ownMoving(), BEFORE);
  assert.deepEqual(a, b, "the same record and instant always resolve to the same result");
});
