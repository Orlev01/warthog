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
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createActivityActions } from "./actions";

import { ActivityView, type ActivityViewProps } from "@/components/activity/activity-view";
import { createDbRecorder } from "@/server/activity/writer";
import { createUndoService } from "@/server/activity/undo";
import { listActivity } from "@/server/activity/list";
import type { ActivityRecorder, ActivityEntryInput } from "@/server/activity/recorder";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { createUser } from "@/server/db/users";
import { createAgent } from "@/server/db/agents";
import { upsertPermissions } from "@/server/db/agent-permissions";
import { createSession, type Session } from "@/server/auth/session";
import { loadConfig, type Config } from "@/server/config";
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

// A stand-in server action the page binds to the Dispute/Undo controls. Binding an
// action is what makes a control LIVE (E08-S10); the loader's own props omit the actions,
// so a test that probes live controls passes them when it renders.
const noopAction = async (_formData: FormData): Promise<void> => {};

// Render the mounted screen the page shows over the loader's props. The page binds the
// Dispute/Undo server actions separately from the loader's props; pass them here to render
// the LIVE controls, or omit them to render the loader's props alone.
function render(
  view: ActivityViewProps,
  actions?: {
    disputeAction?: (formData: FormData) => void | Promise<void>;
    undoAction?: (formData: FormData) => void | Promise<void>;
  },
): string {
  return renderToStaticMarkup(<ActivityView {...view} {...actions} />);
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

// Every <button> as { label, disabled } — the accessible face of each control the view
// mounts, so a live (enabled) Dispute/Undo control can be told from a disabled one.
function controls(markup: string): { label: string; disabled: boolean }[] {
  const out: { label: string; disabled: boolean }[] = [];
  for (const m of markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const label = m[2]!.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    out.push({ label, disabled: /\bdisabled\b/i.test(m[1]!) });
  }
  return out;
}

// Count LIVE (enabled) controls whose face matches `re`.
function liveCount(markup: string, re: RegExp): number {
  return controls(markup).filter((c) => re.test(c.label) && !c.disabled).length;
}

// The inner markup of each <form> whose button face matches `re` (forms don't nest).
function formsFor(markup: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of markup.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)) {
    const inner = m[1]!;
    if (new RegExp(re).test(inner.replace(/<[^>]*>/g, " "))) out.push(inner);
  }
  return out;
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

    // The screen those props mount once the page binds the Dispute/Undo server actions
    // (E08-S10): a LIVE Dispute control per entry, and a LIVE Undo control only for the one
    // reversible entry — so neither is dead, and the Undo control is scoped.
    const markup = render(view, { disputeAction: noopAction, undoAction: noopAction });
    assert.equal(liveCount(markup, /dispute/i), 3, "every entry mounts a live Dispute control");
    assert.equal(liveCount(markup, /\bundo\b/i), 1, "a live Undo control is mounted only for the reversible entry");

    // The one Undo control carries the reversible entry's seq (seq 1) the undo action consumes.
    const undoForms = formsFor(markup, /\bundo\b/i);
    assert.equal(undoForms.length, 1, "exactly one Undo form");
    assert.match(undoForms[0]!, /name="seq"/, "the Undo form carries a seq field");
    assert.match(undoForms[0]!, /value="1"/, "the Undo form's seq is the reversible entry's (seq 1)");
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

// =====================================================================================
// E08-S10 — a date-only 'to' is widened to the END of that day; entry labels show the
// time of day as well as the date
// =====================================================================================

test("a date-only 'to' filter includes entries from the whole of that day (end-of-day inclusive)", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));
    const clock = makeClock("2026-01-01T00:00:00.000Z");
    const dek = randomBytes(DEK_BYTES);
    const aliceId = await makePerson(db, keyWrapper, "dayfilter@people.example", dek);
    const recorder = makeRecorder(db, clock, { [aliceId]: dek });

    // Two entries ON 2026-04-20 — one just after midnight, one mid-afternoon …
    await record(recorder, clock, "2026-04-20T00:05:00.000Z", {
      userId: aliceId,
      kind: "tool_call",
      source: "warthog",
      payload: { summary: "morningword entry", detail: "d" },
    }); // seq 1
    await record(recorder, clock, "2026-04-20T15:30:00.000Z", {
      userId: aliceId,
      kind: "tool_call",
      source: "warthog",
      payload: { summary: "afternoonword entry", detail: "d" },
    }); // seq 2
    // … and one the NEXT day, which a 'to' of 2026-04-20 must NOT include.
    await record(recorder, clock, "2026-04-21T09:00:00.000Z", {
      userId: aliceId,
      kind: "tool_call",
      source: "warthog",
      payload: { summary: "nextdayword entry", detail: "d" },
    }); // seq 3
    const session = await sessionFor(db, aliceId, clock);

    // A date-ONLY 'to' (no time of day, exactly what the view's `<input type="date">`
    // posts) must widen to the END of that day. Without widening, `occurred_at <=
    // 2026-04-20T00:00:00Z` would drop BOTH of that day's entries (00:05 and 15:30 are
    // both after midnight); widened, both are inside the window and the next day is out.
    const view = await makeLoader(db, keyWrapper).load(session, { to: "2026-04-20" });
    assert.deepEqual(
      seqsOf(view),
      [2, 1],
      "both of 2026-04-20's entries are inside the inclusive day window, newest-first",
    );

    const text = strip(render(view));
    assert.ok(text.includes("afternoonword"), "the mid-afternoon entry is included (end-of-day inclusive)");
    assert.ok(text.includes("morningword"), "the just-after-midnight entry is included");
    assert.ok(!text.includes("nextdayword"), "an entry from the next day is outside the 'to' day");
  } finally {
    await db.close();
  }
});

