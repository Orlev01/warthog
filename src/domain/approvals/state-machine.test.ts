// E03-S08 — Approvals state machine (`src/domain/approvals/state-machine.ts`).
//
// RED-first: the module does not exist yet, so importing it fails and every test
// below fails. That is intentional — the implementation is written afterwards to
// make these pass. Do NOT add the module to turn these green; the builder does
// that. The tests pin BEHAVIOUR (the status a transition yields, the fields it
// carries, the decision the waiting agent is handed), never the source text of
// the module, so a later rename that keeps behaviour leaves them untouched.
//
// This is a pure domain module (CLAUDE.md / conventions: `src/domain/**` has no
// React, no DB, no fetch, no process.env, no Date.now — "take a clock"). "Agents
// wait safely" (brief): a request that needs approval is HELD by Warthog, not
// executed; when approved Warthog itself carries out the held request exactly as
// it was approved. So the transitions and the request-preservation invariant are
// deterministic code and belong here, pure, built BEFORE the approval-creation
// and inbox tasks consume them (task: "the reply-matching primitive is needed
// before the approval creation and inbox consume it"). Time enters ONLY as an
// injected `now: Date` — a plain instant — so the module never reaches across the
// domain boundary into the server's Clock seam; the caller passes `clock.now()`.
//
// Vocabulary is EXACTLY the brief's / CLAUDE.md's: an **approval** has status
// `pending | approved | denied | expired | more_detail`; a reply links to the
// approval it answers by `in_reply_to` (the MCP wire name — the TS field is the
// camelCase `inReplyTo`, matching `agentId`/`overBudget` in the sibling domain
// modules). Expiry defaults to 15 minutes, adjustable 2 minutes to 24 hours
// (brief "Agents wait safely"); an expired request "is denied" and the agent
// receives a denial (brief non_functional: "mark it expired, treat it as denied,
// and return a denial to the waiting agent").
//
// ---------------------------------------------------------------------------
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
// The held request's details are OPAQUE to the state machine — a structured
// payload it carries verbatim and never inspects (design §6: the held call's
// "encrypted args"). So `request` is a plain `Record<string, unknown>`; the
// machine's job is to preserve it unchanged across the whole lifecycle so that
// what is executed on approval is what the person saw, never something the agent
// swapped in later.
//
//   type ApprovalStatus =
//     | "pending" | "approved" | "denied" | "expired" | "more_detail";
//
//   interface Approval {
//     id: string;
//     agentId: string;
//     status: ApprovalStatus;
//     request: Record<string, unknown>;   // the held call, preserved for execution
//     createdAt: Date;
//     expiresAt: Date;                     // createdAt + clamped expiry
//     decidedAt?: Date;                    // set on approve / deny / expire
//     question?: string;                   // set by askForMoreDetail
//     answer?: string;                     // set by reply (the agent's answer)
//     inReplyTo?: string;                  // set by reply — links to the asked approval
//   }
//
//   interface CreateApprovalInput {
//     id: string;
//     agentId: string;
//     request: Record<string, unknown>;
//     expiryMinutes?: number;              // omitted → 15; clamped to [2, 1440]
//   }
//
//   const DEFAULT_EXPIRY_MINUTES = 15;
//   const MIN_EXPIRY_MINUTES = 2;
//   const MAX_EXPIRY_MINUTES = 1440;       // 24 hours
//
//   // clampExpiryMinutes(minutes?): the configured expiry, bounded to
//   // [MIN, MAX]; undefined → DEFAULT.
//   function clampExpiryMinutes(minutes?: number): number;
//
//   // createApproval(input, now): a fresh PENDING approval. createdAt = now;
//   // expiresAt = now + clampExpiryMinutes(input.expiryMinutes) minutes.
//   function createApproval(input: CreateApprovalInput, now: Date): Approval;
//
//   // approve / deny: a pending approval → approved / denied, decidedAt = now.
//   // Illegal from any non-pending status (throws — never fails silently).
//   function approve(approval: Approval, now: Date): Approval;
//   function deny(approval: Approval, now: Date): Approval;
//
//   // askForMoreDetail: a pending approval → more_detail, recording the question
//   // on the SAME approval (same id). Illegal from any non-pending status; an
//   // empty/blank question is rejected ("records a question" needs one).
//   function askForMoreDetail(approval: Approval, question: string, now: Date): Approval;
//
//   // reply: the agent answers a more_detail approval, creating a NEW linked
//   // PENDING approval (input.id) with inReplyTo = the answered approval's id and
//   // the agent's answer. It CARRIES THE ORIGINAL REQUEST FORWARD unchanged — the
//   // reply takes no request of its own, so the agent cannot swap what gets
//   // executed. Fresh expiry window from `now`, inheriting the answered
//   // approval's configured duration. Illegal unless the answered approval is in
//   // more_detail status.
//   function reply(approval: Approval, input: { id: string; answer?: string }, now: Date): Approval;
//
//   // expireIfDue(approval, now): a PENDING approval whose expiresAt has been
//   // reached (now >= expiresAt) → expired, decidedAt set. Anything else (not
//   // pending, or not yet due) is returned UNCHANGED — idempotent.
//   function expireIfDue(approval: Approval, now: Date): Approval;
//
//   // agentDecision(approval): what the waiting agent is handed. expired collapses
//   // to "denied" (the AC's "treats it as denied"); pending / approved /
//   // more_detail map to themselves.
//   function agentDecision(approval: Approval): "pending" | "approved" | "denied" | "more_detail";
//
// Every transition is PURE: it returns a NEW approval object and mutates neither
// the input approval nor the injected `now`. Instant comparisons go through an
// `ms()` helper that accepts a Date (per the contract) but tolerates an epoch-ms
// or ISO-string representation too, so a reasonable representation choice never
// reddens a test for the wrong reason.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createApproval,
  approve,
  deny,
  askForMoreDetail,
  reply,
  expireIfDue,
  agentDecision,
  clampExpiryMinutes,
  DEFAULT_EXPIRY_MINUTES,
  MIN_EXPIRY_MINUTES,
  MAX_EXPIRY_MINUTES,
} from "./state-machine";

