// E08-S05 — Activity list read (list-all with filters). Target module:
//   • src/server/activity/list.ts   (the filtered, newest-first list read)
//
// RED-first: the `./list` module does NOT exist yet, so importing `listActivity`
// throws (ERR_MODULE_NOT_FOUND) and this whole suite fails to load. That absence IS
// the point of test-first — do NOT implement anything to make these pass; the builder
// writes `list.ts` afterwards. The activity chains these tests read are produced by the
// REAL writer (`./writer`, E08-S01) through the REAL migrations (0016_activity), so the
// list read runs against genuinely-stored, hash-chained, DEK-encrypted rows.
//
// These tests pin BEHAVIOUR (what the read RETURNS, in what order, scoped to whom, and
// what a boundary handler does with bad input), never the source text of a module — a
// later rename that preserves behaviour must not redden them.
//
// WHY this exists: the Activity page, the Home feed and the `get_context` agent tool all
// need ONE filtered "list-all" read, distinct from any narrower view. It lists a person's
// entries newest-first, filterable by agent, service, kind, outcome and date range, and
// decrypts the payload summaries IN-APP over the already-filtered set (design §4.1, §9,
// constitution principle 14 "Warthog writes the record").
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the builder implements EXACTLY this).
//
//   // `src/server/activity/list.ts`
//   export async function listActivity(
//     db: Db,
//     userId: string,                 // the SESSION user id — the member scope, never a client value
//     filters: {
//       agentId?: string;             // "agent"   → the activity row's agent_id
//       connectorId?: string;         // "service" → the activity row's connector_id (connected service)
//       kind?: string;                // the entry kind
//       outcome?: string;             // the entry outcome
//       from?: string;                // ISO-8601; INCLUSIVE lower bound on occurred_at
//       to?: string;                  // ISO-8601; INCLUSIVE upper bound on occurred_at
//     },
//     dek: Uint8Array,                // the person's unwrapped DEK — decrypts the filtered set
//   ): Promise<ActivityEntry[]>;      // the SAME ActivityEntry shape the writer/recorder use
//
//   • Returns ONLY `userId`'s entries, NEWEST FIRST (so a higher seq / later occurred_at
//     comes before a lower one).
//   • Filters COMBINE with AND; an omitted filter does not constrain. No filters ⇒ all the
//     person's entries.
//   • Every returned entry's `payload` is the DECRYPTED summary; `source` carries the stored
//     label verbatim ("warthog" | "agent_reported").
//   • Member-scoped + parameterized (INV-102): the user id and every filter value travel as
//     BOUND values, never concatenated into the SQL text.
//
// The exact arg order (db, userId, filters, dek) mirrors the sibling `readActivity`
// (`./writer`) with the filter object inserted. Tests pass plain object literals as
// `filters`, so they couple to the FIELD NAMES above, not to any exported type name.
//
// Acceptance criteria → tests:
//   AC1 "Lists only the session user's entries, newest-first, filterable by agent, service,
//        kind, outcome and date range." — a diverse chain is listed newest-first; each filter
//        (and a combination) selects exactly the matching subset; no filters returns all.
//   AC2 "Agent-reported entries are returned labelled source agent_reported." — a mix of
//        warthog + agent_reported entries comes back with each source label preserved, and an
//        agent filter returns the agent_reported entry labelled as such.
//   AC3 "A user never receives another user's entries." — with two people who share a kind,
//        an agent id and a time window, each person's list (even an unfiltered one, and one
//        filtered by the shared values) contains ONLY their own entries.
//   AC3b "Decryption happens over the FILTERED set." — a corrupt ciphertext that the filter
//        EXCLUDES never reddens the read (it is not decrypted); the SAME corrupt row, when the
//        filter INCLUDES it, makes the read reject — so only the filtered set is decrypted.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a fixture handler on the
//        `../http/validate` boundary rejects malformed / oversized / mis-shaped filters with a
//        4xx BEFORE the read runs, and lists under the SESSION user id (never a body id); a
//        SQL-injection probe in a filter field travels as a BOUND value and cannot drop a table.
//   AC5 [obligation:secrets-from-env] (INV-103) — the read holds no key and reads no
//        `process.env`: a decoy env secret never appears in a listed entry, and the read works
//        purely from the injected db + dek.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each real-db
// test uses its own `freshDb()` (an isolated in-memory PGlite with the real migrations), so
// tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { listActivity } from "./list";
import { createDbRecorder } from "./writer";
import type { ActivityEntryInput } from "./recorder";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { fixedClock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key

// Distinct, clean whole-ms UTC instants (one per seq), so occurred_at round-trips
// exactly through timestamptz and the date-range filter has unambiguous boundaries.
const JAN = "2026-01-15T10:00:00.000Z";
const FEB = "2026-02-15T10:00:00.000Z";
const MAR = "2026-03-15T10:00:00.000Z";
const APR = "2026-04-15T10:00:00.000Z";

// A fresh random 256-bit DEK.
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A stand-in wrapped DEK for createUser (opaque base64; this flow never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every activity row hangs off this id — the
// list read's member scope).
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: wrappedDekFor(who),
  });
  return user.id;
}

