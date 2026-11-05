// E08-S09 — Activity page loader (`src/app/(portal)/(protected)/activity/`).
//
// RED-first: the activity LOADER seam does NOT exist yet. `createActivityActions`
// already exists (E08-S07) and returns { disputeEntry, undoEntry, checkIntegrity };
// this task adds a `load(session, searchParams)` method to that SAME factory (the
// home/security pattern — one factory with `load` alongside its mutations) plus the
// two read-side seams `load` needs. Until the builder adds `load`, every test here
// fails at `actions.load(...)` ("load is not a function"). That absence IS the point
// of test-first — do NOT implement anything to make these pass; the builder writes
// the loader afterwards.
//
// Why these tests live in a SIBLING of `page.tsx`: a Next `page.tsx` entry file may
// export ONLY its framework fields (its default page component), so the injectable,
// unit-testable loader logic can't live there without breaking `next build`. The thin
// `page.tsx` reads the session cookie + the process-wide database, awaits the
// request's `searchParams`, calls this seam to turn the verified session into the
// view's props, and renders `<ActivityView>`. The testable logic lives in the plain
// sibling module `./actions` (the convention's `createXActions(deps)` factory), so
// these tests drive it directly against an isolated in-memory PGlite with the REAL
// migrations (`@/test/db`), the REAL activity writer and the REAL crypto seams — no
// test touches the network or Azure, and none asserts on the source text of any
// module, so a later behaviour-preserving refactor stays green.
//
// ─── The contract this task defines (the builder implements exactly this) ─────────────
//
//   createActivityActions(deps: {
//     db: Db;                         // existing — the integrity check reads this
//     disputes: DisputeFiler;         // existing (E08-S07)
//     undo: EntryUndoer;              // existing (E08-S07)
//     keyWrapper?: KeyWrapper;        // NEW (optional, so the E08-S07 construction still
//                                     //   compiles): the loader resolves the SESSION
//                                     //   person's DEK with it — getUserById(session.userId)
//                                     //   then keyWrapper.unwrap(user.wrappedDek), the
//                                     //   same session→DEK idiom `loadAgentContext` uses.
//     reversalFor?: (tool?: string) => string | undefined;  // NEW (optional): the
//                                     //   "is this reversible?" decision the undo service
//                                     //   already takes — the loader uses it to set each
//                                     //   entry's `canUndo` so the Undo control shows only
//                                     //   where a reversal is declared.
//   }): {
//     disputeEntry, undoEntry, checkIntegrity,   // existing (E08-S07)
//     load(session: Session, searchParams: Record<string, string | string[] | undefined>):
//        Promise<ActivityViewProps>              // NEW
//   }
//
//   `load`:
//     • reads ONLY the session user's entries (member-scoped by `session.userId`, NEVER a
//       client value — design §5) and returns the already-built `ActivityViewProps`
//       (`entries`, `filterOptions`, `query`, `integrity`) the frozen <ActivityView>
//       (E08-S08) consumes, newest-first;
//     • narrows the list from the view's own GET params — `q` (free-text search over the
//       decrypted summary), and the facet/date filters `agent`, `service`, `kind`,
//       `outcome`, `from`, `to` (the loader maps `agent`→agentId and `service`→connectorId,
//       exactly the values its filter dropdowns post back) — and echoes the search text as
//       `query`;
//     • sets each entry's `canUndo` from `reversalFor(entry.tool)`; and
//     • runs the record-wide integrity check ONLY when the Check-integrity control posted
//       `verify=1`, returning its result as `integrity` (otherwise `integrity` is null).
//
// ─── Acceptance criteria → tests ──────────────────────────────────────────────────────
//   AC1  the loader reads ONLY the session user's entries and renders <ActivityView> with
//        them (another person's entries never appear; the member scope is the session).
//   AC2  the mounted controls call disputeEntry / undoEntry / checkIntegrity: `verify=1`
//        drives checkIntegrity (its result lands in `integrity`), and the loader's props
//        light up a LIVE Dispute control on every entry plus an Undo control ONLY where the
//        entry is reversible — each carrying the entry seq the dispute/undo actions consume
//        (the actions' own behaviour is E08-S07; this proves the controls are mounted, not
//        dead, and carry what they call).
//   AC3  filters and search narrow the RENDERED list (agent, service, date range, and the
//        free-text search each narrow to the matching entries, case-insensitively).
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each test
// uses its own `freshDb()`. The view is rendered with `react-dom/server` (no DOM/jsdom —
// React component / E2E testing is a per-job ADR), exactly as the sibling home loader test
// and activity-view.test.tsx do.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createActivityActions } from "./actions";

