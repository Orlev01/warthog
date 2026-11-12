// E18-S04 — Set-up checklist status read (`src/server/home/checklist-data.ts`).
//
// RED-first: the module does NOT exist yet, so importing `./checklist-data` throws
// and every test here fails (and `tsc --noEmit` reddens on the missing module) until
// the builder writes the minimum code to pass. That absence IS the point of
// test-first; do NOT implement anything to make these pass — the builder writes
// `checklist-data.ts` afterwards.
//
// These tests pin BEHAVIOUR (what the read DOES: the five-item checklist it assembles
// for the session person, which item each real set-up signal flips, and whose state
// it reads), never the source text of the module — a later rename or moved import
// that preserves behaviour must stay green.
//
// WHY this exists (task E18-S04; brief "HOME — a set-up checklist"; design §5 — every
// member-scoped read takes the user id from the session, never a client value): the
// home loader needs ONE owner-scoped read that turns the person's REAL set-up state
// into the checklist. It gathers the five signals — a low-tier identity field set, a
// saved card, a connected service, a connected agent, a registered push device — by
// REUSING the already-built stores (`identity-fields`, `cards`, `connections`,
// `agents`, `push-subscriptions`) rather than re-querying ad hoc, and turns them into
// the checklist through the ONE pure source of the five items, `computeSetupChecklist`
// (built/tested in E18-S03). It adds no SQL and no crypto of its own: like the vault
// page-data read it resolves the person's DEK through the injected `KeyWrapper` seam
// (from `users.wrapped_dek`) so the identity + push reads can decrypt, reads no
// `process.env` and holds no key (INV-103), and every underlying store binds `userId`
// as a parameter (INV-102).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface SetupChecklistDeps {   // the injected seams — no process.env.
//     db: Db;                        // the parameterizing database seam.
//     keyWrapper: KeyWrapper;        // unwraps the person's DEK (from users.wrapped_dek)
//                                     // so the identity + push reads can decrypt.
//     clock: Clock;                  // "now", for the push store's active/expired filter.
//   }
//
//   loadSetupChecklist(deps: SetupChecklistDeps, userId: string): Promise<SetupChecklistItem[]>
//     • gathers the five set-up signals for `userId` (the SESSION's id, NEVER a client
//       value) from the five stores, and returns `computeSetupChecklist(signals)` — the
//       five first-run items, each `done` iff its own signal is present.
//
// Acceptance criteria → tests (this file):
//   AC1 "For a user who has only signed up (no identity, card, connection, agent or
//        push device) every checklist item comes back not done, and setting any one
//        signal (e.g. saving a card) flips exactly that item to done on the next read."
//        — a fresh account reads as computeSetupChecklist({}) (all five not done); and,
//        per signal, seeding ONLY that store through its real `save/add/create/register`
//        function flips EXACTLY its own item (deepEqual to computeSetupChecklist with
//        only that one signal set), leaving the other four not done.
//   AC2 "The read is filtered by the session user id only; … one user can never see
//        another user's set-up state." — with two people each holding a DIFFERENT
//        signal, the read for one returns only that person's checklist, never the
//        other's and never the two combined.
//
// The obligation acceptance criteria (AC3 validate-and-parameterize-input; AC4
// secrets-from-env) are pinned in the sibling `checklist-data.obligations.test.ts`.
//
// Database tests use `freshDb()` (an isolated in-memory PGlite with the real
// migrations) and the real store functions to seed; each handle is closed in a
// `finally`. Tests touch no network and no Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { loadSetupChecklist } from "./checklist-data";
import { computeSetupChecklist, type SetupSignals } from "../../domain/home/checklist";
import { createUser } from "../db/users";
import { saveIdentityField } from "../db/identity-fields";
import { saveHighTierField } from "../db/high-tier-fields";
import { addCard } from "../db/cards";
import { createConnection } from "../db/connections";
import { createAgent } from "../db/agents";
import { registerSubscription } from "../db/push-subscriptions";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { fixedClock, type Clock } from "../seams/clock";

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // a 256-bit key-encryption key for the local AES wrapper

// A frozen instant used as "now": a push subscription registered at T0 and read at T0
// is comfortably active (never-expiring), with no wall-clock dependence.
const T0 = new Date("2026-06-01T00:00:00.000Z");
const clock: Clock = fixedClock(T0);

// One real local KeyWrapper (dev/test) for the whole file — exactly the one a
// non-production composition root selects, so wrap/unwrap is genuine, not a stub.
// A person's stored wrapped-DEK therefore really unwraps to the DEK the seed used.
const keyWrapper: KeyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));

