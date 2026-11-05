// E08-S06 — Activity search. Target module:
//   • src/server/activity/search.ts   (the member-scoped, query-matching activity search)
//
// RED-first: the `./search` module does NOT exist yet, so importing `searchActivity`
// throws (ERR_MODULE_NOT_FOUND) and this whole suite fails to load. That absence IS
// the point of test-first — do NOT implement anything to make these pass; the builder
// writes `search.ts` afterwards. The activity chains these tests read are produced by
// the REAL writer (`./writer`, E08-S01) through the REAL migrations (0016_activity), so
// the search runs against genuinely-stored, hash-chained, DEK-encrypted rows.
//
// These tests pin BEHAVIOUR (what the search RETURNS, scoped to whom, in what order,
// how it is bounded, and what a boundary handler does with bad input), never the source
// text of a module — a later rename that preserves behaviour must not redden them.
//
// WHY this exists: the person searches their timeline. Warthog cannot match over
// encrypted summaries in SQL, so search DECRYPTS in-app within the already
// user-filtered set (the member's own rows, capped at 5,000 per query) and matches the
// query over the decrypted summary text — "acceptable at v1 scale" (design §4.1, §9).
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the builder implements EXACTLY this).
//
//   // `src/server/activity/search.ts`
//   export async function searchActivity(
//     db: Db,
//     userId: string,      // the SESSION user id — the member scope, never a client value
//     query: string,       // the search text matched over each entry's decrypted summary
//     dek: Uint8Array,     // the person's unwrapped DEK — decrypts the set before matching
//   ): Promise<ActivityEntry[]>;  // the SAME ActivityEntry shape the writer/recorder use
//
//   • MEMBER-SCOPED: returns ONLY `userId`'s entries. The user id is bound ($1), never a
//     client value, so one person never reads another's entries.
//   • The scan is CAPPED at 5,000 rows PER QUERY: the SELECT that pulls the rows to
//     decrypt carries a `LIMIT 5000`, taking the most-recent rows (ORDER BY … DESC), so
//     the number of decryptions per search is bounded — the cap is a SQL LIMIT, not a
//     post-fetch JS slice.
//   • DECRYPTS WITHIN THE SET: every row in the capped, user-scoped set is decrypted
//     under `dek`, THEN matched. A wrong DEK or a tampered ciphertext in that set fails
//     the GCM tag and rejects (decryption is genuine, never a plaintext read).
//   • MATCHES over the entry's decrypted SUMMARY TEXT (`payload.summary`): an entry whose
//     summary CONTAINS `query` as a substring, CASE-INSENSITIVELY, is returned; one whose
//     summary does not contain it is excluded. A query matching nothing ⇒ `[]` (not an error).
//   • Results come back NEWEST FIRST (a higher seq / later occurred_at before a lower one).
//
// The arg order (db, userId, query, dek) mirrors the sibling `listActivity` (`./list`)
// with the free-text `query` in place of the structured `filters` object. Only the
// summary text is matched — search takes no structured filters (YAGNI; the AC asks for a
// query over the summary text, nothing more).
//
// Acceptance criteria → tests:
//   AC1 "Search returns only matching entries of the session user, decrypting within the
//        filtered set." — matching summaries are returned newest-first; a non-matching
//        entry (even the newest) is excluded; a query matching nothing ⇒ []; two people
//        who share the query token each get ONLY their own matches; a wrong DEK / a
//        corrupt ciphertext in the user's set makes the search reject (genuine decryption).
//   AC2 "The scan is capped at 5,000 rows per query." — the SELECT that feeds decryption
//        carries a LIMIT of 5000 over the most-recent rows (ORDER BY … DESC).
//   AC3 [obligation:validate-and-parameterize-input] (INV-102) — a fixture handler on the
//        `../http/validate` boundary rejects malformed / oversized / mis-shaped input with
//        a 4xx BEFORE the search runs, and searches under the SESSION user id (never a body
//        id); a SQL-injection probe in the query cannot alter a query — the user id is a
//        BOUND value and the query text never reaches the SQL at all (it is matched in-app).
//   AC4 [obligation:secrets-from-env] (INV-103) — the search holds no key and reads no
//        `process.env`: a decoy env secret never appears in a returned entry, and the
//        search works purely from the injected db + dek.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { searchActivity } from "./search";
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
// exactly through timestamptz and newest-first ordering is unambiguous.
const JAN = "2026-01-15T10:00:00.000Z";
const FEB = "2026-02-15T10:00:00.000Z";
const MAR = "2026-03-15T10:00:00.000Z";
const APR = "2026-04-15T10:00:00.000Z";

