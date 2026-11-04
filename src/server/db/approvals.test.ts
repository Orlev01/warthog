// E07-S03 — Approvals store (`src/server/db/approvals.ts`,
// `db/migrations/0011_approvals.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so
// importing `./approvals` throws and `freshDb()` has no `approvals` table — every
// test here fails until the builder adds them. That absence IS the point of
// test-first; do NOT implement anything to make these pass — the builder writes the
// module and the migration afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: the stored status,
// the round-tripped detail, the expiry window, who can read/decide what, what a
// handler rejects), never the source text of the module or the SQL file — a later
// rename that preserves behaviour must not redden them.
//
// WHY this exists (design §6, brief "Approval inbox" / "Agents wait safely"): the
// pipeline creates an approval on every `ask` decision; the inbox and notifications
// read and decide them. An approval holds the "exact details (recipient, amount,
// field requested)" the person sees — personal content — so the DETAIL is stored
// only DEK-ENCRYPTED (design §4.1, project rule: personal content is encrypted with
// the per-person DEK; the plaintext never lands in a column). The lifecycle itself
// is the PURE state machine (`src/domain/approvals/state-machine.ts`, E03-S08): this
// repo is its storage skin — it persists and reloads, and `decide()` delegates every
// transition to that pure machine so an illegal move is refused exactly as the
// machine refuses it.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface NewApproval {
//     userId: string;             // the person (the session's id, never a client value)
//     agentId: string;            // the requesting agent connection
//     detail: Record<string, unknown>;  // recipient/amount/field — stored DEK-encrypted
//     expiryMinutes?: number;     // omitted → 15; clamped to [2, 1440] by the state machine
//   }
//
//   interface StoredApproval {
//     id: string;                 // generated on create; what createApproval returns
//     userId: string;
//     agentId: string;
//     status: "pending" | "approved" | "denied" | "expired" | "more_detail";
//     detail: Record<string, unknown>;  // DECRYPTED on read, under the injected DEK
//     createdAt: Date | string;   // the injected clock's instant (moment compared, not representation)
//     expiresAt: Date | string;   // createdAt + clamped expiry window
//     decidedAt?: Date | string;  // set on approve / deny / expire
//     question?: string;          // set by a more_detail decision
//   }
//
//   // A decision targets one of the four non-pending statuses; the repo maps each to
//   // the pure state machine's transition (approve / deny / askForMoreDetail /
//   // expireIfDue) and persists only if the machine allows it.
//   type Decision =
//     | { status: "approved" }
//     | { status: "denied" }
//     | { status: "expired" }
//     | { status: "more_detail"; question: string };
//
//   createApproval(db, input: NewApproval, dek: Uint8Array, clock: Clock): Promise<StoredApproval>
//     • stores a PENDING row for `userId` with its DEK-encrypted detail and an expiry
//       window (createdAt = clock.now(); expiresAt = createdAt + clamped expiry), and
//       returns the StoredApproval (carrying the generated id).
//   getApproval(db, userId, id, dek): Promise<StoredApproval | null>
//     • the one approval with this id OWNED BY `userId` (member-scoped: id AND
//       user_id both bound), detail decrypted under `dek`; null when none for this
//       user. Another user's id returns null (they cannot read it).
//   listPendingForUser(db, userId, dek): Promise<StoredApproval[]>
//     • this user's `pending` approvals, detail decrypted; never another user's, never
//       already-decided ones.
//   decide(db, { userId, id, decision }, dek, clock): Promise<StoredApproval>
//     • member-scoped: loads the owned approval (throws when none for this user, so
//       one person can never decide another's), applies the pure transition
//       (throwing exactly when the machine throws — an already-decided approval is
//       refused and left unchanged), persists and returns the updated StoredApproval.
//       `{status:"expired"}` delegates to expireIfDue — a no-op unless the window has
//       passed.
//
// Acceptance criteria → tests:
//   AC1 "Creating an approval stores it pending with an expiry and DEK-encrypted
//        detail (recipient, amount, field) and returns its id." — createApproval
//        returns an id; getApproval reads it back pending with the SAME detail and an
//        expiry window matching the (clamped) configuration; the plaintext
//        recipient/field never appear in a raw column (encrypted at rest).
//   AC2 "decide() moves an approval through approved/denied/more_detail/expired only
//        along the transitions the pure state machine allows." — each target status
//        is reached from pending; an already-decided approval is refused and left
//        unchanged; an overdue approval expires and can no longer be approved.
//   AC3 "A user cannot read, list or decide another user's approval by id (filtered
//        by session user id)." — B's get returns null, B's list omits A's, B's decide
//        throws and A's approval is untouched; the user id is bound as a parameter.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed/oversized input with a 4xx
//        before any query runs; a SQL-injection probe routed through the repo travels
//        as a BOUND value (placeholders, never concatenation) and cannot drop the
//        table. The handler is a test fixture (the intended usage), not an
//        implementation file.
//   AC5 [obligation:secrets-from-env] — the detail is encrypted under the INJECTED
//        DEK, not a baked-in secret: a different DEK cannot read it back. (The repo
//        reads no `process.env` and holds no key; the DEK and clock are injected.)
//   Migration: the `approvals` relation exists after the project migrations and a
//        second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { createApproval, getApproval, listPendingForUser, decide } from "./approvals";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";
import { DEFAULT_EXPIRY_MINUTES, MIN_EXPIRY_MINUTES } from "../../domain/approvals/state-machine";

