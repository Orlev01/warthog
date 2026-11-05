// E12-S05 — Single-use approval-link store (`src/server/db/approval-links.ts`,
// `db/migrations/0028_approval_links.sql`).
//
// RED-first: neither the data-access module nor the migration exists yet, so
// importing `./approval-links` throws and `freshDb()` has no `approval_links`
// table — every test here fails until the builder adds them. That absence IS the
// point of test-first; do NOT implement anything to make these pass — the builder
// writes the module and the migration afterwards.
//
// These tests pin BEHAVIOUR (what the functions DO: a raw token issued once and
// returned only to the issuer, stored only as a hash with a 10-minute expiry bound
// to ONE approval; a token that redeems to its approval id exactly once and is
// rejected thereafter; that an expired or unknown token is rejected; that the raw
// token never reaches the query layer or a stored column; that every value is bound
// as a parameter; that the repo reads no secret from the environment), never the
// source text of the module or the SQL file — a later rename that preserves
// behaviour must not redden them.
//
// WHY this exists (design §10 Notifications / SMS-email fallback; brief "SMS
// fallback"): when an approval is still unopened at `created_at + fallback_delay`,
// the fallback job sends ONE SMS and ONE email carrying a single-use link that opens
// the approval after sign-in. That link carries a token — a CREDENTIAL — so (project
// rule: tokens and link tokens are stored only as hashes, SHA-256 or HMAC; the
// design fixes this one at a 256-bit value stored as a hash, like every other opaque
// Warthog token) the store keeps only the token's hash, never the raw value. The raw
// token is returned exactly once, to the issuer, for the single message that
// delivers it; it appears in clear nowhere else. Redeeming resolves the token to the
// one approval it is bound to, returns that approval id ONCE, then marks the token
// used — a second presentation, an expired token or an unknown token is rejected.
//
// Unlike the member-scoped stores, this one is CREDENTIAL-KEYED (like `oauth_tokens`
// / access keys): a row is addressed by its token hash and bound to one approval id,
// not a `user_id`. The person who clicks the link signs in first; the member-scope
// check (does this approval belong to the session user?) happens a layer up, when the
// resolved approval is loaded through the member-scoped approvals store — not here.
// So there is no `userId` in this store, and no per-user ownership test here.
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   interface IssueApprovalLinkInput {
//     approvalId: string;   // the approval this single-use link opens (bound to ONE)
//   }
//
//   interface IssueApprovalLinkDeps {
//     clock: Clock;     // the issue instant; expiresAt = now + 10 minutes (never Date.now())
//     random: Random;   // entropy for the 256-bit token (INJECTED, not baked in)
//   }
//
//   interface IssuedApprovalLink {
//     token: string;            // the RAW token — returned ONLY here (for the message),
//                               //   never stored; URL-safe (it rides in a link)
//     approvalId: string;       // the approval the token is bound to
//     expiresAt: Date | string; // issue instant + 10 minutes
//     createdAt: Date | string; // the injected clock's issue instant
//   }
//
//   interface RedeemApprovalLinkInput {
//     token: string;   // the raw token the person presents (from the link in the message)
//   }
//
//   interface RedeemApprovalLinkDeps {
//     clock: Clock;    // the redeem instant, for the expiry + single-use check (never Date.now())
//   }
//
//   type RedeemLinkResult =
//     | { ok: true; approvalId: string }     // first redemption of a live token
//     | { ok: false; reason: "invalid" }     // unknown token, or one already used (indistinguishable)
//     | { ok: false; reason: "expired" };    // the token lapsed before it was redeemed
//
//   issueApprovalLink(db, input: IssueApprovalLinkInput, deps): Promise<IssuedApprovalLink>
//     • draws a 256-bit token, stores ONLY its hash with a ten-minute expiry bound to
//       `approvalId`, and returns the IssuedApprovalLink carrying the RAW token (for
//       the single message that delivers it). Assembles the returned value from its
//       inputs (it does not depend on a RETURNING read). The raw token is stored in
//       no column and returned to no other caller.
//   redeemApprovalLink(db, input: RedeemApprovalLinkInput, deps): Promise<RedeemLinkResult>
//     • matches the token by its hash (the raw token never reaches the query layer as
//       a bound value): a live, unexpired, unused token returns { ok: true, approvalId }
//       and is marked used; a SECOND presentation returns { ok: false, reason: "invalid" };
//       a token presented past its expiry returns { ok: false, reason: "expired" } and
//       is NOT consumed; an unknown token returns { ok: false, reason: "invalid" }.
//
// Acceptance criteria → tests:
//   AC1 "Issuing a link stores only the token's hash with a 10-minute expiry bound to
//        one approval, and redeeming returns the approval id once then marks it used."
//        — issue returns a raw token + an expiry exactly ten minutes after issue; the
//        token redeems to its approval id once; a second redemption of the same token
//        is rejected; two links for two approvals each redeem to their own approval.
//   AC2 "A reused, expired or unknown token is rejected, and the raw token is returned
//        only to the issuer (for the message), never stored in clear." — reused →
//        invalid; expired → expired (and not consumed); unknown → invalid; the raw
//        token appears in no column of approval_links and in no redeem result.
//   AC3 [obligation:validate-and-parameterize-input] (INV-102) — a handler on the
//        `../http/validate` boundary rejects malformed / oversized / missing /
//        mis-typed / mis-shaped input with a 4xx before any query runs; and a
//        SQL-injection probe routed through the repo travels bound (the approval id
//        as a parameter; the token hashed, never spliced) and cannot drop the table.
//        The handler below is a test fixture (the intended usage), not an
//        implementation file.
//   AC4 [obligation:secrets-from-env] (INV-103) — the token is drawn from the INJECTED
//        randomness seam, not a constant baked into source: different entropy yields a
//        different token. The repo takes db / clock / random as dependencies, reads no
//        `process.env` and holds no secret, so a decoy secret planted in the
//        environment never lands in the issued, stored or redeemed link.
//   Migration: the `approval_links` relation exists after the project migrations and a
//        second run of every migration changes nothing.
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// real-db test uses its own `freshDb()` (an isolated in-memory PGlite with the real
// migrations), so tests share no state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { issueApprovalLink, redeemApprovalLink } from "./approval-links";
// Documentary type anchors — the exact names/shapes the implementation exports.
// Erased at runtime (and test files are excluded from `tsc`), so a rename cannot
// break these tests; the runtime assertions below are what actually gate behaviour.
import type {
  IssueApprovalLinkInput,
  IssueApprovalLinkDeps,
  IssuedApprovalLink,
  RedeemApprovalLinkInput,
  RedeemApprovalLinkDeps,
  RedeemLinkResult,
} from "./approval-links";
import { createUser } from "./users";
import { createApproval } from "./approvals";
import { freshDb } from "../../test/db";
import { loadMigrations, runMigrations, type Db } from "./index";
import { fixedClock, type Clock } from "../seams/clock";
import { systemRandom, fixedRandom, type Random } from "../seams/random";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ---------------------------------------------------------------------

const MINUTE_MS = 60_000;
const TEN_MINUTES_MS = 10 * MINUTE_MS; // the single-use link's expiry window (design §10)

// Compare the moment, not the representation: createdAt / expiresAt may come back as a
// Date or an ISO string — either is a reasonable choice and must not redden a test.
const ms = (value: Date | string | number): number => new Date(value as never).getTime();

// T0 is the issue instant; WITHIN redeems well inside the ten-minute window; JUST_AFTER
// is one millisecond past it; LONG_AFTER is a year later (past any reasonable expiry).
const T0 = new Date("2026-02-01T09:00:00.000Z");
const WITHIN = new Date(T0.getTime() + 5 * MINUTE_MS);
const JUST_AFTER = new Date(T0.getTime() + TEN_MINUTES_MS + 1);
const LONG_AFTER = new Date("2027-02-01T09:00:00.000Z");

// Agent connection ids are uuids; use a valid uuid so the `agent_id` column accepts it
// when seeding the approval this link is bound to.
const AGENT_A = "11111111-1111-1111-1111-111111111111";

// Default deps for issuing / redeeming. A fixed clock pins the expiry window
// deterministically; the token is drawn from the injected randomness seam.
function issueDeps(over?: { clock?: Clock; random?: Random }): IssueApprovalLinkDeps {
  return {
    clock: over?.clock ?? fixedClock(T0),
    random: over?.random ?? systemRandom,
  };
}
function redeemDeps(over?: { clock?: Clock }): RedeemApprovalLinkDeps {
  return {
    clock: over?.clock ?? fixedClock(WITHIN),
  };
}

// Create a person and a PENDING approval for them, returning the approval's id (the
// FK target an issued link is bound to). The detail is DEK-encrypted by the approvals
// store; this link store never reads it.
async function makeApprovalId(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  const approval = await createApproval(
    db,
    {
      userId: user.id,
      agentId: AGENT_A,
      detail: { recipient: `r-${who}@example`, amount: "42.00 AUD", field: `field_${who}` },
    },
    randomBytes(32),
    fixedClock(T0),
  );
  return approval.id;
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

// Whether a relation of this exact name exists on this handle. `to_regclass` yields the
// relation name when it exists and NULL when it does not — a non-throwing probe scoped
// to the one table under test (behaviour, not source text).
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

// Assert a probe never appears in any SQL text (the token is hashed before it is bound,
// so it never reaches a statement as text OR as a raw value). The hashed form, not the
// raw probe, is what the query binds — so there is nothing to find in the text.
function assertNotSplicedIntoSql(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is never concatenated into the SQL text");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

// Assert a forbidden value (the raw token) never reached the query layer as any bound
// value — the token is hashed before it is bound, so the plaintext token appears in no
// parameter list.
function assertNeverBound(db: RecordingDb, forbidden: string): void {
  for (const call of db.calls) {
    for (const value of call.values) {
      assert.notEqual(value, forbidden, "the raw token must never reach the query layer as a bound value");
    }
  }
}

// ===========================================================================
// AC1 — issuing stores only a hash with a ten-minute expiry bound to ONE approval;
// the raw token redeems to that approval id exactly once, then is marked used.
// ===========================================================================

test("issueApprovalLink returns a raw token bound to the approval, with a ten-minute expiry", async () => {
  const db = await freshDb();
  try {
    const approvalId = await makeApprovalId(db, "ac1-issue");
    const issued: IssuedApprovalLink = await issueApprovalLink(db, { approvalId }, issueDeps());

    assert.equal(typeof issued.token, "string", "a raw token string is returned to the issuer");
    assert.ok(issued.token.length > 0, "the returned token is non-empty");
    assert.equal(issued.approvalId, approvalId, "the link is bound to the approval it was issued for");
    assert.equal(ms(issued.createdAt), ms(T0), "createdAt is the injected clock instant");
    assert.equal(
      ms(issued.expiresAt) - ms(issued.createdAt),
      TEN_MINUTES_MS,
      "the token expires exactly ten minutes after it is issued",
    );
  } finally {
    await db.close();
  }
});

test("the raw token redeems to its approval id exactly once", async () => {
  const db = await freshDb();
  try {
    const approvalId = await makeApprovalId(db, "ac1-redeem");
    const { token } = await issueApprovalLink(db, { approvalId }, issueDeps());

    const first: RedeemLinkResult = await redeemApprovalLink(db, { token }, redeemDeps());
    assert.deepEqual(first, { ok: true, approvalId }, "the first redemption resolves to the bound approval");

    const second: RedeemLinkResult = await redeemApprovalLink(db, { token }, redeemDeps());
    assert.deepEqual(
      second,
      { ok: false, reason: "invalid" },
      "a reused token is rejected — the link is single-use and was marked used on first redemption",
    );
  } finally {
    await db.close();
  }
});

test("a link is bound to ONE approval: two links each redeem only to their own approval", async () => {
  const db = await freshDb();
  try {
    const approvalA = await makeApprovalId(db, "ac1-bindA");
    const approvalB = await makeApprovalId(db, "ac1-bindB");
    const linkA = await issueApprovalLink(db, { approvalId: approvalA }, issueDeps());
    const linkB = await issueApprovalLink(db, { approvalId: approvalB }, issueDeps());

    assert.notEqual(linkA.token, linkB.token, "two issued links carry distinct tokens");

    assert.deepEqual(
      await redeemApprovalLink(db, { token: linkA.token }, redeemDeps()),
      { ok: true, approvalId: approvalA },
      "A's token opens A's approval, never B's",
    );
    assert.deepEqual(
      await redeemApprovalLink(db, { token: linkB.token }, redeemDeps()),
      { ok: true, approvalId: approvalB },
      "B's token opens B's approval",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC2 — a reused, expired or unknown token is rejected; the raw token is kept
// nowhere in clear.
// ===========================================================================

test("an expired token is rejected and is NOT consumed", async () => {
  const db = await freshDb();
  try {
    const approvalId = await makeApprovalId(db, "ac2-expired");
    const { token } = await issueApprovalLink(db, { approvalId }, issueDeps());

    // Present the correct token one millisecond past its ten-minute window.
    const justAfter: RedeemLinkResult = await redeemApprovalLink(
      db,
      { token },
      redeemDeps({ clock: fixedClock(JUST_AFTER) }),
    );
    assert.deepEqual(justAfter, { ok: false, reason: "expired" }, "a token past its window is rejected as expired");

    // ...and a year later it is still rejected, never silently valid again. (Whether a
    // lapsed token is reported "expired" or folded into "invalid" is the repo's choice;
    // what matters is it NEVER redeems — so assert only that it is rejected.)
    const longAfter: RedeemLinkResult = await redeemApprovalLink(
      db,
      { token },
      redeemDeps({ clock: fixedClock(LONG_AFTER) }),
    );
    assert.equal(longAfter.ok, false, "an expired token never redeems, no matter how late");
  } finally {
    await db.close();
  }
});

test("an unknown token is rejected as invalid", async () => {
  const db = await freshDb();
  try {
    // A well-formed but never-issued token (no link was issued against this db).
    await makeApprovalId(db, "ac2-unknown");
    const result: RedeemLinkResult = await redeemApprovalLink(
      db,
      { token: "A".repeat(43) },
      redeemDeps(),
    );
    assert.deepEqual(result, { ok: false, reason: "invalid" }, "a token matching no stored hash is invalid");
  } finally {
    await db.close();
  }
});

test("the raw token is never stored in the approval_links table (only a hash is kept)", async () => {
  const db = await freshDb();
  try {
    const approvalId = await makeApprovalId(db, "ac2-atrest");
    const { token } = await issueApprovalLink(db, { approvalId }, issueDeps());

    // Scan every cell of the one table under test. The token is a credential and must
    // live only as a hash, so its exact plaintext appearing in any column is a genuine
    // leak. Exact-equality (not substring) avoids a coincidental hex-digit overlap with
    // the stored hash, and the scan is scoped to `approval_links` alone.
    const all = await db.query("SELECT * FROM approval_links");
    assert.ok(all.rows.length >= 1, "the link row was stored");
    for (const row of all.rows) {
      for (const cell of Object.values(row)) {
        if (typeof cell === "string") {
          assert.notEqual(cell, token, "the plaintext token must never be written to a column");
        }
      }
    }
  } finally {
    await db.close();
  }
});

test("redeem returns the approval id but never echoes the raw token back", async () => {
  const db = await freshDb();
  try {
    const approvalId = await makeApprovalId(db, "ac2-noecho");
    const { token } = await issueApprovalLink(db, { approvalId }, issueDeps());

    const result: RedeemLinkResult = await redeemApprovalLink(db, { token }, redeemDeps());
    assert.equal(result.ok, true, "the token redeems");
    // The raw token is returned ONLY by the issuer; a redeem result carries the approval
    // id, never the token itself (exact-value scan, so a coincidental overlap can't trip it).
    assert.ok(
      !Object.values(result).some((v) => v === token),
      "the redeem result never carries the raw token",
    );
  } finally {
    await db.close();
  }
});

test("the raw token never reaches the query layer as a bound value when issuing", async () => {
  // A recording db captures every bound value; the token is hashed before it is stored,
  // so its plaintext must appear in no parameter list.
  const db = recordingDb();
  const issued = await issueApprovalLink(db, { approvalId: "some-approval" }, issueDeps());
  assertNeverBound(db, issued.token);
});

test("the raw token never reaches the query layer as a bound value when redeeming", async () => {
  const db = recordingDb();
  // The recording db returns no rows, so redeem matches nothing and reports invalid —
  // but whatever statement it issued must NOT have bound the raw token (only its hash).
  const token = "redeem-probe-token-0123456789abcdef";
  const result = await redeemApprovalLink(db, { token }, redeemDeps());
  assert.equal(result.ok, false, "no link matches on an empty recording db");
  assertNeverBound(db, token);
});

// ===========================================================================
// AC4 — the token is drawn from the INJECTED randomness seam, not a baked-in secret,
// and the repo reads no process.env.
// ===========================================================================

test("the token is drawn from the injected entropy, not a constant baked into source", async () => {
  const db = await freshDb();
  try {
    // Each issue targets its OWN approval, so the test stands whether or not the schema
    // allows more than one link per approval — it is about the TOKEN's entropy, not
    // re-issue. Distinct entropy values also guarantee distinct tokens (so distinct
    // stored hashes), never a primary-key collision.
    const [a, b, c, d] = await Promise.all([
      makeApprovalId(db, "ac4-ent-a"),
      makeApprovalId(db, "ac4-ent-b"),
      makeApprovalId(db, "ac4-ent-c"),
      makeApprovalId(db, "ac4-ent-d"),
    ]);

    // Different injected entropy must yield a different token — so the token is a
    // function of the injected randomness, not a hard-coded secret in the source.
    const t1 = (await issueApprovalLink(db, { approvalId: a! }, issueDeps({ random: fixedRandom(1) }))).token;
    const t2 = (await issueApprovalLink(db, { approvalId: b! }, issueDeps({ random: fixedRandom(2) }))).token;
    assert.notEqual(t1, t2, "swapping the injected entropy changes the token");

    // ...and two draws from the real entropy source differ too (a fresh high-entropy
    // token every issue, never a reused constant).
    const r1 = (await issueApprovalLink(db, { approvalId: c! }, issueDeps({ random: systemRandom }))).token;
    const r2 = (await issueApprovalLink(db, { approvalId: d! }, issueDeps({ random: systemRandom }))).token;
    assert.notEqual(r1, r2, "two issues draw two distinct tokens");
  } finally {
    await db.close();
  }
});

test("the repo reads no process.env: a decoy secret in the environment never lands in a link", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const approvalId = await makeApprovalId(db, "ac4-env");
    const issued = await issueApprovalLink(db, { approvalId }, issueDeps());
    const redeemed = await redeemApprovalLink(db, { token: issued.token }, redeemDeps());

    assert.equal(redeemed.ok, true, "the link reads and writes purely from the injected db + deps — no app env needed");
    assert.ok(
      !JSON.stringify(issued).includes(DECOY) && !JSON.stringify(redeemed).includes(DECOY),
      "no ambient env value is folded into the issued or redeemed link",
    );

    // Scan every cell of the one table under test for the decoy (scoped narrowly).
    const all = await db.query("SELECT * FROM approval_links");
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
// AC3 — every statement binds its input as a parameter (no spliced SQL); a probe
// routed through the repo is bound (or hashed-then-bound) and the table survives.
// ===========================================================================

test("issueApprovalLink binds the approval id as a parameter, never woven into the SQL text", async () => {
  const db = recordingDb();
  const probe = "a'); DROP TABLE approval_links; --";

  // The recording db returns no rows; issueApprovalLink assembles its result from
  // inputs, so it does not throw on a no-row read — the binding is asserted regardless.
  try {
    await issueApprovalLink(db, { approvalId: probe }, issueDeps());
  } catch {
    /* tolerate a no-row read: the binding is asserted below regardless */
  }
  assertBoundNotSpliced(db, probe);
});

test("redeemApprovalLink never splices the presented token into the SQL text", async () => {
  const db = recordingDb();
  const probe = "x'); DROP TABLE approval_links; --";

  const result = await redeemApprovalLink(db, { token: probe }, redeemDeps());
  assert.equal(result.ok, false, "nothing redeems when the recording db matches no row");
  // The token is hashed before it is bound, so the raw probe appears in no bound value
  // AND in no SQL text — there is no splice point for it to reach the statement.
  assertNotSplicedIntoSql(db, probe);
  assertNeverBound(db, probe);
});

test("a SQL-injection probe in the redeemed token cannot alter the query: the table survives", async () => {
  const db = await freshDb();
  try {
    // Seed a real approval + link so the table is populated and its survival is meaningful.
    const approvalId = await makeApprovalId(db, "ac3-inject");
    const issued = await issueApprovalLink(db, { approvalId }, issueDeps());

    const probe = "x'; DROP TABLE approval_links; --";
    const rejected: RedeemLinkResult = await redeemApprovalLink(db, { token: probe }, redeemDeps());
    assert.deepEqual(
      rejected,
      { ok: false, reason: "invalid" },
      "the injection-shaped token matches no stored hash and is rejected",
    );

    assert.equal(
      await tableExists(db, "approval_links"),
      true,
      "the approval_links table must still exist (the probe was hashed + bound, not run as SQL)",
    );

    // The real token still redeems — proving the table is intact and functional.
    assert.deepEqual(
      await redeemApprovalLink(db, { token: issued.token }, redeemDeps()),
      { ok: true, approvalId },
      "the genuine token still redeems after the injection attempt",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 — a handler on the validation boundary. A route handler validates the external
// input HERE (`parseBody`), then calls this task's parameterized data-access. A
// rejected input maps to a 4xx Response and never reaches a query. The handler is a
// test fixture that EXERCISES the module — it is not an implementation file. Redeeming
// needs no session user id: the store is credential-keyed, and the member-scope check
// happens a layer up when the resolved approval is loaded.
// ===========================================================================

function redeemApprovalLinkHandler(
  db: Db,
  deps: RedeemApprovalLinkDeps,
): (req: Request) => Promise<Response> {
  // The body carries only the token. It is a URL-safe opaque string (it rides in a
  // link), so a generous length bound + a URL-safe charset reject obvious junk while
  // staying agnostic to the exact 256-bit encoding (hex / base62 / base64url).
  const schema = z.object({
    token: z.string().min(16).max(512).regex(/^[A-Za-z0-9_-]+$/),
  });
  return async (req: Request): Promise<Response> => {
    try {
      const body = await parseBody(schema, req, { maxBytes: 4 * 1024 });
      const result = await redeemApprovalLink(db, { token: body.token }, deps);
      return new Response(JSON.stringify(result), { status: result.ok ? 200 : 400 });
    } catch (err) {
      if (err instanceof HttpError) {
        return new Response(JSON.stringify({ error: "invalid input" }), { status: err.status });
      }
      return new Response("internal error", { status: 500 });
    }
  };
}

function jsonRequest(path: string, body: string): Request {
  return new Request(`https://warthog.com.au${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("the redeem handler rejects malformed JSON with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = redeemApprovalLinkHandler(db, redeemDeps());

  const res = await handler(jsonRequest("/api/approval-links/redeem", "{ not valid json"));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "malformed input must never reach a query");
});

test("the redeem handler rejects an oversized body with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = redeemApprovalLinkHandler(db, redeemDeps());

  // ~10 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
  const res = await handler(
    jsonRequest("/api/approval-links/redeem", JSON.stringify({ token: "A".repeat(10 * 1024) })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "an oversized body must never reach a query");
});

test("the redeem handler rejects a body missing the token with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = redeemApprovalLinkHandler(db, redeemDeps());

  const res = await handler(jsonRequest("/api/approval-links/redeem", JSON.stringify({})));

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a schema violation must never reach a query");
});

test("the redeem handler rejects a mis-typed token with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = redeemApprovalLinkHandler(db, redeemDeps());

  // token must be a string — a nested object is a schema violation, rejected before any query.
  const res = await handler(
    jsonRequest("/api/approval-links/redeem", JSON.stringify({ token: { oops: true } })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-typed field must never reach a query");
});

test("the redeem handler rejects a mis-shaped (non URL-safe) token with a 4xx and never reaches a query", async () => {
  const db = recordingDb();
  const handler = redeemApprovalLinkHandler(db, redeemDeps());

  // A token laced with SQL punctuation fails the URL-safe charset: rejected at the
  // boundary, so it never reaches the query at all (the validate half of INV-102).
  const res = await handler(
    jsonRequest("/api/approval-links/redeem", JSON.stringify({ token: "x'); DROP TABLE approval_links; --" })),
  );

  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
  assert.equal(db.calls.length, 0, "a mis-shaped token must never reach a query");
});

test("the redeem handler redeems a well-formed, live token and returns its approval id", async () => {
  const db = await freshDb();
  try {
    const approvalId = await makeApprovalId(db, "handler-ok");
    const issued = await issueApprovalLink(db, { approvalId }, issueDeps());
    const handler = redeemApprovalLinkHandler(db, redeemDeps());

    const res = await handler(
      jsonRequest("/api/approval-links/redeem", JSON.stringify({ token: issued.token })),
    );
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    const result = (await res.json()) as RedeemLinkResult;
    assert.deepEqual(result, { ok: true, approvalId }, "a valid token resolves to its approval id");
  } finally {
    await db.close();
  }
});

test("the redeem handler rejects a well-formed but unknown token with a 4xx", async () => {
  const db = await freshDb();
  try {
    await makeApprovalId(db, "handler-unknown");
    const handler = redeemApprovalLinkHandler(db, redeemDeps());

    // Shape-valid (passes the schema) but never issued, so the repo rejects it.
    const res = await handler(
      jsonRequest("/api/approval-links/redeem", JSON.stringify({ token: "B".repeat(43) })),
    );
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx for an unknown token, got ${res.status}`);
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Migration — the table applies and a second run changes nothing.
// ===========================================================================

test("the approval_links migration applies and re-running every migration changes nothing", async () => {
  const db = await freshDb();
  try {
    assert.equal(
      await tableExists(db, "approval_links"),
      true,
      "the approval_links table must exist after the project migrations",
    );

    const migrations = await loadMigrations();
    assert.ok(
      migrations.some((m) => m.name === "0028_approval_links"),
      "db/migrations/0028_approval_links.sql must be part of the project migrations",
    );

    // A second run over the same database applies nothing new and does not throw —
    // re-executing 0028's CREATE would throw "already exists", so an empty result AND
    // no throw together prove the migration's second run changes nothing.
    const again = await runMigrations(db, migrations);
    assert.deepEqual(again, [], "a second migration run must change nothing");
  } finally {
    await db.close();
  }
});