// A fresh random 256-bit DEK.
function freshDek(): Uint8Array {
  return randomBytes(DEK_BYTES);
}

// A distinctive token that cannot collide with a field name, kind, agent id or any other
// metadata the payload serialises — so a positive match is unambiguous whether the builder
// matches `payload.summary` alone or the whole decrypted payload text.
function token(): string {
  return `MATCH_${randomBytes(6).toString("hex")}`;
}

// A stand-in wrapped DEK for createUser (opaque base64; this flow never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// Create a person and return their id (every activity row hangs off this id — the
// search's member scope).
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
// genuinely stored, hash-chained and DEK-encrypted — exactly what the search reads. The
// writer is stateless across calls (it reads the chain head from the db each time), so a
// fresh recorder per call with a frozen clock gives each entry its own occurred_at.
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

// A summary payload (the readable text search matches over), as the list/home feed store it.
function summary(text: string): { summary: string } {
  return { summary: text };
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
// AC1 — returns only the session user's MATCHING entries, newest-first.
// ===================================================================================

test("search returns the matching entries newest-first and decrypts each summary", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "search-newest");
    const dek = freshDek();
    const t = token();
    // seq1..3 contain the token; seq4 (the NEWEST) does not — so matching, not recency,
    // decides membership, and the matches come back newest-first [3, 2, 1].
    await recordEntry(db, alice, dek, JAN, { payload: summary(`booked a flight ${t} one`) });
    await recordEntry(db, alice, dek, FEB, { payload: summary(`paid an invoice ${t} two`) });
    await recordEntry(db, alice, dek, MAR, { payload: summary(`sent an email ${t} three`) });
    await recordEntry(db, alice, dek, APR, { payload: summary("an unrelated note, no token here") });

    const out = await searchActivity(db, alice, t, dek);

    assert.equal(out.length, 3, "only the three entries whose summary contains the token match");
    assert.deepEqual(seqs(out), [3, 2, 1], "matches come back newest-first");
    assert.ok(out.every((e) => e.userId === alice), "every match is scoped to the person");
    // The summaries are DECRYPTED (not ciphertext) and carry the matched text.
    assert.ok(JSON.stringify(out[0].payload).includes(t), "newest match's summary is decrypted");
    assert.ok(
      !seqs(out).includes(4),
      "the newest entry, lacking the token, is excluded despite being most recent",
    );
  } finally {
    await db.close();
  }
});

test("search matches the query as a case-insensitive substring of the summary text", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "search-substring");
    const dek = freshDek();
    // A human timeline search is forgiving: a lowercase query finds a mixed-case summary,
    // and a mid-word substring matches.
    await recordEntry(db, alice, dek, JAN, { payload: summary("Flight booked to BanksiaPark on Tuesday") });
    await recordEntry(db, alice, dek, FEB, { payload: summary("Groceries delivered") });

    assert.deepEqual(
      seqs(await searchActivity(db, alice, "banksiapark", dek)),
      [1],
      "a lowercase query matches a mixed-case summary (case-insensitive)",
    );
    assert.deepEqual(
      seqs(await searchActivity(db, alice, "FLIGHT", dek)),
      [1],
      "an uppercase query matches a lowercase occurrence",
    );
    assert.deepEqual(
      seqs(await searchActivity(db, alice, "rocer", dek)),
      [2],
      "a mid-word substring matches",
    );
  } finally {
    await db.close();
  }
});

