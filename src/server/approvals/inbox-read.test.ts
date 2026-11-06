// E12-S11 — Approval inbox read (pending + history) (`src/server/approvals/inbox-read.ts`).
//
// RED-first: the module under test does NOT exist yet, so importing `./inbox-read`
// throws and every test here fails until the builder writes it. That absence IS the
// point of test-first — do NOT implement anything to make these pass; the builder
// writes `inbox-read.ts` afterwards.
//
// These tests pin BEHAVIOUR (what the read returns: which approvals, in what order,
// scoped to whom, with which decrypted fields and what time-left) — never the source
// text of the module or any SQL. A later rename that preserves behaviour must not
// redden them.
//
// WHY this exists (design §6, brief "Approval inbox" / "Agents wait safely"): the
// inbox page needs ONE owner-scoped read of the person's PENDING requests plus a
// HISTORY of past decisions. It is distinct from the agent-facing `check_approval`
// (that tells the waiting agent its outcome); this read is for the OWNER and never
// returns another person's approvals. The approval `detail` (recipient / amount /
// field / reason / the triggering rule / the plain-language sentence) is PERSONAL
// CONTENT stored DEK-encrypted by the approvals store (E07-S03), so this read decrypts
// it under the INJECTED per-person DEK — it holds no key and reads no `process.env`.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   // The requesting agent, resolved for display from the agents aggregate.
//   interface ApprovalAgentRef { id: string; displayName: string }
//
//   // A pending request awaiting the OWNER's decision.
//   interface PendingApproval {
//     id: string;
//     agent: ApprovalAgentRef;              // the requesting agent (name resolved)
//     detail: Record<string, unknown>;      // DECRYPTED: the plain-language `sentence`,
//                                            //   the exact details (recipient/amount/field),
//                                            //   the stated `reason` and the triggering `rule`
//                                            //   all live here (opaque to the read)
//     createdAt: Date | string;
//     expiresAt: Date | string;
//     timeLeftMs: number;                    // max(0, ms(expiresAt) - ms(clock.now()))
//     status: "pending";
//   }
//
//   // A past decision: approved / denied / expired / more_detail.
//   interface DecidedApproval {
//     id: string;
//     agent: ApprovalAgentRef;
//     detail: Record<string, unknown>;       // DECRYPTED, as above
//     createdAt: Date | string;
//     expiresAt: Date | string;
//     decidedAt?: Date | string;             // set on approve / deny / expire
//     question?: string;                      // set on a more_detail decision
//     status: "approved" | "denied" | "expired" | "more_detail";
//   }
//
//   interface Inbox {
//     pending: PendingApproval[];             // the owner's status='pending', NEWEST-FIRST
//     history: DecidedApproval[];             // the owner's decided ones (any order)
//   }
//
//   readInbox(db, userId, dek, clock): Promise<Inbox>
//     • Lists `userId`'s PENDING approvals newest-first, each with its requesting agent
//       (name resolved), its decrypted detail (sentence / recipient / amount / field /
//       reason / triggering rule) and the time left before expiry (from the injected
//       clock). Plus a HISTORY of the person's decided approvals — approved, denied,
//       expired AND more_detail. Member-scoped by the `userId` the caller passes (the
//       session's id, never a client value): another person's approvals are never
//       returned in either list. The user id is bound as a parameter (no spliced SQL).
//
// Acceptance criteria → tests:
//   AC1 "Lists the owner's pending approvals newest-first with the agent, the
//        plain-sentence request, the exact details (recipient/amount/field), the reason,
//        the triggering rule and the time left before expiry."
//   AC2 "Returns a history of past decisions including denied, expired and more_detail
//        ones." (and approved; pending are NOT in history)
//   AC3 "A user never receives another user's approvals."
//   AC4 [obligation:validate-and-parameterize-input] — a handler rejects malformed /
//        oversized input with a 4xx (nothing reaches a query); the user id is bound as a
//        parameter and a SQL-injection probe routed through the read travels as data and
//        cannot alter a query. The handler is a test fixture (the intended usage), not an
//        implementation file.
//   AC5 [obligation:secrets-from-env] — the read runs from its INJECTED deps alone (db,
//        userId, dek, clock): no secret, no ambient config; the detail decrypts only
//        under the injected DEK, so a different DEK cannot read it back.
//
// Every db handle is closed in a `finally`; each real-db test uses its own `freshDb()`
// (an isolated in-memory PGlite with the real migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import { readInbox } from "./inbox-read";
import { createApproval, decide } from "../db/approvals";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";
import type { Db } from "../db/index";

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const MINUTE = 60_000;