// A DEK provider over a fixed map of user → key (the writer resolves the DEK per user
// internally).
function dekProvider(
  byUser: Record<string, Uint8Array>,
): (userId: string) => Promise<Uint8Array> {
  return async (userId: string) => {
    const dek = byUser[userId];
    if (!dek) throw new Error(`no DEK for ${userId}`);
    return dek;
  };
}

// Record ONE entry for `userId` at instant `at` through the REAL writer, so it is
// genuinely stored, hash-chained and DEK-encrypted — exactly what the list read reads.
// The writer is stateless across calls (it reads the chain head from the db each time),
// so a fresh recorder per call with a frozen clock gives each entry its own occurred_at.
async function recordEntry(
  db: Db,
  userId: string,
  dek: Uint8Array,
  at: string,
  fields: Partial<Omit<ActivityEntryInput, "userId">>,
): Promise<void> {
  const recorder = createDbRecorder({
    db,
    clock: fixedClock(new Date(at)),
    dekFor: dekProvider({ [userId]: dek }),
  });
  await recorder.record({
    userId,
    kind: fields.kind ?? "tool_call",
    source: fields.source ?? "warthog",
    agentId: fields.agentId,
    connectorId: fields.connectorId,
    tool: fields.tool,
    outcome: fields.outcome,
    merchant: fields.merchant,
    payload: fields.payload ?? {},
  });
}

// Whether a relation of this exact name exists. `to_regclass` yields the relation name
// when it exists and NULL when it does not — a non-throwing probe (behaviour, not source).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (bound value vs. spliced text). Returns no rows.
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

// The seqs of a result, in the order returned (newest-first ⇒ strictly descending).
function seqs(entries: { seq: number }[]): number[] {
  return entries.map((e) => e.seq);
}

// ===================================================================================
// AC1 — lists only the session user's entries, newest-first, with each filter.
// ===================================================================================

test("lists a person's entries newest-first and decrypts each payload summary", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "newest-first");
    const dek = freshDek();
    // Record in ascending time so seq 1 is oldest (JAN) … seq 4 is newest (APR), each
    // with a unique marker in its payload summary.
    const marker = (s: number) => `SUMMARY_${s}_${randomBytes(8).toString("hex")}`;
    const m1 = marker(1), m2 = marker(2), m3 = marker(3), m4 = marker(4);
    await recordEntry(db, alice, dek, JAN, { payload: { summary: m1 } });
    await recordEntry(db, alice, dek, FEB, { payload: { summary: m2 } });
    await recordEntry(db, alice, dek, MAR, { payload: { summary: m3 } });
    await recordEntry(db, alice, dek, APR, { payload: { summary: m4 } });

    const out = await listActivity(db, alice, {}, dek);

    assert.equal(out.length, 4, "no filters ⇒ every one of the person's entries");
    assert.deepEqual(seqs(out), [4, 3, 2, 1], "newest-first: seqs strictly descending");
    assert.equal(out[0].occurredAt, APR, "the first entry is the most recent");
    assert.equal(out[3].occurredAt, JAN, "the last entry is the oldest");

    // Each payload summary is DECRYPTED (not ciphertext) and belongs to the right entry.
    assert.ok(JSON.stringify(out[0].payload).includes(m4), "newest payload decrypted");
    assert.ok(JSON.stringify(out[3].payload).includes(m1), "oldest payload decrypted");
    assert.deepEqual(
      out.map((e) => e.userId),
      [alice, alice, alice, alice],
      "every returned entry is scoped to the person",
    );
  } finally {
    await db.close();
  }
});

