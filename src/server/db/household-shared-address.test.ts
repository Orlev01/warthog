// E15-S06 — Household shared address and follow choice
// (`src/server/db/household-shared-address.ts`,
// `db/migrations/0041_household_shared_address.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./household-shared-address` fails and `freshDb()` has no shared-address relation — every
// test here fails until the builder adds them. That absence IS the point of test-first; do
// NOT implement anything to make these pass — the builder writes the module and the migration
// afterwards.
//
// These tests pin BEHAVIOUR (what the functions DO: a household's ONE shared postal address is
// stored DEK-encrypted with an optional upcoming address and a moving-on date; the owner OR
// any member may edit it, and each edit records a notification to every OTHER member through
// the configured sender; each member chooses to follow the household address or keep their
// own; a member's effective postal address resolves to the shared one — including any upcoming
// address and moving date, with the date-swap applied — when they follow, else to their own
// vault postal address; who may read/write what, filtered by the session user id; what a
// handler rejects; that every value is bound as a parameter; that the repo reads no
// `process.env`), never the source text of the module or the SQL file — a later rename that
// preserves behaviour must not redden them.
//
// WHY this exists (task E15-S06; brief "Household sharing": "the household can share an address
// record that the owner or any member can edit, every change notifying all members, and each
// member chooses either 'use the household address' (their vault postal address then follows
// the shared one, including any upcoming address and moving date) or to keep their own …
// members see the shared address …"). The shared address is PERSONAL CONTENT, so its address
// values are stored DEK-ENCRYPTED (`../crypto/envelope`, design §4.1 lists "household shared
// address" among the DEK-encrypted columns); the moving-on date is plaintext metadata (a date
// for filtering, like a vault field's moving-on date). Every member-scoped read/write is scoped
// to the SESSION's user id, never a value from the client. Notifications go through the
// configured sender seam — the dev outbox in dev, the real senders in prod (selected by the
// composition root, like the approval notifier's injected push sender) — so this module depends
// on a narrow injected notifier, never a concrete Azure sender.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface SharedAddress {              // a household's one shared postal address (read)
//     householdId: string;
//     current: string;                     // the current shared address — DEK-encrypted at rest
//     upcoming: string | null;             // an optional upcoming address — DEK-encrypted; null when none
//     movingOn: Date | string | null;      // the moving-on date (ISO "YYYY-MM-DD"); null when none
//   }
//
//   interface SharedAddressNotifier {      // the narrow injected sender seam (dev outbox / real)
//     notifyMember(message: { userId: string; body: string }): Promise<void>;
//   }
//
//   interface EffectivePostalAddress {     // a member's resolved effective postal address
//     source: "household" | "own";         // which record won: the shared one, or the member's own
//     current: string;
//     upcoming: string | null;
//     movingOn: Date | string | null;
//   }
//
//   setSharedAddress(
//     db,
//     { householdId, actorId, current, upcoming?, movingOn? },  // actorId = the SESSION user (editor)
//     dek,
//     { notify },                                               // the injected notifier seam
//   ): Promise<{ ok: true; address: SharedAddress } | { ok: false; reason: "not_a_member" }>
//     • the owner OR any member may edit (actorId must be a member); stores the one shared
//       address for the household (upsert: a later edit replaces the earlier one), current and
//       upcoming DEK-encrypted; then records ONE notification per OTHER member (never the
//       editor, never a non-member) through `notify`. A non-member is refused "not_a_member"
//       and nothing is stored or sent.
//   getSharedAddress(db, { householdId, userId }, dek): Promise<SharedAddress | null>
//     • the shared address — but ONLY when `userId` is a member of that household; a non-member
//       (or an unset address) reads null (filtered by the session user id), each value decrypted
//       under `dek`.
//   setFollowChoice(db, { householdId, userId, follow }): Promise<
//       { ok: true; follow: boolean } | { ok: false; reason: "not_a_member" }>
//     • a member sets THEIR OWN choice (userId = the session user): follow = use the household
//       address, else keep their own. A non-member is refused "not_a_member".
//   getFollowChoice(db, { householdId, userId }): Promise<boolean>
//     • the member's choice; defaults to false (keep own) until set; a non-member reads false.
//   getEffectivePostalAddress(db, { userId, own }, dek, clock): Promise<EffectivePostalAddress | null>
//     • resolves the member's effective postal address AT `clock.now()`: if the member follows
//       their household AND a shared address exists → the SHARED record (source "household"),
//       else their OWN record (source "own"). `own` (the member's vault postal address, read by
//       the caller) is { current, upcoming?, movingOn? } | null; when the effective record is
//       own and own is null, the result is null. The date-swap is applied to whichever record
//       is effective: an upcoming address with a moving-on date in the past becomes current.
//
// Acceptance criteria → tests:
//   AC1 "The shared address is stored DEK-encrypted and can be edited by the owner or any
//        member, and each edit records a notification to every other member via the configured
//        sender (dev outbox in dev)." — setSharedAddress stores current/upcoming encrypted at
//        rest and round-trips via getSharedAddress; both the owner and a non-owner member may
//        edit; every edit notifies exactly the OTHER members.
//   AC2 "A member who chooses 'use the household address' has their effective postal address
//        resolve to the shared one including any upcoming address and moving-on date, while a
//        member who keeps their own resolves to their vault postal address." —
//        getEffectivePostalAddress returns the shared record (with the date-swap) for a follower
//        and the own record for a non-follower.
//   AC3 "Only members of the household may read or edit the shared address or set their own
//        follow choice (filtered by session user id)." — a non-member's read is null, their
//        edit / follow-choice is refused; one household's address never leaks into another's.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed /
//        mis-shaped input with a 4xx before any query runs; a SQL-injection probe routed through
//        the repo travels as a BOUND value (placeholders, never concatenation) and cannot alter
//        a query. The handlers below are test fixtures (the intended usage), not implementation
//        files.
//   AC5 [obligation:secrets-from-env] (INV-103) — the repo takes `db`, the `dek` and the notifier
//        as injected dependencies, holds no key/secret and reads no `process.env`. Shown
//        behaviourally: the value encrypts under the INJECTED dek (a different dek cannot read it
//        back — not a baked-in key), and a decoy secret planted in the environment never lands in
//        a stored or returned shared address.
//   Migration: the `household_shared_address` relation exists after the project migrations and a
//        second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db test
// uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so tests
// share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import {
  setSharedAddress,
  getSharedAddress,
  setFollowChoice,
  getFollowChoice,
  getEffectivePostalAddress,
} from "./household-shared-address";
import { createHousehold, addMember } from "./households";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db, type QueryResult } from "./index";
import { parseBody, HttpError } from "../http/validate";
import { fixedClock, type Clock } from "../seams/clock";
import type { EmailContent } from "../notify/email";