// A base instant deliberately in the PAST relative to the wall clock, so anything that
// wrongly read Date.now() instead of the injected clock would diverge here.
const T0 = new Date("2026-02-01T09:00:00.000Z");

// Compare the moment, not the representation: timestamps may come back as a Date or an
// ISO string — either is a reasonable choice and must not redden a test.
const ms = (value: Date | string | number): number => new Date(value as never).getTime();

// A fresh random 256-bit DEK. The real DEK is unwrapped from the KeyWrapper seam a layer
// up; this read only ever receives the already-unwrapped bytes (like the store).
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque; this read never unwraps it — it takes
// the already-unwrapped dek directly).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every member-scoped row hangs off this id).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// Insert an agent row the inbox read resolves the display name from. Its `id` AND
// `connection_id` are BOTH set to `agentId`, so whichever column the read joins the
// approval's `agent_id` against, it resolves to this one row with this display name —
// the test does not bet on the internal join key, only on the resolved name.
async function makeAgent(
  db: Db,
  input: { userId: string; agentId: string; displayName: string; platform?: string },
): Promise<void> {
  await db.query(
    `INSERT INTO agents (id, user_id, connection_id, display_name, platform, status, connected_at)
     VALUES ($1, $2, $1, $3, $4, 'connected', $5::timestamptz)`,
    [input.agentId, input.userId, input.displayName, input.platform ?? "Claude Desktop", T0.toISOString()],
  );
}

// The approval detail the inbox shows (brief: "the exact details (recipient, amount,
// field requested)"), plus the plain-language `sentence`, the stated `reason`, and the
// triggering `rule` the inbox lists. A unique token keeps values unambiguous.
function detailWith(token: string): Record<string, unknown> {
  return {
    sentence: `wants to request a card for AUD 42 (${token})`,
    recipient: `mallory-${token}@secret.example`,
    amount: "42.00 AUD",
    field: `card_${token}`,
    reason: `paying the invoice due today (${token})`,
    rule: `Ask me before any agent requests a card (${token})`,
  };
}

// A uuid for an agent connection (the `agents.id`/`approvals.agent_id` columns are uuid).
const uuid = (): string => randomUUID();

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (bound value vs. spliced text). It returns no
// rows and satisfies the `Db` shape structurally (query + close).
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

// ===========================================================================
// AC1 — the owner's PENDING approvals, newest-first, each with the agent, the
// plain-sentence, the exact details, the reason, the triggering rule and the time left.
// ===========================================================================

test("readInbox lists the owner's pending approvals newest-first (by created time)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-order");
    const dek = freshDek();
    const agentId = uuid();
    await makeAgent(db, { userId, agentId, displayName: "Asterisk" });

    // Three pending approvals, created one minute apart.
    const oldest = await createApproval(db, { userId, agentId, detail: detailWith("old") }, dek, fixedClock(T0));
    const middle = await createApproval(db, { userId, agentId, detail: detailWith("mid") }, dek, fixedClock(new Date(T0.getTime() + MINUTE)));
    const newest = await createApproval(db, { userId, agentId, detail: detailWith("new") }, dek, fixedClock(new Date(T0.getTime() + 2 * MINUTE)));

    const inbox = await readInbox(db, userId, dek, fixedClock(new Date(T0.getTime() + 3 * MINUTE)));

    assert.equal(inbox.pending.length, 3, "all three pending approvals are listed");
    assert.deepEqual(
      inbox.pending.map((p) => p.id),
      [newest.id, middle.id, oldest.id],
      "pending approvals come back newest-created first",
    );
    for (const entry of inbox.pending) {
      assert.equal(entry.status, "pending", "every entry in `pending` is pending");
    }
  } finally {
    await db.close();
  }
});

