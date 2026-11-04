// E07-S01 — Release fingerprint store (`src/server/db/release-fingerprints.ts`,
// `db/migrations/0010_release_fingerprints.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so
// importing `./release-fingerprints` throws and `freshDb()` has no
// `release_fingerprints` table — every test here fails until the builder adds
// them. That absence IS the point of test-first; do not implement anything to
// make these pass.
//
// These tests pin BEHAVIOUR (what the data-access functions DO and what the
// migration produces), never the source text of the module or the SQL file — a
// later rename that preserves behaviour must not redden them.
//
// WHY this exists (design §4.2/§4.3): on a release the server records a keyed,
// one-way FINGERPRINT of the handed-over value — HMAC-SHA256(HKDF(DEK,
// `warthog/fp/v1`), normalised value) — and keeps it 90 days, never the value
// itself. Redaction (a later task) masks any later tool call containing a
// previously released value by computing the token's fingerprint and looking it
// up here. So this repo is pure data access over fingerprint HEX DIGESTS: the
// crypto layer (`../crypto/hmac` `fingerprint`) computes them; this module only
// stores and returns them, exactly as `users.ts` stores an opaque wrapped DEK.
//
// The contract this task defines (the builder implements exactly this):
//
//   storeFingerprint(db, { userId, fingerprint }, clock): Promise<void>
//     • inserts a release-fingerprint row for `userId` holding the keyed one-way
//       `fingerprint` (a hex HMAC digest), kept 90 days from clock.now()
//       (expires_at = now + 90 days). Time enters through the injected Clock,
//       never SQL now() (as `jobs.claim(db, clock)` does), so expiry is
//       deterministic and testable. The plaintext value is never passed to — nor
//       written by — this repo.
//   lookupForUser(db, userId, clock): Promise<string[]>
//     • returns this person's fingerprints whose 90-day window has NOT lapsed as
//       of clock.now() (WHERE user_id = $1 AND expires_at > now) — ONLY that
//       user's rows, with `userId` bound as a parameter (member-scoped; the
//       caller passes the session user id, never a client value).
//
// Acceptance criteria → tests:
//   AC1 "Storing a fingerprint for a user makes lookupForUser return it within 90
//        days and omit it once expired." — stored at T, present at T+89d, absent
//        at T+91d (expiry driven by the injected clock, not the wall clock).
//   AC2 "The fingerprint is an HMAC (keyed, one-way); the plaintext value is never
//        written to the table." — what is stored and round-tripped IS the keyed
//        HMAC digest produced by the real `fingerprint(dek, value)` (64 hex
//        chars, not the value); a scan of the whole table never contains the
//        plaintext.
//   AC3 "A user's lookup never returns another user's fingerprints (filtered by
//        session user id)." — A's lookup returns A's fingerprint and never B's,
//        and vice versa; the user id is bound as a parameter.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) "A handler rejects
//        malformed or oversized input with a 4xx, and a SQL-injection probe in an
//        input field cannot alter a query (parameter binding is used)." — the
//        VALIDATE half is reused from the already-built boundary (`../http/validate`);
//        here we prove it COMPOSES with this task's data-access: a handler built on
//        the boundary rejects malformed/oversized input with a 4xx before any query
//        runs, and a probe routed through storeFingerprint/lookupForUser travels as
//        a bound value — it cannot drop or alter the table. The handlers below are
//        test fixtures (the intended usage pattern), not implementation files.
//   AC5 [obligation:secrets-from-env] — no secret value appears in this task's
//        source: the repo holds no key and reads no `process.env`; the HMAC KEY
//        lives in the crypto/config layers, and this repo stores only the already
//        one-way digest. (Enforced here by construction: the fingerprint this repo
//        receives is a digest, not a key; the module imports no secret.)
//   Migration: the `release_fingerprints` relation exists after the project
//        migrations and a second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { storeFingerprint, lookupForUser } from "./release-fingerprints";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { parseBody, HttpError } from "../http/validate";
import { fixedClock, type Clock } from "../seams/clock";
import { fingerprint } from "../crypto/hmac";