// --- pinned shapes, derived from the store's own signatures so a later type rename that
// preserves behaviour does not redden these tests. ---------------------------------------
type SharedAddress = NonNullable<Awaited<ReturnType<typeof getSharedAddress>>>;
type EffectivePostalAddress = NonNullable<Awaited<ReturnType<typeof getEffectivePostalAddress>>>;

// --- fixtures ----------------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit data key (the household's shared values decrypt under it)

// A fresh random 256-bit DEK. The real key is unwrapped from the KeyWrapper seam a layer up;
// this repo only ever receives the already-unwrapped bytes.
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque base64; this module never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A db seam stand-in that records every call instead of running it, so a test can prove WHAT
// reached the query layer and HOW (bound value vs. spliced text). It returns no rows and
// satisfies the `Db` shape structurally (query + close).
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []): Promise<QueryResult> {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// The injected notifier seam, recorded: every notifyMember call is captured so a test can prove
// WHICH members were notified (and what the body carried). The composition root wires the dev
// outbox (dev) / the real senders (prod) behind this same seam, like the approval notifier's
// injected push sender — the module depends only on the seam, never a concrete Azure sender.
interface RecordingNotifier {
  readonly calls: { userId: string; body: string; email?: EmailContent }[];
  notifyMember(message: { userId: string; body: string; email?: EmailContent }): Promise<void>;
}
function recordingNotifier(): RecordingNotifier {
  const calls: { userId: string; body: string; email?: EmailContent }[] = [];
  return {
    calls,
    notifyMember(message: { userId: string; body: string; email?: EmailContent }): Promise<void> {
      calls.push({ userId: message.userId, body: message.body, ...(message.email ? { email: message.email } : {}) });
      return Promise.resolve();
    },
  };
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the relation
// name when it exists and NULL when it does not — a non-throwing probe scoped to the table under
// test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Assert a probe reached the query layer as a BOUND value and never as spliced SQL text, scoped
// to each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// Every base table in the database (table-name-agnostic), so an at-rest scan does not pin the
// exact storage layout the builder chooses (the shared address and the follow choice may live
// in one or several relations).
async function allPublicTables(db: Db): Promise<string[]> {
  const result = await db.query(
    "SELECT table_name FROM information_schema.tables " +
      "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
  );
  return result.rows.map((row) => String(row.table_name));
}

// Assert a UNIQUE plaintext marker appears in NO column of ANY table. The marker is nonce-like,
// so any raw occurrence is a genuine plaintext leak — personal content must be encrypted at rest
// everywhere it is stored, and an ambient env value must never be folded into storage.
async function assertMarkerNowhereInPlaintext(db: Db, marker: string): Promise<void> {
  for (const table of await allPublicTables(db)) {
    const all = await db.query(`SELECT * FROM "${table}"`);
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(marker), `plaintext "${marker}" must not appear in table "${table}"`);
        }
      }
    }
  }
}

// Normalise a moving-on date to a YYYY-MM-DD string regardless of whether the driver hands it
// back as a Date (pg `date` ⇒ local-midnight Date) or an ISO string — either is a reasonable
// representation and must not redden a test.
function dateOnly(value: Date | string | number): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

// The set of member ids a batch of notifications reached.
function notifiedIds(notifier: RecordingNotifier): Set<string> {
  return new Set(notifier.calls.map((c) => c.userId));
}

// A clock for the resolution cases where the date-swap does not matter.
const CLOCK: Clock = fixedClock(new Date("2027-01-15T00:00:00Z"));

// A household with its owner plus the named extra members, all sharing one DEK (the shared values
// are readable by every member, so every member decrypts them under the same key).
async function makeHousehold(
  db: Db,
  owner: string,
  others: string[] = [],
): Promise<{ householdId: string; ownerId: string; memberIds: string[]; dek: Uint8Array }> {
  const ownerId = await makeUser(db, owner);
  const house = await createHousehold(db, { ownerId });
  const memberIds = [ownerId];
  for (const who of others) {
    const id = await makeUser(db, who);
    await addMember(db, { householdId: house.id, userId: id });
    memberIds.push(id);
  }
  return { householdId: house.id, ownerId, memberIds, dek: freshDek() };
}

// ===========================================================================
// AC1 — the shared address is stored DEK-encrypted and round-trips to a member.
// ===========================================================================

