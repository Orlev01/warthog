// E12-S06 — Approval opened-tracking (`src/server/approvals/opened.ts`,
// `db/migrations/0029_approval_opened.sql`).
//
// RED-first: neither the `opened_at` column nor the data-access module exists yet,
// so importing `./opened` throws and `freshDb()` has no `opened_at` column on the
// `approvals` table — every test here fails until the builder adds them. That
// absence IS the point of test-first; do NOT implement anything to make these pass —
// the builder writes the module and the migration afterwards.
//
// WHY this exists (design §10 Notifications / SMS-email fallback; brief "SMS
// fallback"): the fallback job sends an SMS/email ONLY while an approval is still
// unopened. Opened-tracking is the primitive both the inbox (which marks an approval
// opened when the person views it) and the fallback job (which checks whether it is
// still unopened before firing) depend on. Once the person has viewed the approval,
// the fallback is suppressed.
//
// These tests pin BEHAVIOUR (what the functions DO: marking an OWNED approval records
// `opened_at` at the injected clock instant; `isUnopened` is true ONLY while the
// approval is both unopened AND still pending; one person can never mark another's
// approval opened; every value is bound as a parameter; the repo reads no secret from
// the environment), never the source text of the module or the SQL file — a later
// rename that preserves behaviour must not redden them.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface MarkOpenedInput {
//     id: string;       // the approval being viewed
//     userId: string;   // the SESSION's user id, never a client value (member scope)
//   }
//
//   markOpened(db, input: MarkOpenedInput, clock: Clock): Promise<boolean>
//     • sets `opened_at = clock.now()` for the approval with `input.id` OWNED BY
//       `input.userId` (member-scoped: id AND user_id both BOUND). Returns true when
//       the caller's approval was found and recorded opened; false when no approval
//       with that id is owned by this user (so a non-owner marks nothing). Never uses
//       SQL now() — the instant is the injected clock's.
//   isUnopened(db, id: string): Promise<boolean>
//     • true ONLY while the approval with `id` is BOTH unopened (opened_at IS NULL)
//       AND still pending (status = 'pending'); false once it has been opened, once it
//       has been decided (approved/denied/expired), or when no such approval exists.
//       Credential-/id-keyed like the fallback job that calls it (no user scope): the
//       member-scope check happens a layer up, where the approval is loaded.
//
// Acceptance criteria → tests:
//   AC1 "markOpened sets opened_at for an approval owned by the session user, and
//        isUnopened reports true only while the approval is both unopened AND still
//        pending." — a fresh pending approval is unopened; after markOpened it is not
//        (opened_at is the injected clock instant); a DECIDED-but-never-opened approval
//        is NOT unopened (the "still pending" clause); an unknown id is not unopened.
//   AC2 "A user cannot mark another user's approval opened (filtered by session user
//        id)." — Bob's markOpened on Alice's approval marks nothing and leaves it
//        unopened; Alice can mark her own; a forged body user id does not override the
//        session id at the handler.
//   AC3 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed
//        / mis-shaped (SQL-injection-shaped) input with a 4xx BEFORE any query runs; and
//        a SQL-injection probe routed through the repo travels BOUND (never spliced into
//        the SQL text) and cannot drop the table. The handler below is a test fixture
//        (the intended usage), not an implementation file.
//   AC4 [obligation:secrets-from-env] (INV-103) — the repo takes db + clock as
//        dependencies, reads no `process.env` and holds no secret, so a decoy secret
//        planted in the environment never lands in a result or a stored column.
//   Migration: `approvals.opened_at` exists after the project migrations and a second
//        run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { isUnopened, markOpened } from "./opened";
// Documentary type anchor — the exact name/shape the implementation exports. Erased
// at runtime, so a rename cannot break this; the runtime assertions below gate behaviour.
import type { MarkOpenedInput } from "./opened";
import { createUser } from "../db/users";
import { createApproval, decide } from "../db/approvals";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "../db/index";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

const MINUTE_MS = 60_000;

// Compare the moment, not the representation: opened_at may come back as a Date or an
// ISO string depending on the driver — either is a reasonable choice.
const ms = (value: Date | string | number): number => new Date(value as never).getTime();

// T_CREATE is the create instant; T_DECIDE is well inside the (15-minute) default
// window; T_OPEN is the view/mark instant.
const T_CREATE = new Date("2026-03-01T09:00:00.000Z");
const T_DECIDE = new Date(T_CREATE.getTime() + MINUTE_MS);
const T_OPEN = new Date(T_CREATE.getTime() + 5 * MINUTE_MS);

// Agent connection ids are uuids; use a valid uuid so the `agent_id` column accepts it.
const AGENT_A = "11111111-1111-1111-1111-111111111111";

