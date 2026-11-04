// E07-S02 — Activity recorder interface and in-memory chained recorder
// (`src/server/activity/recorder.ts`).
//
// RED-first: the module does not exist yet, so importing `./recorder` fails and
// every test below fails. That absence IS the point of test-first — the builder
// writes the implementation afterwards to make these pass; nothing here is
// implemented to go green early.
//
// These tests pin BEHAVIOUR (what `record()` returns and stores, and what
// `computeEntryHash` does), never the source text of the module — a later rename
// or refactor that preserves behaviour must not redden them.
//
// WHY this exists (design §9, constitution principle 14 "Warthog writes the
// record"): the agent pipeline and every write-through record through ONE
// contract — the `ActivityRecorder` — so Warthog itself writes every entry at the
// moment it handles it. Before the Postgres writer exists, an in-memory recorder
// serves tests and local dev. It must (a) assign a contiguous per-user `seq` and
// chain each entry to the previous one of the SAME user by hash, starting a fresh
// chain per user; (b) run the payload through redaction (design §4.3), including
// the per-user released-value matcher, BEFORE the entry is stored; and (c) compute
// `entry_hash` over `prev_hash` plus the canonical other fields so that altering a
// stored entry is caught by recomputation (the daily integrity check, a later task,
// recomputes exactly this).
//
// THE PINNED CONTRACT (chosen by the tester; the builder implements exactly this):
//
//   interface ActivityEntryInput {
//     userId: string;
//     kind: string;
//     source: "warthog" | "agent_reported";
//     agentId?, connectorId?, tool?, outcome?, merchant? ...;  // optional metadata
//     payload?: unknown;                 // tool parameters / result summary / reason
//   }
//   interface ActivityEntry {            // the stored, chained entry record() returns
//     userId, seq, occurredAt (ISO), kind, source, merchant, outcome, payload,
//     prevHash, entryHash, ...;          // `payload` is the REDACTED payload
//   }
//   interface ActivityRecorder { record(input: ActivityEntryInput): Promise<ActivityEntry>; }
//
//   createInMemoryRecorder(options: {
//     clock: Clock;
//     matchesReleased?: (userId: string, normalisedToken: string) => boolean;
//   }): ActivityRecorder
//     • `clock` supplies occurred_at (constitution: domain/server take a clock, never
//       Date.now()). `matchesReleased` is the per-user released-value fingerprint
//       lookup the real DB writer will back with `release-fingerprints` + `fingerprint`;
//       here it is INJECTED so the recorder stays testable without a DB. Omitted ⇒ the
//       recorder still redacts cards and secret field names; only the released-value
//       rule needs the matcher.
//
//   computeEntryHash(entry: ActivityEntry): string
//     • recomputes the hash over `prev_hash` plus every OTHER canonical field (i.e.
//       everything except `entry_hash` itself). `record()` sets `entry_hash` to this
//       value, so for a genuine entry `computeEntryHash(e) === e.entryHash`, and any
//       mutation to a stored entry makes them disagree. This is the recomputation the
//       integrity check runs; exporting it here is what makes tampering detectable.
//
// AC → tests:
//   AC1 "record() assigns a contiguous per-user seq and sets prev_hash to the previous
//        entry_hash for that user, starting a fresh chain per user." — seq increments
//        by one within a user; each entry's prev_hash is the previous entry_hash; two
//        users interleaved keep independent chains that each start from the genesis.
//   AC2 "A card number or token in a payload field is replaced by a masked placeholder
//        (redaction runs, including released-value fingerprints) before the entry is
//        stored." — the stored payload has the card masked and the secret field
//        redacted; a value the per-user matcher reports becomes `[released value]` for
//        that user only; the stored payload equals `redact(payload, perUserMatcher)`.
//   AC3 "entry_hash is computed over prev_hash plus the canonical other fields so
//        altering a stored entry is detectable by recomputation." — a genuine entry
//        verifies; mutating merchant, outcome, payload, prev_hash OR entry_hash itself
//        is caught; hashing is reproducible (pure over the fields) for the integrity check.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) "A handler rejects
//        malformed or oversized input with a 4xx, and a SQL-injection probe in an input
//        field cannot alter a query (parameter binding is used)." — the VALIDATE half is
//        reused from the already-built boundary (`../http/validate`): a fixture handler
//        rejects malformed/oversized input with a 4xx BEFORE any entry is recorded, and
//        records only under the SESSION user id, never a body-supplied one. The in-memory
//        recorder has NO query surface to alter, so the PARAMETERIZE half reduces to its
//        in-memory analogue: a SQL-injection probe routed through `record()` is stored as
//        inert data (never interpreted), the hash chain stays intact, and another user is
//        unaffected. (The Postgres writer, a later task, binds these as parameters.) The
//        handlers below are test fixtures that EXERCISE the modules — not implementation.
//   AC5 [obligation:secrets-from-env] (INV-103) "No secret value is present in source,
//        the client bundle, or the build context; config is read from env." — satisfied
//        here by construction: the recorder reads no `process.env` and holds no secret;
//        every dependency (clock, released-value matcher) is INJECTED, so no env value or
//        key lives in this module. The determinism test exercises that the recorder is a
//        pure function of its injected seams and inputs (nothing ambient).

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import {
  createInMemoryRecorder,
  computeEntryHash,
  type ActivityRecorder,
  type ActivityEntryInput,
  type ActivityEntry,
} from "./recorder";
import { fixedClock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";
import { redact } from "../../domain/redaction/redact";

// --- fixtures ----------------------------------------------------------------------

// A fixed instant so occurred_at and the hashes are deterministic across a run.
const T0 = new Date("2026-01-01T00:00:00.000Z");

// The classic Luhn-valid test card (redaction masks it, revealing only the last four).
const CARD = "4242424242424242";

// Build a well-formed input, overriding only the fields a test cares about. `userId`,
// `kind` and `source` are the required core; everything else is optional metadata.
function input(overrides: Partial<ActivityEntryInput> = {}): ActivityEntryInput {
  return { userId: "u", kind: "tool_call", source: "warthog", ...overrides };
}

// A compact way to scan a (redacted) payload for a substring without assuming its
// shape — scoped to the one payload under test, never a whole-output check.
function json(payload: unknown): string {
  return JSON.stringify(payload);
}

// A recorder wrapper that captures the inputs reaching `record()`, so a handler test
// can prove WHETHER (and with what) the recorder was called, over a real in-memory
// recorder (genuine seq/hash come back).
function instrumentedRecorder(): { recorder: ActivityRecorder; calls: ActivityEntryInput[] } {
  const calls: ActivityEntryInput[] = [];
  const inner = createInMemoryRecorder({ clock: fixedClock(T0) });
  const recorder: ActivityRecorder = {
    async record(entry) {
      calls.push(entry);
      return inner.record(entry);
    },
  };
  return { recorder, calls };
}

// ===================================================================================
// AC1 — contiguous per-user seq + prev_hash chaining + a fresh chain per user.
// ===================================================================================

test("record assigns a contiguous seq and links each prev_hash to the previous entry_hash", async () => {
  const recorder = createInMemoryRecorder({ clock: fixedClock(T0) });

  const e1 = await recorder.record(input({ payload: { n: 1 } }));
  const e2 = await recorder.record(input({ payload: { n: 2 } }));
  const e3 = await recorder.record(input({ payload: { n: 3 } }));

  assert.equal(typeof e1.seq, "number", "seq is a number");
  assert.equal(e2.seq, e1.seq + 1, "seq is contiguous (increments by one)");
  assert.equal(e3.seq, e2.seq + 1, "seq stays contiguous for the next entry");

  // The first entry starts a fresh chain: its prev_hash is a genesis sentinel, not
  // the hash of any real entry.
  assert.equal(typeof e1.prevHash, "string", "prev_hash is a string");
  assert.notEqual(e1.prevHash, e1.entryHash, "the genesis prev_hash is not a real entry hash");

  // Each later entry's prev_hash is exactly the previous entry's entry_hash.
  assert.equal(e2.prevHash, e1.entryHash, "entry 2 chains to entry 1's hash");
  assert.equal(e3.prevHash, e2.entryHash, "entry 3 chains to entry 2's hash");

  // Distinct entries have distinct hashes (the chain is not a constant).
  assert.notEqual(e1.entryHash, e2.entryHash, "different entries hash differently");
  assert.notEqual(e2.entryHash, e3.entryHash, "different entries hash differently");
});

test("each user has an independent chain — interleaved records never cross users", async () => {
  const recorder = createInMemoryRecorder({ clock: fixedClock(T0) });

  // Interleave two users through the SAME recorder.
  const a1 = await recorder.record(input({ userId: "A", payload: { a: 1 } }));
  const b1 = await recorder.record(input({ userId: "B", payload: { b: 1 } }));
  const a2 = await recorder.record(input({ userId: "A", payload: { a: 2 } }));
  const b2 = await recorder.record(input({ userId: "B", payload: { b: 2 } }));

  // Each user's seq is contiguous on its own, unaffected by the other's writes.
  assert.equal(a2.seq, a1.seq + 1, "user A's seq is contiguous despite B's interleaved write");
  assert.equal(b2.seq, b1.seq + 1, "user B's seq is contiguous despite A's interleaved write");
  assert.equal(b1.seq, a1.seq, "each user's chain starts at the same base seq (fresh per user)");

  // Each entry chains to its OWN user's previous entry, never the other user's.
  assert.equal(a2.prevHash, a1.entryHash, "A2 chains to A1, not to B1");
  assert.equal(b2.prevHash, b1.entryHash, "B2 chains to B1, not to A2");

  // B's first entry does NOT continue A's chain — it starts fresh from the genesis,
  // identical to A's starting point.
  assert.notEqual(b1.prevHash, a1.entryHash, "B's chain does not continue A's chain");
  assert.equal(a1.prevHash, b1.prevHash, "both users' chains start from the same fresh genesis");
});

// ===================================================================================
// AC2 — the payload is redacted (card, secret field name, and released value) BEFORE
// it is stored.
// ===================================================================================

test("record masks a card number and redacts a secret-named field in the payload before storing", async () => {
  // No matcher injected: card masking and secret-field redaction run regardless.
  const recorder = createInMemoryRecorder({ clock: fixedClock(T0) });

  const stored = await recorder.record(
    input({
      payload: { params: { body: `pay ${CARD} now`, token: "superseKRETvalue" } },
    }),
  );

  const text = json(stored.payload);
  // The full card number must not survive; the masked [card …] wrapper is present
  // and reveals only the last four digits (scoped to this payload; last4 legitimately
  // reappears inside the mask, so only the FULL number's absence is asserted).
  assert.ok(!text.includes(CARD), "the full card number must not survive into the stored payload");
  assert.ok(text.includes("[card "), "the card is stored masked as a [card …] token");
  assert.ok(text.includes(CARD.slice(-4) + "]"), "the mask reveals exactly the last four digits");

  // The secret-named field's value is gone, replaced by the redaction marker.
  assert.ok(!text.includes("superseKRETvalue"), "a secret-named field value must not be stored");
  assert.ok(text.includes("[redacted]"), "a secret-named field is stored as [redacted]");
});

test("record applies the released-value matcher per user — only the releasing user's value is masked", async () => {
  // A matcher that reports "swordfish" as released ONLY for user A.
  const matchesReleased = (userId: string, token: string): boolean =>
    userId === "A" && token === "swordfish";
  const recorder = createInMemoryRecorder({ clock: fixedClock(T0), matchesReleased });

  const forA = await recorder.record(input({ userId: "A", payload: { note: "swordfish" } }));
  const forB = await recorder.record(input({ userId: "B", payload: { note: "swordfish" } }));

  // For A, the released value is masked.
  const aText = json(forA.payload);
  assert.ok(aText.includes("[released value]"), "A's released value is masked");
  assert.ok(!aText.includes("swordfish"), "A's released value itself is not stored");

  // For B, who never released it, the same token survives — the matcher is user-scoped.
  const bText = json(forB.payload);
  assert.ok(bText.includes("swordfish"), "B never released it, so the token is kept for B");
  assert.ok(!bText.includes("[released value]"), "B's benign token is not masked");
});

test("record stores exactly redact(payload, per-user matcher) — redaction runs over the payload", async () => {
  const matchesReleased = (userId: string, token: string): boolean =>
    userId === "A" && token === "swordfish";
  const recorder = createInMemoryRecorder({ clock: fixedClock(T0), matchesReleased });

  // A fresh, independent copy each call so the oracle can never observe mutation by record().
  const payloadFor = () => ({
    params: { body: `pay ${CARD} now`, token: "superseKRETvalue" },
    note: "swordfish",
  });

  const stored = await recorder.record(input({ userId: "A", payload: payloadFor() }));

  // The recorder binds the per-user matcher for A; the oracle binds the same one.
  const expected = redact(payloadFor(), (token) => matchesReleased("A", token));
  assert.deepEqual(
    stored.payload,
    expected,
    "the stored payload is the output of the redaction module (card + secret + released value)",
  );
});

// ===================================================================================
// AC3 — entry_hash is computed over prev_hash + the canonical other fields, so a
// mutation to any stored entry is caught by recomputation.
// ===================================================================================

test("a genuine entry verifies by recomputation; altering any hashed field is detected", async () => {
  const recorder = createInMemoryRecorder({ clock: fixedClock(T0) });

  const e = await recorder.record(
    input({ merchant: "BoxCo", outcome: "ok", payload: { amount: 42 } }),
  );

  // Recomputing over the untouched entry reproduces its stored hash: the chain is intact.
  assert.equal(computeEntryHash(e), e.entryHash, "an untouched entry verifies on recomputation");

  // Mutating any canonical field makes the recomputed hash disagree with the stored one.
  assert.notEqual(
    computeEntryHash({ ...e, merchant: "EvilCo" }),
    e.entryHash,
    "tampering with the merchant is detectable",
  );
  assert.notEqual(
    computeEntryHash({ ...e, outcome: "denied" }),
    e.entryHash,
    "tampering with the outcome is detectable",
  );
  assert.notEqual(
    computeEntryHash({ ...e, payload: { amount: 9999 } }),
    e.entryHash,
    "tampering with the payload is detectable",
  );

  // prev_hash is part of the hash, so removing or reordering an entry (which changes a
  // successor's prev_hash) is detectable.
  assert.notEqual(
    computeEntryHash({ ...e, prevHash: "0".repeat(64) }),
    e.entryHash,
    "tampering with prev_hash (reorder/remove) is detectable",
  );

  // Rewriting entry_hash itself is caught: recomputation ignores the stored entry_hash
  // field and so still yields the original value, which no longer matches the forged one.
  const forged = { ...e, entryHash: "deadbeef" };
  assert.notEqual(
    computeEntryHash(forged),
    forged.entryHash,
    "rewriting entry_hash is caught on recomputation",
  );
});

test("entry hashing is reproducible — a pure function of the entry's fields", async () => {
  // Two independent recorders, same clock, same first-entry input: the first entry of
  // a fresh chain must hash identically. This is what lets the daily integrity check
  // recompute the chain; any hidden randomness/nonce in the hash would break it (and
  // this test). It also demonstrates the recorder is pure over its injected seams and
  // inputs — nothing ambient or from the environment enters (AC5).
  const makeEntry = () =>
    createInMemoryRecorder({ clock: fixedClock(T0) }).record(
      input({ merchant: "BoxCo", outcome: "ok", payload: { amount: 42 } }),
    );

  const a = await makeEntry();
  const b = await makeEntry();

  assert.equal(a.seq, b.seq, "the first entry of a fresh chain has the same seq");
  assert.equal(a.prevHash, b.prevHash, "the first entry of a fresh chain has the same genesis");
  assert.equal(a.entryHash, b.entryHash, "identical inputs hash identically (reproducible)");

  // occurred_at is taken from the injected clock, not the wall clock.
  assert.equal(
    new Date(a.occurredAt).getTime(),
    T0.getTime(),
    "occurred_at comes from the injected clock",
  );
});

// ===================================================================================
// AC4 — a handler validates external input at the boundary (rejects malformed /
// oversized with a 4xx before recording), records only under the session user id, and
// treats a SQL-injection probe as inert data. These handlers are TEST FIXTURES.
// ===================================================================================

// A fixture route handler: validate the body at the boundary, then record under the
// SESSION user id (never a body value) as an agent-reported entry. A rejection maps to
// a 4xx Response and never reaches the recorder.
function createLogActivityHandler(
  recorder: ActivityRecorder,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // `payload` is permissive on shape (a probe must be able to REACH the recorder to
  // prove it is inert), but `kind` is bounded so an absurd value is rejected.
  const schema = z.object({
    kind: z.string().min(1).max(64),
    payload: z.unknown().optional(),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 8 * 1024 });
      const entry = await recorder.record({
        userId: sessionUserId,
        kind: body.kind,
        source: "agent_reported",
        payload: body.payload,
      });
      return new Response(JSON.stringify({ seq: entry.seq }), { status: 201 });
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
  return new Request("https://warthog.com.au/api/activity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("a handler rejects malformed JSON with a 4xx and never records", async () => {
  const { recorder, calls } = instrumentedRecorder();
  const handler = createLogActivityHandler(recorder, "session-user");

  const res = await handler(postJson("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(calls.length, 0, "malformed input must never reach the recorder");
});

test("a handler rejects an oversized body with a 4xx and never records", async () => {
  const { recorder, calls } = instrumentedRecorder();
  const handler = createLogActivityHandler(recorder, "session-user");

  // ~20 KiB body, well over the handler's 8 KiB cap: rejected by size before parsing.
  const huge = JSON.stringify({ kind: "tool_call", payload: { blob: "x".repeat(20 * 1024) } });
  const res = await handler(postJson(huge));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(calls.length, 0, "an oversized body must never reach the recorder");
});

test("a handler records under the session user id, never a body-supplied one", async () => {
  const { recorder, calls } = instrumentedRecorder();
  const handler = createLogActivityHandler(recorder, "session-user");

  // The body tries to smuggle a victim's user id; the handler must ignore it.
  const res = await handler(
    postJson(JSON.stringify({ kind: "tool_call", userId: "victim", payload: { note: "hi" } })),
  );

  assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
  assert.equal(calls.length, 1, "a well-formed request records exactly one entry");
  assert.equal(
    calls[0].userId,
    "session-user",
    "the entry is recorded under the session user, never a body-supplied id",
  );
});

test("a SQL-injection probe in a payload field is stored as inert data; the chain stays intact", async () => {
  const recorder = createInMemoryRecorder({ clock: fixedClock(T0) });
  const probe = "robert'); DROP TABLE activity_entries; --";

  const e1 = await recorder.record(input({ userId: "A", payload: { note: probe } }));
  const e2 = await recorder.record(input({ userId: "A", payload: { note: "after" } }));

  // There is no query to alter: the probe is stored as inert data and comes back verbatim
  // (it carries no card, no secret field name, and no matched token, so redaction keeps it).
  assert.ok(
    json(e1.payload).includes(probe),
    "the probe is stored as data, never interpreted as a statement",
  );

  // The hash chain is unharmed: both entries verify and chain correctly.
  assert.equal(computeEntryHash(e1), e1.entryHash, "the probe entry verifies");
  assert.equal(computeEntryHash(e2), e2.entryHash, "the following entry verifies");
  assert.equal(e2.prevHash, e1.entryHash, "the chain continues normally after the probe");

  // Another user's chain is unaffected by A's probe.
  const b1 = await recorder.record(input({ userId: "B", payload: { note: "b" } }));
  assert.notEqual(b1.prevHash, e2.entryHash, "B's chain is independent of A's probe");
});

test("a handler accepts a valid-shaped injection probe as data and returns 2xx", async () => {
  const { recorder, calls } = instrumentedRecorder();
  const handler = createLogActivityHandler(recorder, "session-user");
  const probe = "grace'); DROP TABLE activity_entries; --";

  const res = await handler(postJson(JSON.stringify({ kind: "tool_call", payload: { note: probe } })));

  assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
  assert.equal(calls.length, 1, "the request records exactly one entry");
  assert.deepEqual(
    calls[0].payload,
    { note: probe },
    "the probe reaches the recorder as inert input data, not an interpreted statement",
  );
});
