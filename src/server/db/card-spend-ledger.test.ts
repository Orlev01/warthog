// E07-S07 — Card spend ledger store (`src/server/db/card-spend-ledger.ts`,
// `db/migrations/0015_card_spend_ledger.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./card-spend-ledger` throws and `freshDb()` has no `card_spend_ledger` table — every
// test here fails until the builder adds them. That absence IS the point of test-first;
// do NOT implement anything to make these pass — the builder writes the module and the
// migration afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: a release is recorded
// and sums back, what the connection/member/household sums return, who may read what,
// that the amount/currency/merchant are stored as readable plaintext metadata, what a
// handler rejects, that every value is bound as a parameter), never the source text of
// the module or the SQL file — a later rename that preserves behaviour must not redden
// them.
//
// WHY this exists (design §8 policy step 4 "card requests", §4.1, brief "Card requests"
// + "Spending view"): on an approved card release Warthog records the approved amount,
// currency and merchant against the connection's budget, and the Spending page / the
// budget checks in the policy engine read approved-release TOTALS for the current
// period — per connection (an agent's budget), per member (the member's own limit) and
// per household (the shared household budget). Per design §4.1 the amount + currency +
// merchant name for card releases are PLAINTEXT METADATA (needed for budgets), so —
// unlike vault values, held-request args or rule conditions — they are NOT DEK-encrypted
// and this store holds no key and reads no `process.env`.
//
// The `connectionId` / `householdId` are opaque uuids here (the connections and
// household-membership tables are created by later migrations, so — exactly like
// 0011/0012/0013/0014 bind agent_id/connection_id/scope_agent_id — this store binds them
// by value, with every READ member-scoped by the session's user_id, not a foreign key to
// a table that does not exist yet). A household's total is the ONE cross-member aggregate
// the brief allows, and it is gated by the caller's own participation in that household.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   type PeriodKind = "day" | "week" | "month";   // the brief's budget periods
//
//   interface PeriodKeys {           // the period bucket a release falls in, one per
//     day: string;                   // granularity (opaque keys chosen by the caller,
//     week: string;                  // e.g. "2026-11-05" / "2026-W45" / "2026-11"); the
//     month: string;                 // store matches them verbatim, it does no date math
//   }
//
//   interface NewRelease {           // what recordRelease writes
//     userId: string;                // the member (the session's id, NEVER a client value)
//     connectionId: string;          // the agent connection the release counts against
//     householdId: string | null;    // the household it counts toward (null when solo)
//     amount: number;                // the approved amount, major units — PLAINTEXT
//     currency: string;              // PLAINTEXT metadata
//     merchant: string;              // PLAINTEXT metadata
//     periodKeys: PeriodKeys;        // the day/week/month buckets this release falls in
//   }
//   interface StoredRelease extends NewRelease {
//     id: string;                    // generated UP FRONT on record (not via RETURNING),
//   }                                // so the returned id never depends on a db round-trip
//
//   recordRelease(db, input: NewRelease): Promise<StoredRelease>
//     • inserts ONE ledger row for `input.userId` with the plaintext amount/currency/
//       merchant and the three period keys, and returns the StoredRelease (carrying the
//       generated id). No DEK — these columns are plaintext metadata (design §4.1).
//   sumForConnectionPeriod(db, userId, connectionId, period, periodKey): Promise<number>
//     • the total approved amount for THAT connection owned by `userId`, in the bucket
//       `period`/`periodKey`. Member-scoped (user_id AND connection_id both bound) — so a
//       connection belonging to another user sums to 0. Returns 0 when no row matches.
//   sumForMemberPeriod(db, userId, period, periodKey): Promise<number>
//     • the member's OWN total across ALL their connections in the period (user_id bound).
//   sumForHouseholdPeriod(db, userId, householdId, period, periodKey): Promise<number>
//     • the aggregate total across a household's members in the period (household_id
//       bound) — the one cross-member number the brief exposes. Gated by the SESSION user
//       id: returned only when `userId` participates in `householdId` (has at least one
//       ledger row there); a non-participant gets 0 (they cannot read the household's
//       total). It is only ever a NUMBER — never another member's merchants or rows.
//
// Acceptance criteria → tests:
//   AC1 "recordRelease writes a ledger row and sumForConnectionPeriod returns the total
//        approved amount for that connection in the given period." — a release is stored
//        (one row; amount/currency/merchant readable); the connection sum totals the
//        period's releases for that connection, excluding other connections and other
//        periods (day/week/month granularity).
//   AC2 "sumForMemberPeriod and sumForHouseholdPeriod aggregate across a member's
//        connections and a household's members." — a member's sum totals across their own
//        connections; a household's sum totals across its members.
//   AC3 "A user cannot read another user's ledger rows except the aggregate household
//        total exposed to household members (filtered by session user id)." — B's
//        connection/member sums never include A's spend; the household aggregate IS shared
//        between its members, but a non-member of the household reads 0.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed/oversized/mis-shaped input with a
//        4xx before any query runs; a SQL-injection probe routed through the repo travels
//        as a BOUND value (placeholders, never concatenation) and cannot drop the table.
//        The handler is a test fixture (the intended usage), not an implementation file.
//   AC5 [obligation:secrets-from-env] (INV-103) — the store reads no `process.env` and
//        holds no secret (config flows from `src/server/config.ts` alone), so a decoy
//        secret placed in the environment never lands in a stored or returned release.
//   Migration: the `card_spend_ledger` relation exists after the project migrations and a
//        second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  recordRelease,
  sumForConnectionPeriod,
  sumForMemberPeriod,
  sumForHouseholdPeriod,
} from "./card-spend-ledger";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { parseBody, HttpError } from "../http/validate";

