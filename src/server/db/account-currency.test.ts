// E15-S01 — Account currency setting store
// (`src/server/db/account-currency.ts`, `db/migrations/0037_account_currency.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so importing
// `./account-currency` throws and `freshDb()` has no `account_currency` table — every
// test here fails until the builder adds them. That absence IS the point of test-first;
// do NOT implement anything to make these pass — the builder writes the module and the
// migration afterwards.
//
// These tests pin BEHAVIOUR (what the functions DO: the AUD default a person with
// nothing set reads back, that a valid ISO code persists and round-trips, that an
// unknown or malformed code is rejected with a plain reason and NOT stored, who may
// read/change whose account currency, what a handler rejects, that every value is bound
// as a parameter, that the repo reads no secret from the environment), never the source
// text of the module or the SQL file — a later rename that preserves behaviour must not
// redden them.
//
// WHY this exists (task E15-S01; brief "Currency": "the person sets their account
// currency in Settings (default AUD), and their own agent budgets and limits are in that
// currency"; a new household's currency defaults to the owner's account currency). The
// account currency is a PLAINTEXT METADATA scalar per person — a known ISO 4217 code —
// so, like the notification preferences, it is NOT DEK-encrypted and this module holds no
// key and reads no `process.env`. Every read/write is scoped to the SESSION's user id,
// never a value from the client, so one person can never read or change another's
// account currency.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface SetAccountCurrencyInput {
//     userId: string;    // the person (the SESSION's id, NEVER a client value)
//     currency: string;  // the chosen ISO 4217 code; anything not in the known set is REJECTED
//   }
//
//   type SetAccountCurrencyResult =
//     | { ok: true; currency: string }           // persisted; currency is the stored code
//     | { ok: false; reason: "unknown_currency" }; // unknown/malformed; NOTHING is persisted
//
//   getAccountCurrency(db, userId: string): Promise<string>
//     • member-scoped (WHERE user_id bound). Returns this person's stored ISO code, or —
//       when the person has set none — the default "AUD" (assembled in code). Never
//       another person's currency.
//   setAccountCurrency(db, input: SetAccountCurrencyInput): Promise<SetAccountCurrencyResult>
//     • upserts the ONE row for input.userId (one row per person). A code NOT in the known
//       set of ISO 4217 currency codes (unknown OR malformed — wrong length, non-letters,
//       empty, …) is rejected ({ ok: false, reason: "unknown_currency" }) and NOTHING is
//       written — a previously stored value (or the default) is left untouched. A valid
//       code returns { ok: true, currency } (assembled from the input, not a RETURNING
//       read), and a subsequent get reads the same code back.
//
// Acceptance criteria → tests:
//   AC1 "Reading the currency for a user with none set returns AUD by default, and
//        setAccountCurrency persists a valid ISO code for that user only." — an unset
//        person reads "AUD"; a valid code persists and round-trips; a second set overwrites
//        in place (one row per person); the set never lands on anyone else.
//   AC2 "Setting an unknown or malformed currency code is rejected with a plain reason
//        (not stored)." — an unknown-but-well-formed code ("ZZZ") and malformed codes
//        ("", "US", "AUDD", "12A", an injection string) each return
//        { ok: false, reason: "unknown_currency" } and persist nothing (a prior value or
//        the default survives).
//   AC3 "A user cannot read or change another user's account currency (filtered by session
//        user id)." — one person's set never changes another's read; a second person reads
//        the default, not the first person's code; the user id is bound as a parameter; a
//        handler takes the user id from the SESSION, never the body.
//   AC4 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing / mis-typed
//        input with a 4xx before any query runs; a SQL-injection probe routed through the
//        repo travels as a BOUND value (placeholders, never concatenation), and an
//        injection-shaped currency is rejected by validation and never reaches a query —
//        the table survives either way. The handlers below are test fixtures (the intended
//        usage), not implementation files.
//   AC5 [obligation:secrets-from-env] (INV-103) — the repo takes its db as a dependency,
//        reads no `process.env` and holds no secret, so a decoy secret planted in the
//        environment never lands in the stored or returned currency.
//   Migration: the `account_currency` relation exists after the project migrations and a
//        second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { getAccountCurrency, setAccountCurrency } from "./account-currency";
// Documentary type anchors — the exact names/shapes the implementation exports. Erased
// at runtime (and test files are excluded from `tsc`), so a rename cannot break these
// tests; the runtime assertions below are what actually gate behaviour.
import type {
  SetAccountCurrencyInput,
  SetAccountCurrencyResult,
} from "./account-currency";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db, type QueryResult } from "./index";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

// The brief's default for a person who has set nothing.
const DEFAULT_CURRENCY = "AUD";