test("a query matching no summary returns an empty list, not an error", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "search-empty");
    const dek = freshDek();
    await recordEntry(db, alice, dek, JAN, { payload: summary("a calendar event was created") });
    await recordEntry(db, alice, dek, FEB, { payload: summary("a file was read") });

    assert.deepEqual(
      await searchActivity(db, alice, token(), dek),
      [],
      "a token present in no summary yields an empty list",
    );
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC1 (isolation) — a user never receives another user's entries, even on a shared token.
// ===================================================================================

test("search returns only the session user's matches — never another person's", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "search-iso-alice");
    const bob = await makeUser(db, "search-iso-bob");
    const dekA = freshDek();
    const dekB = freshDek();
    const t = token(); // both people's summaries contain the SAME token

    await recordEntry(db, alice, dekA, FEB, { payload: summary(`ALICE did ${t}`) });
    await recordEntry(db, alice, dekA, MAR, { payload: summary(`ALICE also ${t}`) });
    await recordEntry(db, bob, dekB, FEB, { payload: summary(`BOB did ${t}`) });

    const aliceHits = await searchActivity(db, alice, t, dekA);
    assert.equal(aliceHits.length, 2, "Alice sees exactly her own two matches");
    assert.ok(aliceHits.every((e) => e.userId === alice), "every match is Alice's");
    assert.ok(
      !JSON.stringify(aliceHits).includes("BOB"),
      "no part of Bob's summary leaks into Alice's search, even on a shared token",
    );

    const bobHits = await searchActivity(db, bob, t, dekB);
    assert.equal(bobHits.length, 1, "Bob sees exactly his own one match");
    assert.ok(bobHits.every((e) => e.userId === bob), "every match is Bob's");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC1 (genuine decryption within the set) — a wrong DEK / a corrupt row in the user's
// set makes the search reject, proving the summaries are really DEK-encrypted and the
// whole scoped set is decrypted before matching.
// ===================================================================================

test("a wrong DEK cannot read the searched set — the summaries are genuinely DEK-encrypted", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "search-wrongdek");
    const realDek = freshDek();
    const t = token();
    await recordEntry(db, alice, realDek, JAN, { payload: summary(`secret ${t} one`) });
    await recordEntry(db, alice, realDek, FEB, { payload: summary(`secret ${t} two`) });

    // The right DEK finds the matches.
    assert.equal((await searchActivity(db, alice, t, realDek)).length, 2, "the real DEK decrypts and matches");

    // A wrong DEK over the same scoped set fails the GCM tag and rejects — it never
    // returns other bytes or silently drops the rows.
    await assert.rejects(
      () => searchActivity(db, alice, t, freshDek()),
      "a wrong DEK cannot decrypt the summaries — they are not stored in clear",
    );
  } finally {
    await db.close();
  }
});

test("search decrypts the whole scoped set: a corrupt ciphertext in it makes the search reject", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "search-corrupt");
    const dek = freshDek();
    const t = token();
    await recordEntry(db, alice, dek, JAN, { payload: summary(`good ${t} one`) }); // seq1 (good)
    await recordEntry(db, alice, dek, FEB, { payload: summary("a row we will corrupt") }); // seq2
    await recordEntry(db, alice, dek, MAR, { payload: summary(`good ${t} two`) }); // seq3 (good)

    // Before corruption, the search succeeds and finds the two token-bearing rows.
    assert.equal((await searchActivity(db, alice, t, dek)).length, 2, "the token matches two rows while all decrypt");

    // Corrupt seq2's ciphertext so DECRYPTING it fails the GCM tag. (Direct UPDATE is
    // available in the test engine; the app role's append-only grant is a Postgres
    // concern, not this unit's.)
    await db.query(
      "UPDATE activity_entries SET payload_ct = payload_ct || $2 WHERE user_id = $1 AND seq = $3",
      [alice, "TAMPER", 2],
    );

    // The corrupt row is in the user's scoped set, so it is decrypted before matching —
    // even a query it would never match makes the whole search reject. This proves the
    // match runs over the DECRYPTED set, not over ciphertext.
    await assert.rejects(
      () => searchActivity(db, alice, t, dek),
      "a corrupt ciphertext inside the decrypted set rejects, rather than being skipped",
    );
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC2 — the scan is capped at 5,000 rows per query (a SQL LIMIT, over the newest rows).
// ===================================================================================