// ---------------------------------------------------------------------------
// Helpers — compare the moment, not the representation.
// ---------------------------------------------------------------------------

const ms = (value: Date | number | string): number => new Date(value as never).getTime();
const MINUTE = 60_000;

// The held call the agent asked Warthog to make: a send to the person's manager.
// Opaque to the state machine, which only carries it. Typed loosely (as the
// sibling domain suites do) so the contract is not coupled to its inner shape.
const REQUEST: Record<string, unknown> = {
  tool: "gmail__send",
  args: { to: "manager@example.com", subject: "Leave request", body: "Taking Friday off." },
  reason: "Sending the leave email you asked me to send",
};

const T0 = new Date("2026-03-15T10:00:00.000Z");

function pending(now: Date = T0, expiryMinutes?: number) {
  return createApproval(
    { id: "ap-1", agentId: "agent-1", request: REQUEST, expiryMinutes },
    now,
  );
}

// ===========================================================================
// createApproval — a fresh request is held, PENDING, with its expiry window.
// ===========================================================================

test("createApproval yields a pending approval carrying the held request", () => {
  const a = pending();
  assert.equal(a.status, "pending", "a freshly held request waits as pending");
  assert.equal(a.id, "ap-1", "the id is carried through");
  assert.equal(a.agentId, "agent-1", "the requesting agent is carried through");
  assert.deepEqual(a.request, REQUEST, "the held request details are carried verbatim");
  assert.equal(ms(a.createdAt), ms(T0), "createdAt is the injected now");
});

test("createApproval starts with no decision, question, answer or reply link", () => {
  const a = pending();
  assert.equal(a.decidedAt, undefined, "nothing is decided yet");
  assert.equal(a.question, undefined, "no question has been asked");
  assert.equal(a.answer, undefined, "no answer has been given");
  assert.equal(a.inReplyTo, undefined, "a first request is not a reply to anything");
});

