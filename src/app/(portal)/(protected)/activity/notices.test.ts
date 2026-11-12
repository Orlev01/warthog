// E08-S10 — Activity screen outcome notices (`src/app/(portal)/(protected)/activity/notices.ts`).
//
// RED-first: `./notices` does NOT exist yet, so importing it throws
// (ERR_MODULE_NOT_FOUND) and this whole suite fails to load. That absence IS the point
// of test-first — do NOT implement anything to make these pass; the builder writes
// `notices.ts` afterwards.
//
// WHY this module exists (E08-S09 review veto; constitution "No dead controls / never
// fail silently"; design §server-composition-roots "a server action never fails
// silently"): the /activity page's Dispute and Undo controls post inline `use server`
// wrappers that re-derive the session, call disputeEntry / undoEntry, and redirect back
// with a `?notice=` code the page turns into plain words — exactly the sibling SECURITY
// screen's pattern (`settings/security/notices.ts`). This module is that mapping:
//   • `noticeLocation(successCode, outcome)` — where a finished wrapper redirects: back to
//     /activity with the SUCCESS code on `{ ok: true }`, the refusal's reason code on
//     `{ ok: false, reason }`, or `invalid_request` for a 4xx `HttpError` thrown at the
//     validation boundary. A genuine server fault (any other Error) is RE-THROWN, never
//     dressed up as a notice.
//   • `activityNotice(code)` — the plain-words copy (and tone) for a code, or null for an
//     absent or UNKNOWN code, so the query string can never inject copy onto the screen.
//
// These tests pin BEHAVIOUR (the location a given outcome maps to, and the copy a code
// resolves to), never the source text of any module. The refusal round-trip at the end
// drives the REAL disputeEntry / undoEntry so the actions' own refusal reasons are
// FORCED to be codes this module knows — a silent `?notice=<unknown>` (null copy) would
// be a failing test, which is the cross-seam contract the review asks for.
//
// Acceptance criteria → tests:
//   AC1  a successful dispute redirects back with a plain-words SUCCESS notice; a refusal
//        (malformed, or another person's / a non-existent entry) redirects back with a
//        plain-words PROBLEM notice and is never dressed as a success.
//   AC2  a live Undo reports its OUTCOME via a notice (success OR refusal) and never throws
//        to the page; a malformed/oversized input (the boundary's 4xx) maps to a notice,
//        while a genuine fault still throws.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { noticeLocation, activityNotice } from "./notices";
import { createActivityActions } from "./actions";

