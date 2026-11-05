// E07-S04 — Held-request store (`src/server/db/held-requests.ts`,
// `db/migrations/0012_held_requests.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so
// importing `./held-requests` throws and `freshDb()` has no `held_requests` table —
// every test here fails until the builder adds them. That absence IS the point of
// test-first; do NOT implement anything to make these pass — the builder writes the
// module and the migration afterwards.
//
// These tests pin BEHAVIOUR (what the data-access functions DO: the stored status,
// the round-tripped args, who can read/execute what, the single-shot execution, what
// a handler rejects), never the source text of the module or the SQL file — a later
// rename that preserves behaviour must not redden them.
//
// WHY this exists (design §6.2, brief "Agents wait safely"): on an `ask` decision the
// pipeline HOLDS the exact agent call (`held_requests`, encrypted args) and creates a
// linked approval; the agent is told `pending_approval`. On approval Warthog executes
// that held call EXACTLY ONCE and returns the result via `check_approval`. The held
// call's ARGS carry personal content (recipient, amount, the field asked for), so they
// are stored only DEK-ENCRYPTED (design §4.1, project rule: personal content is
// encrypted with the per-person DEK; the plaintext never lands in a column).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface NewHeldRequest {
//     userId: string;      // the person (the session's id, never a client value)
//     agentId: string;     // the requesting agent connection
//     approvalId: string;  // the approval this held call is parked behind
//     args: Record<string, unknown>;  // the exact agent-call args — stored DEK-encrypted
//   }
//
//   interface StoredHeldRequest {
//     id: string;          // generated on create; identifies the held call
//     userId: string;
//     agentId: string;
//     approvalId: string;
//     status: "held" | "executed";    // "held" on create; "executed" once run
//     args: Record<string, unknown>;  // DECRYPTED on read, under the injected DEK
//     createdAt: Date | string;       // the injected clock's instant (moment, not representation)
//     executedAt?: Date | string;     // set when markExecuted first succeeds
//   }
//
//   interface MarkExecutedInput { userId: string; id: string }
//
//   createHeldRequest(db, input: NewHeldRequest, dek, clock): Promise<StoredHeldRequest>
//     • stores a "held" row for `userId` with its DEK-encrypted args, linked to
//       `approvalId` (createdAt = clock.now()), and returns the StoredHeldRequest
//       (carrying the generated id).
//   getByApproval(db, userId, approvalId, dek): Promise<StoredHeldRequest | null>
//     • the held request parked behind this approval OWNED BY `userId` (member-scoped:
//       approval_id AND user_id both bound), args decrypted under `dek`; null when none
//       for this user. Another user's approval id returns null (they cannot read it).
//   markExecuted(db, { userId, id }, dek, clock): Promise<StoredHeldRequest>
//     • member-scoped and SINGLE-SHOT: loads the owned held request (throws when none
//       for this user, so one person can never execute another's). While it is still
//       "held" it transitions to "executed", stamps executedAt = clock.now(), and
//       returns the StoredHeldRequest with DECRYPTED args (the executor receives the
//       call to run, exactly once). An already-executed held request is REFUSED (throws)
//       and left unchanged — so Warthog can never run the same held call twice.
//
// Acceptance criteria → tests:
//   AC1 "Creating a held request stores args DEK-encrypted and getByApproval returns
//        the decrypted args for the owning user only." — createHeldRequest returns an
//        id and a "held" status; getByApproval reads it back with the SAME args; the
//        plaintext args never appear in a raw column (encrypted at rest); only the
//        owner can read it.
//   AC2 "markExecuted is single-shot: a held request already executed cannot be
//        executed again." — the first markExecuted executes and returns the args; the
//        second is refused and the stored row (status + executedAt) is unchanged.
//   AC3 "A second signed-in user cannot read or execute another user's held request by
//        id (filtered by session user id)." — B's getByApproval returns null and B's
//        markExecuted throws, leaving A's held request untouched; the user id is bound
//        as a parameter.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed/oversized input with a 4xx
//        before any query runs; a SQL-injection probe routed through the repo travels
//        as a BOUND value (placeholders, never concatenation) and cannot drop the
//        table. The handler is a test fixture (the intended usage), not an
//        implementation file.
//   AC5 [obligation:secrets-from-env] — the args are encrypted under the INJECTED DEK,
//        not a baked-in secret: a different DEK cannot read them back. (The repo reads
//        no `process.env` and holds no key; the DEK and clock are injected.)
//   Migration: the `held_requests` relation exists after the project migrations and a
//        second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { createHeldRequest, getByApproval, markExecuted } from "./held-requests";
import { createApproval } from "./approvals";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