test("each pending approval carries the agent, the plain-sentence, the exact details, the reason and the triggering rule", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-fields");
    const dek = freshDek();
    const agentId = uuid();
    await makeAgent(db, { userId, agentId, displayName: "Asterisk" });
    const detail = detailWith("FIELDS");

    const created = await createApproval(db, { userId, agentId, detail }, dek, fixedClock(T0));

    const inbox = await readInbox(db, userId, dek, fixedClock(new Date(T0.getTime() + 5 * MINUTE)));
    assert.equal(inbox.pending.length, 1, "the one pending approval is listed");
    const entry = inbox.pending[0]!;

    assert.equal(entry.id, created.id, "the entry is the created approval");

    // The agent — resolved for display.
    assert.equal(entry.agent.id, agentId, "the requesting agent id is carried");
    assert.equal(entry.agent.displayName, "Asterisk", "the agent's display name is resolved");

    // The plain-sentence request, the exact details, the reason and the triggering rule
    // — the decrypted detail round-trips so the inbox can show every one.
    assert.equal(entry.detail.sentence, detail.sentence, "the plain-language sentence is present");
    assert.equal(entry.detail.recipient, detail.recipient, "the exact recipient is present");
    assert.equal(entry.detail.amount, detail.amount, "the exact amount is present");
    assert.equal(entry.detail.field, detail.field, "the exact field requested is present");
    assert.equal(entry.detail.reason, detail.reason, "the stated reason is present");
    assert.equal(entry.detail.rule, detail.rule, "the triggering rule is present");
  } finally {
    await db.close();
  }
});

test("a pending approval carries the time left before expiry, from the injected clock", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-timeleft");
    const dek = freshDek();
    const agentId = uuid();
    await makeAgent(db, { userId, agentId, displayName: "Asterisk" });

    // Created at T0 with a 15-minute window ⇒ expiresAt = T0 + 15m.
    const created = await createApproval(
      db,
      { userId, agentId, detail: detailWith("TL"), expiryMinutes: 15 },
      dek,
      fixedClock(T0),
    );

    // Read five minutes in: ten minutes remain. (A Date.now()-based read would be far
    // off, since T0 is in the past relative to the wall clock.)
    const atFive = await readInbox(db, userId, dek, fixedClock(new Date(T0.getTime() + 5 * MINUTE)));
    const five = atFive.pending.find((p) => p.id === created.id)!;
    assert.ok(five, "the approval is pending five minutes in");
    assert.equal(five.timeLeftMs, 10 * MINUTE, "time left is expiry minus the injected now (10 minutes)");

    // Read past the window: time left is floored at zero, never negative.
    const atTwenty = await readInbox(db, userId, dek, fixedClock(new Date(T0.getTime() + 20 * MINUTE)));
    const twenty = atTwenty.pending.find((p) => p.id === created.id)!;
    assert.ok(twenty, "the still-pending approval is listed after its window");
    assert.equal(twenty.timeLeftMs, 0, "time left floors at zero once the window has passed");
  } finally {
    await db.close();
  }
});