test("searchActivity caps the per-query scan at 5000 rows with a SQL LIMIT over the newest rows", async () => {
  const db = recordingDb();

  const out = await searchActivity(db, "session-user", "anything", freshDek());
  assert.deepEqual(out, [], "the recording db returns no rows → no matches");

  // Find the SELECT over activity_entries that feeds decryption.
  const select = db.calls.find(
    (c) => /select/i.test(c.text) && /from\s+activity_entries/i.test(c.text),
  );
  assert.ok(select, "a SELECT over activity_entries is issued");

  // The scan is bounded by a LIMIT clause of 5000 — whether the 5000 is a literal in the
  // SQL text or a bound value, the cap must be exactly 5000 (not 500, not 50000).
  assert.ok(/\blimit\b/i.test(select!.text), "the scan is bounded by a LIMIT clause (a per-query cap)");
  const cappedTo5000 =
    /\blimit\s+5000\b/i.test(select!.text) ||
    select!.values.includes(5000) ||
    select!.values.includes("5000");
  assert.ok(cappedTo5000, "the scan is capped at exactly 5000 rows per query");

  // The cap takes the MOST-RECENT rows, so search covers the newest activity.
  assert.ok(/order\s+by/i.test(select!.text), "the capped scan is ordered");
  assert.ok(/desc/i.test(select!.text), "…newest-first, so the cap keeps the most recent rows");

  // Member scope travels as a bound value even on the capped scan (never concatenated).
  assert.ok(select!.values.includes("session-user"), "the user id is bound on the capped scan");
  assert.ok(!select!.text.includes("session-user"), "the user id is never spliced into the SQL text");
});

// ===================================================================================
// AC3 — a boundary handler validates input (4xx before the search) and searches under
// the SESSION user id; the injection probe cannot alter a query. The handler below is a
// TEST FIXTURE exercising the real boundary modules — NOT an implementation file.
// ===================================================================================

// The free-text query the fixture handler accepts, with a length cap so a grossly
// oversized field is refused at the boundary (declared locally so the test couples to
// behaviour, not to the module's exported type names).
const MAX_QUERY = 200;

// A recording "search" seam: it never touches a database, so "the searcher was called"
// is a proxy for "a search ran". Validation failures must leave `calls` empty.
interface RecordingSearcher {
  readonly calls: { userId: string; query: string }[];
  search(userId: string, query: string): Promise<{ seq: number }[]>;
}
function recordingSearcher(): RecordingSearcher {
  const calls: { userId: string; query: string }[] = [];
  return {
    calls,
    async search(userId, query) {
      calls.push({ userId, query });
      return [];
    },
  };
}

