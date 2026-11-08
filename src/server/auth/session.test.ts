// E04-S01 — Sessions data-access and cookie (`src/server/auth/session.ts`,
// `db/migrations/0004_sessions.sql`).
//
// RED-first: neither the session module nor the migration exists yet, so importing
// `./session` throws and `freshDb()` has no `sessions` table — every test here fails
// until the builder adds them. That absence IS the point of test-first; do not
// implement anything to make these pass.
//
// These tests pin BEHAVIOUR (what create/verify/step-up DO, and what the migration
// produces), never the source text of the module or the SQL file — a later rename
// that preserves behaviour must not redden them.
//
// The contract this task defines (design §5; the builder implements exactly this):
//
//   createSession(db, userId, { clock, random }): Promise<CreatedSession>
//     • draws a random 256-bit id from the `random` seam, stores it HASHED (the raw
//       id is never persisted in plaintext), anchors created_at AND last_seen_at at
//       clock.now(), and leaves stepped_up_at unset.
//     • returns { session, token, cookie } where:
//         session = { id, userId, createdAt, lastSeenAt, steppedUpAt: Date | null }
//         token   = the exact string placed in the cookie (the raw id, to the client)
//         cookie  = the Set-Cookie header value — name `__Host-wh_session`, value the
//                   token, flags HttpOnly + Secure + SameSite=Lax + Path=/ and NO
//                   Domain (a `__Host-` cookie must be host-locked).
//
//   verifySession(db, token, { clock }): Promise<Session | null>
//     • hashes the presented token, finds the matching session, and returns it only
//       when it is within BOTH the 14-day idle window (now - last_seen_at) AND the
//       30-day absolute window (now - created_at); a successful verify slides the
//       idle timer (last_seen_at = now). An unknown, tampered, malformed or expired
//       token yields null (never a throw).
//
//   recordStepUp(db, sessionId, { clock }): Promise<Session>
//     • stores stepped_up_at = clock.now() on the session and returns it, so a later
//       verify surfaces the step-up timestamp.
//
// Acceptance criteria → tests:
//   AC1 "Creates a session with a random 256-bit id stored hashed in a
//        __Host-wh_session cookie (HttpOnly, Secure, SameSite=Lax)." — createSession:
//        the id draw is 32 bytes (256-bit); the cookie carries the raw token with the
//        required name/flags and is host-locked; the raw token is never stored in
//        plaintext yet it verifies (so it is stored hashed); distinct sessions get
//        distinct tokens.
//   AC2 "Verifies 14-day idle and 30-day absolute expiry and stores stepped_up_at; an
//        unknown or expired cookie yields no session." — verifySession returns the
//        stored session for a valid token; a session idle > 14 days or older than the
//        30-day absolute cap yields null; recent activity slides the idle timer;
//        unknown/tampered/malformed tokens yield null; recordStepUp stores the
//        timestamp and verify surfaces it.
//   INV-102 "parameterize every query." — a SQL-injection probe routed through
//        verifySession travels as a bound value: it cannot drop the sessions table,
//        and it is never concatenated into the statement text.
//   Migration: 0004_sessions applies, the `sessions` relation exists, and a second
//        run of every migration changes nothing (idempotent).
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state. Tests never touch the network or Azure.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createSession, verifySession, recordStepUp } from "./session";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "../db/index";
import { systemRandom, type Random } from "../seams/random";
import type { Clock } from "../seams/clock";

const SECOND_MS = 1000;
const DAY_MS = 24 * 60 * 60 * SECOND_MS;
const T0 = new Date("2026-02-01T00:00:00.000Z");

// A clock whose "now" the test controls, so idle/absolute windows are exercised
// deterministically with no wall-clock dependence (same shape as jobs.test.ts).
function mutableClock(start: Date): { clock: Clock; advance(ms: number): void } {
  let current = start.getTime();
  return {
    clock: {
      now(): Date {
        return new Date(current);
      },
    },
    advance(ms: number): void {
      current += ms;
    },
  };
}