// A valid uuid that was never created — for the "unknown approval" reads (a well-formed
// value so it is never a cast error, it simply matches no row).
const ABSENT_ID = "99999999-9999-9999-9999-999999999999";

function freshDek(): Uint8Array {
  return randomBytes(32);
}

// Create a person and a PENDING approval for them. Returns the session user id, the
// approval id, and the DEK the approvals store used (needed to decide it later). The
// detail is DEK-encrypted by the approvals store; this opened-tracking store never
// reads it.
async function seedApproval(
  db: Db,
  who: string,
): Promise<{ userId: string; approvalId: string; dek: Uint8Array }> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  const dek = freshDek();
  const approval = await createApproval(
    db,
    {
      userId: user.id,
      agentId: AGENT_A,
      detail: { recipient: `r-${who}@example`, amount: "42.00 AUD", field: `field_${who}` },
    },
    dek,
    fixedClock(T_CREATE),
  );
  return { userId: user.id, approvalId: approval.id, dek };
}

// Read the raw `opened_at` cell for one approval (NULL when never opened). Reading
// stored state is behaviour; the column itself is what this task adds.
async function readOpenedAt(db: Db, id: string): Promise<unknown> {
  const result = await db.query("SELECT opened_at FROM approvals WHERE id = $1", [id]);
  return result.rows[0]?.opened_at ?? null;
}

// Whether a column of this exact name exists on this table — a non-throwing schema
// probe (behaviour, not source text), scoped to the one column under test.
async function columnExists(db: Db, table: string, column: string): Promise<boolean> {
  const result = await db.query(
    "SELECT 1 AS present FROM information_schema.columns WHERE table_name = $1 AND column_name = $2",
    [table, column],
  );
  return result.rows.length > 0;
}

// Whether a relation of this exact name exists. `to_regclass` yields the name when it
// exists and NULL otherwise — a non-throwing probe scoped to the one table under test.
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (bound value vs. spliced text). Returns no rows
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

// Assert a probe reached the query layer as a BOUND value and never as spliced SQL text,
// scoped to each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