test("entry labels show the time of day as well as the date", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));
    const clock = makeClock("2026-01-01T00:00:00.000Z");
    const dek = randomBytes(DEK_BYTES);
    const aliceId = await makePerson(db, keyWrapper, "timelabel@people.example", dek);
    const recorder = makeRecorder(db, clock, { [aliceId]: dek });

    // Two entries on the SAME calendar day at DIFFERENT times of day (12½ hours apart,
    // so they differ in time of day under any time zone).
    await record(recorder, clock, "2026-05-10T09:15:00.000Z", {
      userId: aliceId,
      kind: "tool_call",
      source: "warthog",
      payload: { summary: "morning entry word", detail: "d" },
    }); // seq 1
    await record(recorder, clock, "2026-05-10T21:45:00.000Z", {
      userId: aliceId,
      kind: "tool_call",
      source: "warthog",
      payload: { summary: "evening entry word", detail: "d" },
    }); // seq 2
    const session = await sessionFor(db, aliceId, clock);

    const view = await makeLoader(db, keyWrapper).load(session, {});
    const labels = view.entries.map((entry) => entry.at);
    assert.equal(view.entries.length, 2, "both entries are listed");
    assert.ok(
      labels.every((label) => label.length > 0),
      "every entry carries a time label",
    );
    // Two entries on the SAME date but different times of day get DISTINCT labels — the
    // label must carry the time of day, not only the date (which is identical here).
    assert.notEqual(
      labels[0],
      labels[1],
      "same-day entries at different times get distinct labels (the label shows the time of day)",
    );
    // … and the label still shows the DATE too (not only the time) — the year or the
    // month of these May-2026 entries is present, so it reads as a date AND a time.
    assert.ok(
      labels.every((label) => /2026|may/i.test(label)),
      "each label still shows the date (year or month), not only the time of day",
    );
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

// =====================================================================================
// E07-S20 — Undo is a LIVE control for an entry whose tool declares a reversal, wired
// through the MCP composition root, instead of being disabled with "undo execution is
// not configured".
//
// BEHAVIOUR SUPERSESSION (declared by the plan for THIS file): until E07-S20 the activity
// page built its undo service with a stub `runReversal` that THREW "undo execution is not
// configured", so the page supplied NO `undoAction` and a reversible entry's Undo rendered
// DISABLED (no dead control over a throwing executor). This task wires `runReversal` to the
// real agent-call pipeline through the composition root, so a reversible entry's Undo is a
// LIVE control that runs the reversal once and reports the outcome in plain words.
//
// RED-first: the composition root does NOT export the executor factory yet, so
// `createAgentExecutors` is absent and this test fails at `composeExecutors(...)` — that
// absence IS the point of test-first. The builder adds the factory to
// `src/server/mcp/compose.ts` (within this task's Touches) and binds the live undoAction.
//
// The pinned contract (the builder implements exactly this, alongside the existing
// `createMcpDispatch`, which compose.test.ts locks to a dispatch function and MUST keep):
//
//   createAgentExecutors(deps: { db: Db; config: Config }): {
//     executeApprovedHold(userId, approvalId): Promise<ApprovedHoldResult>;
//     runReversal(job: { userId; reversalTool; originalSeq; reason? }): Promise<{ outcome: string }>;
//   }
//
// `runReversal` is the undo service's reversal executor (the same seam shape undo.ts takes,
// routed through the pipeline), built from { db, config } (the composition root's two
// inputs). It REPORTS an outcome in plain words — it never fails silently and never throws
// the old "not configured" stub — so the undo service can always record the reversal entry.
// The user id is the CALLER's (the session's), never a form value.
//
// This drives the REAL undo service + pipeline over an isolated PGlite with the real stores
// and asserts BEHAVIOUR (a live Undo renders only for the reversible entry; undoing runs the
// reversal and appends a new recorded entry; a non-reversible entry is refused), never the
// source text of any module.