// A random seam that records how many bytes each draw asked for (to prove the id is
// 256-bit) and returns distinct bytes per draw (so successive sessions get distinct
// tokens). The byte values are irrelevant to the round-trip — create stores a hash
// of the token string and verify re-hashes the same string.
function countingRandom(): { random: Random; draws: number[] } {
  const draws: number[] = [];
  let call = 0;
  return {
    random: {
      randomBytes(n: number): Uint8Array {
        draws.push(n);
        const out = new Uint8Array(n);
        for (let i = 0; i < n; i += 1) out[i] = (call * 101 + i * 31 + 7) & 0xff;
        call += 1;
        return out;
      },
    },
    draws,
  };
}

// A db seam stand-in that records every call instead of running it, so a test can
// prove HOW a value reached the query layer (bound vs. spliced). It returns no rows,
// which is all verifySession needs to yield null. Satisfies the `Db` shape.
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
// the relation name when it exists and NULL otherwise — a non-throwing probe scoped
// to the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Create a person row and return its id (the session's userId). Sessions hang off a
// real user, so every real-db test makes one first.
async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return user.id;
}

// Compare two instants with a small tolerance (timestamptz round-trips at ms
// precision; the fixed clock has none, so this is generous, not loose).
function sameInstant(actual: unknown, expected: Date, msg: string): void {
  assert.ok(actual instanceof Date, `${msg}: expected a Date`);
  assert.ok(
    Math.abs((actual as Date).getTime() - expected.getTime()) <= SECOND_MS,
    `${msg}: ${(actual as Date).toISOString()} ≉ ${expected.toISOString()}`,
  );
}

// Parse a Set-Cookie header value into its name, value, flags and attributes.
// Cookie attribute names are case-insensitive, so flags/attrs are lower-cased; the
// cookie NAME and VALUE are kept verbatim (they are case-sensitive).
function parseSetCookie(header: string): {
  name: string;
  value: string;
  flags: Set<string>;
  attrs: Map<string, string>;
} {
  const parts = header.split(";").map((p) => p.trim()).filter((p) => p.length > 0);
  const first = parts[0] ?? "";
  const eq = first.indexOf("=");
  assert.ok(eq > 0, "the Set-Cookie header must start with name=value");
  const name = first.slice(0, eq);
  const value = first.slice(eq + 1);
  const flags = new Set<string>();
  const attrs = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const i = part.indexOf("=");
    if (i === -1) flags.add(part.toLowerCase());
    else attrs.set(part.slice(0, i).toLowerCase(), part.slice(i + 1));
  }
  return { name, value, flags, attrs };
}

// =====================================================================================
// AC1 — createSession: a random 256-bit id, stored hashed, in a __Host- cookie.
// =====================================================================================

test("createSession returns a session for the user, anchored to the clock, with no step-up yet", async () => {
  const { clock } = mutableClock(T0);
  const { random } = countingRandom();
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "alice");

    const created = await createSession(db, userId, { clock, random });

    assert.equal(typeof created.session.id, "string", "a created session carries a string id");
    assert.ok(created.session.id.length > 0, "the session id must be non-empty");
    assert.equal(created.session.userId, userId, "the session is bound to the user it was made for");
    sameInstant(created.session.createdAt, T0, "created_at is anchored to the clock");
    sameInstant(created.session.lastSeenAt, T0, "last_seen_at is anchored to the clock at creation");
    assert.equal(
      created.session.steppedUpAt,
      null,
      "a fresh session has no step-up timestamp yet",
    );
    assert.equal(typeof created.token, "string", "a created session yields a token string");
    assert.ok(created.token.length > 0, "the token must be non-empty");
  } finally {
    await db.close();
  }
});

test("createSession draws a 256-bit (32-byte) id from the random seam", async () => {
  const { clock } = mutableClock(T0);
  const counter = countingRandom();
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "bob");

    await createSession(db, userId, { clock, random: counter.random });

    assert.ok(
      counter.draws.includes(32),
      `the session id must be a 256-bit (32-byte) draw; draws were [${counter.draws.join(", ")}]`,
    );
  } finally {
    await db.close();
  }
});