test("createApproval does not mutate the injected now and is deterministic", () => {
  const now = new Date("2026-03-15T10:00:00.000Z");
  const before = now.getTime();
  const a = pending(now);
  const b = pending(now);
  assert.equal(now.getTime(), before, "the injected instant is left untouched");
  assert.equal(ms(a.expiresAt), ms(b.expiresAt), "same inputs give the same expiry");
});

// ===========================================================================
// AC1a — expiry window: default 15 minutes, bounded 2 minutes to 24 hours.
// ===========================================================================

test("the expiry bounds are 15 minutes default, 2 minutes min, 24 hours max", () => {
  assert.equal(DEFAULT_EXPIRY_MINUTES, 15, "default expiry is 15 minutes");
  assert.equal(MIN_EXPIRY_MINUTES, 2, "the floor is 2 minutes");
  assert.equal(MAX_EXPIRY_MINUTES, 1440, "the ceiling is 24 hours (1440 minutes)");
});

test("clampExpiryMinutes defaults an omitted value to 15 minutes", () => {
  assert.equal(clampExpiryMinutes(undefined), 15, "no configured expiry falls back to the 15-minute default");
});

test("clampExpiryMinutes passes a value inside the bounds through unchanged", () => {
  assert.equal(clampExpiryMinutes(2), 2, "the exact floor is allowed");
  assert.equal(clampExpiryMinutes(15), 15, "the default is in range");
  assert.equal(clampExpiryMinutes(120), 120, "two hours is in range");
  assert.equal(clampExpiryMinutes(1440), 1440, "the exact ceiling is allowed");
});

test("clampExpiryMinutes raises a value below the floor to 2 minutes", () => {
  assert.equal(clampExpiryMinutes(1), 2, "under the 2-minute floor is clamped up");
  assert.equal(clampExpiryMinutes(0), 2, "zero is clamped up to the floor");
  assert.equal(clampExpiryMinutes(-30), 2, "a negative value is clamped up to the floor");
});

test("clampExpiryMinutes lowers a value above the ceiling to 24 hours", () => {
  assert.equal(clampExpiryMinutes(1441), 1440, "a minute over 24 hours is clamped down");
  assert.equal(clampExpiryMinutes(100_000), 1440, "a wildly large value is clamped down to the ceiling");
});

test("createApproval with no expiry gives a 15-minute window from now", () => {
  const a = pending(T0);
  assert.equal(ms(a.expiresAt) - ms(a.createdAt), 15 * MINUTE, "expiresAt is 15 minutes after createdAt");
});

test("createApproval honours an in-bounds expiry", () => {
  const a = pending(T0, 30);
  assert.equal(ms(a.expiresAt) - ms(a.createdAt), 30 * MINUTE, "a 30-minute expiry produces a 30-minute window");
});

test("createApproval clamps a below-floor expiry to 2 minutes", () => {
  const a = pending(T0, 1);
  assert.equal(ms(a.expiresAt) - ms(a.createdAt), 2 * MINUTE, "a 1-minute request is held to the 2-minute floor");
});

test("createApproval clamps an above-ceiling expiry to 24 hours", () => {
  const a = pending(T0, 100_000);
  assert.equal(ms(a.expiresAt) - ms(a.createdAt), 1440 * MINUTE, "an over-long request is held to the 24-hour ceiling");
});

// ===========================================================================
// AC1b — pending transitions to approved or denied.
// ===========================================================================

test("approve moves a pending approval to approved and stamps the decision time", () => {
  const a = pending(T0);
  const decidedAt = new Date("2026-03-15T10:05:00.000Z");
  const b = approve(a, decidedAt);
  assert.equal(b.status, "approved", "a pending approval becomes approved");
  assert.equal(ms(b.decidedAt as Date), ms(decidedAt), "decidedAt is the injected now");
  assert.deepEqual(b.request, REQUEST, "approval preserves the held request for execution");
});

test("deny moves a pending approval to denied and stamps the decision time", () => {
  const a = pending(T0);
  const decidedAt = new Date("2026-03-15T10:03:00.000Z");
  const b = deny(a, decidedAt);
  assert.equal(b.status, "denied", "a pending approval becomes denied");
  assert.equal(ms(b.decidedAt as Date), ms(decidedAt), "decidedAt is the injected now");
});