test("setSharedAddress stores the current address and getSharedAddress round-trips it for a member", async () => {
  const db = await freshDb();
  try {
    const { householdId, ownerId, dek } = await makeHousehold(db, "s1-owner");

    const result = await setSharedAddress(
      db,
      { householdId, actorId: ownerId, current: "12 Shared St, Sydney NSW 2000" },
      dek,
      { notify: recordingNotifier() },
    );
    assert.equal(result.ok, true, "the owner may set the shared address");
    if (result.ok) {
      assert.equal(result.address.current, "12 Shared St, Sydney NSW 2000", "the result carries the stored current address");
      assert.equal(result.address.upcoming, null, "no upcoming address was set");
    }

    const read: SharedAddress | null = await getSharedAddress(db, { householdId, userId: ownerId }, dek);
    assert.ok(read, "a member reads the shared address back");
    assert.equal(read!.current, "12 Shared St, Sydney NSW 2000", "the current address decrypts back to what was stored");
    assert.ok(read!.upcoming === null || read!.upcoming === undefined, "an unset upcoming address reads as absent");
    assert.ok(read!.movingOn === null || read!.movingOn === undefined, "an unset moving-on date reads as absent");
  } finally {
    await db.close();
  }
});

test("setSharedAddress stores the optional upcoming address and moving-on date, and they round-trip", async () => {
  const db = await freshDb();
  try {
    const { householdId, ownerId, dek } = await makeHousehold(db, "s1-upcoming");

    await setSharedAddress(
      db,
      {
        householdId,
        actorId: ownerId,
        current: "12 Old St, Sydney NSW 2000",
        upcoming: "99 New Rd, Melbourne VIC 3000",
        movingOn: "2027-03-01",
      },
      dek,
      { notify: recordingNotifier() },
    );

    const read = await getSharedAddress(db, { householdId, userId: ownerId }, dek);
    assert.ok(read, "the shared address is read back");
    assert.equal(read!.current, "12 Old St, Sydney NSW 2000", "the current address round-trips");
    assert.equal(read!.upcoming, "99 New Rd, Melbourne VIC 3000", "the upcoming address round-trips decrypted");
    assert.equal(dateOnly(read!.movingOn as Date | string), "2027-03-01", "the moving-on date round-trips");
  } finally {
    await db.close();
  }
});

test("the shared address values are stored DEK-encrypted: the plaintext never appears in any column", async () => {
  const db = await freshDb();
  try {
    const { householdId, ownerId, dek } = await makeHousehold(db, "s1-atrest");
    const marker = "LEAKCHECK_shared_addr_9x7Q unit 4, 12 Example St";

    await setSharedAddress(
      db,
      { householdId, actorId: ownerId, current: marker, upcoming: `${marker} (next)` },
      dek,
      { notify: recordingNotifier() },
    );

    // The address is personal content that MUST be encrypted at rest; the marker is unique, so
    // any raw occurrence is a real plaintext leak. Scanned across every table so the check does
    // not depend on the storage layout.
    await assertMarkerNowhereInPlaintext(db, marker);

    // …yet it round-trips decrypted under the owner's DEK.
    const read = await getSharedAddress(db, { householdId, userId: ownerId }, dek);
    assert.equal(read!.current, marker, "the encrypted current address decrypts back verbatim");
  } finally {
    await db.close();
  }
});