test("createSession issues a __Host-wh_session cookie: HttpOnly, Secure, SameSite=Lax, Path=/ and host-locked", async () => {
  const { clock } = mutableClock(T0);
  const { random } = countingRandom();
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "carol");

    const created = await createSession(db, userId, { clock, random });
    const cookie = parseSetCookie(created.cookie);

    assert.equal(cookie.name, "__Host-wh_session", "the cookie is named __Host-wh_session");
    assert.equal(cookie.value, created.token, "the cookie carries the raw token value");
    assert.ok(cookie.flags.has("httponly"), "the cookie must be HttpOnly (no script access)");
    assert.ok(cookie.flags.has("secure"), "the cookie must be Secure (HTTPS only)");
    assert.equal(
      cookie.attrs.get("samesite")?.toLowerCase(),
      "lax",
      "the cookie must be SameSite=Lax",
    );
    assert.equal(cookie.attrs.get("path"), "/", "a __Host- cookie must have Path=/");
    assert.ok(
      !cookie.attrs.has("domain"),
      "a __Host- cookie must NOT carry a Domain (it is host-locked)",
    );
  } finally {
    await db.close();
  }
});

test("the cookie token verifies the session: it maps back to the stored session for its user", async () => {
  const { clock } = mutableClock(T0);
  const { random } = countingRandom();
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "dave");
    const created = await createSession(db, userId, { clock, random });

    const verified = await verifySession(db, created.token, { clock });

    assert.ok(verified != null, "the token from the cookie must verify immediately after creation");
    assert.equal(verified?.id, created.session.id, "verification returns the same session row");
    assert.equal(verified?.userId, userId, "verification carries the session's user id");
  } finally {
    await db.close();
  }
});

test("the session id is stored hashed: the raw token is never persisted in plaintext, yet it verifies", async () => {
  const { clock } = mutableClock(T0);
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "erin");
    // A real-entropy token so it cannot coincidentally appear in any other column.
    const created = await createSession(db, userId, { clock, random: systemRandom });

    // Every byte the sessions table holds, serialised. The raw token must not be in
    // it — only a one-way hash of the token may be stored (design §5: "stored hashed";
    // project rule: "session ids are stored only as hashes").
    const stored = await db.query("SELECT * FROM sessions");
    const dump = JSON.stringify(stored.rows);
    assert.ok(
      !dump.includes(created.token),
      "the raw session token must never be stored in plaintext",
    );

    // ...and yet the raw token still verifies — proving the stored form is a hash the
    // presented token reproduces, not the token itself.
    const verified = await verifySession(db, created.token, { clock });
    assert.ok(verified != null, "the raw token verifies against its stored hash");
    assert.equal(verified?.userId, userId, "the verified session belongs to the right user");
  } finally {
    await db.close();
  }
});

test("two sessions get distinct tokens and distinct session ids", async () => {
  const { clock } = mutableClock(T0);
  const counter = countingRandom();
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "frank");

    const one = await createSession(db, userId, { clock, random: counter.random });
    const two = await createSession(db, userId, { clock, random: counter.random });

    assert.notEqual(one.token, two.token, "each session gets its own random token");
    assert.notEqual(one.session.id, two.session.id, "each session is a distinct row");

    // Each token resolves to its own session, never the other's.
    assert.equal((await verifySession(db, one.token, { clock }))?.id, one.session.id);
    assert.equal((await verifySession(db, two.token, { clock }))?.id, two.session.id);
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — verifySession: idle + absolute expiry, ownership, unknown/expired → null.
// =====================================================================================

test("verifySession returns the right user's session, never another user's", async () => {
  const { clock } = mutableClock(T0);
  const { random } = countingRandom();
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "owner-a");
    const bob = await makeUser(db, "owner-b");
    const aSession = await createSession(db, alice, { clock, random });
    const bSession = await createSession(db, bob, { clock, random });

    const asA = await verifySession(db, aSession.token, { clock });
    assert.equal(asA?.userId, alice, "A's token resolves to A's session");
    assert.notEqual(asA?.userId, bob, "A's token must never resolve to B");

    const asB = await verifySession(db, bSession.token, { clock });
    assert.equal(asB?.userId, bob, "B's token resolves to B's session, independently");
  } finally {
    await db.close();
  }
});