// --- fixtures ---------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
// A base instant deliberately in the past relative to the wall clock, so a lookup
// that wrongly filtered on SQL now() instead of the injected clock would behave
// differently and be caught by the expiry tests below.
const T0 = new Date("2026-01-01T00:00:00.000Z");
const WITHIN_WINDOW = new Date(T0.getTime() + 89 * DAY_MS); // still inside 90 days
const AFTER_WINDOW = new Date(T0.getTime() + 91 * DAY_MS); // past the 90-day window

// A deterministic 32-byte per-person DEK stand-in. The real DEK comes from the
// crypto/key layers; this repo only ever sees the fingerprint it produces.
function dekFor(who: string): Uint8Array {
  const buf = Buffer.alloc(32);
  Buffer.from(`dek-${who}`).copy(buf);
  return new Uint8Array(buf);
}

// The keyed one-way fingerprint of `value` for a person, via the real crypto
// helper — exactly what the release flow stores through this repo.
function fpFor(who: string, value: string): string {
  return fingerprint(dekFor(who), value);
}

// A stand-in wrapped DEK for createUser (opaque base64; this module never reads it).
function wrappedDekFor(who: string): string {
  return Buffer.from(`wrapped-dek-${who}`).toString("base64");
}

// A db seam stand-in that records every call instead of running it, so a test can
// prove WHAT reached the query layer and HOW (bound value vs. spliced text). It
// returns no rows. It satisfies the `Db` shape structurally (query + close).
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

// --- AC1: stored, returned within 90 days, omitted once expired --------------------

test("a stored fingerprint is returned by lookupForUser within the 90-day window", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, {
      email: "ac1@warthog.com.au",
      wrappedDek: wrappedDekFor("ac1"),
    });
    const fp = fpFor("ac1", "a-released-value");

    await storeFingerprint(db, { userId: user.id, fingerprint: fp }, fixedClock(T0));

    const within = await lookupForUser(db, user.id, fixedClock(WITHIN_WINDOW));
    assert.ok(Array.isArray(within), "lookupForUser returns a list of fingerprints");
    assert.ok(within.includes(fp), "the fingerprint is returned while inside the 90-day window");
  } finally {
    await db.close();
  }
});

test("lookupForUser omits a fingerprint once its 90-day window has lapsed", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, {
      email: "ac1b@warthog.com.au",
      wrappedDek: wrappedDekFor("ac1b"),
    });
    const fp = fpFor("ac1b", "a-released-value");

    await storeFingerprint(db, { userId: user.id, fingerprint: fp }, fixedClock(T0));

    // Expiry is driven by the injected clock: 91 days after storage the value is
    // past its 90-day life and must not come back.
    const after = await lookupForUser(db, user.id, fixedClock(AFTER_WINDOW));
    assert.ok(!after.includes(fp), "the fingerprint is omitted once the 90-day window lapses");
  } finally {
    await db.close();
  }
});

// --- AC2: the stored thing IS the keyed HMAC; the plaintext is never written -------

test("lookupForUser round-trips the exact keyed HMAC digest, never the plaintext", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, {
      email: "ac2@warthog.com.au",
      wrappedDek: wrappedDekFor("ac2"),
    });

    const plaintext = "released-value-ZX7Q9-not-a-real-secret";
    const fp = fingerprint(dekFor("ac2"), plaintext);

    // A fingerprint is a SHA-256 HMAC hex digest — one-way and unrelated in form to
    // the value it was derived from.
    assert.match(fp, /^[0-9a-f]{64}$/, "a fingerprint is a 64-char lowercase hex HMAC digest");
    assert.notEqual(fp, plaintext, "the fingerprint is not the plaintext value");

    await storeFingerprint(db, { userId: user.id, fingerprint: fp }, fixedClock(T0));

    const back = await lookupForUser(db, user.id, fixedClock(T0));
    assert.ok(back.includes(fp), "the exact keyed fingerprint round-trips intact (no mangling)");
    assert.ok(
      back.includes(fingerprint(dekFor("ac2"), plaintext)),
      "the stored digest equals an independent recompute of the keyed HMAC",
    );

    // The plaintext value appears nowhere in the table — only its one-way digest was
    // ever written. Scoped to the one table under test; the probe plaintext is a
    // unique string, so a hit would be a real leak, not a coincidence.
    const all = await db.query("SELECT * FROM release_fingerprints");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.ok(
            !cell.includes(plaintext),
            "the plaintext released value is never written to the table",
          );
        }
      }
    }
  } finally {
    await db.close();
  }
});