test("filters by agent, service, kind and outcome each select exactly the matching subset", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "filters");
    const dek = freshDek();
    // seq1: agent A, service gmail, kind tool_call,  outcome ok
    // seq2: agent B, service gcal,  kind approval,   outcome denied
    // seq3: agent A, service gcal,  kind tool_call,  outcome ok
    // seq4: agent B, service gmail, kind approval,   outcome ok
    await recordEntry(db, alice, dek, JAN, { agentId: "agent-A", connectorId: "gmail", kind: "tool_call", outcome: "ok" });
    await recordEntry(db, alice, dek, FEB, { agentId: "agent-B", connectorId: "gcal", kind: "approval", outcome: "denied" });
    await recordEntry(db, alice, dek, MAR, { agentId: "agent-A", connectorId: "gcal", kind: "tool_call", outcome: "ok" });
    await recordEntry(db, alice, dek, APR, { agentId: "agent-B", connectorId: "gmail", kind: "approval", outcome: "ok" });

    // agent (agentId) filter.
    assert.deepEqual(
      seqs(await listActivity(db, alice, { agentId: "agent-A" }, dek)),
      [3, 1],
      "agent filter returns only that agent's entries, newest-first",
    );
    // service (connectorId) filter.
    assert.deepEqual(
      seqs(await listActivity(db, alice, { connectorId: "gmail" }, dek)),
      [4, 1],
      "service filter returns only that connected service's entries",
    );
    // kind filter.
    assert.deepEqual(
      seqs(await listActivity(db, alice, { kind: "tool_call" }, dek)),
      [3, 1],
      "kind filter returns only that kind",
    );
    // outcome filter.
    assert.deepEqual(
      seqs(await listActivity(db, alice, { outcome: "denied" }, dek)),
      [2],
      "outcome filter returns only that outcome",
    );
    // combined filters AND together.
    assert.deepEqual(
      seqs(await listActivity(db, alice, { agentId: "agent-B", kind: "approval", outcome: "ok" }, dek)),
      [4],
      "combined filters intersect (AND), not union",
    );
    // a filter matching nothing returns an empty list, not an error.
    assert.deepEqual(
      await listActivity(db, alice, { agentId: "no-such-agent" }, dek),
      [],
      "a filter that matches nothing returns an empty list",
    );
  } finally {
    await db.close();
  }
});

test("the date-range filter bounds occurred_at inclusively on both ends", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "date-range");
    const dek = freshDek();
    await recordEntry(db, alice, dek, JAN, {}); // seq1
    await recordEntry(db, alice, dek, FEB, {}); // seq2
    await recordEntry(db, alice, dek, MAR, {}); // seq3
    await recordEntry(db, alice, dek, APR, {}); // seq4

    // from..to inclusive both ends: FEB..MAR selects seq2 and seq3 (newest-first).
    assert.deepEqual(
      seqs(await listActivity(db, alice, { from: FEB, to: MAR }, dek)),
      [3, 2],
      "from/to are inclusive on both ends — the boundary entries are included",
    );
    // from only (open upper bound): >= MAR selects seq3 and seq4.
    assert.deepEqual(
      seqs(await listActivity(db, alice, { from: MAR }, dek)),
      [4, 3],
      "from alone bounds only the lower end",
    );
    // to only (open lower bound): <= FEB selects seq1 and seq2.
    assert.deepEqual(
      seqs(await listActivity(db, alice, { to: FEB }, dek)),
      [2, 1],
      "to alone bounds only the upper end",
    );
    // a window that straddles no entry returns empty.
    assert.deepEqual(
      await listActivity(db, alice, { from: "2026-05-01T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z" }, dek),
      [],
      "a window containing no entry returns an empty list",
    );
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC2 — agent-reported entries come back labelled source agent_reported.
// ===================================================================================

test("each entry's source label is preserved, and an agent filter returns the agent_reported entry", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "source-label");
    const dek = freshDek();
    // seq1: Warthog recorded it itself.
    await recordEntry(db, alice, dek, JAN, { source: "warthog", kind: "release" });
    // seq2: a summary REPORTED by an agent (labelled, never treated as source of truth).
    await recordEntry(db, alice, dek, FEB, { source: "agent_reported", agentId: "agent-claude", kind: "tool_call" });

    const all = await listActivity(db, alice, {}, dek);
    const bySeq = new Map(all.map((e) => [e.seq, e]));
    assert.equal(bySeq.get(1)?.source, "warthog", "the Warthog-written entry is labelled 'warthog'");
    assert.equal(bySeq.get(2)?.source, "agent_reported", "the agent-submitted summary is labelled 'agent_reported'");

    // Filtering by that agent returns its entry, still labelled agent_reported.
    const byAgent = await listActivity(db, alice, { agentId: "agent-claude" }, dek);
    assert.deepEqual(seqs(byAgent), [2], "the agent filter selects the agent's entry");
    assert.equal(byAgent[0].source, "agent_reported", "returned labelled as agent_reported");
    assert.equal(byAgent[0].agentId, "agent-claude", "carrying the reporting agent's id");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC3 — a user never receives another user's entries (even on shared filter values).