// A handful of codes that are unambiguously in ISO 4217 — any "known set of ISO
// currency codes" the builder picks must contain these.
const VALID_CODES = ["USD", "EUR", "GBP", "JPY", "NZD", "CAD"] as const;

// Codes that must be rejected: "ZZZ" is well-formed (three uppercase letters) but is not
// an assigned ISO 4217 code, so it proves the repo checks a KNOWN SET rather than merely
// a shape; the rest are malformed (too short, too long, non-letters, empty).
const UNKNOWN_CODE = "ZZZ";
const MALFORMED_CODES = ["", "US", "AUDD", "12A"] as const;

// A stand-in wrapped DEK for createUser (opaque base64; this module never reads it).
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
    query(text: string, values: unknown[] = []): Promise<QueryResult> {
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

// ===========================================================================
// AC1 — a person with nothing set reads "AUD"; a valid code persists and round-trips;
// a second set overwrites the one row.
// ===========================================================================

test("reading the account currency for a person who has set none returns AUD by default", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-default");
    const currency = await getAccountCurrency(db, userId);
    assert.equal(currency, DEFAULT_CURRENCY, "an unset person reads AUD (the brief's default)");
  } finally {
    await db.close();
  }
});

test("setAccountCurrency persists a valid ISO code that reads back for the person", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-roundtrip");

    const result: SetAccountCurrencyResult = await setAccountCurrency(db, {
      userId,
      currency: "USD",
    });
    assert.equal(result.ok, true, "a valid code is accepted");
    if (result.ok) {
      assert.equal(result.currency, "USD", "the returned result carries the stored code");
    }

    assert.equal(await getAccountCurrency(db, userId), "USD", "the chosen code reads back");
  } finally {
    await db.close();
  }
});

test("every unambiguously valid ISO code is accepted and round-trips", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-validcodes");
    for (const code of VALID_CODES) {
      const result = await setAccountCurrency(db, { userId, currency: code });
      assert.equal(result.ok, true, `${code} is a known ISO code and must be accepted`);
      assert.equal(await getAccountCurrency(db, userId), code, `${code} reads back after setting`);
    }
  } finally {
    await db.close();
  }
});

test("a second set overwrites the account currency in place — one row per person", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac1-upsert");

    await setAccountCurrency(db, { userId, currency: "USD" });
    await setAccountCurrency(db, { userId, currency: "EUR" });

    assert.equal(await getAccountCurrency(db, userId), "EUR", "the second set wins (upsert, not a new row)");

    const count = await db.query(
      "SELECT count(*)::int AS n FROM account_currency WHERE user_id = $1",
      [userId],
    );
    assert.equal(count.rows[0]!.n, 1, "there is exactly one account-currency row for the person");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — an unknown or malformed code is rejected with a plain reason and NOT stored.
// ===========================================================================

test("an unknown-but-well-formed code (ZZZ) is rejected and nothing is stored", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-unknown");

    const result: SetAccountCurrencyResult = await setAccountCurrency(db, {
      userId,
      currency: UNKNOWN_CODE,
    });
    assert.deepEqual(
      result,
      { ok: false, reason: "unknown_currency" },
      "a code not in the known ISO set is rejected with a plain reason",
    );

    assert.equal(
      await getAccountCurrency(db, userId),
      DEFAULT_CURRENCY,
      "the unknown code was not stored — the person still reads the default",
    );
  } finally {
    await db.close();
  }
});

test("malformed codes are each rejected and never stored", async () => {
  const db = await freshDb();
  try {
    for (const bad of MALFORMED_CODES) {
      const userId = await makeUser(db, `ac2-malformed-${bad || "empty"}`);
      const result = await setAccountCurrency(db, { userId, currency: bad });
      assert.deepEqual(
        result,
        { ok: false, reason: "unknown_currency" },
        `the malformed code ${JSON.stringify(bad)} is rejected`,
      );
      assert.equal(
        await getAccountCurrency(db, userId),
        DEFAULT_CURRENCY,
        `the malformed code ${JSON.stringify(bad)} was not stored`,
      );
    }
  } finally {
    await db.close();
  }
});