test("approve returns a new object and does not mutate the pending approval", () => {
  const a = pending(T0);
  const b = approve(a, new Date("2026-03-15T10:05:00.000Z"));
  assert.notEqual(b, a, "a new approval object is returned");
  assert.equal(a.status, "pending", "the original approval is left pending (pure transition)");
  assert.equal(a.decidedAt, undefined, "the original approval is not stamped");
});

test("deny returns a new object and does not mutate the pending approval", () => {
  const a = pending(T0);
  const b = deny(a, new Date("2026-03-15T10:03:00.000Z"));
  assert.notEqual(b, a, "a new approval object is returned");
  assert.equal(a.status, "pending", "the original approval is left pending (pure transition)");
});

test("approve refuses any non-pending approval", () => {
  const now = new Date("2026-03-15T10:05:00.000Z");
  const approved = approve(pending(T0), now);
  const denied = deny(pending(T0), now);
  const asked = askForMoreDetail(pending(T0), "Which manager?", now);
  const expired = expireIfDue(pending(T0, 2), new Date("2026-03-15T10:02:00.000Z"));
  assert.throws(() => approve(approved, now), "cannot approve an already-approved request");
  assert.throws(() => approve(denied, now), "cannot approve a denied request");
  assert.throws(() => approve(asked, now), "cannot approve a request still waiting on more detail");
  assert.throws(() => approve(expired, now), "cannot approve an expired request");
});

test("deny refuses any non-pending approval", () => {
  const now = new Date("2026-03-15T10:05:00.000Z");
  const approved = approve(pending(T0), now);
  const denied = deny(pending(T0), now);
  assert.throws(() => deny(approved, now), "cannot deny an already-approved request");
  assert.throws(() => deny(denied, now), "cannot deny an already-denied request");
});

// ===========================================================================
// AC1c — expiry marks the request expired and treats it as denied.
// ===========================================================================

test("expireIfDue leaves a pending approval untouched before its expiry time", () => {
  const a = pending(T0); // expires at 10:15:00
  const justBefore = new Date(ms(a.expiresAt) - 1);
  const r = expireIfDue(a, justBefore);
  assert.equal(r.status, "pending", "a millisecond before expiry it is still pending");
});

test("expireIfDue expires a pending approval exactly at its expiry time", () => {
  const a = pending(T0); // expires at 10:15:00
  const r = expireIfDue(a, a.expiresAt);
  assert.equal(r.status, "expired", "reaching the expiry time marks it expired");
  assert.notEqual(r.decidedAt, undefined, "an expiry stamps a decision time");
});

test("expireIfDue expires a pending approval after its expiry time", () => {
  const a = pending(T0); // expires at 10:15:00
  const r = expireIfDue(a, new Date("2026-03-15T11:00:00.000Z"));
  assert.equal(r.status, "expired", "well past the expiry time it is expired");
});

test("expireIfDue is a no-op for an approval that was already decided", () => {
  const approved = approve(pending(T0), new Date("2026-03-15T10:05:00.000Z"));
  const wayLater = new Date("2026-03-16T00:00:00.000Z");
  const r = expireIfDue(approved, wayLater);
  assert.equal(r.status, "approved", "a decided approval never expires out from under its decision");
});

test("expireIfDue does not run the expiry clock on a more_detail approval", () => {
  const asked = askForMoreDetail(pending(T0), "Which manager?", new Date("2026-03-15T10:05:00.000Z"));
  const wayLater = new Date("2026-03-16T00:00:00.000Z");
  const r = expireIfDue(asked, wayLater);
  assert.equal(r.status, "more_detail", "a request waiting on the agent's reply does not expire");
});

test("expireIfDue is idempotent once expired", () => {
  const a = pending(T0);
  const once = expireIfDue(a, new Date("2026-03-15T11:00:00.000Z"));
  const twice = expireIfDue(once, new Date("2026-03-15T12:00:00.000Z"));
  assert.equal(twice.status, "expired", "re-checking an expired approval keeps it expired");
});