// ===================================================================================

test("a person's list contains only their own entries — never another person's", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "iso-alice");
    const bob = await makeUser(db, "iso-bob");
    const dekA = freshDek();
    const dekB = freshDek();

    // Both people share a kind, an agent id and a time window — so only the member scope
    // (not the filter) can keep them apart.
    await recordEntry(db, alice, dekA, FEB, { agentId: "shared-agent", kind: "tool_call", payload: { who: "ALICE" } });
    await recordEntry(db, alice, dekA, MAR, { agentId: "shared-agent", kind: "tool_call", payload: { who: "ALICE" } });
    await recordEntry(db, bob, dekB, FEB, { agentId: "shared-agent", kind: "tool_call", payload: { who: "BOB" } });

    // Unfiltered: Alice sees only her two entries; Bob only his one.
    const aliceAll = await listActivity(db, alice, {}, dekA);
    assert.equal(aliceAll.length, 2, "Alice sees exactly her own two entries");
    assert.ok(aliceAll.every((e) => e.userId === alice), "every entry is Alice's");
    assert.ok(
      !JSON.stringify(aliceAll).includes("BOB"),
      "no part of Bob's payload leaks into Alice's list",
    );

    const bobAll = await listActivity(db, bob, {}, dekB);
    assert.equal(bobAll.length, 1, "Bob sees exactly his own one entry");
    assert.ok(bobAll.every((e) => e.userId === bob), "every entry is Bob's");

    // Even a filter on the SHARED agent id does not cross the member boundary.
    const aliceByAgent = await listActivity(db, alice, { agentId: "shared-agent" }, dekA);
    assert.equal(aliceByAgent.length, 2, "Alice's agent filter still returns only Alice's entries");
    assert.ok(aliceByAgent.every((e) => e.userId === alice), "the shared agent id does not pull in Bob's entry");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC3b — decryption happens over the FILTERED set, not the whole table.
// ===================================================================================

test("only the filtered set is decrypted: a corrupt row the filter excludes never reddens the read", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "filtered-decrypt");
    const dek = freshDek();
    await recordEntry(db, alice, dek, JAN, { kind: "tool_call", payload: { n: 1 } }); // seq1 (good)
    await recordEntry(db, alice, dek, FEB, { kind: "corrupt_kind", payload: { n: 2 } }); // seq2 (to corrupt)
    await recordEntry(db, alice, dek, MAR, { kind: "tool_call", payload: { n: 3 } }); // seq3 (good)

    // Corrupt seq2's ciphertext so that DECRYPTING it would fail the GCM tag. (Direct
    // UPDATE is available in the test engine; the app role's append-only grant is a
    // Postgres concern, not this unit's.)
    await db.query(
      "UPDATE activity_entries SET payload_ct = payload_ct || $2 WHERE user_id = $1 AND seq = $3",
      [alice, "TAMPER", 2],
    );

    // Filtering to kind=tool_call EXCLUDES the corrupt seq2 — so it is never fetched or
    // decrypted, and the read succeeds with the two good entries, newest-first.
    const good = await listActivity(db, alice, { kind: "tool_call" }, dek);
    assert.deepEqual(seqs(good), [3, 1], "the filtered set is returned newest-first");
    assert.ok(JSON.stringify(good[0].payload).includes("3"), "seq3 payload decrypted");
    assert.ok(JSON.stringify(good[1].payload).includes("1"), "seq1 payload decrypted");

    // Control: the SAME corrupt row, when the (empty) filter INCLUDES it, makes the read
    // reject — proving the row really is undecryptable and that the filter above excluded
    // it from decryption (decryption is genuine, and happens over the filtered set).
    await assert.rejects(
      () => listActivity(db, alice, {}, dek),
      "a corrupt ciphertext inside the filtered set fails decryption and rejects",
    );
  } finally {
    await db.close();
  }
});