const MINUTE = 60_000;
const DEK_BYTES = 32; // a 256-bit per-person data key

// Compare the moment, not the representation: createdAt / executedAt may come back as
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

// The held call's args (brief: the exact call parked behind the approval). The
// recipient and field carry UNIQUE tokens so an at-rest scan for them is unambiguous —
// a hit would be a real plaintext leak, not a coincidence.
function argsWith(token: string): Record<string, unknown> {
  return {
    tool: "gmail__send",
    to: `mallory-${token}@secret.example`,
    amount: "42.00 AUD",
    note: `passport_number_${token}`,
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

// Create a REAL approval for this person and return its id. A held request is parked
// behind an approval, so using a genuine approval id keeps the link realistic and is
// safe whether or not the schema binds `approval_id` with a foreign key.
async function makeApproval(
  db: Db,
  userId: string,
  dek: Uint8Array,
  agentId: string = AGENT_A,
): Promise<string> {
  const approval = await createApproval(
    db,
    { userId, agentId, detail: { recipient: "r@example.com", amount: "1 AUD", field: "none" } },
    dek,
    fixedClock(T0),
  );
  return approval.id;
}

// ===========================================================================
// AC1 — creating stores a "held" request with its DEK-encrypted args, linked to
// an approval, and returns its id; getByApproval reads it back for the owner.
// ===========================================================================

test("createHeldRequest returns a held request with an id, held status and the injected created-at", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1");
    const dek = freshDek();
    const approvalId = await makeApproval(db, userId, dek);

    const created = await createHeldRequest(
      db,
      { userId, agentId: AGENT_A, approvalId, args: argsWith("A1") },
      dek,
      fixedClock(T0),
    );

    assert.equal(typeof created.id, "string", "createHeldRequest returns an id string");
    assert.ok(created.id.length > 0, "the returned id is non-empty");
    assert.equal(created.status, "held", "a freshly held request waits as held");
    assert.equal(created.userId, userId, "the held request belongs to the creating person");
    assert.equal(created.approvalId, approvalId, "it is linked to its approval");
    assert.equal(ms(created.createdAt), ms(T0), "createdAt is the injected clock instant");
    assert.equal(created.executedAt ?? undefined, undefined, "a held request has not executed yet");
  } finally {
    await db.close();
  }
});

test("createHeldRequest gives each held request a distinct id", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-ids");
    const dek = freshDek();
    const one = await createHeldRequest(
      db,
      { userId, agentId: AGENT_A, approvalId: await makeApproval(db, userId, dek), args: argsWith("x") },
      dek,
      fixedClock(T0),
    );
    const two = await createHeldRequest(
      db,
      { userId, agentId: AGENT_A, approvalId: await makeApproval(db, userId, dek), args: argsWith("y") },
      dek,
      fixedClock(T0),
    );
    assert.notEqual(one.id, two.id, "two created held requests have different ids");
  } finally {
    await db.close();
  }
});