// --- fixtures ---------------------------------------------------------------------

const MINUTE = 60_000;
const DEK_BYTES = 32; // a 256-bit per-person data key

// Compare the moment, not the representation: createdAt / expiresAt may come back as
// a Date or an ISO string — either is a reasonable choice and must not redden a test.
const ms = (value: Date | string | number): number => new Date(value as never).getTime();

// A base instant deliberately in the past relative to the wall clock, so anything
// that wrongly read Date.now() instead of the injected clock would diverge here.
const T0 = new Date("2026-02-01T09:00:00.000Z");

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a
// layer up; this repo only ever receives the already-unwrapped bytes.
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque base64; this module never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Agent connection ids are uuids; use valid uuids so a `uuid` column accepts them.
const AGENT_A = "11111111-1111-1111-1111-111111111111";
const AGENT_B = "22222222-2222-2222-2222-222222222222";

// The approval detail the inbox shows (brief: "the exact details (recipient, amount,
// field requested)"). The recipient and field carry UNIQUE tokens so an at-rest scan
// for them is unambiguous — a hit would be a real plaintext leak, not a coincidence.
function detailWith(token: string): Record<string, unknown> {
  return {
    recipient: `mallory-${token}@secret.example`,
    amount: "42.00 AUD",
    field: `passport_number_${token}`,
  };
}

// A db seam stand-in that records every call instead of running it, so a test can
// prove WHAT reached the query layer and HOW (bound value vs. spliced text). It
// returns no rows and satisfies the `Db` shape structurally (query + close).
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

// Whether a relation of this exact name exists on this handle. `to_regclass` yields
// the relation name when it exists and NULL when it does not — a non-throwing probe
// scoped to the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Create a person and return their id (every member-scoped row hangs off this id).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// ===========================================================================
// AC1 — creating stores a PENDING approval with its expiry window and
// DEK-encrypted detail, and returns its id.
// ===========================================================================

test("createApproval returns a pending approval with an id and the injected created-at", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const dek = freshDek();

    const created = await createApproval(
      db,
      { userId, agentId: AGENT_A, detail: detailWith("A1") },
      dek,
      fixedClock(T0),
    );

    assert.equal(typeof created.id, "string", "createApproval returns an id string");
    assert.ok(created.id.length > 0, "the returned id is non-empty");
    assert.equal(created.status, "pending", "a freshly created approval waits as pending");
    assert.equal(created.userId, userId, "the approval belongs to the creating person");
    assert.equal(ms(created.createdAt), ms(T0), "createdAt is the injected clock instant");
  } finally {
    await db.close();
  }
});

test("createApproval gives each approval a distinct id", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-ids");
    const dek = freshDek();
    const one = await createApproval(db, { userId, agentId: AGENT_A, detail: detailWith("x") }, dek, fixedClock(T0));
    const two = await createApproval(db, { userId, agentId: AGENT_A, detail: detailWith("y") }, dek, fixedClock(T0));
    assert.notEqual(one.id, two.id, "two created approvals have different ids");
  } finally {
    await db.close();
  }
});

test("getApproval reads a created approval back: pending, same detail, owned by the person", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-read");
    const dek = freshDek();
    const detail = detailWith("ROUND");

    const created = await createApproval(db, { userId, agentId: AGENT_A, detail }, dek, fixedClock(T0));

    const loaded = await getApproval(db, userId, created.id, dek);
    assert.ok(loaded, "the created approval is readable by its owner");
    assert.equal(loaded!.id, created.id, "the same approval id is returned");
    assert.equal(loaded!.status, "pending", "it is still pending");
    assert.equal(loaded!.agentId, AGENT_A, "the requesting agent is preserved");
    assert.deepEqual(loaded!.detail, detail, "the DEK-encrypted detail round-trips verbatim");
  } finally {
    await db.close();
  }
});