test("a wrong DEK cannot read the filtered set — the summaries are genuinely DEK-encrypted", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "wrongdek");
    const realDek = freshDek();
    await recordEntry(db, alice, realDek, JAN, { kind: "tool_call", payload: { secret: "s" } });
    await recordEntry(db, alice, realDek, FEB, { kind: "tool_call", payload: { secret: "s" } });

    // The right DEK reads the (non-empty) filtered set back.
    assert.equal((await listActivity(db, alice, { kind: "tool_call" }, realDek)).length, 2, "the real DEK decrypts");

    // A wrong DEK over the same non-empty filtered set fails the GCM tag and rejects.
    await assert.rejects(
      () => listActivity(db, alice, { kind: "tool_call" }, freshDek()),
      "a wrong DEK cannot decrypt the summaries — they are not stored in clear",
    );
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC4 — a boundary handler validates filters (4xx before the read) and lists under the
// SESSION user id; every value is bound (parameterized). The handler below is a TEST
// FIXTURE exercising the modules — NOT an implementation file.
// ===================================================================================

// The minimal filter shape the fixture handler accepts (declared locally so the test
// couples to behaviour, not to the module's exported type names).
type Filters = {
  agentId?: string;
  connectorId?: string;
  kind?: string;
  outcome?: string;
  from?: string;
  to?: string;
};

// A recording "list" seam: it never touches a database, so "the lister was called" is a
// proxy for "a read ran". Validation failures must leave `calls` empty (no read reached).
interface RecordingLister {
  readonly calls: { userId: string; filters: Filters }[];
  list(userId: string, filters: Filters): Promise<{ seq: number }[]>;
}
function recordingLister(): RecordingLister {
  const calls: { userId: string; filters: Filters }[] = [];
  return {
    calls,
    async list(userId, filters) {
      calls.push({ userId, filters });
      return [];
    },
  };
}

// A regex for the whole-ms UTC ISO-8601 instants the app writes, so a mis-formatted date
// is rejected at the boundary (not cast later at the query).
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