test("rejecting an unknown code leaves a previously saved valid code untouched (not cleared)", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac2-keeps");

    await setAccountCurrency(db, { userId, currency: "GBP" });
    const rejected = await setAccountCurrency(db, { userId, currency: UNKNOWN_CODE });
    assert.deepEqual(rejected, { ok: false, reason: "unknown_currency" }, "the unknown code is rejected");

    assert.equal(
      await getAccountCurrency(db, userId),
      "GBP",
      "the earlier valid code survives the rejected set (it was neither overwritten nor cleared)",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — ownership: one person's account currency never leaks to or overwrites another's.
// The user id is bound from the session, never the client.
// ===========================================================================

test("one person's account currency never changes another person's read", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "own-alice");
    const bob = await makeUser(db, "own-bob");

    await setAccountCurrency(db, { userId: alice, currency: "USD" });

    // Bob has set nothing: he reads the default, never Alice's code.
    assert.equal(await getAccountCurrency(db, bob), DEFAULT_CURRENCY, "Bob reads AUD (the default), not Alice's USD");

    // Bob sets his own; Alice's is untouched.
    await setAccountCurrency(db, { userId: bob, currency: "EUR" });
    assert.equal(await getAccountCurrency(db, alice), "USD", "Alice's code is untouched by Bob's set");
    assert.equal(await getAccountCurrency(db, bob), "EUR", "Bob reads his own code");
  } finally {
    await db.close();
  }
});

test("getAccountCurrency binds the member-scope user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "p'); DROP TABLE account_currency; --";

  // The recording db returns no rows, so a read yields the default carrying no leaked SQL
  // — but whatever statement it issued must have BOUND the id.
  const currency = await getAccountCurrency(db, probe);
  assert.equal(currency, DEFAULT_CURRENCY, "no row → the default (AUD) is assembled");
  assertBoundNotSpliced(db, probe);
});

test("setAccountCurrency binds the user id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "u'); DROP TABLE account_currency; --";

  // A valid currency, so the write path runs and the probe user id is bound into it.
  const result = await setAccountCurrency(db, { userId: probe, currency: "USD" });
  assert.equal(result.ok, true, "a valid code is accepted; the result is assembled from inputs");
  assertBoundNotSpliced(db, probe);
});

test("setAccountCurrency binds the currency as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();

  await setAccountCurrency(db, { userId: "session-user", currency: "USD" });

  assert.ok(
    db.calls.some((c) => c.values.includes("USD")),
    "the currency code travels as a bound value",
  );
  for (const call of db.calls) {
    assert.ok(!call.text.includes("'USD'"), "the currency is bound, never concatenated into the SQL");
  }
});

// ===========================================================================
// AC4 — a SQL-injection probe is bound (user id) or rejected by validation (currency);
// the account_currency table survives either way.
// ===========================================================================

test("a SQL-injection probe in the user id is bound, never run: the account_currency table survives", async () => {
  const db = await freshDb();
  try {
    const probe = "u'); DROP TABLE account_currency; --";

    // Reading with a probe user id binds it as a parameter; it never executes as SQL.
    // (A non-uuid value may error on the cast or simply match nothing — either way the
    // statement is a bound read, so the table must still be there afterwards.)
    try {
      await getAccountCurrency(db, probe);
    } catch {
      /* tolerate a type/cast error — the point is that no injected statement ran */
    }

    assert.equal(
      await tableExists(db, "account_currency"),
      true,
      "the account_currency table must still exist (the probe was bound, never executed as SQL)",
    );
  } finally {
    await db.close();
  }
});