// --- the pinned shapes, taken from the store's own signatures so a later type rename
// that preserves behaviour does not redden these tests. -----------------------------
type NewRelease = Parameters<typeof recordRelease>[1];
type StoredRelease = Awaited<ReturnType<typeof recordRelease>>;
type PeriodKind = Parameters<typeof sumForConnectionPeriod>[3];

// The brief's budget periods, as `as const` literals so each is assignable to the
// store's PeriodKind parameter without importing the type name.
const DAY = "day" as const satisfies PeriodKind;
const WEEK = "week" as const satisfies PeriodKind;
const MONTH = "month" as const satisfies PeriodKind;

// --- fixtures ----------------------------------------------------------------------

// A stand-in wrapped DEK for createUser (opaque base64; this module never reads it —
// the ledger stores only plaintext metadata, no encrypted column).
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

// Connection / household ids are uuids; use valid uuids so a `uuid` column accepts them.
const CONN_A = "11111111-1111-1111-1111-111111111111";
const CONN_B = "22222222-2222-2222-2222-222222222222";
const CONN_C = "33333333-3333-3333-3333-333333333333";
const HOUSE_H = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const HOUSE_H2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// Period buckets. Two days inside one week inside one month, plus a second month, so a
// test can prove each granularity filters independently.
const D5 = "2026-11-05";
const D6 = "2026-11-06";
const W45 = "2026-W45";
const W46 = "2026-W46";
const M_NOV = "2026-11";
const M_DEC = "2026-12";

// The three period keys for a release, defaulting to day D5 / week W45 / month M_NOV.
function keys(overrides: Partial<NewRelease["periodKeys"]> = {}): NewRelease["periodKeys"] {
  return { day: D5, week: W45, month: M_NOV, ...overrides };
}

// Amounts use quarter-dollar values (exactly representable in binary floating point), so
// the sums are exact and `assert.equal` on the number is safe.

// The release a test starts from, overriding only what it is about — a non-literal value
// passed to recordRelease, so excess-property checks never bite.
function makeRelease(userId: string, overrides: Partial<NewRelease> = {}): NewRelease {
  return {
    userId,
    connectionId: CONN_A,
    householdId: null,
    amount: 10.5,
    currency: "AUD",
    merchant: "BoxCo",
    periodKeys: keys(),
    ...overrides,
  };
}

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (bound value vs. spliced text). It returns no rows
// and satisfies the `Db` shape structurally (query + close).
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the
// relation name when it exists and NULL when it does not — a non-throwing probe scoped to
// the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// How many ledger rows exist for one person — proves recordRelease inserts exactly one
// row per release. A stored-state assertion (behaviour). The amount/currency/merchant
// columns are PLAINTEXT metadata (design §4.1), so reading them back is a legitimate
// state assertion, not a leak.
async function ledgerRowsFor(db: Db, userId: string): Promise<Record<string, unknown>[]> {
  const result = await db.query(
    "SELECT amount, currency, merchant, connection_id, household_id FROM card_spend_ledger WHERE user_id = $1",
    [userId],
  );
  return result.rows;
}

// ===========================================================================
// AC1 — recordRelease stores a release; sumForConnectionPeriod totals the
// period's releases for that connection.
// ===========================================================================