import { HttpError } from "@/server/http/validate";
import { createDisputeRepo } from "@/server/activity/disputes";
import { createUndoService } from "@/server/activity/undo";
import { createDbRecorder } from "@/server/activity/writer";
import { createUser } from "@/server/db/users";
import { createSession, type Session } from "@/server/auth/session";
import { fixedClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

// The screen these notices live on (the redirect target).
const SCREEN = "/activity";

// Read the `notice` code back out of a redirect location (`/activity?notice=<code>`),
// decoding any percent-encoding so a reason that travelled is read exactly.
function noticeCode(location: string): string | null {
  const q = location.indexOf("?");
  if (q < 0) return null;
  return new URLSearchParams(location.slice(q + 1)).get("notice");
}

// Copy that must never leak into a person-facing notice: internal identifiers / protocol
// words. (The notice is plain Australian English — design UX copy.)
const JARGON = /HttpError|\buserId\b|\bentrySeq\b|\bseq\b|session id|token|\bDEK\b|undefined|null|\$\d/i;

// =====================================================================================
// AC1 / AC2 — where a finished wrapper redirects (pure mapping, no DB)
// =====================================================================================

test("a successful dispute or undo redirects back to the activity screen with its success notice", () => {
  assert.equal(noticeLocation("dispute_filed", { ok: true }), `${SCREEN}?notice=dispute_filed`);
  assert.equal(noticeLocation("undo_done", { ok: true }), `${SCREEN}?notice=undo_done`);
});

test("a refusal redirects back naming its reason, never dressed up as the success code", () => {
  // Whatever reason the action reports becomes the notice code — never the success code.
  const disputeRefused = noticeLocation("dispute_filed", { ok: false, reason: "dispute_refused" });
  assert.equal(noticeCode(disputeRefused), "dispute_refused", "the refusal's reason is the notice code");
  assert.ok(disputeRefused.startsWith(`${SCREEN}?notice=`), "and it still returns to the activity screen");
  assert.notEqual(noticeCode(disputeRefused), "dispute_filed", "a refusal is never reported as the success");

  const undoRefused = noticeLocation("undo_done", { ok: false, reason: "undo_no_reversal" });
  assert.equal(noticeCode(undoRefused), "undo_no_reversal", "the undo refusal's reason is the notice code");
  assert.notEqual(noticeCode(undoRefused), "undo_done", "a refused undo is never reported as done");
});

test("a malformed request (the boundary's 4xx HttpError) maps to an invalid_request notice; a genuine fault still throws", () => {
  // A live Undo (or Dispute) must never throw to the page for a bad input: the boundary's
  // HttpError becomes a notice. A genuine server fault is NOT dressed up — it rethrows.
  assert.equal(noticeLocation("dispute_filed", new HttpError(400, "bad id")), `${SCREEN}?notice=invalid_request`);
  assert.equal(noticeLocation("undo_done", new HttpError(413, "too large")), `${SCREEN}?notice=invalid_request`);
  assert.throws(() => noticeLocation("dispute_filed", new Error("db down")), /db down/);
  assert.throws(() => noticeLocation("undo_done", new Error("kaboom")), /kaboom/);
});

// =====================================================================================
// the copy each code resolves to — plain words, correct tone, unknown codes inert
// =====================================================================================

test("every known notice has plain-words copy and the right tone", () => {
  for (const code of ["dispute_filed", "undo_done"]) {
    const notice = activityNotice(code);
    assert.ok(notice && notice.text.length > 0, `copy exists for ${code}`);
    assert.equal(notice!.tone, "done", `${code} is a success (done) notice`);
    assert.doesNotMatch(notice!.text, JARGON, `${code} copy is plain words, no jargon`);
  }
  const invalid = activityNotice("invalid_request");
  assert.ok(invalid && invalid.text.length > 0, "copy exists for invalid_request");
  assert.equal(invalid!.tone, "problem", "invalid_request is a problem notice");
  assert.doesNotMatch(invalid!.text, JARGON, "invalid_request copy is plain words, no jargon");
});

test("an unknown or absent code resolves to nothing — the query string cannot inject copy", () => {
  assert.equal(activityNotice(undefined), null, "an absent code shows nothing");
  assert.equal(activityNotice("not_a_real_notice_code"), null, "an unknown code shows nothing");
  assert.equal(activityNotice("<script>alert(1)</script>"), null, "an injection probe shows nothing");
  assert.equal(activityNotice(""), null, "an empty code shows nothing");
});

// =====================================================================================
// the refusal round-trip: a REAL disputeEntry / undoEntry refusal must resolve to a
// plain-words PROBLEM notice (never a silent `?notice=<unknown>`)
// =====================================================================================

// Build the real activity actions over a real db, with the real sub-services composed
// from the same seams production uses. `reversalFor` declares nothing reversible, so an
// undo always refuses with "no reversal" — the refusal path under test.
function realActions(db: Db, dek: Uint8Array) {
  const clock = fixedClock(new Date("2026-01-01T00:00:00.000Z"));
  const dekFor = async (): Promise<Uint8Array> => dek;
  const recorder = createDbRecorder({ db, clock, dekFor });
  const disputes = createDisputeRepo({ db, clock, dekFor });
  const undo = createUndoService({
    db,
    recorder,
    reversalFor: () => undefined,
    runReversal: async () => ({ status: "executed", outcome: "reversed" }),
  });
  return { actions: createActivityActions({ db, disputes, undo }), recorder, clock };
}

async function sessionFor(db: Db, userId: string): Promise<Session> {
  const created = await createSession(db, userId, {
    clock: fixedClock(new Date("2026-01-01T00:00:00.000Z")),
    random: systemRandom,
  });
  return created.session;
}

test("a real dispute refusal (an entry that isn't the person's) maps to a plain-words problem notice", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32);
    const alice = await createUser(db, { email: "notice-dispute@warthog.com.au", wrappedDek: "d" });
    const { actions } = realActions(db, dek);
    const session = await sessionFor(db, alice.id);

    // Alice has no entry at seq 7, so the dispute is refused (never a silent success).
    const refusal = await actions.disputeEntry(session, 7, "this is wrong");
    assert.equal(refusal.ok, false, "disputing a non-existent entry is a reported refusal");

    const location = noticeLocation("dispute_filed", refusal);
    const code = noticeCode(location);
    assert.ok(code, "the refusal travels as a notice code");
    assert.notEqual(code, "dispute_filed", "a refusal is not reported as the success");
    const notice = activityNotice(code ?? undefined);
    assert.ok(notice, `the dispute refusal reason (${code}) must resolve to a notice — never a silent unknown`);
    assert.equal(notice!.tone, "problem", "a refusal reads as a problem");
    assert.ok(notice!.text.length > 0, "the refusal notice has plain-words copy");
    assert.doesNotMatch(notice!.text, JARGON, "the refusal notice is plain words, no jargon");
  } finally {
    await db.close();
  }
});