// The executor factory this task adds to the composition root (the pinned contract). Only
// `runReversal` is exercised here; executeApprovedHold is the inbox side's twin.
type ApprovedHoldResult =
  | { status: "executed"; result: unknown }
  | { status: "refused"; reason: string };
type AgentExecutors = {
  executeApprovedHold(userId: string, approvalId: string): Promise<ApprovedHoldResult>;
  runReversal(job: {
    userId: string;
    reversalTool: string;
    originalSeq: number;
    reason?: string;
  }): Promise<{ outcome: string }>;
};

// The composition-root module as this task widens it. The factory is OPTIONAL in the view
// so the file type-checks before the builder adds it; at runtime it is absent until then,
// so `composeExecutors` fails LOUDLY (RED). Loaded dynamically so this one unbuilt seam
// reddens only THIS test, not the whole file.
type ComposeModule = {
  createAgentExecutors?: (deps: { db: Db; config: Config }) => AgentExecutors;
};

async function composeExecutors(db: Db, config: Config): Promise<AgentExecutors> {
  const mod = (await import("../../../../server/mcp/compose")) as unknown as ComposeModule;
  assert.equal(
    typeof mod.createAgentExecutors,
    "function",
    "E07-S20: compose must export createAgentExecutors({ db, config }) → { executeApprovedHold, runReversal }",
  );
  return mod.createAgentExecutors!({ db, config });
}

// A dev config whose devKek is the local KEK the composition root derives its KeyWrapper
// from, so the DEK we wrap below is exactly what the composed executor unwraps.
const HMAC_KEY_B64 = Buffer.alloc(48, 0x2a).toString("base64");
const DEV_KEK_B64 = Buffer.alloc(32, 0x5c).toString("base64");
function devConfig(): Config {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "https://warthog.example",
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: HMAC_KEY_B64,
    WARTHOG_DEV_KEK: DEV_KEK_B64,
  } as NodeJS.ProcessEnv);
}