test("createApproval's default expiry window is 15 minutes from created-at", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-exp-default");
    const created = await createApproval(
      db,
      { userId, agentId: AGENT_A, detail: detailWith("d") },
      freshDek(),
      fixedClock(T0),
    );
    assert.equal(
      ms(created.expiresAt) - ms(created.createdAt),
      DEFAULT_EXPIRY_MINUTES * MINUTE,
      "an unconfigured approval expires 15 minutes after it is created",
    );
  } finally {
    await db.close();
  }
});

test("createApproval honours an in-bounds expiry and clamps a below-floor one", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-exp-clamp");
    const dek = freshDek();

    const thirty = await createApproval(
      db,
      { userId, agentId: AGENT_A, detail: detailWith("t30"), expiryMinutes: 30 },
      dek,
      fixedClock(T0),
    );
    assert.equal(
      ms(thirty.expiresAt) - ms(thirty.createdAt),
      30 * MINUTE,
      "a 30-minute expiry produces a 30-minute window",
    );

    const tooShort = await createApproval(
      db,
      { userId, agentId: AGENT_A, detail: detailWith("t1"), expiryMinutes: 1 },
      dek,
      fixedClock(T0),
    );
    assert.equal(
      ms(tooShort.expiresAt) - ms(tooShort.createdAt),
      MIN_EXPIRY_MINUTES * MINUTE,
      "a 1-minute request is held to the 2-minute floor",
    );
  } finally {
    await db.close();
  }
});

test("the detail is stored DEK-encrypted: the plaintext recipient and field never appear in a raw column", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-atrest");
    const dek = freshDek();
    const detail = detailWith("LEAKCHECK9x");

    await createApproval(db, { userId, agentId: AGENT_A, detail }, dek, fixedClock(T0));

    // Scan every cell of the one table under test. The recipient address and the
    // field name are personal content that MUST be encrypted (AC1), and their tokens
    // are unique, so any raw occurrence is a genuine plaintext leak.
    const all = await db.query("SELECT * FROM approvals");
    assert.ok(all.rows.length >= 1, "the approval row was stored");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(
            !cell.includes(detail.recipient as string),
            "the plaintext recipient must never be written to a column",
          );
          assert.ok(
            !cell.includes(detail.field as string),
            "the plaintext field name must never be written to a column",
          );
        }
      }
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the detail is encrypted under the INJECTED dek, not a baked-in secret:
// a different dek cannot read it back.
// ===========================================================================

test("getApproval cannot decrypt the detail with a different DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5");
    const dek = freshDek();
    const created = await createApproval(db, { userId, agentId: AGENT_A, detail: detailWith("K") }, dek, fixedClock(T0));

    // A different DEK is the wrong key; the GCM tag must fail rather than return
    // other bytes — so reading the detail under it rejects.
    const wrongDek = freshDek();
    await assert.rejects(
      async () => {
        await getApproval(db, userId, created.id, wrongDek);
      },
      "the detail is bound to the person's own DEK, not any ambient/hardcoded key",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — decide() moves an approval through each target status only along the
// transitions the pure state machine allows.
// ===========================================================================

test("decide approves a pending approval and stamps the decision time", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-approve");
    const dek = freshDek();
    const detail = detailWith("APP");
    const created = await createApproval(db, { userId, agentId: AGENT_A, detail }, dek, fixedClock(T0));

    const decideAt = new Date(T0.getTime() + 5 * MINUTE);
    const decided = await decide(db, { userId, id: created.id, decision: { status: "approved" } }, dek, fixedClock(decideAt));

    assert.equal(decided.status, "approved", "a pending approval becomes approved");
    assert.ok(decided.decidedAt !== undefined, "approving stamps a decision time");
    assert.equal(ms(decided.decidedAt!), ms(decideAt), "decidedAt is the injected clock instant");
    assert.deepEqual(decided.detail, detail, "the detail is preserved through the decision");

    const reloaded = await getApproval(db, userId, created.id, dek);
    assert.equal(reloaded!.status, "approved", "the approval is persisted as approved");
  } finally {
    await db.close();
  }
});