// Build the read under test with the pinned deps (db + the shared keyWrapper + clock),
// so every call site passes the SAME literal shape the builder must accept.
function load(db: Db, userId: string): Promise<ReturnType<typeof computeSetupChecklist>> {
  return loadSetupChecklist({ db, keyWrapper, clock }, userId);
}

// Create a person whose stored wrapped-DEK really unwraps (under `keyWrapper`) to the
// returned `dek`, so values the seed encrypts under `dek` round-trip through the read.
async function makeUserWithDek(db: Db, who: string): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

// --- the five set-up signals, each seeded through its REAL store -------------------
// Each seeder writes to exactly ONE store, so a case proves that setting that one
// signal flips exactly its own checklist item. The `connection_id` an agent carries is
// an opaque uuid (migration 0020 — no foreign key), so seeding a connected AGENT does
// not also create a connected SERVICE row; the five signals are independent.

interface SeedCtx {
  readonly db: Db;
  readonly userId: string;
  readonly dek: Uint8Array;
}

// A detail the person added themselves. Sign-up saves their name for them, so the name
// alone never marks "Add your details" done (see the sign-up-name case below).
async function seedIdentity({ db, userId, dek }: SeedCtx): Promise<void> {
  await saveIdentityField(db, { userId, kind: "phone", value: "0400 000 000" }, dek);
}

async function seedProtectedDetail({ db, userId }: SeedCtx): Promise<void> {
  await saveHighTierField(db, { userId, type: "passport", label: "Passport", ciphertext: "v1:passport-ciphertext" });
}

async function seedCard({ db, userId }: SeedCtx): Promise<void> {
  await addCard(db, {
    userId,
    brand: "visa",
    lastFour: "4242",
    expiryMonth: 11,
    expiryYear: 2029,
    nickname: "Everyday",
    billingAddressId: "addr-1",
    numberCiphertext: "v1:card-number-ciphertext",
  });
}

async function seedConnection({ db, userId, dek }: SeedCtx): Promise<void> {
  await createConnection(
    db,
    {
      userId,
      connectorId: "google-gmail",
      accountLabel: "person@gmail.com",
      credentials: { accessToken: "atok" },
    },
    dek,
    clock,
  );
}

async function seedAgent({ db, userId }: SeedCtx): Promise<void> {
  await createAgent(
    db,
    { userId, connectionId: randomUUID(), displayName: "Claude", platform: "claude" },
    clock,
  );
}

async function seedPush({ db, userId, dek }: SeedCtx): Promise<void> {
  await registerSubscription(
    db,
    { userId, endpoint: "https://push.example/endpoint-1", keys: { p256dh: "p256dh-key", auth: "auth-key" } },
    dek,
    clock,
  );
}

// Each case: the one store it seeds, and the ONE signal that store flips. `expected` is
// a literal (type-checked against SetupSignals) so the deepEqual ties the read to the
// single source of the items — only that one item done, the other four not done.
const CASES: ReadonlyArray<{
  readonly name: string;
  readonly expected: SetupSignals;
  readonly seed: (ctx: SeedCtx) => Promise<void>;
}> = [
  { name: "a saved everyday detail → \"Add your details\"", expected: { identityAdded: true }, seed: seedIdentity },
  { name: "a saved protected detail → \"Add your details\"", expected: { identityAdded: true }, seed: seedProtectedDetail },
  { name: "a saved card → \"Add a card\"", expected: { cardAdded: true }, seed: seedCard },
  { name: "a connected service → \"Connect a service\"", expected: { serviceConnected: true }, seed: seedConnection },
  { name: "a connected agent → \"Connect an agent\"", expected: { agentConnected: true }, seed: seedAgent },
  { name: "a registered push device → \"Get notified\"", expected: { notificationsEnabled: true }, seed: seedPush },
];

// ===========================================================================
// AC1 — a freshly signed-up account reads as every item NOT done.
// ===========================================================================

test("a user who has only signed up reads as the five items, every one NOT done", async () => {
  const db = await freshDb();
  try {
    const { userId } = await makeUserWithDek(db, "fresh-signup");

    const checklist = await load(db, userId);

    assert.deepEqual(
      checklist,
      computeSetupChecklist({}),
      "a fresh account's checklist must be the five items with no signal set",
    );
    assert.equal(checklist.length, 5, "the read returns all five set-up items");
    assert.ok(
      checklist.every((item) => item.done === false),
      "every set-up item is NOT done for an account with no identity, card, connection, agent or push device",
    );
  } finally {
    await db.close();
  }
});