test("agentDecision hands the waiting agent a denial for an expired request", () => {
  // The AC: expiry "treats it as denied"; brief: "return a denial to the waiting
  // agent". So the expired status collapses to a denial at the agent boundary.
  const expired = expireIfDue(pending(T0), new Date("2026-03-15T11:00:00.000Z"));
  assert.equal(expired.status, "expired", "the stored status records it expired (for the person's history)");
  assert.equal(agentDecision(expired), "denied", "but the waiting agent is told: denied");
});

test("agentDecision maps each live status to the decision the agent receives", () => {
  const now = new Date("2026-03-15T10:05:00.000Z");
  assert.equal(agentDecision(pending(T0)), "pending", "a held request reads as pending");
  assert.equal(agentDecision(approve(pending(T0), now)), "approved", "an approved request reads as approved");
  assert.equal(agentDecision(deny(pending(T0), now)), "denied", "a denied request reads as denied");
  assert.equal(
    agentDecision(askForMoreDetail(pending(T0), "Which manager?", now)),
    "more_detail",
    "a request awaiting detail reads as more_detail",
  );
});

// ===========================================================================
// AC2 — ask-for-more-detail records a question; a reply creates a linked
// approval via in_reply_to.
// ===========================================================================

test("askForMoreDetail records the question and parks the request as more_detail", () => {
  const a = pending(T0);
  const asked = askForMoreDetail(a, "Which manager — your work or personal one?", new Date("2026-03-15T10:04:00.000Z"));
  assert.equal(asked.status, "more_detail", "the request moves to more_detail");
  assert.equal(asked.question, "Which manager — your work or personal one?", "the person's question is recorded");
  assert.equal(asked.id, a.id, "the question is recorded on the same approval, not a new one");
  assert.deepEqual(asked.request, REQUEST, "the held request is preserved while detail is sought");
});

test("askForMoreDetail does not mutate the pending approval", () => {
  const a = pending(T0);
  const asked = askForMoreDetail(a, "Which manager?", new Date("2026-03-15T10:04:00.000Z"));
  assert.notEqual(asked, a, "a new approval object is returned");
  assert.equal(a.status, "pending", "the original approval is left pending");
  assert.equal(a.question, undefined, "the original approval records no question");
});

test("askForMoreDetail rejects a blank question", () => {
  const a = pending(T0);
  const now = new Date("2026-03-15T10:04:00.000Z");
  assert.throws(() => askForMoreDetail(a, "", now), "an empty question is not a question");
  assert.throws(() => askForMoreDetail(a, "   ", now), "a whitespace-only question is not a question");
});

test("askForMoreDetail refuses any non-pending approval", () => {
  const now = new Date("2026-03-15T10:05:00.000Z");
  const approved = approve(pending(T0), now);
  const denied = deny(pending(T0), now);
  assert.throws(() => askForMoreDetail(approved, "Why?", now), "cannot ask for detail on a decided request");
  assert.throws(() => askForMoreDetail(denied, "Why?", now), "cannot ask for detail on a denied request");
});

test("reply creates a new pending approval linked to the asked one via inReplyTo", () => {
  const asked = askForMoreDetail(pending(T0), "Which manager?", new Date("2026-03-15T10:04:00.000Z"));
  const replyNow = new Date("2026-03-15T10:06:00.000Z");
  const r = reply(asked, { id: "ap-2", answer: "My work manager, Dana." }, replyNow);
  assert.equal(r.status, "pending", "the reply waits as a fresh pending approval");
  assert.equal(r.id, "ap-2", "the reply is a new approval with its own id");
  assert.equal(r.inReplyTo, asked.id, "the reply links back to the approval that asked");
  assert.equal(r.answer, "My work manager, Dana.", "the agent's answer is recorded on the reply");
  assert.equal(r.agentId, asked.agentId, "the reply belongs to the same agent");
});

test("a reply carries the original held request forward unchanged", () => {
  // The security point: the person asked a question, the agent answered — but what
  // Warthog will execute is the ORIGINAL held request, not anything the agent
  // could swap in. reply takes no request of its own.
  const asked = askForMoreDetail(pending(T0), "Which manager?", new Date("2026-03-15T10:04:00.000Z"));
  const r = reply(asked, { id: "ap-2", answer: "Dana." }, new Date("2026-03-15T10:06:00.000Z"));
  assert.deepEqual(r.request, REQUEST, "the reply holds the very same request the person first saw");
});