test("decide denies a pending approval", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-deny");
    const dek = freshDek();
    const created = await createApproval(db, { userId, agentId: AGENT_A, detail: detailWith("DEN") }, dek, fixedClock(T0));

    const decided = await decide(
      db,
      { userId, id: created.id, decision: { status: "denied" } },
      dek,
      fixedClock(new Date(T0.getTime() + 2 * MINUTE)),
    );
    assert.equal(decided.status, "denied", "a pending approval becomes denied");

    const reloaded = await getApproval(db, userId, created.id, dek);
    assert.equal(reloaded!.status, "denied", "the approval is persisted as denied");
  } finally {
    await db.close();
  }
});

test("decide parks a pending approval in more_detail, recording the person's question", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-detail");
    const dek = freshDek();
    const created = await createApproval(db, { userId, agentId: AGENT_A, detail: detailWith("MD") }, dek, fixedClock(T0));

    const question = "Which manager — your work or personal one?";
    const decided = await decide(
      db,
      { userId, id: created.id, decision: { status: "more_detail", question } },
      dek,
      fixedClock(new Date(T0.getTime() + 3 * MINUTE)),
    );
    assert.equal(decided.status, "more_detail", "the approval moves to more_detail");
    assert.equal(decided.question, question, "the person's question is recorded on the approval");

    const reloaded = await getApproval(db, userId, created.id, dek);
    assert.equal(reloaded!.status, "more_detail", "more_detail is persisted");
    assert.equal(reloaded!.question, question, "the question is persisted");
  } finally {
    await db.close();
  }
});

test("decide refuses to re-decide an already-decided approval and leaves it unchanged", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-illegal");
    const dek = freshDek();
    const created = await createApproval(db, { userId, agentId: AGENT_A, detail: detailWith("IL") }, dek, fixedClock(T0));

    await decide(db, { userId, id: created.id, decision: { status: "approved" } }, dek, fixedClock(new Date(T0.getTime() + MINUTE)));

    // The pure state machine forbids approving/denying anything not pending; decide
    // must surface that refusal (never silently) and must not alter the stored row.
    await assert.rejects(
      async () => {
        await decide(db, { userId, id: created.id, decision: { status: "denied" } }, dek, fixedClock(new Date(T0.getTime() + 2 * MINUTE)));
      },
      "an already-approved approval cannot be denied",
    );
    await assert.rejects(
      async () => {
        await decide(db, { userId, id: created.id, decision: { status: "approved" } }, dek, fixedClock(new Date(T0.getTime() + 2 * MINUTE)));
      },
      "an already-approved approval cannot be approved again",
    );

    const reloaded = await getApproval(db, userId, created.id, dek);
    assert.equal(reloaded!.status, "approved", "the refused re-decisions leave it approved");
  } finally {
    await db.close();
  }
});

test("decide expires an overdue pending approval, which can then no longer be approved", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-expire");
    const dek = freshDek();
    const created = await createApproval(
      db,
      { userId, agentId: AGENT_A, detail: detailWith("EXP"), expiryMinutes: 2 },
      dek,
      fixedClock(T0),
    );

    // Past the 2-minute window: expiring it is due.
    const past = new Date(T0.getTime() + 3 * MINUTE);
    const expired = await decide(db, { userId, id: created.id, decision: { status: "expired" } }, dek, fixedClock(past));
    assert.equal(expired.status, "expired", "an overdue pending approval expires");

    const reloaded = await getApproval(db, userId, created.id, dek);
    assert.equal(reloaded!.status, "expired", "expiry is persisted");

    // Once expired it is no longer pending, so the machine refuses an approval.
    await assert.rejects(
      async () => {
        await decide(db, { userId, id: created.id, decision: { status: "approved" } }, dek, fixedClock(new Date(T0.getTime() + 4 * MINUTE)));
      },
      "an expired request can no longer be approved",
    );
  } finally {
    await db.close();
  }
});

test("decide to expired is a no-op before the window has passed (the machine only expires when due)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-noexpire");
    const dek = freshDek();
    const created = await createApproval(
      db,
      { userId, agentId: AGENT_A, detail: detailWith("NX"), expiryMinutes: 30 },
      dek,
      fixedClock(T0),
    );

    // Only one minute in — not yet due — so expireIfDue leaves it pending.
    const result = await decide(db, { userId, id: created.id, decision: { status: "expired" } }, dek, fixedClock(new Date(T0.getTime() + MINUTE)));
    assert.equal(result.status, "pending", "a not-yet-due approval stays pending");

    const reloaded = await getApproval(db, userId, created.id, dek);
    assert.equal(reloaded!.status, "pending", "and remains pending in storage");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1/AC2 — listPendingForUser returns the person's pending approvals and