function jsonRequest(path: string, body: string): Request {
  return new Request(`https://warthog.com.au${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

// A route handler fixture on the validation boundary — the intended usage, NOT an
// implementation file. The body carries only the approval `id` (a uuid); the session
// user id is injected by the server (never read from the body, so a forged body user
// id cannot widen the member scope). A rejected input maps to a 4xx and never reaches
// a query; a well-formed one calls this task's parameterized data-access.
function markOpenedHandler(
  db: Db,
  sessionUserId: string,
  clock: Clock,
): (req: Request) => Promise<Response> {
  const schema = z.object({ id: z.uuid() });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const marked = await markOpened(db, { id: body.id, userId: sessionUserId }, clock);
      return new Response(JSON.stringify({ marked }), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

// ===========================================================================
// AC1 — markOpened records opened_at; isUnopened reflects (unopened AND pending).
// ===========================================================================

test("a fresh pending approval is unopened and its opened_at starts NULL", async () => {
  const db = await freshDb();
  try {
    const { approvalId } = await seedApproval(db, "ac1-fresh");

    assert.equal(await readOpenedAt(db, approvalId), null, "opened_at starts NULL");
    assert.equal(
      await isUnopened(db, approvalId),
      true,
      "a newly created, never-viewed pending approval is unopened (its fallback is still armed)",
    );
  } finally {
    await db.close();
  }
});

test("markOpened records the approval opened at the injected clock instant, and isUnopened flips to false", async () => {
  const db = await freshDb();
  try {
    const { userId, approvalId } = await seedApproval(db, "ac1-mark");

    const marked: boolean = await markOpened(db, { id: approvalId, userId }, fixedClock(T_OPEN));
    assert.equal(marked, true, "marking an owned pending approval reports it was recorded opened");

    const stored = await readOpenedAt(db, approvalId);
    assert.notEqual(stored, null, "opened_at is now set");
    assert.equal(
      ms(stored as Date | string),
      ms(T_OPEN),
      "opened_at is the injected clock instant, never SQL now()",
    );

    assert.equal(
      await isUnopened(db, approvalId),
      false,
      "once viewed, the approval is no longer unopened — the fallback is suppressed",
    );
  } finally {
    await db.close();
  }
});

test("isUnopened is false for a DECIDED but never-opened approval (the 'still pending' clause)", async () => {
  const db = await freshDb();
  try {
    const { userId, approvalId, dek } = await seedApproval(db, "ac1-decided");

    // Decide it WITHOUT ever opening it — opened_at stays NULL, but status leaves 'pending'.
    await decide(
      db,
      { userId, id: approvalId, decision: { status: "approved" } },
      dek,
      fixedClock(T_DECIDE),
    );

    assert.equal(await readOpenedAt(db, approvalId), null, "it was never opened (opened_at still NULL)");
    assert.equal(
      await isUnopened(db, approvalId),
      false,
      "a decided approval is NOT unopened — isUnopened requires it to STILL be pending, not merely never-opened",
    );
  } finally {
    await db.close();
  }
});

test("isUnopened is false for an approval that does not exist", async () => {
  const db = await freshDb();
  try {
    // A well-formed but never-created id matches no row.
    await seedApproval(db, "ac1-absent");
    assert.equal(
      await isUnopened(db, ABSENT_ID),
      false,
      "a non-existent approval is not unopened — there is nothing pending to keep a fallback armed for",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — ownership: one person can never mark another's approval opened.
// ===========================================================================

test("markOpened by a non-owner marks nothing: the owner's approval stays unopened", async () => {
  const db = await freshDb();
  try {
    const alice = await seedApproval(db, "ac2-alice");
    const bob = await seedApproval(db, "ac2-bob");

    // Bob tries to mark ALICE's approval opened, using HIS session id.
    const marked: boolean = await markOpened(
      db,
      { id: alice.approvalId, userId: bob.userId },
      fixedClock(T_OPEN),
    );
    assert.equal(
      marked,
      false,
      "a non-owner's markOpened marks nothing (member-scoped by the session user id, never a client value)",
    );
    assert.equal(
      await readOpenedAt(db, alice.approvalId),
      null,
      "Alice's approval is untouched — its opened_at is still NULL",
    );
    assert.equal(
      await isUnopened(db, alice.approvalId),
      true,
      "Alice's approval remains unopened, so Bob cannot suppress her fallback",
    );

    // Alice CAN mark her own.
    assert.equal(
      await markOpened(db, { id: alice.approvalId, userId: alice.userId }, fixedClock(T_OPEN)),
      true,
      "Alice can mark her own approval opened",
    );
    assert.equal(await isUnopened(db, alice.approvalId), false, "...and only then is it opened");
  } finally {
    await db.close();
  }
});

test("marking an already-opened approval keeps it opened and does not error (idempotent view)", async () => {
  const db = await freshDb();
  try {
    const { userId, approvalId } = await seedApproval(db, "ac2-idem");

    await markOpened(db, { id: approvalId, userId }, fixedClock(T_OPEN));
    // A second view must neither throw nor re-arm the fallback.
    await markOpened(db, { id: approvalId, userId }, fixedClock(new Date(T_OPEN.getTime() + MINUTE_MS)));

    assert.equal(await isUnopened(db, approvalId), false, "a second view leaves the approval opened");
    assert.notEqual(
      await readOpenedAt(db, approvalId),
      null,
      "opened_at remains set after a repeat view",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — the handler rejects bad input at the boundary (VALIDATE half, INV-102).
// A rejected input never reaches a query (the recording db records zero calls).
// ===========================================================================

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = markOpenedHandler(db, ABSENT_ID, fixedClock(T_OPEN));

  const res = await handler(jsonRequest("/api/approvals/opened", "{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = markOpenedHandler(db, ABSENT_ID, fixedClock(T_OPEN));

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest("/api/approvals/opened", JSON.stringify({ id: "A".repeat(10 * 1024) })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing the id with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = markOpenedHandler(db, ABSENT_ID, fixedClock(T_OPEN));

  const res = await handler(jsonRequest("/api/approvals/opened", JSON.stringify({})));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed id with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = markOpenedHandler(db, ABSENT_ID, fixedClock(T_OPEN));

  // id must be a uuid string — a nested object is a schema violation, rejected before any query.
  const res = await handler(
    jsonRequest("/api/approvals/opened", JSON.stringify({ id: { oops: true } })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler rejects a SQL-injection-shaped id with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = markOpenedHandler(db, ABSENT_ID, fixedClock(T_OPEN));

  // A value laced with SQL punctuation is not a uuid: rejected at the boundary, so the
  // injection probe never reaches the query at all (the validate half of INV-102).
  const res = await handler(
    jsonRequest("/api/approvals/opened", JSON.stringify({ id: "x'); DROP TABLE approvals; --" })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-shaped id must never reach a query");
});

test("the handler marks a well-formed, owned approval opened and reports it", async () => {
  const db = await freshDb();
  try {
    const { userId, approvalId } = await seedApproval(db, "ac3-ok");
    const handler = markOpenedHandler(db, userId, fixedClock(T_OPEN));

    const res = await handler(
      jsonRequest("/api/approvals/opened", JSON.stringify({ id: approvalId })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const result = (await res.json()) as { marked: boolean };
    assert.equal(result.marked, true, "the owned approval is marked opened");
    assert.equal(await isUnopened(db, approvalId), false, "...and is no longer unopened");
  } finally {
    await db.close();
  }
});

test("the session user id is authoritative: a forged body user id cannot mark another person's approval", async () => {
  const db = await freshDb();
  try {
    const alice = await seedApproval(db, "ac3-session-alice");
    const bob = await seedApproval(db, "ac3-session-bob");

    // The handler runs under BOB's session. The client forges Alice's user id in the body.
    const handler = markOpenedHandler(db, bob.userId, fixedClock(T_OPEN));
    const res = await handler(
      jsonRequest(
        "/api/approvals/opened",
        JSON.stringify({ id: alice.approvalId, userId: alice.userId }),
      ),
    );

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    // The server scopes by the SESSION id (Bob), who does not own Alice's approval — so
    // nothing is marked, and the forged body user id was ignored.
    assert.equal(
      await isUnopened(db, alice.approvalId),
      true,
      "Alice's approval is still unopened — the session id (Bob), not the forged body id, scoped the write",
    );
    assert.equal(
      await readOpenedAt(db, alice.approvalId),
      null,
      "Alice's opened_at is still NULL",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — every statement binds its input as a parameter (PARAMETERIZE half, INV-102);
// a probe routed through the repo is bound and the table survives.
// ===========================================================================

test("markOpened binds the id and user id as parameters, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "a'); DROP TABLE approvals; --";

  // The recording db returns no rows; markOpened simply reports nothing was marked — the
  // binding is asserted regardless of the (tolerated) no-row result.
  try {
    await markOpened(db, { id: probe, userId: probe }, fixedClock(T_OPEN));
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }
  assertBoundNotSpliced(db, probe);
});

test("isUnopened binds the id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "x'); DROP TABLE approvals; --";

  try {
    await isUnopened(db, probe);
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }
  assertBoundNotSpliced(db, probe);
});

test("a SQL-injection probe routed through the repo cannot drop the approvals table", async () => {
  const db = await freshDb();
  try {
    const { userId, approvalId } = await seedApproval(db, "ac3-inject");

    // `approvals.id` is a uuid column, so a non-uuid probe is bound as a (malformed)
    // VALUE — Postgres may reject the cast, but it is never executed as SQL. Tolerate the
    // rejection; the point is the table is NOT dropped and the genuine approval still works.
    const probe = "x'; DROP TABLE approvals; --";
    try {
      await markOpened(db, { id: probe, userId }, fixedClock(T_OPEN));
    } catch {
      /* a cast rejection is fine — the probe was treated as data, not SQL */
    }
    try {
      await isUnopened(db, probe);
    } catch {
      /* same */
    }

    assert.equal(
      await tableExists(db, "approvals"),
      true,
      "the approvals table must still exist (the probe was bound, not run as SQL)",
    );
    // The genuine approval is untouched and still behaves.
    assert.equal(
      await isUnopened(db, approvalId),
      true,
      "the real approval is unaffected and still unopened",
    );
    assert.equal(
      await markOpened(db, { id: approvalId, userId }, fixedClock(T_OPEN)),
      true,
      "the real approval still marks opened after the injection attempt",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 — the repo reads no process.env: a decoy secret never lands in a result or row.
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in a result", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const { userId, approvalId } = await seedApproval(db, "ac4-env");

    const marked = await markOpened(db, { id: approvalId, userId }, fixedClock(T_OPEN));
    const unopened = await isUnopened(db, approvalId);

    assert.equal(marked, true, "marking works purely from the injected db + clock — no app env needed");
    assert.equal(unopened, false, "and the opened state is read back without any env");
    assert.ok(
      !JSON.stringify({ marked, unopened }).includes(DECOY),
      "no ambient env value is folded into the results",
    );

    // Scan the one approval row for the decoy (scoped narrowly to the row under test).
    const row = await db.query("SELECT * FROM approvals WHERE id = $1", [approvalId]);
    for (const cell of Object.values(row.rows[0] ?? {})) {
      if (typeof cell === "string") {
        assert.ok(!cell.includes(DECOY), "no ambient env value is written to a column");
      }
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// ===========================================================================
// Migration — opened_at is added to approvals and a second run changes nothing.
// ===========================================================================

test("the 0029 migration adds opened_at to approvals and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await columnExists(db, "approvals", "opened_at"),
      true,
      "approvals.opened_at must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0029_approval_opened"),
      "db/migrations/0029_approval_opened.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0029's ALTER would throw, so an empty result AND no throw together
    // prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});

// A compile-time anchor that MarkOpenedInput is the exported input shape (erased at
// runtime; keeps the documentary type import honest without asserting source text).
const _inputAnchor: MarkOpenedInput = { id: ABSENT_ID, userId: ABSENT_ID };
void _inputAnchor;