test("distinct released values are stored as distinct fingerprints, both retrievable", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, {
      email: "ac2b@warthog.com.au",
      wrappedDek: wrappedDekFor("ac2b"),
    });
    const fp1 = fpFor("ac2b", "first-released-value");
    const fp2 = fpFor("ac2b", "second-released-value");
    assert.notEqual(fp1, fp2, "different values produce different fingerprints");

    await storeFingerprint(db, { userId: user.id, fingerprint: fp1 }, fixedClock(T0));
    await storeFingerprint(db, { userId: user.id, fingerprint: fp2 }, fixedClock(T0));

    const back = await lookupForUser(db, user.id, fixedClock(T0));
    assert.ok(back.includes(fp1), "the first fingerprint is retrievable");
    assert.ok(back.includes(fp2), "the second fingerprint is retrievable");
  } finally {
    await db.close();
  }
});

// --- AC3: a lookup is scoped to its own user, never another's ----------------------

test("lookupForUser returns only the requesting user's fingerprints, never another's", async () => {
  const db = await freshDb();
  try {
    const alice = await createUser(db, {
      email: "alice@warthog.com.au",
      wrappedDek: wrappedDekFor("alice"),
    });
    const bob = await createUser(db, {
      email: "bob@warthog.com.au",
      wrappedDek: wrappedDekFor("bob"),
    });
    assert.notEqual(alice.id, bob.id, "two people have distinct ids");

    const fpAlice = fpFor("alice", "alices-released-value");
    const fpBob = fpFor("bob", "bobs-released-value");
    await storeFingerprint(db, { userId: alice.id, fingerprint: fpAlice }, fixedClock(T0));
    await storeFingerprint(db, { userId: bob.id, fingerprint: fpBob }, fixedClock(T0));

    const alicesLookup = await lookupForUser(db, alice.id, fixedClock(T0));
    assert.ok(alicesLookup.includes(fpAlice), "Alice sees her own fingerprint");
    assert.ok(!alicesLookup.includes(fpBob), "Alice never sees Bob's fingerprint");

    const bobsLookup = await lookupForUser(db, bob.id, fixedClock(T0));
    assert.ok(bobsLookup.includes(fpBob), "Bob sees his own fingerprint");
    assert.ok(!bobsLookup.includes(fpAlice), "Bob never sees Alice's fingerprint");
  } finally {
    await db.close();
  }
});

// --- AC3/AC4: every statement binds its input as a parameter (no spliced SQL) ------

test("lookupForUser binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'; DROP TABLE release_fingerprints; --";

  const result = await lookupForUser(db, probe, fixedClock(T0));
  assert.deepEqual(result, [], "the recording db returns no rows, so the lookup is empty");

  assert.ok(db.calls.length >= 1, "the lookup issues at least one query");
  assert.ok(
    db.calls.some((c) => c.values.includes(probe)),
    "the user id travels as a bound value",
  );
  for (const call of db.calls) {
    assert.ok(call.text.includes("$1"), "the statement uses a placeholder for the user id");
    assert.ok(!call.text.includes(probe), "the user id is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("storeFingerprint binds the user id and fingerprint as parameters, never spliced", async () => {
  const db = recordingDb();
  const probe = "x'); DROP TABLE release_fingerprints; --";

  await storeFingerprint(db, { userId: "user-1", fingerprint: probe }, fixedClock(T0));

  assert.ok(db.calls.length >= 1, "storing issues at least one query");
  assert.ok(
    db.calls.some((c) => c.values.includes("user-1")),
    "the user id travels as a bound value",
  );
  assert.ok(
    db.calls.some((c) => c.values.includes(probe)),
    "the fingerprint travels as a bound value",
  );
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the fingerprint is bound, never concatenated into SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
});

test("a SQL-injection probe stored as a fingerprint cannot drop the table and round-trips as data", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, {
      email: "probe@warthog.com.au",
      wrappedDek: wrappedDekFor("probe"),
    });
    const safeFp = fpFor("probe", "a-safe-released-value");
    await storeFingerprint(db, { userId: user.id, fingerprint: safeFp }, fixedClock(T0));

    // A probe fingerprint that, if concatenated rather than bound, would drop the table.
    const probeFp = "evil'); DROP TABLE release_fingerprints; --";
    await storeFingerprint(db, { userId: user.id, fingerprint: probeFp }, fixedClock(T0));

    assert.equal(
      await tableExists(db, "release_fingerprints"),
      true,
      "the release_fingerprints table must still exist (the injection was data, not SQL)",
    );

    const back = await lookupForUser(db, user.id, fixedClock(T0));
    assert.ok(back.includes(safeFp), "the safe fingerprint survives");
    assert.ok(back.includes(probeFp), "the probe is stored verbatim as data and comes back as-is");
  } finally {
    await db.close();
  }
});