test("a later edit replaces the household's one shared address (an upsert, not a second record)", async () => {
  const db = await freshDb();
  try {
    const { householdId, ownerId, dek } = await makeHousehold(db, "s1-edit");

    await setSharedAddress(db, { householdId, actorId: ownerId, current: "First Address" }, dek, { notify: recordingNotifier() });
    await setSharedAddress(
      db,
      { householdId, actorId: ownerId, current: "Second Address", movingOn: "2028-01-01" },
      dek,
      { notify: recordingNotifier() },
    );

    const read = await getSharedAddress(db, { householdId, userId: ownerId }, dek);
    assert.equal(read!.current, "Second Address", "the latest edit wins — there is one shared address per household");
    assert.equal(dateOnly(read!.movingOn as Date | string), "2028-01-01", "the latest edit's moving-on date reads back");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — editable by the OWNER or ANY member.
// ===========================================================================

test("a non-owner member may edit the shared address (any member can edit, not only the owner)", async () => {
  const db = await freshDb();
  try {
    const { householdId, memberIds, dek } = await makeHousehold(db, "s1-anyedit-owner", ["s1-anyedit-member"]);
    const bob = memberIds[1]!;

    const result = await setSharedAddress(
      db,
      { householdId, actorId: bob, current: "A member-set address" },
      dek,
      { notify: recordingNotifier() },
    );
    assert.equal(result.ok, true, "a plain member — not the owner — may edit the shared address");

    const read = await getSharedAddress(db, { householdId, userId: bob }, dek);
    assert.equal(read!.current, "A member-set address", "the member's edit landed");
  } finally {
    await db.close();
  }
});

test("a non-member cannot edit the shared address, and nothing is stored or sent", async () => {
  const db = await freshDb();
  try {
    const { householdId, ownerId, dek } = await makeHousehold(db, "s1-nonmember-edit");
    await setSharedAddress(db, { householdId, actorId: ownerId, current: "Owner address" }, dek, { notify: recordingNotifier() });

    const stranger = await makeUser(db, "s1-stranger");
    const notifier = recordingNotifier();
    const result = await setSharedAddress(
      db,
      { householdId, actorId: stranger, current: "Intruder address" },
      dek,
      { notify: notifier },
    );
    assert.equal(result.ok, false, "a non-member cannot edit the shared address");
    if (!result.ok) assert.equal(result.reason, "not_a_member", "the refusal says the actor is not a member");

    assert.equal(notifier.calls.length, 0, "a refused edit sends no notifications");
    assert.equal(
      (await getSharedAddress(db, { householdId, userId: ownerId }, dek))!.current,
      "Owner address",
      "the shared address is unchanged by the refused edit",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — each edit notifies every OTHER member via the configured sender.
// ===========================================================================

test("editing the shared address notifies every OTHER member, never the editor", async () => {
  const db = await freshDb();
  try {
    const { householdId, memberIds, dek } = await makeHousehold(db, "notify-owner", ["notify-bob", "notify-carol"]);
    const [alice, bob, carol] = memberIds as [string, string, string];

    // Bob edits → Alice and Carol are notified, Bob is not.
    const notifier = recordingNotifier();
    const result = await setSharedAddress(db, { householdId, actorId: bob, current: "New shared address" }, dek, { notify: notifier });
    assert.equal(result.ok, true, "the edit succeeds");

    assert.deepEqual(
      notifiedIds(notifier),
      new Set([alice, carol]),
      "exactly the other two members are notified",
    );
    assert.ok(!notifiedIds(notifier).has(bob), "the editor is never notified of their own edit");
    assert.equal(notifier.calls.length, 2, "one notification per other member — no duplicates");
  } finally {
    await db.close();
  }
});

test("the owner's edit notifies every member except the owner", async () => {
  const db = await freshDb();
  try {
    const { householdId, memberIds, dek } = await makeHousehold(db, "notify-owneredit", ["notify-x", "notify-y"]);
    const [alice, x, y] = memberIds as [string, string, string];

    const notifier = recordingNotifier();
    await setSharedAddress(db, { householdId, actorId: alice, current: "Owner edited this" }, dek, { notify: notifier });

    assert.deepEqual(notifiedIds(notifier), new Set([x, y]), "both members are notified of the owner's edit");
    assert.ok(!notifiedIds(notifier).has(alice), "the owner (the editor) is not notified");
  } finally {
    await db.close();
  }
});

test("a lone-member household's edit notifies no one (there is no other member)", async () => {
  const db = await freshDb();
  try {
    const { householdId, ownerId, dek } = await makeHousehold(db, "notify-lone");

    const notifier = recordingNotifier();
    await setSharedAddress(db, { householdId, actorId: ownerId, current: "Just me" }, dek, { notify: notifier });

    assert.equal(notifier.calls.length, 0, "with no other members, an edit sends no notifications");
  } finally {
    await db.close();
  }
});

test("every edit — including a subsequent one — re-notifies the other members", async () => {
  const db = await freshDb();
  try {
    const { householdId, memberIds, dek } = await makeHousehold(db, "notify-again-owner", ["notify-again-bob"]);
    const [alice, bob] = memberIds as [string, string];

    const first = recordingNotifier();
    await setSharedAddress(db, { householdId, actorId: alice, current: "v1" }, dek, { notify: first });
    assert.deepEqual(notifiedIds(first), new Set([bob]), "the first edit notifies the other member");

    const second = recordingNotifier();
    await setSharedAddress(db, { householdId, actorId: bob, current: "v2" }, dek, { notify: second });
    assert.deepEqual(notifiedIds(second), new Set([alice]), "the second edit (by the other member) notifies back");
  } finally {
    await db.close();
  }
});

test("a notification does not leak the address plaintext (personal content stays out of the channel)", async () => {
  const db = await freshDb();
  try {
    const { householdId, memberIds, dek } = await makeHousehold(db, "notify-noleak-owner", ["notify-noleak-bob"]);
    const alice = memberIds[0]!;
    const marker = "ZZXWARTHOGADDRZZ 404 Nowhere St";

    const notifier = recordingNotifier();
    await setSharedAddress(db, { householdId, actorId: alice, current: marker }, dek, { notify: notifier });

    assert.ok(notifier.calls.length >= 1, "the other member was notified");
    for (const call of notifier.calls) {
      assert.ok(
        !call.body.includes(marker),
        "the notification tells members the address changed WITHOUT carrying the address plaintext",
      );
    }
  } finally {
    await db.close();
  }
});

test("the shared-address email is branded and, like the body, carries no address", async () => {
  const db = await freshDb();
  try {
    const { householdId, memberIds, dek } = await makeHousehold(db, "notify-branded-owner", ["notify-branded-bob"]);
    const marker = "ZZXWARTHOGBRANDEDZZ 404 Nowhere St";
    const notifier = recordingNotifier();
    await setSharedAddress(db, { householdId, actorId: memberIds[0]!, current: marker }, dek, { notify: notifier });
    const email = notifier.calls[0]!.email!;
    assert.equal(email.subject, "Your household's shared address changed");
    assert.equal(email.heading, "Your shared address was updated");
    assert.match(email.paragraphs.join(" "), /Open Warthog to see the new address/);
    assert.ok(!JSON.stringify(email).includes("ZZXWARTHOGBRANDEDZZ"), "no address plaintext in the email");
    assert.equal(email.action, undefined);
  } finally {
    await db.close();
  }
});

test("editing one household's address never notifies another household's members", async () => {
  const db = await freshDb();
  try {
    const houseA = await makeHousehold(db, "iso-a-owner", ["iso-a-bob"]);
    const houseB = await makeHousehold(db, "iso-b-owner", ["iso-b-carol"]);

    const notifier = recordingNotifier();
    await setSharedAddress(db, { householdId: houseA.householdId, actorId: houseA.ownerId, current: "A's address" }, houseA.dek, { notify: notifier });

    assert.deepEqual(notifiedIds(notifier), new Set([houseA.memberIds[1]!]), "only household A's other member is notified");
    for (const bId of houseB.memberIds) {
      assert.ok(!notifiedIds(notifier).has(bId), "no member of household B is notified of A's edit");
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — the follow choice, and the effective-address resolution.
// ===========================================================================

test("the follow choice defaults to false (keep own) and round-trips once set", async () => {
  const db = await freshDb();
  try {
    const { householdId, ownerId } = await makeHousehold(db, "follow-default");

    assert.equal(await getFollowChoice(db, { householdId, userId: ownerId }), false, "a member who has not chosen keeps their own (false)");

    const set = await setFollowChoice(db, { householdId, userId: ownerId, follow: true });
    assert.equal(set.ok, true, "a member may opt in to the household address");
    if (set.ok) assert.equal(set.follow, true, "the result carries the stored choice");
    assert.equal(await getFollowChoice(db, { householdId, userId: ownerId }), true, "the choice reads back as true");

    await setFollowChoice(db, { householdId, userId: ownerId, follow: false });
    assert.equal(await getFollowChoice(db, { householdId, userId: ownerId }), false, "a member may switch back to keeping their own");
  } finally {
    await db.close();
  }
});

test("a follower's effective postal address resolves to the shared address", async () => {
  const db = await freshDb();
  try {
    const { householdId, ownerId, dek } = await makeHousehold(db, "eff-follow");
    await setSharedAddress(db, { householdId, actorId: ownerId, current: "5 Shared Plain St" }, dek, { notify: recordingNotifier() });
    await setFollowChoice(db, { householdId, userId: ownerId, follow: true });

    const effective: EffectivePostalAddress | null = await getEffectivePostalAddress(
      db,
      { userId: ownerId, own: { current: "7 Private Ln" } },
      dek,
      CLOCK,
    );
    assert.ok(effective, "a follower resolves to an address");
    assert.equal(effective!.source, "household", "a follower's effective address comes from the household");
    assert.equal(effective!.current, "5 Shared Plain St", "it is the shared address, not the member's own");
  } finally {
    await db.close();
  }
});

test("a follower's effective address carries the shared upcoming address before the moving date", async () => {
  const db = await freshDb();
  try {
    const { householdId, ownerId, dek } = await makeHousehold(db, "eff-upcoming-before");
    await setSharedAddress(
      db,
      { householdId, actorId: ownerId, current: "12 Old St", upcoming: "99 New Rd", movingOn: "2027-03-01" },
      dek,
      { notify: recordingNotifier() },
    );
    await setFollowChoice(db, { householdId, userId: ownerId, follow: true });

    // Two months BEFORE the move: both the current and the upcoming address are returned.
    const before: Clock = fixedClock(new Date("2027-01-01T00:00:00Z"));
    const effective = await getEffectivePostalAddress(db, { userId: ownerId, own: { current: "own" } }, dek, before);
    assert.equal(effective!.source, "household", "a follower resolves to the shared record");
    assert.equal(effective!.current, "12 Old St", "before the move the current address is still current");
    assert.equal(effective!.upcoming, "99 New Rd", "the upcoming address is included before the move");
    assert.equal(dateOnly(effective!.movingOn as Date | string), "2027-03-01", "the moving-on date is included before the move");
  } finally {
    await db.close();
  }
});

test("on or after the moving date the shared upcoming address becomes current (the date-swap)", async () => {
  const db = await freshDb();
  try {
    const { householdId, ownerId, dek } = await makeHousehold(db, "eff-upcoming-after");
    await setSharedAddress(
      db,
      { householdId, actorId: ownerId, current: "12 Old St", upcoming: "99 New Rd", movingOn: "2027-03-01" },
      dek,
      { notify: recordingNotifier() },
    );
    await setFollowChoice(db, { householdId, userId: ownerId, follow: true });

    // Three months AFTER the move: the upcoming address has become current and no upcoming remains.
    const after: Clock = fixedClock(new Date("2027-06-01T00:00:00Z"));
    const effective = await getEffectivePostalAddress(db, { userId: ownerId, own: { current: "own" } }, dek, after);
    assert.equal(effective!.source, "household", "still the household record");
    assert.equal(effective!.current, "99 New Rd", "after the move the upcoming address is now current");
    assert.ok(effective!.upcoming === null || effective!.upcoming === undefined, "no upcoming address remains after the move");
    assert.ok(effective!.movingOn === null || effective!.movingOn === undefined, "no moving-on date remains after the move");
  } finally {
    await db.close();
  }
});

test("a member who keeps their own resolves to their own vault postal address, not the shared one", async () => {
  const db = await freshDb();
  try {
    const { householdId, ownerId, dek } = await makeHousehold(db, "eff-keepown");
    await setSharedAddress(db, { householdId, actorId: ownerId, current: "5 Shared Plain St" }, dek, { notify: recordingNotifier() });
    // The default choice is to keep their own; make it explicit for clarity.
    await setFollowChoice(db, { householdId, userId: ownerId, follow: false });

    const effective = await getEffectivePostalAddress(
      db,
      { userId: ownerId, own: { current: "7 Private Ln" } },
      dek,
      CLOCK,
    );
    assert.ok(effective, "a non-follower with an own address resolves to it");
    assert.equal(effective!.source, "own", "a non-follower's effective address comes from their own record");
    assert.equal(effective!.current, "7 Private Ln", "it is the member's own address, not the shared one");
  } finally {
    await db.close();
  }
});

test("two members of one household resolve independently by their own follow choice", async () => {
  const db = await freshDb();
  try {
    const { householdId, memberIds, dek } = await makeHousehold(db, "eff-percap-owner", ["eff-percap-bob"]);
    const [alice, bob] = memberIds as [string, string];
    await setSharedAddress(db, { householdId, actorId: alice, current: "The Shared Address" }, dek, { notify: recordingNotifier() });

    await setFollowChoice(db, { householdId, userId: alice, follow: true });
    await setFollowChoice(db, { householdId, userId: bob, follow: false });

    const aliceEff = await getEffectivePostalAddress(db, { userId: alice, own: { current: "Alice's own" } }, dek, CLOCK);
    const bobEff = await getEffectivePostalAddress(db, { userId: bob, own: { current: "Bob's own" } }, dek, CLOCK);

    assert.equal(aliceEff!.source, "household", "the follower (Alice) gets the shared address");
    assert.equal(aliceEff!.current, "The Shared Address", "Alice's effective address is the shared one");
    assert.equal(bobEff!.source, "own", "the non-follower (Bob) keeps his own");
    assert.equal(bobEff!.current, "Bob's own", "Bob's effective address is his own, not the shared one and not Alice's");
  } finally {
    await db.close();
  }
});

test("a follower with no shared address set falls back to their own address", async () => {
  const db = await freshDb();
  try {
    const { householdId, ownerId, dek } = await makeHousehold(db, "eff-follow-noshared");
    // The member opts in, but no shared address has ever been set for the household.
    await setFollowChoice(db, { householdId, userId: ownerId, follow: true });

    const effective = await getEffectivePostalAddress(db, { userId: ownerId, own: { current: "9 Fallback Rd" } }, dek, CLOCK);
    assert.equal(effective!.source, "own", "with no shared address to follow, the member keeps their own");
    assert.equal(effective!.current, "9 Fallback Rd", "the own address is returned");
  } finally {
    await db.close();
  }
});

test("a person in no household resolves to their own address", async () => {
  const db = await freshDb();
  try {
    const loner = await makeUser(db, "eff-nohousehold");
    const effective = await getEffectivePostalAddress(db, { userId: loner, own: { current: "1 Solo St" } }, freshDek(), CLOCK);
    assert.equal(effective!.source, "own", "a person in no household resolves to their own address");
    assert.equal(effective!.current, "1 Solo St", "the own address is returned");
  } finally {
    await db.close();
  }
});

test("a non-follower with no own address resolves to null", async () => {
  const db = await freshDb();
  try {
    const { householdId, ownerId, dek } = await makeHousehold(db, "eff-own-null");
    await setSharedAddress(db, { householdId, actorId: ownerId, current: "A shared address" }, dek, { notify: recordingNotifier() });
    await setFollowChoice(db, { householdId, userId: ownerId, follow: false });

    const effective = await getEffectivePostalAddress(db, { userId: ownerId, own: null }, dek, CLOCK);
    assert.equal(effective, null, "a non-follower with no own address has no effective postal address");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — only members may read / edit the shared address or set their follow choice,
// filtered by the session user id.
// ===========================================================================

test("a non-member cannot read a household's shared address (reads null)", async () => {
  const db = await freshDb();
  try {
    const { householdId, ownerId, dek } = await makeHousehold(db, "read-nonmember-owner");
    await setSharedAddress(db, { householdId, actorId: ownerId, current: "Members only" }, dek, { notify: recordingNotifier() });

    const stranger = await makeUser(db, "read-stranger");
    assert.equal(
      await getSharedAddress(db, { householdId, userId: stranger }, dek),
      null,
      "a non-member reads null for a household's shared address",
    );
  } finally {
    await db.close();
  }
});

test("one household's shared address never leaks into another household member's read", async () => {
  const db = await freshDb();
  try {
    const houseA = await makeHousehold(db, "leak-a-owner");
    const houseB = await makeHousehold(db, "leak-b-owner");
    await setSharedAddress(db, { householdId: houseA.householdId, actorId: houseA.ownerId, current: "A's secret address" }, houseA.dek, { notify: recordingNotifier() });

    // B's owner, a member of B only, cannot read A's shared address.
    assert.equal(
      await getSharedAddress(db, { householdId: houseA.householdId, userId: houseB.ownerId }, houseA.dek),
      null,
      "a member of another household reads null, not A's address",
    );
  } finally {
    await db.close();
  }
});

test("a non-member cannot set a follow choice for a household they do not belong to", async () => {
  const db = await freshDb();
  try {
    const { householdId } = await makeHousehold(db, "follow-nonmember-owner");
    const stranger = await makeUser(db, "follow-stranger");

    const result = await setFollowChoice(db, { householdId, userId: stranger, follow: true });
    assert.equal(result.ok, false, "a non-member cannot set a follow choice");
    if (!result.ok) assert.equal(result.reason, "not_a_member", "the refusal says they are not a member");
    assert.equal(await getFollowChoice(db, { householdId, userId: stranger }), false, "a non-member's choice reads false");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("setSharedAddress binds the household id and actor id as parameters (membership check)", async () => {
  const db = recordingDb();
  const probe = "h'); DROP TABLE household_shared_address; --";
  // The recording db returns no rows, so the membership check concludes "not a member" and
  // nothing is stored — but the membership-check statement must have BOUND the probe.
  const result = await setSharedAddress(
    db,
    { householdId: probe, actorId: probe, current: "x" },
    freshDek(),
    { notify: recordingNotifier() },
  );
  assert.equal(result.ok, false, "no rows from the recording db → the actor is not a member");
  assertBoundNotSpliced(db, probe);
});

test("getSharedAddress binds the household id and user id as parameters", async () => {
  const db = recordingDb();
  const probe = "g'); DROP TABLE household_shared_address; --";
  const result = await getSharedAddress(db, { householdId: probe, userId: probe }, freshDek());
  assert.equal(result, null, "the recording db returns no rows, so the read is null");
  assertBoundNotSpliced(db, probe);
});

test("setFollowChoice binds the household id and user id as parameters", async () => {
  const db = recordingDb();
  const probe = "f'); DROP TABLE household_members; --";
  const result = await setFollowChoice(db, { householdId: probe, userId: probe, follow: true });
  assert.equal(result.ok, false, "no rows from the recording db → not a member");
  assertBoundNotSpliced(db, probe);
});

test("getEffectivePostalAddress binds the user id as a parameter", async () => {
  const db = recordingDb();
  const probe = "e'); DROP TABLE households; --";
  const result = await getEffectivePostalAddress(db, { userId: probe, own: null }, freshDek(), CLOCK);
  assert.equal(result, null, "with no household and no own address the result is null");
  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe in the address value is stored as data: the tables survive and it round-trips", async () => {
  const db = await freshDb();
  try {
    const { householdId, ownerId, dek } = await makeHousehold(db, "inject-value");
    const probe = "Grace'); DROP TABLE household_shared_address; --";

    await setSharedAddress(db, { householdId, actorId: ownerId, current: probe }, dek, { notify: recordingNotifier() });

    assert.equal(await tableExists(db, "households"), true, "the households table survives the probe");
    const read = await getSharedAddress(db, { householdId, userId: ownerId }, dek);
    assert.equal(read!.current, probe, "the probe round-trips verbatim as data, never interpreted as SQL");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in a household id is bound, never run: the household tables survive", async () => {
  const db = await freshDb();
  try {
    const probe = "h'); DROP TABLE households; --";
    // A non-uuid probe either matches nothing or errors on the uuid cast — either way the
    // statement is a bound read, never injected SQL.
    try {
      await getSharedAddress(db, { householdId: probe, userId: probe }, freshDek());
    } catch {
      /* tolerate a type/cast error — the point is that no injected statement ran */
    }
    assert.equal(await tableExists(db, "households"), true, "the households table survives the probe");
    assert.equal(await tableExists(db, "household_members"), true, "the household_members table survives the probe");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — handlers on the validation boundary reject bad input and take the actor from
// the session. These handlers are test fixtures (the intended usage), not implementation files.
// ===========================================================================

function setSharedAddressHandler(
  db: Db,
  dek: Uint8Array,
  sessionUserId: string,
  notify: RecordingNotifier,
): (req: Request) => Promise<Response> {
  // The body carries the household id and the address fields; the actor comes from the session,
  // never the body. The household id is validated to the uuid shape at the boundary (OBS-049),
  // so a mis-shaped id is rejected with a 4xx and never reaches a `WHERE … = $1`.
  const schema = z.object({
    householdId: z.uuid(),
    current: z.string().min(1).max(4096),
    upcoming: z.string().min(1).max(4096).optional(),
    movingOn: z.iso.date().optional(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 8 * 1024 });
      const result = await setSharedAddress(
        db,
        {
          householdId: body.householdId,
          actorId: sessionUserId,
          current: body.current,
          upcoming: body.upcoming,
          movingOn: body.movingOn,
        },
        dek,
        { notify },
      );
      if (!result.ok) {
        // A refusal (not a member) is a client error, reported honestly — never a silent no-op.
        return new Response(JSON.stringify({ error: result.reason }), { status: 403 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test sees
      // the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function setFollowHandler(db: Db, sessionUserId: string): (req: Request) => Promise<Response> {
  const schema = z.object({ householdId: z.uuid(), follow: z.boolean() });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const result = await setFollowChoice(db, {
        householdId: body.householdId,
        userId: sessionUserId,
        follow: body.follow,
      });
      if (!result.ok) {
        return new Response(JSON.stringify({ error: result.reason }), { status: 403 });
      }
      return new Response(JSON.stringify({ follow: result.follow }), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/household/address", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

// A fully-valid address body, for the tests that vary one thing.
function validBody(householdId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ householdId, current: "12 Valid St, Sydney NSW 2000", ...overrides });
}

// A valid-uuid-shaped household id that does not exist (for the boundary tests that must not
// reach a real row).
const ABSENT_HOUSE = "99999999-9999-4999-8999-999999999999";

test("the address handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = setSharedAddressHandler(db, freshDek(), "session-user", recordingNotifier());

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the address handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = setSharedAddressHandler(db, freshDek(), "session-user", recordingNotifier());

  // ~20 KiB body, well over the handler's 8 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(validBody(ABSENT_HOUSE, { current: "a".repeat(20 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the address handler rejects a body missing the current address with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = setSharedAddressHandler(db, freshDek(), "session-user", recordingNotifier());

  const bad = JSON.parse(validBody(ABSENT_HOUSE)) as Record<string, unknown>;
  delete bad.current;
  const res = await handler(jsonRequest(JSON.stringify(bad)));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the address handler rejects a mis-typed current address with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = setSharedAddressHandler(db, freshDek(), "session-user", recordingNotifier());

  const res = await handler(jsonRequest(validBody(ABSENT_HOUSE, { current: 42 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed current address must never reach a query");
});

test("the address handler rejects a mis-shaped (non-uuid) household id with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = setSharedAddressHandler(db, freshDek(), "session-user", recordingNotifier());

  // An injection-shaped id is not a uuid, so it is rejected at the boundary (OBS-049) and never
  // reaches a `WHERE … = $1` cast.
  const probe = "h'); DROP TABLE household_shared_address; --";
  const res = await handler(jsonRequest(validBody(probe)));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-shaped household id must never reach a query");
});

test("the address handler takes the actor from the session, not the body", async () => {
  const db = await freshDb();
  try {
    const { householdId, ownerId, dek } = await makeHousehold(db, "handler-actor-owner");
    const attacker = await makeUser(db, "handler-actor-attacker");

    // A member's session may edit.
    const ownerHandler = setSharedAddressHandler(db, dek, ownerId, recordingNotifier());
    const ok = await ownerHandler(jsonRequest(validBody(householdId, { current: "Owner's address" })));
    assert.ok(ok.status >= 200 && ok.status < 300, `member expected a 2xx, got ${ok.status}`);
    assert.equal((await getSharedAddress(db, { householdId, userId: ownerId }, dek))!.current, "Owner's address", "the member's edit landed");

    // The attacker's session smuggles a member id in the body; the handler ignores it and uses
    // the SESSION id (the attacker, a non-member), so the edit is refused and nothing changes.
    const attackerHandler = setSharedAddressHandler(db, dek, attacker, recordingNotifier());
    const refused = await attackerHandler(
      jsonRequest(validBody(householdId, { current: "Intruder address", actorId: ownerId, userId: ownerId })),
    );
    assert.ok(refused.status >= 400 && refused.status < 500, `attacker expected a 4xx, got ${refused.status}`);
    assert.equal(
      (await getSharedAddress(db, { householdId, userId: ownerId }, dek))!.current,
      "Owner's address",
      "the smuggled actor id is ignored — the address is unchanged",
    );
  } finally {
    await db.close();
  }
});

test("the address handler binds the household id as a parameter (never spliced)", async () => {
  const db = recordingDb();
  const handler = setSharedAddressHandler(db, freshDek(), "session-user", recordingNotifier());

  // A valid-uuid id that will not match any row in the recording db: it passes validation,
  // reaches the repo, and must be bound (not spliced) into the membership-check statement.
  const res = await handler(jsonRequest(validBody(ABSENT_HOUSE)));
  assert.ok(res.status >= 400 && res.status < 500, "no membership row → a 4xx refusal");

  assert.ok(db.calls.length >= 1, "the handler reached a query");
  assert.ok(db.calls.some((c) => c.values.includes(ABSENT_HOUSE)), "the household id travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(ABSENT_HOUSE), "the id is bound, never concatenated into the SQL");
  }
});

test("the follow handler rejects a mis-typed / missing choice with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = setFollowHandler(db, "session-user");

  const misTyped = await handler(jsonRequest(JSON.stringify({ householdId: ABSENT_HOUSE, follow: "yes" })));
  assert.ok(misTyped.status >= 400 && misTyped.status < 500, `expected a 4xx, got ${misTyped.status}`);

  const missing = await handler(jsonRequest(JSON.stringify({ householdId: ABSENT_HOUSE })));
  assert.ok(missing.status >= 400 && missing.status < 500, `expected a 4xx, got ${missing.status}`);

  assert.equal(db.calls.length, 0, "a mis-typed or missing follow choice must never reach a query");
});

test("the follow handler sets the choice for the SESSION user, not a body-smuggled id", async () => {
  const db = await freshDb();
  try {
    const { householdId, memberIds } = await makeHousehold(db, "follow-handler-owner", ["follow-handler-bob"]);
    const [alice, bob] = memberIds as [string, string];

    const handler = setFollowHandler(db, alice);
    // The body smuggles Bob's id; the handler must apply the choice to the SESSION user (Alice).
    const res = await handler(jsonRequest(JSON.stringify({ householdId, follow: true, userId: bob })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal(await getFollowChoice(db, { householdId, userId: alice }), true, "Alice's choice (the session user) was set");
    assert.equal(await getFollowChoice(db, { householdId, userId: bob }), false, "Bob's choice (smuggled in the body) was not touched");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the value encrypts under the INJECTED dek, not a baked-in key; the repo reads no
// process.env (INV-103), shown behaviourally with a decoy secret in the environment.
// ===========================================================================

test("getSharedAddress cannot decrypt the shared address with a different DEK", async () => {
  const db = await freshDb();
  try {
    const { householdId, ownerId, dek } = await makeHousehold(db, "ac5-wrongdek");
    await setSharedAddress(db, { householdId, actorId: ownerId, current: "A private shared address" }, dek, { notify: recordingNotifier() });

    // A different DEK is the wrong key; the GCM tag must fail rather than return other bytes.
    const wrongDek = freshDek();
    await assert.rejects(
      async () => {
        await getSharedAddress(db, { householdId, userId: ownerId }, wrongDek);
      },
      "the address is bound to the injected DEK, not any ambient/hardcoded key",
    );
  } finally {
    await db.close();
  }
});

test("the repo reads no process.env: a decoy secret in the environment never lands in a shared address", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const { householdId, ownerId, dek } = await makeHousehold(db, "ac5-env");
    await setSharedAddress(
      db,
      { householdId, actorId: ownerId, current: "12 Env-check St", upcoming: "99 Env-check Rd", movingOn: "2027-09-09" },
      dek,
      { notify: recordingNotifier() },
    );
    await setFollowChoice(db, { householdId, userId: ownerId, follow: true });

    const read = await getSharedAddress(db, { householdId, userId: ownerId }, dek);
    assert.ok(read, "the address reads and writes purely from the injected db — no app env needed");
    assert.ok(!JSON.stringify(read).includes(DECOY), "no ambient env value is folded into the returned shared address");

    const effective = await getEffectivePostalAddress(db, { userId: ownerId, own: null }, dek, CLOCK);
    assert.ok(!JSON.stringify(effective).includes(DECOY), "no ambient env value is folded into the effective address");

    await assertMarkerNowhereInPlaintext(db, DECOY);
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===========================================================================
// Migration — the relation applies and a second run changes nothing.
// ===========================================================================

test("the household_shared_address migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "household_shared_address"),
      true,
      "the household_shared_address table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0041_household_shared_address"),
      "db/migrations/0041_household_shared_address.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw — re-executing
    // 0041's CREATE would throw "already exists", so an empty result AND no throw together prove
    // the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