test("a session idle beyond 14 days yields no session", async () => {
  const c = mutableClock(T0);
  const { random } = countingRandom();
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "idle");
    const created = await createSession(db, userId, { clock: c.clock, random });

    // Well within the idle window: still valid.
    c.advance(13 * DAY_MS);
    assert.ok(
      (await verifySession(db, created.token, { clock: c.clock })) != null,
      "a session touched within 14 days is still valid",
    );

    // No activity for another 15 days (last touched at +13d): idle window exceeded.
    c.advance(15 * DAY_MS); // now +28d; last_seen was +13d → 15 days idle
    assert.equal(
      await verifySession(db, created.token, { clock: c.clock }),
      null,
      "a session idle for more than 14 days yields no session",
    );
  } finally {
    await db.close();
  }
});

test("activity within the idle window slides the idle timer", async () => {
  const c = mutableClock(T0);
  const { random } = countingRandom();
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "active");
    const created = await createSession(db, userId, { clock: c.clock, random });

    // Touch at +10 days: within idle, so it verifies AND resets last_seen_at to +10d.
    c.advance(10 * DAY_MS);
    assert.ok(
      (await verifySession(db, created.token, { clock: c.clock })) != null,
      "the session verifies at +10 days",
    );

    // Touch again at +20 days: only 10 days since the last touch, so still valid —
    // which can only be true if the first verify slid the idle timer forward (without
    // a slide, +20 days from creation would exceed the 14-day idle window).
    c.advance(10 * DAY_MS);
    assert.ok(
      (await verifySession(db, created.token, { clock: c.clock })) != null,
      "activity within the window keeps the session alive (the idle timer slid forward)",
    );
  } finally {
    await db.close();
  }
});

test("a session past the 30-day absolute cap yields no session even with recent activity", async () => {
  const c = mutableClock(T0);
  const { random } = countingRandom();
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "aged");
    const created = await createSession(db, userId, { clock: c.clock, random });

    // Keep the session continuously active so idle never trips — only the absolute
    // 30-day cap (measured from creation) can end it.
    c.advance(13 * DAY_MS);
    assert.ok((await verifySession(db, created.token, { clock: c.clock })) != null, "+13d: alive");
    c.advance(13 * DAY_MS); // +26d, 13 days since last touch (< 14) and < 30 absolute
    assert.ok((await verifySession(db, created.token, { clock: c.clock })) != null, "+26d: alive");

    // +31 days from creation: only 5 days since the last touch (idle is fine), but the
    // 30-day absolute cap is exceeded — so the session must end regardless of activity.
    c.advance(5 * DAY_MS); // +31d
    assert.equal(
      await verifySession(db, created.token, { clock: c.clock }),
      null,
      "beyond 30 days from creation the session ends even though it was recently active",
    );
  } finally {
    await db.close();
  }
});

test("an unknown token yields no session", async () => {
  const { clock } = mutableClock(T0);
  const { random } = countingRandom();
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "known");
    await createSession(db, userId, { clock, random });

    // A token that was never issued (correctly shaped, 32 random bytes as hex).
    const neverIssued = Buffer.from(systemRandom.randomBytes(32)).toString("hex");
    assert.equal(
      await verifySession(db, neverIssued, { clock }),
      null,
      "a token that matches no stored session yields null",
    );
  } finally {
    await db.close();
  }
});

test("a tampered token yields no session", async () => {
  const { clock } = mutableClock(T0);
  const { random } = countingRandom();
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "tamper");
    const created = await createSession(db, userId, { clock, random });

    // Flip one character of the issued token: same shape, different value.
    const mid = Math.floor(created.token.length / 2);
    const swap = created.token[mid] === "a" ? "b" : "a";
    const tampered = created.token.slice(0, mid) + swap + created.token.slice(mid + 1);
    assert.notEqual(tampered, created.token, "the tampered token differs from the issued one");

    assert.equal(
      await verifySession(db, tampered, { clock }),
      null,
      "a token that is not exactly the issued one does not verify",
    );
  } finally {
    await db.close();
  }
});