test("recordRelease stores one ledger row and returns it with an id and its content", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const input = makeRelease(userId, {
      connectionId: CONN_A,
      amount: 42.5,
      currency: "AUD",
      merchant: "BoxCo",
    });

    const saved = await recordRelease(db, input);

    assert.equal(typeof saved.id, "string", "recordRelease returns an id string");
    assert.ok(saved.id.length > 0, "the returned id is non-empty");
    assert.equal(saved.userId, userId, "the release belongs to the recording person");
    assert.equal(saved.connectionId, CONN_A, "the connection is preserved");
    assert.equal(saved.amount, 42.5, "the approved amount is preserved");
    assert.equal(saved.currency, "AUD", "the currency is preserved");
    assert.equal(saved.merchant, "BoxCo", "the merchant is preserved");

    // Exactly one row, and the amount/currency/merchant are stored as READABLE plaintext
    // metadata (design §4.1: these are explicitly allowed plaintext for budgets).
    const rows = await ledgerRowsFor(db, userId);
    assert.equal(rows.length, 1, "exactly one ledger row is written per release");
    assert.equal(Number(rows[0]!.amount), 42.5, "the amount is stored as a readable number");
    assert.equal(rows[0]!.currency, "AUD", "the currency is stored as readable plaintext");
    assert.equal(rows[0]!.merchant, "BoxCo", "the merchant is stored as readable plaintext");
  } finally {
    await db.close();
  }
});

test("recordRelease gives each release a distinct id", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-ids");
    const one = await recordRelease(db, makeRelease(userId));
    const two = await recordRelease(db, makeRelease(userId));
    assert.notEqual(one.id, two.id, "two recorded releases have different ids");
  } finally {
    await db.close();
  }
});

test("sumForConnectionPeriod returns the total approved amount for that connection in the period", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-connsum");

    // Two releases on connection A this month, one on connection B this month, and one on
    // connection A but in a different month.
    await recordRelease(db, makeRelease(userId, { connectionId: CONN_A, amount: 10.5, periodKeys: keys() }));
    await recordRelease(db, makeRelease(userId, { connectionId: CONN_A, amount: 20.25, periodKeys: keys() }));
    await recordRelease(db, makeRelease(userId, { connectionId: CONN_B, amount: 100.0, periodKeys: keys() }));
    await recordRelease(
      db,
      makeRelease(userId, { connectionId: CONN_A, amount: 5.25, periodKeys: keys({ month: M_DEC, week: W46, day: D6 }) }),
    );

    const totalA = await sumForConnectionPeriod(db, userId, CONN_A, MONTH, M_NOV);
    assert.equal(totalA, 30.75, "connection A's November total is just its two November releases");

    const totalB = await sumForConnectionPeriod(db, userId, CONN_B, MONTH, M_NOV);
    assert.equal(totalB, 100.0, "connection B's total is its own release, not A's");

    const totalADec = await sumForConnectionPeriod(db, userId, CONN_A, MONTH, M_DEC);
    assert.equal(totalADec, 5.25, "connection A's December total is only the December release");
  } finally {
    await db.close();
  }
});

test("sumForConnectionPeriod returns 0 when the connection has no release in the period", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-zero");
    await recordRelease(db, makeRelease(userId, { connectionId: CONN_A, amount: 10.5 }));

    assert.equal(
      await sumForConnectionPeriod(db, userId, CONN_C, MONTH, M_NOV),
      0,
      "a connection with no releases totals 0 (not undefined/NaN)",
    );
    assert.equal(
      await sumForConnectionPeriod(db, userId, CONN_A, MONTH, M_DEC),
      0,
      "a period with no releases totals 0",
    );
  } finally {
    await db.close();
  }
});

test("sumForConnectionPeriod matches the queried granularity independently (day vs week vs month)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-gran");

    // Two releases on connection A, same week and month but different days.
    await recordRelease(db, makeRelease(userId, { connectionId: CONN_A, amount: 10.5, periodKeys: keys({ day: D5 }) }));
    await recordRelease(db, makeRelease(userId, { connectionId: CONN_A, amount: 20.25, periodKeys: keys({ day: D6 }) }));

    assert.equal(await sumForConnectionPeriod(db, userId, CONN_A, DAY, D5), 10.5, "the day bucket D5 totals only its release");
    assert.equal(await sumForConnectionPeriod(db, userId, CONN_A, DAY, D6), 20.25, "the day bucket D6 totals only its release");
    assert.equal(await sumForConnectionPeriod(db, userId, CONN_A, WEEK, W45), 30.75, "the week bucket totals both days");
    assert.equal(await sumForConnectionPeriod(db, userId, CONN_A, MONTH, M_NOV), 30.75, "the month bucket totals both days");
    assert.equal(await sumForConnectionPeriod(db, userId, CONN_A, DAY, D6), 20.25, "a day key does not match the week/month keys");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — sumForMemberPeriod aggregates across a member's connections;