test("each pending entry resolves its OWN requesting agent's display name", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-agents");
    const dek = freshDek();
    const agentA = uuid();
    const agentB = uuid();
    await makeAgent(db, { userId, agentId: agentA, displayName: "Research Agent" });
    await makeAgent(db, { userId, agentId: agentB, displayName: "Shopping Agent" });

    const a = await createApproval(db, { userId, agentId: agentA, detail: detailWith("A") }, dek, fixedClock(T0));
    const b = await createApproval(db, { userId, agentId: agentB, detail: detailWith("B") }, dek, fixedClock(new Date(T0.getTime() + MINUTE)));

    const inbox = await readInbox(db, userId, dek, fixedClock(new Date(T0.getTime() + 2 * MINUTE)));
    const byId = new Map(inbox.pending.map((p) => [p.id, p]));

    assert.equal(byId.get(a.id)!.agent.displayName, "Research Agent", "approval A shows agent A's name");
    assert.equal(byId.get(b.id)!.agent.displayName, "Shopping Agent", "approval B shows agent B's name");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a HISTORY of past decisions: approved, denied, expired AND more_detail —
// and pending approvals are NOT in the history.
// ===========================================================================

test("the history returns approved, denied, expired and more_detail decisions, and excludes pending", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-history");
    const dek = freshDek();
    const agentId = uuid();
    await makeAgent(db, { userId, agentId, displayName: "Asterisk" });

    // One of each, plus a still-pending one. `decide` delegates to the pure state
    // machine, so each reaches exactly its target status.
    const pending = await createApproval(db, { userId, agentId, detail: detailWith("PEND") }, dek, fixedClock(T0));

    const approved = await createApproval(db, { userId, agentId, detail: detailWith("APPR") }, dek, fixedClock(T0));
    await decide(db, { userId, id: approved.id, decision: { status: "approved" } }, dek, fixedClock(new Date(T0.getTime() + MINUTE)));

    const denied = await createApproval(db, { userId, agentId, detail: detailWith("DENY") }, dek, fixedClock(T0));
    await decide(db, { userId, id: denied.id, decision: { status: "denied" } }, dek, fixedClock(new Date(T0.getTime() + 2 * MINUTE)));

    // Expired: created with a 15-minute window, expired after the window passes.
    const expired = await createApproval(db, { userId, agentId, detail: detailWith("EXPD"), expiryMinutes: 15 }, dek, fixedClock(T0));
    await decide(db, { userId, id: expired.id, decision: { status: "expired" } }, dek, fixedClock(new Date(T0.getTime() + 20 * MINUTE)));

    const moreDetail = await createApproval(db, { userId, agentId, detail: detailWith("MORE") }, dek, fixedClock(T0));
    await decide(
      db,
      { userId, id: moreDetail.id, decision: { status: "more_detail", question: "Which card is this for?" } },
      dek,
      fixedClock(new Date(T0.getTime() + 3 * MINUTE)),
    );

    const inbox = await readInbox(db, userId, dek, fixedClock(new Date(T0.getTime() + 25 * MINUTE)));

    // The history holds every DECIDED approval, keyed by id → status.
    const statusById = new Map(inbox.history.map((h) => [h.id, h.status]));
    assert.equal(statusById.get(approved.id), "approved", "an approved approval is in the history");
    assert.equal(statusById.get(denied.id), "denied", "a denied approval is in the history");
    assert.equal(statusById.get(expired.id), "expired", "an expired approval is in the history");
    assert.equal(statusById.get(moreDetail.id), "more_detail", "a more_detail approval is in the history");

    // The still-pending one is in `pending`, NOT the history.
    assert.ok(!statusById.has(pending.id), "a pending approval is never in the history");
    assert.ok(inbox.pending.some((p) => p.id === pending.id), "the pending approval is in the pending list");
    assert.ok(
      !inbox.pending.some((p) => [approved.id, denied.id, expired.id, moreDetail.id].includes(p.id)),
      "no decided approval appears in the pending list",
    );
  } finally {
    await db.close();
  }
});

test("a more_detail history entry carries the question that was asked", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-question");
    const dek = freshDek();
    const agentId = uuid();
    await makeAgent(db, { userId, agentId, displayName: "Asterisk" });

    const created = await createApproval(db, { userId, agentId, detail: detailWith("Q") }, dek, fixedClock(T0));
    await decide(
      db,
      { userId, id: created.id, decision: { status: "more_detail", question: "Who is the recipient?" } },
      dek,
      fixedClock(new Date(T0.getTime() + MINUTE)),
    );

    const inbox = await readInbox(db, userId, dek, fixedClock(new Date(T0.getTime() + 2 * MINUTE)));
    const entry = inbox.history.find((h) => h.id === created.id)!;
    assert.ok(entry, "the more_detail approval is in the history");
    assert.equal(entry.question, "Who is the recipient?", "the history entry carries the asked question");
  } finally {
    await db.close();
  }
});