// omits decided ones.
// ===========================================================================

test("listPendingForUser returns pending approvals and omits decided ones", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac-list");
    const dek = freshDek();

    const stillPending = await createApproval(db, { userId, agentId: AGENT_A, detail: detailWith("P1") }, dek, fixedClock(T0));
    const toApprove = await createApproval(db, { userId, agentId: AGENT_A, detail: detailWith("P2") }, dek, fixedClock(T0));
    await decide(db, { userId, id: toApprove.id, decision: { status: "approved" } }, dek, fixedClock(new Date(T0.getTime() + MINUTE)));

    const pending = await listPendingForUser(db, userId, dek);
    const ids = pending.map((a) => a.id);
    assert.ok(ids.includes(stillPending.id), "the pending approval is listed");
    assert.ok(!ids.includes(toApprove.id), "the approved approval is not listed as pending");
    for (const a of pending) {
      assert.equal(a.status, "pending", "every listed approval is pending");
    }
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: one person can never read, list or decide another's
// approval by id. The user id is bound from the session, never the client.
// ===========================================================================

test("getApproval never returns another user's approval by id", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-alice");
    const bob = await makeUser(db, "owner-bob");
    const dek = freshDek();

    const alices = await createApproval(db, { userId: alice, agentId: AGENT_A, detail: detailWith("AL") }, dek, fixedClock(T0));

    assert.ok(await getApproval(db, alice, alices.id, dek), "Alice can read her own approval");
    assert.equal(
      await getApproval(db, bob, alices.id, dek),
      null,
      "Bob cannot read Alice's approval by its id",
    );
  } finally {
    await db.close();
  }
});

test("listPendingForUser never includes another user's pending approvals", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "list-alice");
    const bob = await makeUser(db, "list-bob");
    const dek = freshDek();

    const alices = await createApproval(db, { userId: alice, agentId: AGENT_A, detail: detailWith("AL2") }, dek, fixedClock(T0));
    const bobs = await createApproval(db, { userId: bob, agentId: AGENT_B, detail: detailWith("BO2") }, dek, fixedClock(T0));

    const alicesList = (await listPendingForUser(db, alice, dek)).map((a) => a.id);
    assert.ok(alicesList.includes(alices.id), "Alice sees her own pending approval");
    assert.ok(!alicesList.includes(bobs.id), "Alice never sees Bob's pending approval");

    const bobsList = (await listPendingForUser(db, bob, dek)).map((a) => a.id);
    assert.ok(bobsList.includes(bobs.id), "Bob sees his own pending approval");
    assert.ok(!bobsList.includes(alices.id), "Bob never sees Alice's pending approval");
  } finally {
    await db.close();
  }
});