import { ActivityView, type ActivityViewProps } from "@/components/activity/activity-view";
import { createDbRecorder } from "@/server/activity/writer";
import type { ActivityRecorder, ActivityEntryInput } from "@/server/activity/recorder";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { createUser } from "@/server/db/users";
import { createSession, type Session } from "@/server/auth/session";
import { systemRandom } from "@/server/seams/random";
import type { Clock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // a 256-bit local AES key-encryption key (AES-256-GCM)

// A curated reversible tool and its declared reversal (design §7: create_event ↔
// delete_event), a read that declares no reversal, and the reversal table the loader
// consults to decide `canUndo`. Tool names are `<connector>__<tool>`.
const CREATE_EVENT = "google_calendar__create_event";
const DELETE_EVENT = "google_calendar__delete_event";
const LIST_EVENTS = "google_calendar__list_events";
const REVERSALS: Record<string, string> = { [CREATE_EVENT]: DELETE_EVENT };
const reversalFor = (tool?: string): string | undefined => (tool ? REVERSALS[tool] : undefined);

// A mutable clock so seeded entries get DISTINCT occurred_at values (the loader lists
// newest-first and narrows by an inclusive date range — both need real timestamps).
function makeClock(start: string): Clock & { set(iso: string): void } {
  let at = new Date(start).getTime();
  return {
    now: () => new Date(at),
    set: (iso: string) => {
      at = new Date(iso).getTime();
    },
  };
}

// The disputes / undo sub-services the factory requires but the LOADER never touches
// (dispute/undo behaviour is E08-S07). Stand-ins that throw/refuse if load ever calls
// them, so a loader that wrongly routed a read through them would be caught.
const unusedDisputes = {
  async fileDispute(): Promise<unknown> {
    throw new Error("the loader must not file a dispute");
  },
};
const unusedUndo = {
  async undo(): Promise<{ ok: false; reason: string }> {
    return { ok: false, reason: "the loader must not undo" };
  },
};

// Build the activity actions with the read-side seams the loader uses. `deps` is a
// pre-declared variable (not a bare object literal) so the two NEW optional seams don't
// trip an excess-property check before the builder widens the deps type.
function makeLoader(db: Db, keyWrapper: KeyWrapper) {
  const deps = {
    db,
    disputes: unusedDisputes,
    undo: unusedUndo,
    keyWrapper,
    reversalFor,
  };
  return createActivityActions(deps);
}

// Create a person whose wrapped DEK unwraps (under `keyWrapper`) to `dek`, so the loader
// resolving the DEK from the session can decrypt the entries this DEK encrypted.
async function makePerson(
  db: Db,
  keyWrapper: KeyWrapper,
  email: string,
  dek: Uint8Array,
): Promise<string> {
  const user = await createUser(db, { email, wrappedDek: await keyWrapper.wrap(dek) });
  return user.id;
}

// A real verified session for `userId` — the loader must read `session.userId` from it.
async function sessionFor(db: Db, userId: string, clock: Clock): Promise<Session> {
  const created = await createSession(db, userId, { clock, random: systemRandom });
  return created.session;
}

// A real DB-backed recorder over a per-user DEK map (the writer encrypts each payload
// under the acting user's DEK, exactly as production does).
function makeRecorder(db: Db, clock: Clock, dekByUser: Record<string, Uint8Array>): ActivityRecorder {
  return createDbRecorder({
    db,
    clock,
    dekFor: async (userId: string) => {
      const dek = dekByUser[userId];
      if (!dek) throw new Error(`no DEK seeded for ${userId}`);
      return dek;
    },
  });
}

// Seed one entry at a given instant through the REAL writer (a sound chain link).
async function record(
  recorder: ActivityRecorder,
  clock: Clock & { set(iso: string): void },
  at: string,
  input: ActivityEntryInput,
): Promise<void> {
  clock.set(at);
  await recorder.record(input);
}

// --- a seeded world: Alice (the session person) + Bob (an unrelated person) ----------
//
// Alice's three entries carry distinctive, digit-free summary words (so redaction leaves
// them intact and they can't collide with chrome/placeholder copy), distinct agents and
// connected services, one reversible tool, and distinct months for the date-range test.
// Bob's single entry carries a word that must NEVER surface in Alice's loader output.

const ALICE_EMAIL = "quokka@people.example";
const BOB_EMAIL = "narwhal@people.example";

// seq → the distinctive word in that entry's summary.
const WORD = { 1: "quokkaflight", 2: "banksiapark", 3: "wattlemail" } as const;
const BOB_WORD = "zzzbobonly";

async function seedWorld(db: Db, keyWrapper: KeyWrapper) {
  const clock = makeClock("2026-01-01T00:00:00.000Z");
  const dekAlice = randomBytes(DEK_BYTES);
  const dekBob = randomBytes(DEK_BYTES);

  const aliceId = await makePerson(db, keyWrapper, ALICE_EMAIL, dekAlice);
  const bobId = await makePerson(db, keyWrapper, BOB_EMAIL, dekBob);

  const recorder = makeRecorder(db, clock, { [aliceId]: dekAlice, [bobId]: dekBob });

  // Alice seq 1 — reversible (create_event), agent-claude, google_calendar, Feb.
  await record(recorder, clock, "2026-02-10T00:00:00.000Z", {
    userId: aliceId,
    kind: "tool_call",
    source: "warthog",
    agentId: "agent-claude",
    connectorId: "google_calendar",
    tool: CREATE_EVENT,
    outcome: "ok",
    payload: { summary: `Booked ${WORD[1]} trip`, detail: "trip detail" },
  });
  // Alice seq 2 — a read (not reversible), agent-gpt, gmail, agent-reported, Mar.
  await record(recorder, clock, "2026-03-15T00:00:00.000Z", {
    userId: aliceId,
    kind: "tool_call",
    source: "agent_reported",
    agentId: "agent-gpt",
    connectorId: "gmail",
    tool: LIST_EVENTS,
    outcome: "done",
    payload: { summary: `Read ${WORD[2]} inbox`, detail: "inbox detail" },
  });
  // Alice seq 3 — no tool (not reversible), agent-claude, gmail, Apr.
  await record(recorder, clock, "2026-04-20T00:00:00.000Z", {
    userId: aliceId,
    kind: "tool_call",
    source: "warthog",
    agentId: "agent-claude",
    connectorId: "gmail",
    outcome: "ok",
    payload: { summary: `Sent ${WORD[3]} note`, detail: "note detail" },
  });
  // Bob — an unrelated person's entry that must never leak into Alice's view.
  await record(recorder, clock, "2026-03-01T00:00:00.000Z", {
    userId: bobId,
    kind: "tool_call",
    source: "warthog",
    agentId: "agent-claude",
    connectorId: "gmail",
    tool: CREATE_EVENT,
    outcome: "ok",
    payload: { summary: `Bob ${BOB_WORD} entry`, detail: "bob detail" },
  });

  const aliceSession = await sessionFor(db, aliceId, clock);
  return { aliceId, bobId, aliceSession };
}

// --- helpers (no DOM) ----------------------------------------------------------------

// The seqs of the returned entries, in order (the loader lists newest-first).
function seqsOf(view: ActivityViewProps): number[] {
  return view.entries.map((entry) => entry.seq);
}

// Render the mounted screen the page shows over the loader's props.
function render(view: ActivityViewProps): string {
  return renderToStaticMarkup(<ActivityView {...view} />);
}

// Visible text with tags stripped — the words a sighted reader actually sees.
function strip(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Tally the hidden `intent` inputs by value — one per Dispute/Undo control the view
// mounts. (The view posts `<input name="intent" value="dispute|undo">` with the seq.)
function intentCounts(markup: string): { dispute: number; undo: number } {
  const counts = { dispute: 0, undo: 0 };
  for (const m of markup.matchAll(/name="intent"\s+value="([^"]+)"/g)) {
    if (m[1] === "dispute") counts.dispute += 1;
    if (m[1] === "undo") counts.undo += 1;
  }
  return counts;
}

// =====================================================================================
// AC1 — the loader reads ONLY the session user's entries and renders them
// =====================================================================================

test("the loader returns the session person's own entries, newest-first", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));
    const { aliceSession } = await seedWorld(db, keyWrapper);

    const view = await makeLoader(db, keyWrapper).load(aliceSession, {});

    // All three of Alice's entries, newest occurred_at first (Apr, Mar, Feb → seq 3,2,1).
    assert.deepEqual(seqsOf(view), [3, 2, 1], "the loader lists the person's entries newest-first");
  } finally {
    await db.close();
  }
});