test("an expired history entry is marked expired with a decided time", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-expired");
    const dek = freshDek();
    const agentId = uuid();
    await makeAgent(db, { userId, agentId, displayName: "Asterisk" });

    const created = await createApproval(db, { userId, agentId, detail: detailWith("E"), expiryMinutes: 15 }, dek, fixedClock(T0));
    const decidedAt = new Date(T0.getTime() + 20 * MINUTE);
    await decide(db, { userId, id: created.id, decision: { status: "expired" } }, dek, fixedClock(decidedAt));

    const inbox = await readInbox(db, userId, dek, fixedClock(new Date(T0.getTime() + 25 * MINUTE)));
    const entry = inbox.history.find((h) => h.id === created.id)!;
    assert.ok(entry, "the expired approval is in the history");
    assert.equal(entry.status, "expired", "its status is expired");
    assert.ok(entry.decidedAt != null, "an expired approval carries a decided time");
    assert.equal(ms(entry.decidedAt!), ms(decidedAt), "the decided time is the instant it expired");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — a user NEVER receives another user's approvals (pending or history).
// ===========================================================================

test("readInbox returns only the owner's approvals — never another person's", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    const dekA = freshDek();
    const dekB = freshDek();
    const agentA = uuid();
    const agentB = uuid();
    await makeAgent(db, { userId: alice, agentId: agentA, displayName: "Alice's Agent" });
    await makeAgent(db, { userId: bob, agentId: agentB, displayName: "Bob's Agent" });

    // Alice: one pending, one approved. Bob: one pending, one denied.
    const alicePending = await createApproval(db, { userId: alice, agentId: agentA, detail: detailWith("a-pend") }, dekA, fixedClock(T0));
    const aliceApproved = await createApproval(db, { userId: alice, agentId: agentA, detail: detailWith("a-appr") }, dekA, fixedClock(T0));
    await decide(db, { userId: alice, id: aliceApproved.id, decision: { status: "approved" } }, dekA, fixedClock(new Date(T0.getTime() + MINUTE)));

    const bobPending = await createApproval(db, { userId: bob, agentId: agentB, detail: detailWith("b-pend") }, dekB, fixedClock(T0));
    const bobDenied = await createApproval(db, { userId: bob, agentId: agentB, detail: detailWith("b-deny") }, dekB, fixedClock(T0));
    await decide(db, { userId: bob, id: bobDenied.id, decision: { status: "denied" } }, dekB, fixedClock(new Date(T0.getTime() + MINUTE)));

    // Alice's inbox: only Alice's ids, in neither list is any of Bob's.
    const aliceInbox = await readInbox(db, alice, dekA, fixedClock(new Date(T0.getTime() + 2 * MINUTE)));
    const aliceIds = [...aliceInbox.pending, ...aliceInbox.history].map((x) => x.id);
    assert.ok(aliceIds.includes(alicePending.id), "Alice sees her pending approval");
    assert.ok(aliceIds.includes(aliceApproved.id), "Alice sees her approved approval");
    assert.ok(!aliceIds.includes(bobPending.id), "Alice never sees Bob's pending approval");
    assert.ok(!aliceIds.includes(bobDenied.id), "Alice never sees Bob's denied approval");

    // Bob's inbox: only Bob's ids.
    const bobInbox = await readInbox(db, bob, dekB, fixedClock(new Date(T0.getTime() + 2 * MINUTE)));
    const bobIds = [...bobInbox.pending, ...bobInbox.history].map((x) => x.id);
    assert.ok(bobIds.includes(bobPending.id), "Bob sees his pending approval");
    assert.ok(bobIds.includes(bobDenied.id), "Bob sees his denied approval");
    assert.ok(!bobIds.includes(alicePending.id), "Bob never sees Alice's pending approval");
    assert.ok(!bobIds.includes(aliceApproved.id), "Bob never sees Alice's approved approval");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 [obligation:validate-and-parameterize-input] (INV-102)
//
// A route handler validates the request HERE (`parseBody`), then reads the inbox for the
// SESSION's user id — NEVER a value from the request body. A rejected input maps to a 4xx
// Response and never reaches a query. The user id is bound as a parameter (no spliced
// SQL). This handler is a test fixture that EXERCISES the modules — not an
// implementation file.
// ===========================================================================

function inboxHandler(
  db: Db,
  dek: Uint8Array,
  clock: Clock,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body is OPTIONAL and the only member scope is the SESSION's id — a `userId` in
  // the body is accepted by the shape but IGNORED (it must never widen the scope). The
  // size cap keeps an absurd body out before it is parsed.
  const schema = z.object({ userId: z.string().max(256).optional() });
  return async (req: Request): Promise<Response> => {
    try {
      await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const inbox = await readInbox(db, sessionUserId, dek, clock);
      return new Response(
        JSON.stringify({
          pendingIds: inbox.pending.map((p) => p.id),
          historyIds: inbox.history.map((h) => h.id),
        }),
        { status: 200 },
      );
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/inbox", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("readInbox binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'; DROP TABLE approvals; --";

  const inbox = await readInbox(db, probe, freshDek(), fixedClock(T0));
  assert.deepEqual(inbox.pending, [], "the recording db returns no rows, so pending is empty");
  assert.deepEqual(inbox.history, [], "the recording db returns no rows, so history is empty");

  assert.ok(db.calls.length >= 1, "the read issues at least one query");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the user id travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the user id is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = inboxHandler(db, freshDek(), fixedClock(T0), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = inboxHandler(db, freshDek(), fixedClock(T0), "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ filler: "a".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler reads the SESSION user's inbox and ignores a user id supplied in the body", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "handler-alice");
    const bob = await makeUser(db, "handler-bob");
    const dekA = freshDek();
    const dekB = freshDek();
    const agentA = uuid();
    const agentB = uuid();
    await makeAgent(db, { userId: alice, agentId: agentA, displayName: "Alice's Agent" });
    await makeAgent(db, { userId: bob, agentId: agentB, displayName: "Bob's Agent" });

    const alicePending = await createApproval(db, { userId: alice, agentId: agentA, detail: detailWith("ha") }, dekA, fixedClock(T0));
    const bobPending = await createApproval(db, { userId: bob, agentId: agentB, detail: detailWith("hb") }, dekB, fixedClock(T0));

    // The handler is Alice's session; the body tries to pass BOB's id.
    const handler = inboxHandler(db, dekA, fixedClock(new Date(T0.getTime() + MINUTE)), alice);
    const res = await handler(jsonRequest(JSON.stringify({ userId: bob })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const { pendingIds } = (await res.json()) as { pendingIds: string[] };
    assert.ok(pendingIds.includes(alicePending.id), "the handler reads the session (Alice's) inbox");
    assert.ok(!pendingIds.includes(bobPending.id), "the body's user id is ignored — never widens the scope");
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in an approval's detail round-trips through the read as inert data", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "inject");
    const dek = freshDek();
    const agentId = uuid();
    await makeAgent(db, { userId, agentId, displayName: "Asterisk" });
    const detail = {
      sentence: "wants to send a message",
      recipient: "grace'); DROP TABLE approvals; --",
      amount: "1.00 AUD",
      field: "evil'); DROP TABLE approvals; --",
      reason: "test",
      rule: "Ask me first",
    };

    const created = await createApproval(db, { userId, agentId, detail }, dek, fixedClock(T0));

    const inbox = await readInbox(db, userId, dek, fixedClock(new Date(T0.getTime() + MINUTE)));

    assert.equal(await tableExists(db, "approvals"), true, "the approvals table survives the read (the probe is data, not SQL)");
    const entry = inbox.pending.find((p) => p.id === created.id)!;
    assert.ok(entry, "the approval is read back");
    assert.equal(entry.detail.recipient, detail.recipient, "the probe recipient round-trips verbatim");
    assert.equal(entry.detail.field, detail.field, "the probe field round-trips verbatim");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 [obligation:secrets-from-env] — the read runs from its INJECTED deps alone (db,
// userId, dek, clock): no secret, no ambient config; the detail decrypts only under the
// injected DEK, so a different DEK cannot read it back (the key is injected, not baked
// in).
// ===========================================================================

test("readInbox runs from injected deps alone: no secret and no ambient configuration", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "obl-secrets");
    const dek = freshDek();
    const agentId = uuid();
    await makeAgent(db, { userId, agentId, displayName: "Asterisk" });
    const created = await createApproval(db, { userId, agentId, detail: detailWith("S") }, dek, fixedClock(T0));

    // Only db / userId / dek / clock — no connection string, no key read from env.
    const inbox = await readInbox(db, userId, dek, fixedClock(new Date(T0.getTime() + MINUTE)));

    assert.ok(inbox.pending.some((p) => p.id === created.id), "the inbox reads with no secret or env handed to it");
  } finally {
    await db.close();
  }
});

test("readInbox cannot decrypt the detail with a different DEK (the key is injected, not baked in)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "obl-wrongdek");
    const realDek = freshDek();
    const agentId = uuid();
    await makeAgent(db, { userId, agentId, displayName: "Asterisk" });
    await createApproval(db, { userId, agentId, detail: detailWith("W") }, realDek, fixedClock(T0));

    const wrongDek = freshDek();
    await assert.rejects(
      () => readInbox(db, userId, wrongDek, fixedClock(new Date(T0.getTime() + MINUTE))),
      "a DEK that did not encrypt the detail cannot read it back",
    );
  } finally {
    await db.close();
  }
});