test("getByApproval reads a created held request back: held, same args, owned by the person", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-read");
    const dek = freshDek();
    const approvalId = await makeApproval(db, userId, dek);
    const args = argsWith("ROUND");

    const created = await createHeldRequest(
      db,
      { userId, agentId: AGENT_A, approvalId, args },
      dek,
      fixedClock(T0),
    );

    const loaded = await getByApproval(db, userId, approvalId, dek);
    assert.ok(loaded, "the created held request is readable by its owner via the approval");
    assert.equal(loaded!.id, created.id, "the same held-request id is returned");
    assert.equal(loaded!.status, "held", "it is still held");
    assert.equal(loaded!.agentId, AGENT_A, "the requesting agent is preserved");
    assert.deepEqual(loaded!.args, args, "the DEK-encrypted args round-trip verbatim");
    assert.equal(loaded!.executedAt ?? undefined, undefined, "it has not executed yet");
  } finally {
    await db.close();
  }
});

test("getByApproval returns null when no held request is parked behind the approval", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-none");
    const dek = freshDek();
    // A real approval with nothing held behind it.
    const approvalId = await makeApproval(db, userId, dek);

    const loaded = await getByApproval(db, userId, approvalId, dek);
    assert.equal(loaded, null, "an approval with no held request returns null");
  } finally {
    await db.close();
  }
});