test("the loader never returns another person's entries, and the rendered screen shows none", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));
    const { aliceSession } = await seedWorld(db, keyWrapper);

    const view = await makeLoader(db, keyWrapper).load(aliceSession, {});
    const text = strip(render(view));

    // Alice's own words are on the screen …
    for (const seq of [1, 2, 3] as const) {
      assert.ok(text.includes(WORD[seq]), `the activity screen shows Alice's entry "${WORD[seq]}"`);
    }
    // … and Bob's never are (member scope is the session user, never a client value).
    assert.ok(
      !text.includes(BOB_WORD),
      "the loader must never surface another person's entry in Alice's activity view",
    );
    assert.ok(
      view.entries.every((entry) => !JSON.stringify(entry).includes(BOB_WORD)),
      "no returned entry carries another person's content",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC2 — the mounted controls call disputeEntry / undoEntry / checkIntegrity
// =====================================================================================

test("verify=1 runs the integrity check over the person's OWN chain; no verify leaves it unrun", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));
    const { aliceSession } = await seedWorld(db, keyWrapper);
    const loader = makeLoader(db, keyWrapper);

    // No Check-integrity control pressed ⇒ no result panel.
    const idle = await loader.load(aliceSession, {});
    assert.equal(idle.integrity, null, "without verify=1 the loader must not run the integrity check");

    // The Check-integrity control posts verify=1 ⇒ the loader runs checkIntegrity and
    // returns its result, scoped to Alice's own three-entry chain (intact).
    const checked = await loader.load(aliceSession, { verify: "1" });
    assert.ok(checked.integrity, "verify=1 must drive checkIntegrity and populate the result");
    assert.equal(checked.integrity?.intact, true, "Alice's sound chain verifies as intact");
    assert.equal(checked.integrity?.checked, 3, "the check covers exactly Alice's own 3 entries");
    assert.equal(checked.integrity?.brokenSeq, null, "an intact chain reports no broken seq");
  } finally {
    await db.close();
  }
});