// UI/UX pass, newcomer-01: sign-up saves the person's name for them, so a brand-new member
// who has only signed up must not see "Add your details · Done" (and "1 of 5 steps").
test("the name saved at sign-up alone leaves \"Add your details\" not done", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makeUserWithDek(db, "signup-name");
    await saveIdentityField(db, { userId, kind: "name", value: "Quokka Xylophone" }, dek);
    assert.deepEqual(await load(db, userId), computeSetupChecklist({}), "the sign-up name marks nothing done");

    await saveIdentityField(db, { userId, kind: "preferred_name", value: "Quokka" }, dek);
    assert.deepEqual(
      await load(db, userId),
      computeSetupChecklist({ identityAdded: true }),
      "a detail the person adds themselves marks it done",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — setting any ONE signal flips EXACTLY that item to done on the next read.
// ===========================================================================

for (const { name, expected, seed } of CASES) {
  test(`setting one signal flips exactly its item to done: ${name}`, async () => {
    const db = await freshDb();
    try {
      const { userId, dek } = await makeUserWithDek(db, "one-signal");

      // Baseline: before seeding, nothing is done.
      assert.deepEqual(
        await load(db, userId),
        computeSetupChecklist({}),
        "before the signal is set, every item is not done",
      );

      // Set exactly this one signal through its REAL store.
      await seed({ db, userId, dek });

      // The read now flips EXACTLY that item — tied to the single source of the items.
      const checklist = await load(db, userId);
      assert.deepEqual(
        checklist,
        computeSetupChecklist(expected),
        "the read flips exactly the item for the signal that was set, and no other",
      );
      assert.equal(
        checklist.filter((item) => item.done).length,
        1,
        "exactly one of the five items is done after setting a single signal",
      );
    } finally {
      await db.close();
    }
  });
}

// Belt-and-braces: all five signals set together ⇒ every item done. Proves no signal
// masks or overrides another, and that the read composes them from the five stores.
test("with all five signals set, every checklist item comes back done", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makeUserWithDek(db, "all-signals");
    const ctx: SeedCtx = { db, userId, dek };
    await seedIdentity(ctx);
    await seedCard(ctx);
    await seedConnection(ctx);
    await seedAgent(ctx);
    await seedPush(ctx);

    const checklist = await load(db, userId);

    assert.deepEqual(
      checklist,
      computeSetupChecklist({
        notificationsEnabled: true,
        identityAdded: true,
        cardAdded: true,
        serviceConnected: true,
        agentConnected: true,
      }),
      "every signal set ⇒ every item done",
    );
    assert.ok(checklist.every((item) => item.done === true), "all five items are done");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — member scope: the read reflects ONLY the session person's set-up state.
// ===========================================================================

test("the read reflects only the session person's set-up state, never another person's", async () => {
  const db = await freshDb();
  try {
    const a = await makeUserWithDek(db, "owner-a");
    const b = await makeUserWithDek(db, "owner-b");

    // A has only a saved card; B has only a connected service — DIFFERENT signals.
    await seedCard({ db, userId: a.userId, dek: a.dek });
    await seedConnection({ db, userId: b.userId, dek: b.dek });

    // The read for A shows A's state (the card done, the service NOT), never B's.
    const forA = await load(db, a.userId);
    assert.deepEqual(
      forA,
      computeSetupChecklist({ cardAdded: true }),
      "A's checklist reflects A's card only — never B's connected service",
    );

    // And symmetrically the read for B shows B's state, never A's.
    const forB = await load(db, b.userId);
    assert.deepEqual(
      forB,
      computeSetupChecklist({ serviceConnected: true }),
      "B's checklist reflects B's service only — never A's card",
    );
  } finally {
    await db.close();
  }
});

// A second account's activity NEVER bleeds into the session person's checklist: with a
// fully set-up neighbour present, the session person (who has nothing) still reads as
// all-not-done. Scope is by the passed `userId` alone.
test("a fully set-up neighbour does not flip any item for a person who has nothing", async () => {
  const db = await freshDb();
  try {
    const me = await makeUserWithDek(db, "me-empty");
    const neighbour = await makeUserWithDek(db, "neighbour-full");

    const nCtx: SeedCtx = { db, userId: neighbour.userId, dek: neighbour.dek };
    await seedIdentity(nCtx);
    await seedCard(nCtx);
    await seedConnection(nCtx);
    await seedAgent(nCtx);
    await seedPush(nCtx);

    const mine = await load(db, me.userId);
    assert.deepEqual(
      mine,
      computeSetupChecklist({}),
      "the neighbour's complete set-up must not flip any of my items",
    );
  } finally {
    await db.close();
  }
});