// sumForHouseholdPeriod aggregates across a household's members.
// ===========================================================================

test("sumForMemberPeriod totals a member's spend across ALL their connections in the period", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-member");

    await recordRelease(db, makeRelease(userId, { connectionId: CONN_A, amount: 10.5, periodKeys: keys() }));
    await recordRelease(db, makeRelease(userId, { connectionId: CONN_B, amount: 20.25, periodKeys: keys() }));
    // A release in a different month must not count toward November.
    await recordRelease(db, makeRelease(userId, { connectionId: CONN_A, amount: 100.0, periodKeys: keys({ month: M_DEC }) }));

    const memberNov = await sumForMemberPeriod(db, userId, MONTH, M_NOV);
    assert.equal(memberNov, 30.75, "the member's November total aggregates across connection A and B");

    // And it is strictly a superset of any single connection — more than one connection's own total.
    const connA = await sumForConnectionPeriod(db, userId, CONN_A, MONTH, M_NOV);
    assert.ok(memberNov > connA, "the member total spans more than one connection");
  } finally {
    await db.close();
  }
});

test("sumForHouseholdPeriod totals spend across a household's members in the period", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "ac2-hh-alice");
    const bob = await makeUser(db, "ac2-hh-bob");
    // Operator fix (E07-S07 no-progress): the H2 release belonged to Alice, which put one
    // person in two households and made Alice's own November total (110.50) exceed H's
    // (30.75), so the third assertion could never pass. A person belongs to one household;
    // the H2 release now belongs to Carol, keeping the cross-household isolation check.
    const carol = await makeUser(db, "ac2-hh-carol");

    // Alice and Bob both belong to household H and both spend this month.
    await recordRelease(db, makeRelease(alice, { connectionId: CONN_A, householdId: HOUSE_H, amount: 10.5, periodKeys: keys() }));
    await recordRelease(db, makeRelease(bob, { connectionId: CONN_B, householdId: HOUSE_H, amount: 20.25, periodKeys: keys() }));
    // A release in a different household must not count toward H.
    await recordRelease(db, makeRelease(carol, { connectionId: CONN_C, householdId: HOUSE_H2, amount: 100.0, periodKeys: keys() }));
    // A release in a different month must not count toward November's H total.
    await recordRelease(db, makeRelease(bob, { connectionId: CONN_B, householdId: HOUSE_H, amount: 5.25, periodKeys: keys({ month: M_DEC }) }));

    const householdNov = await sumForHouseholdPeriod(db, alice, HOUSE_H, MONTH, M_NOV);
    assert.equal(householdNov, 30.75, "household H's November total aggregates Alice's and Bob's November releases");

    // Both members see the SAME household aggregate (it is the shared household total).
    assert.equal(
      await sumForHouseholdPeriod(db, bob, HOUSE_H, MONTH, M_NOV),
      30.75,
      "the household total is the same for every member of the household",
    );

    // The household total exceeds either member's own total — it genuinely spans members.
    assert.ok(
      householdNov > (await sumForMemberPeriod(db, alice, MONTH, M_NOV)),
      "the household total is larger than Alice's own member total",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: a user cannot read another user's ledger rows, except the
// aggregate household total shared with household members. Filtered by the
// session user id.
// ===========================================================================

test("sumForConnectionPeriod never includes another user's spend on the same connection id", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "own-conn-alice");
    const bob = await makeUser(db, "own-conn-bob");

    await recordRelease(db, makeRelease(alice, { connectionId: CONN_A, amount: 42.5, periodKeys: keys() }));

    assert.equal(
      await sumForConnectionPeriod(db, alice, CONN_A, MONTH, M_NOV),
      42.5,
      "Alice sees her own connection total",
    );
    assert.equal(
      await sumForConnectionPeriod(db, bob, CONN_A, MONTH, M_NOV),
      0,
      "Bob querying the same connection id sees none of Alice's spend (member-scoped by user id)",
    );
  } finally {
    await db.close();
  }
});