test("the loader's props mount a live Dispute control on every entry and an Undo control only where reversible", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));
    const { aliceSession } = await seedWorld(db, keyWrapper);

    const view = await makeLoader(db, keyWrapper).load(aliceSession, {});

    // canUndo is reversalFor(tool): true for the create_event entry (seq 1) only.
    const undoable = view.entries.filter((entry) => entry.canUndo).map((entry) => entry.seq);
    assert.deepEqual(undoable, [1], "only the reversible entry (create_event, seq 1) is undoable");

    // The screen those props mount: a Dispute form per entry, an Undo form only for the
    // one reversible entry — so neither control is dead, and the Undo control is scoped.
    const counts = intentCounts(render(view));
    assert.equal(counts.dispute, 3, "every entry mounts a live Dispute control");
    assert.equal(counts.undo, 1, "an Undo control is mounted only for the reversible entry");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — filters and search narrow the rendered list
// =====================================================================================

test("the free-text search narrows the list to matching summaries (case-insensitively)", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));
    const { aliceSession } = await seedWorld(db, keyWrapper);
    const loader = makeLoader(db, keyWrapper);

    const lower = await loader.load(aliceSession, { q: WORD[2] });
    assert.deepEqual(seqsOf(lower), [2], "search matches only the entry whose summary contains the term");
    assert.equal(lower.query, WORD[2], "the loader echoes the search text so the box pre-fills");

    const upper = await loader.load(aliceSession, { q: WORD[2].toUpperCase() });
    assert.deepEqual(seqsOf(upper), [2], "search is case-insensitive");

    // The narrowed screen shows only the match.
    const text = strip(render(lower));
    assert.ok(text.includes(WORD[2]), "the matching entry is on the narrowed screen");
    assert.ok(!text.includes(WORD[1]) && !text.includes(WORD[3]), "the non-matching entries are gone");
  } finally {
    await db.close();
  }
});