test("an empty or malformed token yields null, never a throw", async () => {
  const { clock } = mutableClock(T0);
  const db = await freshDb();
  try {
    assert.equal(await verifySession(db, "", { clock }), null, "an empty token yields null");
    assert.equal(
      await verifySession(db, "not-a-real-token", { clock }),
      null,
      "a malformed token yields null rather than crashing verification",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — stepped_up_at is stored and surfaced on verification.
// =====================================================================================

test("recordStepUp stores stepped_up_at and a later verify surfaces it", async () => {
  const c = mutableClock(T0);
  const { random } = countingRandom();
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "stepper");
    const created = await createSession(db, userId, { clock: c.clock, random });
    assert.equal(created.session.steppedUpAt, null, "a fresh session has no step-up timestamp");

    // The person re-authenticates an hour in: the step-up time is recorded.
    c.advance(60 * 60 * SECOND_MS);
    const stepUpAt = c.clock.now();
    const stepped = await recordStepUp(db, created.session.id, { clock: c.clock });
    sameInstant(stepped.steppedUpAt, stepUpAt, "recordStepUp returns the session with the step-up time");

    // A later verify (still within both windows) surfaces the PERSISTED step-up time,
    // not the time of the verify.
    c.advance(60 * 60 * SECOND_MS);
    const verified = await verifySession(db, created.token, { clock: c.clock });
    assert.ok(verified != null, "the session still verifies after a step-up");
    sameInstant(verified?.steppedUpAt, stepUpAt, "verify surfaces the stored step-up timestamp");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// INV-102 — parameterize every query (a probe cannot alter a query).
// =====================================================================================

test("verifySession binds its token as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "zzz'; DROP TABLE sessions; --";

  const result = await verifySession(db, probe, { clock: mutableClock(T0).clock });

  assert.equal(result, null, "no row matches (the recording db returns none)");
  assert.ok(db.calls.length >= 1, "verification issues at least one query");
  for (const call of db.calls) {
    assert.ok(
      !call.text.includes(probe),
      "the token value is bound, never concatenated into the SQL text",
    );
    assert.ok(
      !call.text.includes("DROP TABLE"),
      "no injected statement appears in the SQL text",
    );
  }
  assert.ok(
    db.calls.some((call) => /\$\d/.test(call.text)),
    "verification uses a bound placeholder, not an inlined value",
  );
});

test("a SQL-injection probe passed to verifySession cannot drop the sessions table", async () => {
  const { clock } = mutableClock(T0);
  const { random } = countingRandom();
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "probe");
    const created = await createSession(db, userId, { clock, random });

    const probe = "robert'); DROP TABLE sessions; --";
    assert.equal(
      await verifySession(db, probe, { clock }),
      null,
      "the probe matches no session (it was bound as data, not interpreted)",
    );

    // The table survived and the genuine session still verifies.
    assert.equal(await tableExists(db, "sessions"), true, "the sessions table must still exist");
    assert.equal(
      (await verifySession(db, created.token, { clock }))?.id,
      created.session.id,
      "the real session is unaffected by the probe",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Migration — 0004_sessions applies and a second run changes nothing.
// =====================================================================================

test("the sessions migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    // 0004_sessions applied: the `sessions` relation exists (a non-throwing existence
    // probe scoped to the one table under test — behaviour, not source text).
    assert.equal(
      await tableExists(db, "sessions"),
      true,
      "the sessions table must exist after the project migrations",
    );

    // The project migration set includes the sessions migration (its recorded name is
    // the task's named deliverable, stable once applied).
    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0004_sessions"),
      "db/migrations/0004_sessions.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0004's CREATE would throw "already exists", so an empty result AND
    // no throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});

// Review (unverified, low) — the cookie must outlive the browser session: without
// Max-Age it is a session cookie, dropped when the browser (or an installed iOS web app)
// closes, long before the 14-day idle / 30-day absolute windows the server enforces.
test("the session cookie persists for the 30-day absolute window (Max-Age)", async () => {
  const { clock } = mutableClock(T0);
  const { random } = countingRandom();
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "erin");
    const created = await createSession(db, userId, { clock, random });
    const cookie = parseSetCookie(created.cookie);
    assert.equal(cookie.attrs.get("max-age"), String(30 * 24 * 60 * 60), "Max-Age is the absolute window");
  } finally {
    await db.close();
  }
});