// --- AC4: a handler on the validation boundary rejects bad input and binds probes --
//
// A route handler validates external input at the boundary (`parseBody`), then calls
// this task's parameterized data-access with the session's user id (NEVER a body
// value). A rejected input maps to a 4xx Response and never reaches a query. These
// handlers are test fixtures that EXERCISE the modules — they are not implementation
// files.

function createReleaseFingerprintHandler(
  db: Db,
  clock: Clock,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries only the one-way fingerprint; the user id comes from the
  // session. The schema is permissive on length (a probe must be able to REACH the
  // query to prove it is bound), but caps the field so an absurd value is rejected.
  const schema = z.object({ fingerprint: z.string().min(1).max(256) });
  return async (req: Request): Promise<Response> => {
    try {
      const { fingerprint: fp } = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      await storeFingerprint(db, { userId: sessionUserId, fingerprint: fp }, clock);
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
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
  return new Request("https://warthog.com.au/api/release-fingerprints", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("a handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createReleaseFingerprintHandler(db, fixedClock(T0), "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("a handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = createReleaseFingerprintHandler(db, fixedClock(T0), "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ fingerprint: "a".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("a handler accepts a well-formed fingerprint and persists it for the session user", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, {
      email: "handler@warthog.com.au",
      wrappedDek: wrappedDekFor("handler"),
    });
    const clock = fixedClock(T0);
    const handler = createReleaseFingerprintHandler(db, clock, user.id);
    const fp = fpFor("handler", "a-released-value");

    const res = await handler(jsonRequest(JSON.stringify({ fingerprint: fp })));

    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const stored = await lookupForUser(db, user.id, clock);
    assert.ok(stored.includes(fp), "a valid fingerprint is persisted for the session user");
  } finally {
    await db.close();
  }
});

test("a handler cannot be SQL-injected: a probe fingerprint is stored as data and the table survives", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, {
      email: "handler-probe@warthog.com.au",
      wrappedDek: wrappedDekFor("handler-probe"),
    });
    const clock = fixedClock(T0);
    const handler = createReleaseFingerprintHandler(db, clock, user.id);
    const probeFp = "grace'); DROP TABLE release_fingerprints; --";

    const res = await handler(jsonRequest(JSON.stringify({ fingerprint: probeFp })));

    assert.ok(res.status >= 200 && res.status < 300, "a valid-shaped (if nasty) value is accepted");
    assert.equal(
      await tableExists(db, "release_fingerprints"),
      true,
      "the release_fingerprints table must still exist",
    );
    const stored = await lookupForUser(db, user.id, clock);
    assert.ok(stored.includes(probeFp), "the probe is stored verbatim, not interpreted as SQL");
  } finally {
    await db.close();
  }
});

// --- Migration: the table applies and a second run changes nothing -----------------

test("the release_fingerprints migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    // 0010_release_fingerprints applied: the relation exists (a non-throwing existence
    // probe scoped to the one table under test — behaviour, not source text).
    assert.equal(
      await tableExists(db, "release_fingerprints"),
      true,
      "the release_fingerprints table must exist after the project migrations",
    );

    // The project migration set includes this task's migration (its recorded name is
    // the task's named deliverable, stable once applied).
    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0010_release_fingerprints"),
      "db/migrations/0010_release_fingerprints.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0010's CREATE would throw "already exists", so an empty result AND
    // no throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