test("the agent and service facet filters narrow the list to matching entries", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));
    const { aliceSession } = await seedWorld(db, keyWrapper);
    const loader = makeLoader(db, keyWrapper);

    // Agent: agent-claude is on seq 1 & 3 (newest-first ⇒ 3, 1).
    const byAgent = await loader.load(aliceSession, { agent: "agent-claude" });
    assert.deepEqual(seqsOf(byAgent), [3, 1], "the agent filter narrows to that agent's entries");

    // Service maps to the connected service (connectorId): gmail is on seq 2 & 3.
    const byService = await loader.load(aliceSession, { service: "gmail" });
    assert.deepEqual(seqsOf(byService), [3, 2], "the service filter narrows to that service's entries");

    // The narrowed screen for the agent filter shows only those entries.
    const text = strip(render(byAgent));
    assert.ok(text.includes(WORD[1]) && text.includes(WORD[3]), "agent-claude's entries are shown");
    assert.ok(!text.includes(WORD[2]), "the other agent's entry is filtered out");
  } finally {
    await db.close();
  }
});

test("the date-range filter narrows to entries inside the inclusive window", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));
    const { aliceSession } = await seedWorld(db, keyWrapper);

    // March only ⇒ just seq 2 (seq 1 is Feb, seq 3 is Apr).
    const march = await makeLoader(db, keyWrapper).load(aliceSession, {
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-03-31T23:59:59.999Z",
    });
    assert.deepEqual(seqsOf(march), [2], "the date range narrows to entries inside the window");
  } finally {
    await db.close();
  }
});

test("the filter dropdowns offer the person's own agents and services as filter values", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));
    const { aliceSession } = await seedWorld(db, keyWrapper);

    const view = await makeLoader(db, keyWrapper).load(aliceSession, {});

    // Each facet option is posted back verbatim as the filter value, so the options must
    // BE the filterable values present in Alice's entries (the round-trip the AC needs).
    for (const agent of ["agent-claude", "agent-gpt"]) {
      assert.ok(view.filterOptions.agents.includes(agent), `the agent filter offers "${agent}"`);
    }
    for (const service of ["google_calendar", "gmail"]) {
      assert.ok(view.filterOptions.services.includes(service), `the service filter offers "${service}"`);
    }
  } finally {
    await db.close();
  }
});

test("a person with no activity gets an empty list and the empty state renders", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));
    const clock = makeClock("2026-01-01T00:00:00.000Z");
    const emptyId = await makePerson(db, keyWrapper, "loneemu@people.example", randomBytes(DEK_BYTES));
    const session = await sessionFor(db, emptyId, clock);

    const view = await makeLoader(db, keyWrapper).load(session, {});
    assert.deepEqual(view.entries, [], "a person with no entries gets an empty list");

    const text = strip(render(view));
    assert.ok(text.includes("no activity yet"), "the empty state renders when there are no entries");
  } finally {
    await db.close();
  }
});