test("sumForMemberPeriod never includes another user's spend", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "own-member-alice");
    const bob = await makeUser(db, "own-member-bob");

    await recordRelease(db, makeRelease(alice, { connectionId: CONN_A, amount: 42.5, periodKeys: keys() }));

    assert.equal(await sumForMemberPeriod(db, alice, MONTH, M_NOV), 42.5, "Alice sees her own member total");
    assert.equal(
      await sumForMemberPeriod(db, bob, MONTH, M_NOV),
      0,
      "Bob's member total never includes Alice's spend",
    );
  } finally {
    await db.close();
  }
});

test("sumForHouseholdPeriod does not expose a household's total to a non-member", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "hh-member-alice");
    const carol = await makeUser(db, "hh-stranger-carol");

    // Alice is in household H; Carol has spend but only in a DIFFERENT household H2 — she
    // is not a participant in H.
    await recordRelease(db, makeRelease(alice, { connectionId: CONN_A, householdId: HOUSE_H, amount: 42.5, periodKeys: keys() }));
    await recordRelease(db, makeRelease(carol, { connectionId: CONN_B, householdId: HOUSE_H2, amount: 7.25, periodKeys: keys() }));

    assert.equal(
      await sumForHouseholdPeriod(db, alice, HOUSE_H, MONTH, M_NOV),
      42.5,
      "a member of household H reads its total",
    );
    assert.equal(
      await sumForHouseholdPeriod(db, carol, HOUSE_H, MONTH, M_NOV),
      0,
      "a non-member of household H cannot read H's total (gated by the session user id)",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("recordRelease binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "a'; DROP TABLE card_spend_ledger; --";

  await recordRelease(db, makeRelease(probe, { merchant: "BoxCo" }));

  assert.ok(db.calls.length >= 1, "recording issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("sumForConnectionPeriod binds the user id and connection id as parameters", async () => {
  const db = recordingDb();
  const probe = "c'; DROP TABLE card_spend_ledger; --";

  const total = await sumForConnectionPeriod(db, probe, probe, MONTH, M_NOV);
  assert.equal(total, 0, "the recording db returns no rows, so the total is 0");

  assert.ok(db.calls.length >= 1, "the sum issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("sumForMemberPeriod binds the user id as a parameter", async () => {
  const db = recordingDb();
  const probe = "m'; DROP TABLE card_spend_ledger; --";

  const total = await sumForMemberPeriod(db, probe, MONTH, M_NOV);
  assert.equal(total, 0, "the recording db returns no rows, so the total is 0");

  assert.ok(db.calls.length >= 1, "the sum issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("sumForHouseholdPeriod binds the user id and household id as parameters", async () => {
  const db = recordingDb();
  const probe = "h'; DROP TABLE card_spend_ledger; --";

  const total = await sumForHouseholdPeriod(db, probe, probe, MONTH, M_NOV);
  assert.equal(total, 0, "the recording db returns no rows, so the total is 0");

  assert.ok(db.calls.length >= 1, "the sum issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("a SQL-injection probe in the merchant field is stored as data: the table survives and the sum is unchanged", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const probe = "ACME'); DROP TABLE card_spend_ledger; --";

    await recordRelease(db, makeRelease(userId, { connectionId: CONN_A, merchant: probe, amount: 42.5, periodKeys: keys() }));

    assert.equal(
      await tableExists(db, "card_spend_ledger"),
      true,
      "the ledger table must still exist (the probe was stored as data, not run as SQL)",
    );

    // The amount still sums — the row was inserted intact — and the merchant round-trips
    // verbatim as plaintext data, not interpreted as SQL.
    assert.equal(await sumForConnectionPeriod(db, userId, CONN_A, MONTH, M_NOV), 42.5, "the release was stored and sums");
    const rows = await ledgerRowsFor(db, userId);
    assert.equal(rows.length, 1, "the probe release is the one stored row");
    assert.equal(rows[0]!.merchant, probe, "the probe merchant round-trips verbatim as data");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input and binds probes.
//
// A route handler validates external input HERE (`parseBody`), then calls this task's
// parameterized data-access with the SESSION's user id (NEVER a body value). A rejected
// input maps to a 4xx Response and never reaches a query. This handler is a test fixture
// that EXERCISES the modules — it is not an implementation file.
// ===========================================================================

function releaseHandler(db: Db, sessionUserId: string): (req: Request) => Promise<Response> {
  // The body carries the release metadata; the user id comes from the session. Lengths
  // and the amount range are capped so an absurd value is rejected, but generous enough
  // that a probe can still REACH the query to prove it is bound.
  const schema = z.object({
    connectionId: z.string().min(1).max(64),
    householdId: z.string().min(1).max(64).nullable().optional(),
    amount: z.number().nonnegative().max(1_000_000),
    currency: z.string().min(1).max(8),
    merchant: z.string().min(1).max(200),
    periodKeys: z.object({
      day: z.string().min(1).max(40),
      week: z.string().min(1).max(40),
      month: z.string().min(1).max(40),
    }),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const saved = await recordRelease(db, {
        userId: sessionUserId,
        connectionId: body.connectionId,
        householdId: body.householdId ?? null,
        amount: body.amount,
        currency: body.currency,
        merchant: body.merchant,
        periodKeys: body.periodKeys,
      });
      return new Response(JSON.stringify({ id: saved.id }), { status: 201 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a
      // test sees the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/spending/releases", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

// A fully-valid request body (every release field), for the tests that vary one thing.
function validBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    connectionId: CONN_A,
    householdId: HOUSE_H,
    amount: 42.5,
    currency: "AUD",
    merchant: "BoxCo",
    periodKeys: { day: D5, week: W45, month: M_NOV },
    ...overrides,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = releaseHandler(db, "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = releaseHandler(db, "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(validBody({ merchant: "a".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = releaseHandler(db, "session-user");

  // No amount — a release must name the approved amount it records.
  const bad = JSON.parse(validBody()) as Record<string, unknown>;
  delete bad.amount;
  const res = await handler(jsonRequest(JSON.stringify(bad)));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-shaped amount with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = releaseHandler(db, "session-user");

  // amount must be a non-negative number — a string, and a negative value, are schema
  // violations rejected before any query.
  const asString = await handler(jsonRequest(validBody({ amount: "lots" })));
  assert.ok(asString.status >= 400 && asString.status < 500, `expected a 4xx, got ${asString.status}`);

  const negative = await handler(jsonRequest(validBody({ amount: -5 })));
  assert.ok(negative.status >= 400 && negative.status < 500, `expected a 4xx, got ${negative.status}`);

  assert.equal(db.calls.length, 0, "a mis-shaped amount must never reach a query");
});

test("the handler accepts a well-formed body and records the release for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const handler = releaseHandler(db, userId);

    const res = await handler(jsonRequest(validBody({ amount: 42.5, merchant: "BoxCo" })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };
    assert.ok(typeof id === "string" && id.length > 0, "the handler returns the new release id");

    assert.equal(
      await sumForConnectionPeriod(db, userId, CONN_A, MONTH, M_NOV),
      42.5,
      "a valid body is persisted for the session user and sums into the period total",
    );
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const handler = releaseHandler(db, sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(jsonRequest(validBody({ userId: attacker, amount: 42.5 })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal(
      await sumForMemberPeriod(db, sessionUser, MONTH, M_NOV),
      42.5,
      "the release is recorded under the SESSION user",
    );
    assert.equal(
      await sumForMemberPeriod(db, attacker, MONTH, M_NOV),
      0,
      "and never under the user id smuggled in the body",
    );
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe merchant is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const handler = releaseHandler(db, userId);
    const probe = "grace'); DROP TABLE card_spend_ledger; --";

    const res = await handler(jsonRequest(validBody({ merchant: probe, amount: 42.5 })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "card_spend_ledger"), true, "the ledger table must still exist");

    const rows = await ledgerRowsFor(db, userId);
    assert.equal(rows.length, 1, "the release is stored");
    assert.equal(rows[0]!.merchant, probe, "the probe merchant is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the store reads no process.env and folds no ambient secret into a release.
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in a ledger row", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-env");
    const saved = await recordRelease(db, makeRelease(userId, { connectionId: CONN_A, amount: 42.5 }));

    assert.ok(saved.id.length > 0, "the release reads and writes purely from the injected db — no app env needed");
    assert.ok(!JSON.stringify(saved).includes(DECOY), "no ambient env value is folded into a returned release");

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the
    // same value could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM card_spend_ledger");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(!cell.includes(DECOY), "no ambient env value is written to a column");
        }
      }
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===========================================================================
// Migration — the table applies and a second run changes nothing.
// ===========================================================================

test("the card_spend_ledger migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "card_spend_ledger"),
      true,
      "the card_spend_ledger table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0015_card_spend_ledger"),
      "db/migrations/0015_card_spend_ledger.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0015's CREATE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