test("decide cannot touch another user's approval, and leaves it unchanged", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "decide-alice");
    const bob = await makeUser(db, "decide-bob");
    const dek = freshDek();

    const alices = await createApproval(db, { userId: alice, agentId: AGENT_A, detail: detailWith("AL3") }, dek, fixedClock(T0));

    // Bob tries to approve Alice's approval by its id: member-scoped, so there is no
    // such approval FOR BOB — decide must refuse (never silently decide it).
    await assert.rejects(
      async () => {
        await decide(db, { userId: bob, id: alices.id, decision: { status: "approved" } }, dek, fixedClock(new Date(T0.getTime() + MINUTE)));
      },
      "Bob cannot decide an approval that is not his",
    );

    const stillAlices = await getApproval(db, alice, alices.id, dek);
    assert.equal(stillAlices!.status, "pending", "Alice's approval is untouched by Bob's attempt");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("getApproval binds the id and user id as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "a'; DROP TABLE approvals; --";

  const result = await getApproval(db, probe, probe, freshDek());
  assert.equal(result, null, "the recording db returns no rows, so the lookup is empty");

  assert.ok(db.calls.length >= 1, "the lookup issues at least one query");
  assert.ok(
    db.calls.some((c) => c.values.includes(probe)),
    "the probe travels as a bound value",
  );
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("listPendingForUser binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'; DROP TABLE approvals; --";

  const result = await listPendingForUser(db, probe, freshDek());
  assert.deepEqual(result, [], "the recording db returns no rows, so the list is empty");

  assert.ok(db.calls.length >= 1, "listing issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the user id travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the user id is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("decide binds the id and user id when it loads the approval, never splicing SQL", async () => {
  const db = recordingDb();
  const probe = "x'; DROP TABLE approvals; --";

  // No row comes back, so decide cannot find an approval for this (user, id) and must
  // refuse — but the load it issued must have bound the probe, not spliced it.
  await assert.rejects(async () => {
    await decide(db, { userId: probe, id: probe, decision: { status: "approved" } }, freshDek(), fixedClock(T0));
  }, "decide refuses when no owned approval exists");

  assert.ok(db.calls.length >= 1, "decide issues at least one query to load the approval");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("a SQL-injection probe in the detail is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const dek = freshDek();
    const detail = {
      recipient: "grace'); DROP TABLE approvals; --",
      amount: "1.00 AUD",
      field: "evil'); DROP TABLE approvals; --",
    };

    const created = await createApproval(db, { userId, agentId: AGENT_A, detail }, dek, fixedClock(T0));

    assert.equal(
      await tableExists(db, "approvals"),
      true,
      "the approvals table must still exist (the probe was stored as data, not run as SQL)",
    );

    const loaded = await getApproval(db, userId, created.id, dek);
    assert.deepEqual(loaded!.detail, detail, "the probe round-trips verbatim as data");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — a handler on the validation boundary rejects bad input and binds probes.
//
// A route handler validates external input HERE (`parseBody`), then calls this
// task's parameterized data-access with the SESSION's user id (NEVER a body value).
// A rejected input maps to a 4xx Response and never reaches a query. This handler is
// a test fixture that EXERCISES the modules — it is not an implementation file.
// ===========================================================================

function createApprovalHandler(
  db: Db,
  dek: Uint8Array,
  clock: Clock,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries the agent and the detail; the user id comes from the session.
  // Lengths are capped so an absurd value is rejected, but generous enough that a
  // probe can still REACH the query to prove it is bound.
  const schema = z.object({
    agentId: z.string().min(1).max(64),
    recipient: z.string().min(1).max(256),
    amount: z.string().min(1).max(64),
    field: z.string().min(1).max(256),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const created = await createApproval(
        db,
        {
          userId: sessionUserId,
          agentId: body.agentId,
          detail: { recipient: body.recipient, amount: body.amount, field: body.field },
        },
        dek,
        clock,
      );
      return new Response(JSON.stringify({ id: created.id }), { status: 201 });
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
  return new Request("https://warthog.com.au/api/approvals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createApprovalHandler(db, freshDek(), fixedClock(T0), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createApprovalHandler(db, freshDek(), fixedClock(T0), "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest(JSON.stringify({ agentId: AGENT_A, recipient: "a".repeat(10 * 1024), amount: "1 AUD", field: "f" })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createApprovalHandler(db, freshDek(), fixedClock(T0), "session-user");

  const res = await handler(jsonRequest(JSON.stringify({ agentId: AGENT_A, amount: "1 AUD" })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler accepts a well-formed body and persists the approval for the session user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const handler = createApprovalHandler(db, dek, fixedClock(T0), userId);

    const res = await handler(
      jsonRequest(JSON.stringify({ agentId: AGENT_A, recipient: "dana@example.com", amount: "42.00 AUD", field: "none" })),
    );

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };
    const stored = await getApproval(db, userId, id, dek);
    assert.ok(stored, "a valid approval is persisted for the session user");
    assert.equal(stored!.status, "pending", "and it is pending");
    assert.equal(stored!.detail.recipient, "dana@example.com", "with the submitted detail");
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe recipient is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const dek = freshDek();
    const handler = createApprovalHandler(db, dek, fixedClock(T0), userId);
    const probe = "grace'); DROP TABLE approvals; --";

    const res = await handler(
      jsonRequest(JSON.stringify({ agentId: AGENT_A, recipient: probe, amount: "1.00 AUD", field: "none" })),
    );

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "approvals"), true, "the approvals table must still exist");

    const { id } = (await res.json()) as { id: string };
    const stored = await getApproval(db, userId, id, dek);
    assert.equal(stored!.detail.recipient, probe, "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Migration — the table applies and a second run changes nothing.
// ===========================================================================

test("the approvals migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "approvals"),
      true,
      "the approvals table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0011_approvals"),
      "db/migrations/0011_approvals.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0011's CREATE would throw "already exists", so an empty result AND
    // no throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