test("a SQL-injection probe in the currency field is rejected by validation and stores nothing", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac4-currency-probe");
    const probe = "AUD'); DROP TABLE account_currency; --";

    const result = await setAccountCurrency(db, { userId, currency: probe });
    assert.deepEqual(
      result,
      { ok: false, reason: "unknown_currency" },
      "an injection-shaped currency is not a known ISO code, so it is rejected",
    );

    assert.equal(await tableExists(db, "account_currency"), true, "the account_currency table must still exist");
    assert.equal(
      await getAccountCurrency(db, userId),
      DEFAULT_CURRENCY,
      "the injection-shaped currency was not stored",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC5 — the repo reads no process.env: a decoy secret in the environment never lands in
// the stored or returned currency.
// ===========================================================================

test("the repo reads no process.env: a decoy secret in the environment never lands in the currency", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "ac5-env");
    const saved = await setAccountCurrency(db, { userId, currency: "USD" });
    assert.equal(saved.ok, true, "the set reads and writes purely from the injected db + inputs — no app env needed");

    const currency = await getAccountCurrency(db, userId);
    assert.equal(currency, "USD", "the stored code reads back — no ambient env value is substituted");
    assert.ok(
      !JSON.stringify(currency).includes(DECOY) && !JSON.stringify(saved).includes(DECOY),
      "no ambient env value is folded into the stored or returned currency",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly — the
    // same value could legitimately live elsewhere if it were a real datum, which it is not).
    const all = await db.query("SELECT * FROM account_currency");
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
// AC3 / AC4 — a handler on the validation boundary. A route handler validates external
// input HERE (`parseBody`), then calls this task's parameterized data-access with the
// SESSION's user id (NEVER a body value). A rejected input maps to a 4xx Response and
// never reaches a query; an unknown code from the repo also maps to a 4xx. This handler
// is a test fixture that EXERCISES the modules — it is not an implementation file.
// ===========================================================================

function setAccountCurrencyHandler(
  db: Db,
  sessionUserId: string,
): (req: Request) => Promise<Response> {
  // The body carries only the chosen code; the user id comes from the session, never the
  // body. The `max` is generous enough that an injection-shaped value can still REACH the
  // repo (to prove it is validated/bound there), yet an absurdly long value is rejected
  // at the boundary. The repo remains the one source of truth for which codes are valid.
  const schema = z.object({
    currency: z.string().max(64),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const result = await setAccountCurrency(db, {
        userId: sessionUserId,
        currency: body.currency,
      });
      if (!result.ok) {
        return new Response(JSON.stringify({ error: result.reason }), { status: 400 });
      }
      return new Response(JSON.stringify({ currency: result.currency }), { status: 200 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a test
      // sees the raw-500 failure rather than a masked success.
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/api/account-currency", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = setAccountCurrencyHandler(db, "session-user");

  const res = await handler(jsonRequest("{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = setAccountCurrencyHandler(db, "session-user");

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(jsonRequest(JSON.stringify({ currency: "USD", junk: "x".repeat(10 * 1024) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the handler rejects a body missing the currency field with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = setAccountCurrencyHandler(db, "session-user");

  const res = await handler(jsonRequest(JSON.stringify({})));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the handler rejects a mis-typed currency with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = setAccountCurrencyHandler(db, "session-user");

  // currency must be a string — a number is a schema violation, rejected before any query.
  const res = await handler(jsonRequest(JSON.stringify({ currency: 42 })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the handler rejects an over-long currency string with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = setAccountCurrencyHandler(db, "session-user");

  // A 100-char value violates the boundary's length cap before any query runs.
  const res = await handler(jsonRequest(JSON.stringify({ currency: "A".repeat(100) })));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an over-long currency must never reach a query");
});

test("the handler rejects an unknown currency with a 4xx and stores nothing", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-unknown");
    const handler = setAccountCurrencyHandler(db, userId);

    const res = await handler(jsonRequest(JSON.stringify({ currency: UNKNOWN_CODE })));
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx for an unknown code, got ${res.status}`);

    assert.equal(
      await getAccountCurrency(db, userId),
      DEFAULT_CURRENCY,
      "an unknown code rejected by the repo stores nothing — the person still reads the default",
    );
  } finally {
    await db.close();
  }
});

test("the handler accepts a well-formed body and persists it for the SESSION user", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-ok");
    const handler = setAccountCurrencyHandler(db, userId);

    const res = await handler(jsonRequest(JSON.stringify({ currency: "JPY" })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal(await getAccountCurrency(db, userId), "JPY", "the submitted code is persisted for the session user");
  } finally {
    await db.close();
  }
});

test("the handler takes the user id from the session, not the body (no cross-user write)", async () => {
  const db = await freshDb();
  try {
    const sessionUser = await makeUser(db, "handler-session");
    const attacker = await makeUser(db, "handler-attacker");
    const handler = setAccountCurrencyHandler(db, sessionUser);

    // The body smuggles a userId; the handler must ignore it and use the session's.
    const res = await handler(jsonRequest(JSON.stringify({ userId: attacker, currency: "EUR" })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);

    assert.equal(await getAccountCurrency(db, sessionUser), "EUR", "the set landed on the SESSION user");
    assert.equal(
      await getAccountCurrency(db, attacker),
      DEFAULT_CURRENCY,
      "and never under the user id smuggled in the body (the attacker still reads the default)",
    );
  } finally {
    await db.close();
  }
});

test("the handler cannot be SQL-injected via the currency field: the account_currency table survives", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "handler-probe");
    const handler = setAccountCurrencyHandler(db, userId);
    const probe = "AUD'); DROP TABLE account_currency; --";

    const res = await handler(jsonRequest(JSON.stringify({ currency: probe })));

    // The injection-shaped value is not a known ISO code, so it is rejected (never run).
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx for the probe, got ${res.status}`);
    assert.equal(await tableExists(db, "account_currency"), true, "the account_currency table must still exist");
    assert.equal(await getAccountCurrency(db, userId), DEFAULT_CURRENCY, "nothing was stored for the probe");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Migration — the table applies and a second run changes nothing.
// ===========================================================================

test("the account_currency migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "account_currency"),
      true,
      "the account_currency table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0037_account_currency"),
      "db/migrations/0037_account_currency.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0037's CREATE would throw "already exists", so an empty result AND no
    // throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});

// Keep the documentary input type referenced so a drift in its name is noticed at
// authoring time (the import is erased at runtime; this never executes).
export type __AccountCurrencyInputAnchor = SetAccountCurrencyInput;