test("a reply opens a fresh expiry window inheriting the asked approval's duration", () => {
  const asked = askForMoreDetail(pending(T0, 30), "Which manager?", new Date("2026-03-15T10:04:00.000Z"));
  const replyNow = new Date("2026-03-15T10:06:00.000Z");
  const r = reply(asked, { id: "ap-2", answer: "Dana." }, replyNow);
  assert.equal(ms(r.createdAt), ms(replyNow), "the reply's clock starts when the agent answers");
  assert.equal(ms(r.expiresAt) - ms(r.createdAt), 30 * MINUTE, "it inherits the 30-minute window the person configured");
});

test("reply does not mutate the asked approval", () => {
  const asked = askForMoreDetail(pending(T0), "Which manager?", new Date("2026-03-15T10:04:00.000Z"));
  const r = reply(asked, { id: "ap-2", answer: "Dana." }, new Date("2026-03-15T10:06:00.000Z"));
  assert.notEqual(r, asked, "the reply is a distinct approval object");
  assert.equal(asked.status, "more_detail", "the asked approval stays in more_detail");
  assert.equal(asked.inReplyTo, undefined, "the asked approval is not itself a reply");
});

test("reply refuses an approval that is not waiting on more detail", () => {
  const now = new Date("2026-03-15T10:05:00.000Z");
  const stillPending = pending(T0);
  const approved = approve(pending(T0), now);
  assert.throws(() => reply(stillPending, { id: "ap-2", answer: "Dana." }, now), "cannot reply to a request no one asked about");
  assert.throws(() => reply(approved, { id: "ap-2", answer: "Dana." }, now), "cannot reply to an already-decided request");
});

// ===========================================================================
// AC3 — INVARIANT: across create → ask-more → reply → approve, the ORIGINAL
// request details are preserved and used for execution.
//
// This is the sequence invariant (not just per-op): the held request must
// survive the whole lifecycle unchanged, so that what Warthog executes on the
// final approval is exactly what the person first saw.
// ===========================================================================

test("the original request survives create → ask-more → reply → approve and is what gets executed", () => {
  // Snapshot the request before the chain so we can prove nothing mutated it.
  const snapshot = JSON.parse(JSON.stringify(REQUEST));

  const created = createApproval({ id: "ap-1", agentId: "agent-1", request: REQUEST }, T0);
  const asked = askForMoreDetail(created, "Which manager — work or personal?", new Date("2026-03-15T10:04:00.000Z"));
  const replied = reply(asked, { id: "ap-2", answer: "My work manager, Dana." }, new Date("2026-03-15T10:06:00.000Z"));
  const approved = approve(replied, new Date("2026-03-15T10:08:00.000Z"));

  assert.equal(approved.status, "approved", "the chain ends in an approval");
  assert.deepEqual(
    approved.request,
    snapshot,
    "the request executed on approval is the ORIGINAL held request, preserved through the whole chain",
  );
  assert.equal(approved.inReplyTo, asked.id, "the approved reply still links to the question it answered");
  assert.equal(approved.answer, "My work manager, Dana.", "the agent's answer rides along with the approved reply");
  assert.deepEqual(REQUEST, snapshot, "the original request object was never mutated by any transition");
});

test("every step of the chain preserves the held request, not only the final approval", () => {
  const created = createApproval({ id: "ap-1", agentId: "agent-1", request: REQUEST }, T0);
  const asked = askForMoreDetail(created, "Which manager?", new Date("2026-03-15T10:04:00.000Z"));
  const replied = reply(asked, { id: "ap-2", answer: "Dana." }, new Date("2026-03-15T10:06:00.000Z"));
  const approved = approve(replied, new Date("2026-03-15T10:08:00.000Z"));

  for (const step of [created, asked, replied, approved]) {
    assert.deepEqual(step.request, REQUEST, `the held request is intact at status "${step.status}"`);
  }
});