test("the args are stored DEK-encrypted: the plaintext recipient and field never appear in a raw column", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-atrest");
    const dek = freshDek();
    const approvalId = await makeApproval(db, userId, dek);
    const args = argsWith("LEAKCHECK9x");

    await createHeldRequest(db, { userId, agentId: AGENT_A, approvalId, args }, dek, fixedClock(T0));

    // Scan every cell of the one table under test. The recipient address and the field
    // name are personal content that MUST be encrypted (AC1), and their tokens are
    // unique, so any raw occurrence is a genuine plaintext leak. Scoped to
    // `held_requests` alone — the same value may legitimately live (encrypted) elsewhere.
    const all = await db.query("SELECT * FROM held_requests");
    assert.ok(all.rows.length >= 1, "the held-request row was stored");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(
            !cell.includes(args.to as string),
            "the plaintext recipient must never be written to a column",
          );
          assert.ok(
            !cell.includes(args.note as string),
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
// AC5 — the args are encrypted under the INJECTED dek, not a baked-in secret:
// a different dek cannot read them back.
// ===========================================================================

test("getByApproval cannot decrypt the args with a different DEK", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5");
    const dek = freshDek();
    const approvalId = await makeApproval(db, userId, dek);
    await createHeldRequest(db, { userId, agentId: AGENT_A, approvalId, args: argsWith("K") }, dek, fixedClock(T0));

    // A different DEK is the wrong key; the GCM tag must fail rather than return other
    // bytes — so reading the args under it rejects.
    const wrongDek = freshDek();
    await assert.rejects(
      async () => {
        await getByApproval(db, userId, approvalId, wrongDek);
      },
      "the args are bound to the person's own DEK, not any ambient/hardcoded key",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — markExecuted is single-shot: the first run executes and hands back the
// args; the second is refused and leaves the stored row unchanged.
// ===========================================================================

test("markExecuted executes a held request once, returning the args to run and stamping the time", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-exec");
    const dek = freshDek();
    const approvalId = await makeApproval(db, userId, dek);
    const args = argsWith("EXEC");
    const created = await createHeldRequest(db, { userId, agentId: AGENT_A, approvalId, args }, dek, fixedClock(T0));

    const execAt = new Date(T0.getTime() + 5 * MINUTE);
    const executed = await markExecuted(db, { userId, id: created.id }, dek, fixedClock(execAt));

    assert.equal(executed.status, "executed", "a held request becomes executed");
    assert.deepEqual(executed.args, args, "markExecuted hands back the exact args to run");
    assert.ok(executed.executedAt !== undefined, "executing stamps an execution time");
    assert.equal(ms(executed.executedAt!), ms(execAt), "executedAt is the injected clock instant");

    const reloaded = await getByApproval(db, userId, approvalId, dek);
    assert.equal(reloaded!.status, "executed", "the held request is persisted as executed");
  } finally {
    await db.close();
  }
});

test("markExecuted refuses to execute an already-executed held request and leaves it unchanged", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-single");
    const dek = freshDek();
    const approvalId = await makeApproval(db, userId, dek);
    const created = await createHeldRequest(db, { userId, agentId: AGENT_A, approvalId, args: argsWith("ONCE") }, dek, fixedClock(T0));

    const execAt = new Date(T0.getTime() + MINUTE);
    await markExecuted(db, { userId, id: created.id }, dek, fixedClock(execAt));

    // The call ran once already; a second execution must be refused (never silently),
    // so Warthog can never run the same held call twice.
    await assert.rejects(
      async () => {
        await markExecuted(db, { userId, id: created.id }, dek, fixedClock(new Date(T0.getTime() + 2 * MINUTE)));
      },
      "an already-executed held request cannot be executed again",
    );

    const reloaded = await getByApproval(db, userId, approvalId, dek);
    assert.equal(reloaded!.status, "executed", "the refused second attempt leaves it executed");
    assert.equal(
      ms(reloaded!.executedAt!),
      ms(execAt),
      "the original execution time is untouched by the refused second attempt",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: a second signed-in user can never read or execute another's
// held request. The user id is bound from the session, never the client.
// ===========================================================================

test("getByApproval never returns another user's held request", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-alice");
    const bob = await makeUser(db, "owner-bob");
    const dek = freshDek();

    const approvalId = await makeApproval(db, alice, dek);
    await createHeldRequest(db, { userId: alice, agentId: AGENT_A, approvalId, args: argsWith("AL") }, dek, fixedClock(T0));

    assert.ok(await getByApproval(db, alice, approvalId, dek), "Alice can read her own held request");
    assert.equal(
      await getByApproval(db, bob, approvalId, dek),
      null,
      "Bob cannot read Alice's held request via her approval id",
    );
  } finally {
    await db.close();
  }
});

test("markExecuted cannot execute another user's held request, and leaves it unchanged", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "exec-alice");
    const bob = await makeUser(db, "exec-bob");
    const dek = freshDek();

    const approvalId = await makeApproval(db, alice, dek);
    const alices = await createHeldRequest(db, { userId: alice, agentId: AGENT_A, approvalId, args: argsWith("AL3") }, dek, fixedClock(T0));

    // Bob tries to execute Alice's held request by its id: member-scoped, so there is
    // no such held request FOR BOB — markExecuted must refuse (never silently run it).
    await assert.rejects(
      async () => {
        await markExecuted(db, { userId: bob, id: alices.id }, dek, fixedClock(new Date(T0.getTime() + MINUTE)));
      },
      "Bob cannot execute a held request that is not his",
    );

    const stillAlices = await getByApproval(db, alice, approvalId, dek);
    assert.equal(stillAlices!.status, "held", "Alice's held request is untouched by Bob's attempt");
    assert.equal(stillAlices!.executedAt ?? undefined, undefined, "and it still has not executed");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — every statement binds its input as a parameter (no spliced SQL).
// ===========================================================================

test("createHeldRequest binds the ids as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "a'; DROP TABLE held_requests; --";

  await createHeldRequest(
    db,
    { userId: probe, agentId: AGENT_A, approvalId: probe, args: argsWith("bind") },
    freshDek(),
    fixedClock(T0),
  );

  assert.ok(db.calls.length >= 1, "creating issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("getByApproval binds the approval id and user id as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "p'; DROP TABLE held_requests; --";

  const result = await getByApproval(db, probe, probe, freshDek());
  assert.equal(result, null, "the recording db returns no rows, so the lookup is empty");

  assert.ok(db.calls.length >= 1, "the lookup issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("markExecuted binds the id and user id when it loads the held request, never splicing SQL", async () => {
  const db = recordingDb();
  const probe = "x'; DROP TABLE held_requests; --";

  // No row comes back, so markExecuted cannot find a held request for this (user, id)
  // and must refuse — but the load it issued must have bound the probe, not spliced it.
  await assert.rejects(async () => {
    await markExecuted(db, { userId: probe, id: probe }, freshDek(), fixedClock(T0));
  }, "markExecuted refuses when no owned held request exists");

  assert.ok(db.calls.length >= 1, "markExecuted issues at least one query to load the held request");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("a SQL-injection probe in the args is stored as data: the table survives and it round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const dek = freshDek();
    const approvalId = await makeApproval(db, userId, dek);
    const args = {
      tool: "gmail__send",
      to: "grace'); DROP TABLE held_requests; --",
      note: "evil'); DROP TABLE held_requests; --",
    };

    const created = await createHeldRequest(db, { userId, agentId: AGENT_A, approvalId, args }, dek, fixedClock(T0));

    assert.equal(
      await tableExists(db, "held_requests"),
      true,
      "the held_requests table must still exist (the probe was stored as data, not run as SQL)",
    );

    const loaded = await getByApproval(db, userId, approvalId, dek);
    assert.equal(loaded!.id, created.id, "the same held request is read back");
    assert.deepEqual(loaded!.args, args, "the probe round-trips verbatim as data");
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

function holdRequestHandler(
  db: Db,
  dek: Uint8Array,
  clock: Clock,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries the agent, the linked approval and the call's args; the user id
  // comes from the session. Lengths are capped so an absurd value is rejected, but
  // generous enough that a probe can still REACH the query to prove it is bound.
  const schema = z.object({
    agentId: z.string().min(1).max(64),
    approvalId: z.string().min(1).max(64),
    args: z.record(z.string(), z.unknown()),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const created = await createHeldRequest(
        db,
        {
          userId: sessionUserId,
          agentId: body.agentId,
          approvalId: body.approvalId,
          args: body.args,
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
  return new Request("https://warthog.com.au/api/held-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = holdRequestHandler(db, freshDek(), fixedClock(T0), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = holdRequestHandler(db, freshDek(), fixedClock(T0), "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest(
      JSON.stringify({ agentId: AGENT_A, approvalId: AGENT_B, args: { note: "a".repeat(10 * 1024) } }),
    ),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing a required field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = holdRequestHandler(db, freshDek(), fixedClock(T0), "session-user");

  // No approvalId — a held request must be parked behind an approval.
  const res = await handler(jsonRequest(JSON.stringify({ agentId: AGENT_A, args: { to: "x" } })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler accepts a well-formed body and holds the request for the session user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const dek = freshDek();
    const approvalId = await makeApproval(db, userId, dek);
    const handler = holdRequestHandler(db, dek, fixedClock(T0), userId);

    const res = await handler(
      jsonRequest(
        JSON.stringify({ agentId: AGENT_A, approvalId, args: { tool: "gmail__send", to: "dana@example.com" } }),
      ),
    );

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { id } = (await res.json()) as { id: string };

    const stored = await getByApproval(db, userId, approvalId, dek);
    assert.ok(stored, "a valid held request is persisted for the session user");
    assert.equal(stored!.id, id, "the stored held request matches the returned id");
    assert.equal(stored!.status, "held", "and it is held");
    assert.equal(stored!.args.to, "dana@example.com", "with the submitted args");
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected: a probe arg is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const dek = freshDek();
    const approvalId = await makeApproval(db, userId, dek);
    const handler = holdRequestHandler(db, dek, fixedClock(T0), userId);
    const probe = "grace'); DROP TABLE held_requests; --";

    const res = await handler(
      jsonRequest(JSON.stringify({ agentId: AGENT_A, approvalId, args: { tool: "x", to: probe } })),
    );

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(await tableExists(db, "held_requests"), true, "the held_requests table must still exist");

    const stored = await getByApproval(db, userId, approvalId, dek);
    assert.equal(stored!.args.to, probe, "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Migration — the table applies and a second run changes nothing.
// ===========================================================================

test("the held_requests migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "held_requests"),
      true,
      "the held_requests table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0012_held_requests"),
      "db/migrations/0012_held_requests.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0012's CREATE would throw "already exists", so an empty result AND
    // no throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