// Validate the request body at the boundary, then search under the SESSION user id (never
// a body value). A rejection maps to a 4xx Response and never reaches the searcher.
function createSearchActivityHandler(
  searcher: RecordingSearcher,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  const schema = z.object({
    query: z.string().min(1).max(MAX_QUERY),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 16 * 1024 });
      const entries = await searcher.search(sessionUserId, body.query);
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
  return new Request("https://warthog.com.au/api/activity/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the search handler rejects malformed JSON with a 4xx and never reaches the search", async () => {
  const searcher = recordingSearcher();
  const handler = createSearchActivityHandler(searcher, "session-user");

  const res = await handler(postJson("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(searcher.calls.length, 0, "malformed input must never reach the search");
});

test("the search handler rejects an oversized body with a 4xx and never reaches the search", async () => {
  const searcher = recordingSearcher();
  const handler = createSearchActivityHandler(searcher, "session-user");

  // ~40 KiB body, well over the handler's 16 KiB cap: rejected by size before parsing.
  const huge = JSON.stringify({ query: "x".repeat(40 * 1024) });
  const res = await handler(postJson(huge));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(searcher.calls.length, 0, "an oversized body must never reach the search");
});

test("the search handler rejects mis-shaped or oversized query input with a 4xx and never reaches the search", async () => {
  const cases: Record<string, unknown> = {
    "query missing": {},
    "query as a number": { query: 123 },
    "query as an object": { query: { nested: true } },
    "query empty string": { query: "" },
    "query over the length cap": { query: "x".repeat(MAX_QUERY + 1) },
  };
  for (const [label, body] of Object.entries(cases)) {
    const searcher = recordingSearcher();
    const handler = createSearchActivityHandler(searcher, "session-user");

    const res = await handler(postJson(JSON.stringify(body)));

    assert.ok(res.status >= 400 && res.status < 500, `${label}: expected a 4xx, got ${res.status}`);
    assert.equal(searcher.calls.length, 0, `${label}: a mis-shaped query must never reach the search`);
  }
});

test("a well-formed request reaches the search once with the validated query", async () => {
  const searcher = recordingSearcher();
  const handler = createSearchActivityHandler(searcher, "session-user");

  const res = await handler(postJson(JSON.stringify({ query: "flight to perth" })));

  assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
  assert.equal(searcher.calls.length, 1, "a well-formed request reaches the search exactly once");
  assert.equal(searcher.calls[0].query, "flight to perth", "with the validated query");
});

test("the search handler searches under the SESSION user id, never a body-supplied id", async () => {
  const searcher = recordingSearcher();
  const handler = createSearchActivityHandler(searcher, "session-user");

  // The body smuggles a victim's user id; the handler must ignore it and use the session's.
  const res = await handler(postJson(JSON.stringify({ query: "anything", userId: "attacker" })));

  assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
  assert.equal(searcher.calls.length, 1, "the request is searched");
  assert.equal(searcher.calls[0].userId, "session-user", "under the session user id");
  assert.ok(
    !searcher.calls.some((c) => c.userId === "attacker"),
    "the body-supplied id never becomes the scope",
  );
});

// ---- injection safety (INV-102): the probe cannot alter a query ---------------------

test("searchActivity binds the user id and keeps the query out of the SQL text entirely", async () => {
  const db = recordingDb();
  const probeUser = "u'); DROP TABLE activity_entries; --";
  const probeQuery = "q'); DROP TABLE activity_entries; --";

  const out = await searchActivity(db, probeUser, probeQuery, freshDek());
  assert.deepEqual(out, [], "the recording db returns no rows → no matches");

  assert.ok(db.calls.length >= 1, "searchActivity issues at least one query");
  const everyValue = db.calls.flatMap((c) => c.values);
  assert.ok(everyValue.includes(probeUser), "the user id travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probeUser), "the user id is bound, never concatenated into the SQL");
    assert.ok(
      !call.text.includes(probeQuery),
      "the query text is never concatenated into the SQL (it is matched in-app, not in SQL)",
    );
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("a SQL-injection probe in the query is inert and the activity table survives", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "search-probe");
    const dek = freshDek();
    const t = token();
    await recordEntry(db, alice, dek, JAN, { payload: summary(`real ${t} one`) });
    await recordEntry(db, alice, dek, FEB, { payload: summary(`real ${t} two`) });

    const probe = "evil'); DROP TABLE activity_entries; --";
    // The probe is matched in-app against the decrypted summaries and simply matches no
    // row — it never executes as SQL.
    assert.deepEqual(await searchActivity(db, alice, probe, dek), [], "the probe matches no summary");

    assert.equal(await tableExists(db, "activity_entries"), true, "the activity table survives the probe");
    // The real entries are still searchable afterwards — nothing was dropped.
    assert.equal((await searchActivity(db, alice, t, dek)).length, 2, "the real entries remain");
  } finally {
    await db.close();
  }
});

// ===================================================================================
// AC4 — the search holds no key and reads no process.env: no secret value is folded in.
// ===================================================================================

test("the search reads no process.env: a decoy env secret never appears in a returned entry", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "search-env");
    const dek = freshDek();
    const t = token();
    await recordEntry(db, alice, dek, JAN, { payload: summary(`a plain summary ${t}`) });
    await recordEntry(db, alice, dek, FEB, { payload: summary(`another one ${t}`) });

    const out = await searchActivity(db, alice, t, dek);
    assert.equal(out.length, 2, "the search works purely from the injected db + dek");
    assert.ok(
      !JSON.stringify(out).includes(DECOY),
      "no ambient env value is folded into a returned entry — the search holds no secret",
    );
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});