test("a real undo refusal (an entry with no declared reversal) maps to a plain-words problem notice", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32);
    const alice = await createUser(db, { email: "notice-undo@warthog.com.au", wrappedDek: "d" });
    const { actions, recorder } = realActions(db, dek);

    // One non-reversible entry of Alice's own (no tool declares a reversal).
    await recorder.record({
      userId: alice.id,
      kind: "tool_call",
      source: "warthog",
      payload: { summary: "a read, not reversible" },
    });
    const session = await sessionFor(db, alice.id);

    // Each realistic live-Undo refusal — a non-reversible entry (seq 1) and a
    // no-longer-present entry (seq 999) — must report its outcome via a PLAIN-WORDS
    // notice, never throw to the page and never a silent `?notice=<unknown>`. (The raw
    // service reasons are a fixed sentence and a sentence carrying a POSITION NUMBER, so
    // only STABLE codes — not passed-through sentences — can resolve to copy here.)
    for (const seq of [1, 999]) {
      const refusal = await actions.undoEntry(session, seq);
      assert.equal(refusal.ok, false, `undoing entry ${seq} is a reported refusal`);

      const location = noticeLocation("undo_done", refusal);
      const code = noticeCode(location);
      assert.ok(code, `the undo refusal for ${seq} travels as a notice code`);
      assert.notEqual(code, "undo_done", "a refused undo is not reported as done");
      const notice = activityNotice(code ?? undefined);
      assert.ok(notice, `the undo refusal reason (${code}) must resolve to a notice — never a silent unknown`);
      assert.equal(notice!.tone, "problem", "a refused undo reads as a problem");
      assert.ok(notice!.text.length > 0, "the undo refusal notice has plain-words copy");
      assert.doesNotMatch(notice!.text, JARGON, "the undo refusal notice is plain words, no jargon");
    }
  } finally {
    await db.close();
  }
});

test("pending Undo links to approval while provider failure and refusal remain distinct", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "undo-outcomes@warthog.com.au", wrappedDek: "synthetic" });
    const dek = randomBytes(32);
    const clock = fixedClock(new Date("2026-11-11T12:00:00Z"));
    const recorder = createDbRecorder({ db, clock, dekFor: async () => dek });
    await recorder.record({ userId: user.id, kind: "tool_call", source: "warthog", tool: "google-calendar__create", payload: {} });
    const session = await sessionFor(db, user.id);
    for (const [status, code] of [["pending_approval", "undo_pending"], ["failed", "undo_failed"], ["refused", "undo_refused"]] as const) {
      const undo = createUndoService({ db, recorder, reversalFor: () => "google-calendar__delete",
        runReversal: async () => ({ status, outcome: "Fixed internal explanation" }),
      });
      const actions = createActivityActions({ db, undo, disputes: { fileDispute: async () => {} } });
      const result = await actions.undoEntry(session, 1);
      const location = noticeLocation("undo_done", result);
      assert.equal(noticeCode(location), code);
      const notice = activityNotice(code)!;
      assert.ok(notice.text.length > 0);
      assert.notEqual(notice.tone, "done");
      if (status === "pending_approval") {
        assert.equal(notice.tone, "waiting");
        assert.match(notice.text, /has not been undone/);
        assert.deepEqual(notice.action, { href: "/inbox", label: "Review approval" });
      } else assert.equal(notice.action, undefined);
    }
  } finally { await db.close(); }
});

// interaction-02: a dispute with a blank note files nothing and says what to do instead.
test("a blank dispute note lands back on the entry with a plain-words problem notice", () => {
  assert.equal(
    noticeLocation("dispute_filed", { ok: false, reason: "dispute_note_missing" }, 42),
    "/activity?entry=42&notice=dispute_note_missing#entry-42",
  );
  const notice = activityNotice("dispute_note_missing");
  assert.equal(notice?.tone, "problem");
  assert.match(notice?.text ?? "", /add a note/i);
  assert.doesNotMatch(notice!.text, JARGON);
});