// Validate the filter body at the boundary, then list under the SESSION user id (never a
// body value). A rejection maps to a 4xx Response and never reaches the lister.
function createListActivityHandler(
  lister: RecordingLister,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  const schema = z.object({
    agentId: z.string().min(1).max(200).optional(),
    connectorId: z.string().min(1).max(200).optional(),
    kind: z.string().min(1).max(200).optional(),
    outcome: z.string().min(1).max(200).optional(),
    from: z.string().regex(ISO_INSTANT).optional(),
    to: z.string().regex(ISO_INSTANT).optional(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 16 * 1024 });
      const entries = await lister.list(sessionUserId, body);
      return new Response(JSON.stringify({ count: entries.length }), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // Surface an uncontrolled 500 rather than masking it as success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function postJson(body: string): Request {
  return new Request("https://warthog.com.au/api/activity/list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the list handler rejects malformed JSON with a 4xx and never reaches the read", async () => {
  const lister = recordingLister();
  const handler = createListActivityHandler(lister, "session-user");

  const res = await handler(postJson("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(lister.calls.length, 0, "malformed input must never reach the read");
});

test("the list handler rejects an oversized body with a 4xx and never reaches the read", async () => {
  const lister = recordingLister();
  const handler = createListActivityHandler(lister, "session-user");

  // ~40 KiB body, well over the handler's 16 KiB cap: rejected by size before parsing.
  const huge = JSON.stringify({ kind: "x".repeat(40 * 1024) });
  const res = await handler(postJson(huge));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(lister.calls.length, 0, "an oversized body must never reach the read");
});

test("the list handler rejects mis-shaped filters with a 4xx and never reaches the read", async () => {
  const cases: Record<string, unknown> = {
    "agentId as a number": { agentId: 123 },
    "kind as a number": { kind: 7 },
    "outcome as an object": { outcome: { nested: true } },
    "connectorId empty": { connectorId: "" },
    "from not an ISO instant": { from: "not-a-date" },
    "to not an ISO instant": { to: "2026-13-40" },
    "from as a number": { from: 1700000000000 },
  };
  for (const [label, body] of Object.entries(cases)) {
    const lister = recordingLister();
    const handler = createListActivityHandler(lister, "session-user");

    const res = await handler(postJson(JSON.stringify(body)));

    assert.ok(res.status >= 400 && res.status < 500, `${label}: expected a 4xx, got ${res.status}`);
    assert.equal(lister.calls.length, 0, `${label}: a mis-shaped filter must never reach the read`);
  }
});

test("a well-formed filter request reaches the read once with the validated filters", async () => {
  const lister = recordingLister();
  const handler = createListActivityHandler(lister, "session-user");

  const res = await handler(postJson(JSON.stringify({ kind: "tool_call", from: FEB, to: MAR })));

  assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
  assert.equal(lister.calls.length, 1, "a well-formed request reaches the read exactly once");
  assert.equal(lister.calls[0].filters.kind, "tool_call", "with the validated kind");
  assert.equal(lister.calls[0].filters.from, FEB, "and the validated from");
  assert.equal(lister.calls[0].filters.to, MAR, "and the validated to");
});

test("an empty filter body is valid and lists everything (no constraints)", async () => {
  const lister = recordingLister();
  const handler = createListActivityHandler(lister, "session-user");

  const res = await handler(postJson(JSON.stringify({})));

  assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
  assert.equal(lister.calls.length, 1, "an empty filter is a valid request");
});

test("the list handler lists under the SESSION user id, never a body-supplied id", async () => {
  const lister = recordingLister();
  const handler = createListActivityHandler(lister, "session-user");

  // The body smuggles a victim's user id; the handler must ignore it and use the session's.
  const res = await handler(postJson(JSON.stringify({ kind: "tool_call", userId: "attacker" })));

  assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
  assert.equal(lister.calls.length, 1, "the request is listed");
  assert.equal(lister.calls[0].userId, "session-user", "under the session user id");
  assert.ok(
    !lister.calls.some((c) => c.userId === "attacker"),
    "the body-supplied id never becomes the scope",
  );
});

// ---- parameterization (INV-102): every value is bound, never concatenated ----------

test("listActivity binds the user id and every filter value as parameters, never woven into SQL", async () => {
  const db = recordingDb();
  const probeUser = "u'); DROP TABLE activity_entries; --";
  const probeAgent = "a'); DROP TABLE activity_entries; --";
  const probeKind = "k'); DROP TABLE activity_entries; --";

  const out = await listActivity(
    db,
    probeUser,
    { agentId: probeAgent, connectorId: "svc", kind: probeKind, outcome: "ok", from: FEB, to: MAR },
    freshDek(),
  );
  assert.deepEqual(out, [], "the recording db returns no rows → no entries");

  assert.ok(db.calls.length >= 1, "listActivity issues at least one query");
  const everyValue = db.calls.flatMap((c) => c.values);
  assert.ok(everyValue.includes(probeUser), "the user id travels as a bound value");
  assert.ok(everyValue.includes(probeAgent), "the agent filter travels as a bound value");
  assert.ok(everyValue.includes(probeKind), "the kind filter travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probeUser), "the user id is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes(probeAgent), "the agent filter is bound, never concatenated");
    assert.ok(!call.text.includes(probeKind), "the kind filter is bound, never concatenated");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("a SQL-injection probe in a filter field is inert and the activity table survives", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "probe");
    const dek = freshDek();
    await recordEntry(db, alice, dek, JAN, { kind: "tool_call" });
    await recordEntry(db, alice, dek, FEB, { kind: "tool_call" });

    const probe = "evil'); DROP TABLE activity_entries; --";
    // The probe binds to WHERE kind = $n and simply matches nothing — it never executes.
    const out = await listActivity(db, alice, { kind: probe }, dek);
    assert.deepEqual(out, [], "the probe is a bound value that matches no row");

    assert.equal(await tableExists(db, "activity_entries"), true, "the activity table survives the probe");
    // The real entries are still readable afterwards — nothing was dropped.
    assert.equal((await listActivity(db, alice, { kind: "tool_call" }, dek)).length, 2, "the real entries remain");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC5 — the read holds no key and reads no process.env: no secret value is folded in.
// ===================================================================================

test("the list read reads no process.env: a decoy env secret never appears in a listed entry", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "env-check");
    const dek = freshDek();
    await recordEntry(db, alice, dek, JAN, { kind: "tool_call", payload: { summary: "a plain summary" } });
    await recordEntry(db, alice, dek, FEB, { kind: "tool_call", payload: { summary: "another one" } });

    const out = await listActivity(db, alice, {}, dek);
    assert.equal(out.length, 2, "the read works purely from the injected db + dek");
    assert.ok(
      !JSON.stringify(out).includes(DECOY),
      "no ambient env value is folded into a listed entry — the read holds no secret",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