test("a reversible entry gets a live Undo that runs the reversal once and reports the outcome; a non-reversible entry shows no Undo", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const keyWrapper = localAesKeyWrapper(config.devKek!);
    const clock = makeClock("2026-02-01T00:00:00.000Z");
    const dek = randomBytes(DEK_BYTES);
    const userId = await makePerson(db, keyWrapper, `undo-${randomUUID()}@people.example`, dek);

    // A real agent connection the reversal can resolve. No connector is granted, so routing
    // the reversal tool through the pipeline is cleanly declined — the reversal still reports
    // an outcome in plain words rather than throwing.
    const connectionId = randomUUID();
    const agent = await createAgent(
      db,
      { userId, connectionId, displayName: "Claude", platform: "claude" },
      clock,
    );
    await upsertPermissions(db, {
      userId,
      connectionId,
      grantedConnectors: [],
      readTools: true,
      changeTools: "allow",
      identityAccess: false,
      highTierAccess: false,
      cardAccess: false,
      cardBudget: null,
      skillsScope: [],
      memoryRead: true,
      sharing: false,
      rulesScope: [],
      rateLimit: 120,
    });

    // seq 1 — a reversible create_event; seq 2 — a read (list_events) that declares no reversal.
    const recorder = makeRecorder(db, clock, { [userId]: dek });
    await record(recorder, clock, "2026-02-10T00:00:00.000Z", {
      userId,
      kind: "tool_call",
      source: "warthog",
      agentId: agent.id,
      connectorId: "google_calendar",
      tool: CREATE_EVENT,
      outcome: "ok",
      payload: { summary: "Booked a dentist slot", detail: "slot detail" },
    });
    await record(recorder, clock, "2026-03-10T00:00:00.000Z", {
      userId,
      kind: "tool_call",
      source: "agent_reported",
      agentId: agent.id,
      connectorId: "google_calendar",
      tool: LIST_EVENTS,
      outcome: "done",
      payload: { summary: "Read the diary", detail: "diary detail" },
    });

    const executors = await composeExecutors(db, config);
    assert.equal(typeof executors.runReversal, "function", "the composition root builds a runReversal executor");

    // The undo service the activity page composes: the real recorder + reversal table + the
    // pipeline-backed runReversal from the composition root (no "not configured" stub).
    const undo = createUndoService({
      db,
      recorder: makeRecorder(db, clock, { [userId]: dek }),
      reversalFor,
      runReversal: executors.runReversal,
    });
    const actions = createActivityActions({ db, disputes: unusedDisputes, undo, keyWrapper, reversalFor });
    const session = await sessionFor(db, userId, clock);

    // The loader + rendered screen: a LIVE Undo on the reversible entry only, carrying its seq.
    const view = await actions.load(session, {});
    const markup = render(view, { disputeAction: noopAction, undoAction: noopAction });
    assert.equal(liveCount(markup, /\bundo\b/i), 1, "a live Undo is mounted for the entry with a declared reversal");
    const undoForms = formsFor(markup, /\bundo\b/i);
    assert.equal(undoForms.length, 1, "exactly one Undo form");
    assert.match(undoForms[0]!, /value="1"/, "the live Undo carries the reversible entry's seq (1)");

    // Undo the reversible entry → the reversal runs and reports a plain-words outcome,
    // appended as a NEW warthog activity entry. The original entry is never altered.
    const before = (await listActivity(db, userId, {}, dek)).filter((e) => e.tool === DELETE_EVENT).length;
    assert.equal(before, 0, "no reversal entry exists before the undo");

    const undone = await actions.undoEntry(session, 1, "undo the booking");
    assert.equal(undone.ok, true, "undoing a reversible entry succeeds — the reversal is wired and ran");

    const afterUndo = await listActivity(db, userId, {}, dek);
    const reversalEntries = afterUndo.filter((e) => e.tool === DELETE_EVENT && e.source === "warthog");
    assert.ok(reversalEntries.length >= 1, "the reversal ran and was recorded as a new warthog entry");
    assert.ok(
      reversalEntries.every((e) => typeof e.outcome === "string" && (e.outcome ?? "").length > 0),
      "the reversal's outcome is reported in plain words, never blank or silent",
    );
    assert.ok(afterUndo.some((e) => e.tool === CREATE_EVENT), "the original entry is untouched (append-only)");
    const reversalCount = reversalEntries.length;

    // An entry that declares NO reversal cannot be undone — it is refused and nothing more
    // is run or recorded (entries without a reversal show no Undo).
    const notReversible = await actions.undoEntry(session, 2);
    assert.equal(notReversible.ok, false, "an entry with no declared reversal is refused (shown no Undo)");
    assert.equal(
      (await listActivity(db, userId, {}, dek)).filter((e) => e.tool === DELETE_EVENT).length,
      reversalCount,
      "a refused undo runs and records no reversal",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix G11 — the filters show what is applied, and bad dates never crash the page.
// A hand-made `?from=yesterday-ish` reached `occurred_at >= $n` as a timestamp cast and
// threw (a 500); and after "filter to Claude" the list was filtered but every control
// still read "All …" with the panel collapsed, so pressing Apply again silently dropped
// the filter. The loader now validates dates and hands the applied filters back.
// =====================================================================================

test("a malformed from/to date is ignored (never a server error) and not reported as applied", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));
    const { aliceSession } = await seedWorld(db, keyWrapper);
    const loader = makeLoader(db, keyWrapper);
    for (const bad of ["yesterday-ish", "2026-13-45", "'; DROP TABLE activity_entries; --"]) {
      const view = await loader.load(aliceSession, { from: bad, to: bad });
      assert.deepEqual(seqsOf(view), [3, 2, 1], `"${bad}" narrows nothing`);
      assert.equal(view.activeFilters?.from, undefined);
      assert.equal(view.activeFilters?.to, undefined);
    }
  } finally {
    await db.close();
  }
});

test("the loader hands back the applied filters so the controls can show them", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));
    const { aliceSession } = await seedWorld(db, keyWrapper);
    const view = await makeLoader(db, keyWrapper).load(aliceSession, {
      agent: "agent-claude",
      service: "gmail",
      from: "2026-03-01",
      to: "2026-04-30",
    });
    assert.deepEqual(view.activeFilters, {
      agent: "agent-claude",
      service: "gmail",
      from: "2026-03-01",
      to: "2026-04-30",
    });
    assert.deepEqual(seqsOf(view), [3]);
  } finally {
    await db.close();
  }
});

// Review fix (E7 follow-through): the loader reads ONE bounded page of the newest entries
// and builds the dropdowns from the plaintext facet columns, so a long history is never
// decrypted whole and the filters still offer values from outside the page.
test("the loader shows a bounded page of the newest entries; the filters still offer every agent", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));
    const { aliceSession } = await seedWorld(db, keyWrapper);

    const loader = createActivityActions({
      db,
      disputes: unusedDisputes,
      undo: unusedUndo,
      keyWrapper,
      reversalFor,
      pageLimit: 2,
    });
    const view = await loader.load(aliceSession, {});

    assert.deepEqual(seqsOf(view), [3, 2], "only the newest two entries are read");
    for (const agent of ["agent-claude", "agent-gpt"]) {
      assert.ok(view.filterOptions.agents.includes(agent), `the agent filter still offers "${agent}"`);
    }
  } finally {
    await db.close();
  }
});
