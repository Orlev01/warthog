// E18-S08 — Home page loader: feed the dashboard from the two owner-scoped reads
// (the home-loader half — the sibling `actions.ts` seam the thin `home/page.tsx`
// loader composes).
//
// RED-first: today the loader is the MINIMAL E18-S13 placeholder — it hard-codes
// the checklist as `computeSetupChecklist({})` (every item not done) and the
// data-bearing sections as the empty states (`pendingApprovals: 0`, and empty
// `activity` / `agents` / `reminders`), reading NONE of the person's real set-up
// progress or live metrics. E18-S08 extends it to feed the dashboard view from the
// two already-built owner-scoped reads — the set-up status read (`loadSetupChecklist`,
// E18-S04) and the dashboard metrics read (`loadHomeMetrics`, E18-S05) — so the five
// checklist items reflect the person's REAL progress and the approvals/activity the
// person actually has show up. Until the builder wires those in, the tests that seed
// real progress + real metrics FAIL (and `tsc --noEmit` reddens on the new `clock`
// dep the reads require). That absence IS the point of test-first — do NOT implement
// anything to make these pass.
//
// Why the sibling `actions.ts` seam (not `page.tsx`): a Next `page.tsx` entry file
// may export ONLY its framework fields, so it cannot carry an injectable,
// unit-testable seam without breaking `next build`. The thin `page.tsx` loader reads
// the session cookie + the process-wide database (from `getServerDb()`) and renders
// the view; the testable logic — turning the verified session into the dashboard's
// props from the two reads — lives in the plain sibling `createHomeActions` factory
// (the convention's `createXActions({ db, ... })` pattern, exactly as the sibling
// security page uses `createSecurityActions`). These tests drive that factory
// directly against an isolated in-memory PGlite with the REAL migrations (src/test/db)
// and the REAL stores, so no test touches the network or Azure, and none asserts on
// the source text of any module — a later behaviour-preserving refactor stays green.
//
// ─── Acceptance criteria → tests ────────────────────────────────────────────────────
//   AC1  "A signed-in GET /home renders the dashboard view fed by the set-up status
//        read and the dashboard metrics read for the session user, so a freshly
//        signed-up user sees all five checklist items not done and plain empty states
//        while a user with a pending approval and recent activity sees the count and
//        the entries."
//          → "a freshly signed-up user: all five set-up items not done and plain
//            empty states" (the empty path through BOTH reads),
//          → "a user with a pending approval and recent activity sees the count and
//            the entries" (the populated path — the headline behaviour),
//          → "the set-up checklist reflects the person's real progress" (the set-up
//            status read is actually driving the checklist, not a hard-coded empty).
//
//   Security (design §5 — every member-scoped read takes the user id from the SESSION,
//   never a client value; CLAUDE.md: every member-scoped task has an ownership test):
//          → "the loader surfaces only the session person's approvals and activity,
//            never another account's".
//
//   AC2  "The loader selects the in-memory Queryable when the configured database URL
//        starts with 'memory:' and the real pool otherwise, branching at the loader
//        (not inside the reads), so /home is drivable under next dev without Postgres."
//        In THIS project that branch is NOT a `startsWith('memory:')` check in the
//        page: the project addendum forbids `createDb` in `src/app/**` and has every
//        server page take its database from `getServerDb()` (src/server/db/server.ts),
//        which calls `createDb(loadConfig().databaseUrl)` — the ONE composition root
//        that selects the in-process PGlite Queryable for a `pglite:` URL and the real
//        `pg` Pool for a `postgres://` one, keyed on the URL scheme (see
//        src/server/db/index.ts; covered by its own tests). The behavioural heart of
//        AC2 — "the reads do NOT branch on the URL (they take an injected `Db`), so the
//        loader + reads run against the in-memory Queryable with no Postgres" — is what
//        every test below exercises: each drives `createHomeActions({ db, ... })` with
//        an injected in-memory `Db` from `freshDb()` and gets real data back. (The
//        wording of AC2 is noted as superseded by the project's getServerDb convention.)
//
// Every db handle is closed in a `finally` so node:test leaves no open handle; each
// test uses its own `freshDb()`. We render the view with `react-dom/server` (no
// DOM/jsdom — React component / E2E testing is a per-job ADR) and read the emitted
// markup, exactly as the existing home tests do.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createHomeActions } from "./actions";

import { DashboardView } from "@/components/home/dashboard-view";
import { createUser } from "@/server/db/users";
import { createSession, type Session } from "@/server/auth/session";
import { createApproval } from "@/server/db/approvals";
import { createAgent } from "@/server/db/agents";
import { createRecord } from "@/server/db/life-admin-records";
import { createCustomCategory } from "@/server/db/life-admin-categories";
import { saveIdentityField } from "@/server/db/identity-fields";
import { createDbRecorder } from "@/server/activity/writer";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock, type Clock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

// A frozen instant used as "now": a session created at NOW and read at NOW is
// comfortably inside its expiry window, and the activity / spend-period / "upcoming"
// derivations are deterministic (no wall-clock dependence).
const NOW = new Date("2026-11-15T12:00:00.000Z");
const clock: Clock = fixedClock(NOW);

// One real local KeyWrapper (dev/test) for the whole file — exactly the one a
// non-production composition root selects — so a stored wrapped-DEK really unwraps to
// the DEK the seed encrypted the activity payloads and identity fields under, and the
// loader's reads can decrypt them.
const keyWrapper: KeyWrapper = localAesKeyWrapper(randomBytes(32));

// The five set-up checklist labels, in documented order (the one source of them is
// the domain module; this test hard-codes none of the done-state logic).
const SET_UP_TITLES = [
  "Connect an agent",
  "Connect a service",
  "Add your details",
  "Get notified",
  "Add a card",
] as const;

test("reminders use the owner's saved title or name and friendly category fallbacks", async () => {
  const db = await freshDb();
  try {
    const owner = await seedSignedIn(db, "reminder-owner@example.com");
    const other = await seedSignedIn(db, "reminder-other@example.com");
    for (const [kind, fields] of [
      ["subscription", { name: "Mobile plan" }],
      ["receipt_warranty", { title: "Laptop", name: "Other name" }],
      ["renewal_appointment", { what: "Passport" }],
      ["subscription", { name: "   " }],
      ["receipt_warranty", {}],
      ["renewal_appointment", {}],
    ] as const) {
      await createRecord(db, { userId: owner.userId, kind, fields, dueDate: "2027-02-28", status: "active", source: { kind: "person" } }, owner.dek);
    }
    await createRecord(db, { userId: other.userId, kind: "subscription", fields: { name: "Other person's private title" }, dueDate: "2027-02-28", status: "active", source: { kind: "person" } }, other.dek);
    const view = await makeActions(db).load(owner.session);
    assert.deepEqual(view.reminders.map((reminder) => reminder.title).sort(), [
      "Laptop", "Mobile plan", "Passport", "Receipt or warranty", "Renewal or appointment", "Subscription",
    ].sort());
  } finally {
    await db.close();
  }
});

test("each reminder links to its record in Life admin, says what its date means, and marks a recent overdue one; suggestions are counted", async () => {
  const db = await freshDb();
  try {
    const owner = await seedSignedIn(db, "reminder-links@example.com");
    const rego = await createRecord(db, { userId: owner.userId, kind: "item", type: "vehicles.registration", fields: { provider: "Transport for NSW" }, dueDate: "2026-12-14", status: "active", source: { kind: "person" } }, owner.dek);
    const lapsed = await createRecord(db, { userId: owner.userId, kind: "item", type: "health.insurance", fields: { provider: "Medibank" }, dueDate: "2026-11-02", status: "active", source: { kind: "agent", agentId: "agent-1" } }, owner.dek);
    const view = await makeActions(db).load(owner.session);
    assert.deepEqual(view.reminders, [
      { id: lapsed.id, title: "Medibank", due: "2 Nov 2026", dueLabel: "Renews or extras reset", overdue: true, href: `/life-admin?view=life&tab=things#record-${lapsed.id}` },
      { id: rego.id, title: "Transport for NSW", due: "14 Dec 2026", dueLabel: "Expires", href: `/life-admin?view=life&tab=things#record-${rego.id}` },
    ]);
    assert.deepEqual(view.toCheck, { count: 1, href: "/life-admin?view=life&tab=things" }, "the agent's record waits to be checked");
  } finally {
    await db.close();
  }
});

test("a kind of the person's own category reads its reminder its own way; a stay that has started is happening, not overdue", async () => {
  const db = await freshDb();
  try {
    const owner = await seedSignedIn(db, "reminder-custom@example.com");
    const { slug } = await createCustomCategory(db, {
      userId: owner.userId,
      state: "active",
      origin: { kind: "person" },
      definition: {
        label: "Boat", description: "The boat.", lifeArea: "getting_around", icon: "sailboat",
        kinds: [{ key: "mooring", label: "Mooring", lifecycle: "standing", use: "A mooring licence.", fields: [], due: { means: "renews", label: "Licence renews" } }],
      },
    }, owner.dek, clock);
    const mooring = await createRecord(db, { userId: owner.userId, kind: "item", type: `${slug}.mooring`, fields: { provider: "Maritime NSW" }, dueDate: "2026-12-01", status: "active", source: { kind: "person" } }, owner.dek);
    const stay = await createRecord(db, {
      userId: owner.userId, kind: "item", type: "travel.stay",
      fields: { provider: "Park Hyatt", starts_at: "2026-11-14T15:00+11:00[Australia/Sydney]", ends_at: "2026-11-17T11:00+11:00[Australia/Sydney]" },
      dueDate: "2026-11-14", status: "active", state: "confirmed", source: { kind: "person" },
    }, owner.dek);
    const view = await makeActions(db).load(owner.session);
    const byId = new Map(view.reminders.map((reminder) => [reminder.id, reminder]));
    assert.equal(byId.get(mooring.id)?.dueLabel, "Licence renews");
    assert.equal(byId.get(stay.id)?.overdue, undefined, "a stay under way isn't overdue");
  } finally {
    await db.close();
  }
});

// --- the view model the loader returns -----------------------------------------
// Derived from the function itself so the test pins the BEHAVIOURAL fields without
// locking the props type's NAME (the existing home tests take the same approach).
type HomeView = Awaited<ReturnType<ReturnType<typeof createHomeActions>["load"]>>;

// Build the loader under test with the pinned deps — the real db seam, the key
// wrapper the reads need to decrypt the person's own data, and the fixed clock the
// metrics / set-up reads derive "now" through (so the test is deterministic).
function makeActions(db: Db) {
  return createHomeActions({ db, keyWrapper, clock });
}

// Seed a signed-in person whose stored wrapped-DEK really unwraps (under `keyWrapper`)
// to the returned `dek`, so values the seed encrypts under `dek` round-trip through the
// loader's reads. Returns the user id, that DEK, and the verified Session the loader
// consumes.
async function seedSignedIn(
  db: Db,
  email: string,
): Promise<{ userId: string; dek: Uint8Array; session: Session }> {
  const dek = randomBytes(32);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email, wrappedDek });
  const created = await createSession(db, user.id, { clock, random: systemRandom });
  return { userId: user.id, dek, session: created.session };
}

// Create one of `userId`'s agents (one row per connection) — used both to attribute
// activity and to flip the "Connect an agent" set-up signal.
async function connectAgent(db: Db, userId: string, displayName: string): Promise<{ id: string }> {
  const agent = await createAgent(
    db,
    { userId, connectionId: randomUUID(), displayName, platform: "Claude Desktop" },
    clock,
  );
  return { id: agent.id };
}

// Record one activity entry for `userId` at the instant `at`, its `summary` encrypted
// under the SAME `dek` the loader resolves. Reuses the DB-backed recorder (the
// production write path), so the entry is a genuine chained, encrypted row — exactly
// as the metrics read's own tests seed activity.
async function recordActivity(
  db: Db,
  dek: Uint8Array,
  userId: string,
  input: { at: Date; agentId: string; summary: string },
): Promise<void> {
  const recorder = createDbRecorder({ db, clock: fixedClock(input.at), dekFor: async () => dek });
  await recorder.record({
    userId,
    kind: "tool_call",
    source: "warthog",
    agentId: input.agentId,
    payload: { summary: input.summary },
  });
}

// --- markup helpers (no DOM), mirrored from the existing home tests --------------

function render(view: HomeView): string {
  return renderToStaticMarkup(<DashboardView {...view} />);
}

// Visible text with tags stripped: exactly the words a sighted reader sees. Decodes
// the entities that matter.
function strip(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Count the anchors in the markup that point at a given href.
function anchorsTo(markup: string, href: string): number {
  let n = 0;
  for (const m of markup.matchAll(/<a\b([^>]*)>/gi)) {
    const h = m[1]!.match(/\bhref="([^"]*)"/i);
    if (h && h[1] === href) n += 1;
  }
  return n;
}

// The `done` flag of a checklist item located by its label (so the test does not bet
// on array order).
function checklistDone(view: HomeView, label: string): boolean {
  const item = view.checklist.find((i) => i.label === label);
  assert.ok(item, `the set-up checklist must include "${label}"`);
  return item!.done;
}

// The summaries of the returned activity, in order — the per-entry marker the seeds
// plant, so ordering + membership can be asserted without an entry id.
function activitySummaries(view: HomeView): string[] {
  return view.activity.map((e) => e.summary);
}

// ===========================================================================
// AC1 — a freshly signed-up user: all five set-up items NOT done, plain empty states.
// ===========================================================================
//
// The EMPTY path through BOTH reads: with no set-up progress and no live data, the
// set-up status read yields the five items all not done and the metrics read yields
// nothing, so each data-bearing section renders a plain message, never a dead control.

test("a freshly signed-up user: all five set-up items not done and plain empty states", async () => {
  const db = await freshDb();
  try {
    const { session } = await seedSignedIn(db, "freshquokka@people.example");
    const view = await makeActions(db).load(session);

    // The checklist: the five first-run items, EVERY one not done.
    assert.equal(view.checklist.length, 5, "the checklist shows all five set-up items");
    assert.deepEqual(
      view.checklist.map((i) => i.label),
      [...SET_UP_TITLES],
      "the five set-up items come back in documented order",
    );
    assert.ok(
      view.checklist.every((item) => item.done === false),
      "every set-up checklist item is NOT done on a freshly signed-up account",
    );

    // Empty states: nothing pending, and no activity / agents / reminders yet.
    assert.equal(view.pendingApprovals, 0, "a fresh account has no pending approvals");
    assert.deepEqual(view.activity, [], "a fresh account has no recent activity");
    assert.deepEqual(view.agents, [], "a fresh account has no connected agents");
    assert.deepEqual(view.reminders, [], "a fresh account has no reminders");

    // The screen a signed-in GET /home renders (the 200 body): the five set-up titles
    // and the plain empty-state copy for the data-bearing sections.
    const text = strip(render(view));
    for (const title of SET_UP_TITLES) {
      assert.ok(text.includes(title), `the home screen must show the set-up item "${title}", got: "${text}"`);
    }
    // Before the first agent, Home is one task (UI/UX pass newcomer-01): Get started, with
    // the one action that makes Warthog work, and no wall of empty panels.
    assert.ok(text.includes("Get started"), "a brand-new member is asked to get started");
    assert.ok(text.includes("Connect your first agent"), "with one action: connect the first agent");
    assert.ok(!text.includes("Recent activity"), "no empty activity panel before the first agent");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — a user with a pending approval and recent activity sees the count and the
// entries (the headline behaviour the loader must feed from the metrics read).
// ===========================================================================

test("a user with a pending approval and recent activity sees the count and the entries", async () => {
  const db = await freshDb();
  try {
    const { session, userId, dek } = await seedSignedIn(db, "busybadger@people.example");

    // One pending approval (the count the dashboard must surface).
    await createApproval(
      db,
      { userId, agentId: randomUUID(), detail: { sentence: "Pay $20 at the shops" } },
      dek,
      clock,
    );

    // Two recent activity entries, distinct summaries, at increasing instants, from a
    // connected agent — so the feed must surface them, newest first.
    const agent = await connectAgent(db, userId, "Claude");
    await recordActivity(db, dek, userId, {
      at: new Date(NOW.getTime() - 2 * 60_000),
      agentId: agent.id,
      summary: "Rearranged the sock drawer",
    });
    await recordActivity(db, dek, userId, {
      at: new Date(NOW.getTime() - 1 * 60_000),
      agentId: agent.id,
      summary: "Booked a flight to Perth",
    });

    const view = await makeActions(db).load(session);

    // The count: the one pending approval is surfaced (decided ones excluded by the read).
    assert.equal(view.pendingApprovals, 1, "the one pending approval is surfaced as the count");

    // The entries: both recent activity summaries are present, newest first.
    const summaries = activitySummaries(view);
    assert.ok(summaries.includes("Booked a flight to Perth"), "the newest activity entry is present and decrypted");
    assert.ok(summaries.includes("Rearranged the sock drawer"), "the older activity entry is present and decrypted");
    assert.ok(
      summaries.indexOf("Booked a flight to Perth") < summaries.indexOf("Rearranged the sock drawer"),
      "recent activity is ordered newest first",
    );

    // The screen a signed-in GET /home renders: the count (linked to the inbox) and
    // the entries. With a pending approval the approvals section is a count-link to
    // /inbox, not a dead/empty message.
    const markup = render(view);
    const text = strip(markup);
    assert.ok(/1 request is waiting for your approval/i.test(text), `the home screen shows the pending-approval count, got: "${text}"`);
    assert.ok(anchorsTo(markup, "/inbox") >= 1, "the pending-approval count links to the inbox");
    assert.ok(text.includes("Booked a flight to Perth"), "the home screen shows the recent activity entry");
    assert.ok(text.includes("Rearranged the sock drawer"), "the home screen shows the older activity entry");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC1 — the set-up checklist reflects the person's REAL progress (the set-up status
// read is actually driving the checklist, not a hard-coded all-not-done).
// ===========================================================================

test("the set-up checklist reflects the person's real progress: completed steps show done", async () => {
  const db = await freshDb();
  try {
    const { session, userId, dek } = await seedSignedIn(db, "keenkoala@people.example");

    // Complete two set-up steps: save an everyday detail ("Add your details"; the name
    // sign-up saves doesn't count on its own) and connect an agent ("Connect an agent").
    // The other three remain not done.
    await saveIdentityField(db, { userId, kind: "phone", value: "0400 000 000" }, dek);
    await connectAgent(db, userId, "Claude");

    const view = await makeActions(db).load(session);

    assert.equal(checklistDone(view, "Add your details"), true, "a saved everyday detail marks 'Add your details' done");
    assert.equal(checklistDone(view, "Connect an agent"), true, "a connected agent marks 'Connect an agent' done");
    assert.equal(checklistDone(view, "Get notified"), false, "an untouched step stays not done");
    assert.equal(checklistDone(view, "Add a card"), false, "an untouched step stays not done");
    assert.equal(checklistDone(view, "Connect a service"), false, "an untouched step stays not done");
  } finally {
    await db.close();
  }
});

// ===========================================================================
// Security (design §5) — the loader surfaces only the SESSION person's data. Every
// figure is scoped to `session.userId`, never a client value; one person can never
// read another's approvals or activity.
// ===========================================================================

test("the loader surfaces only the session person's approvals and activity, never another account's", async () => {
  const db = await freshDb();
  try {
    const mine = await seedSignedIn(db, "myturtle@people.example");
    const other = await seedSignedIn(db, "theirotter@people.example");

    // Mine: ONE pending approval and ONE activity entry.
    await createApproval(
      db,
      { userId: mine.userId, agentId: randomUUID(), detail: { sentence: "My payment" } },
      mine.dek,
      clock,
    );
    const myAgent = await connectAgent(db, mine.userId, "Mine");
    await recordActivity(db, mine.dek, mine.userId, { at: NOW, agentId: myAgent.id, summary: "MINE-did-a-thing" });

    // Theirs: TWO pending approvals and a DIFFERENT activity entry.
    await createApproval(
      db,
      { userId: other.userId, agentId: randomUUID(), detail: { sentence: "Their payment 1" } },
      other.dek,
      clock,
    );
    await createApproval(
      db,
      { userId: other.userId, agentId: randomUUID(), detail: { sentence: "Their payment 2" } },
      other.dek,
      clock,
    );
    const theirAgent = await connectAgent(db, other.userId, "Theirs");
    await recordActivity(db, other.dek, other.userId, {
      at: NOW,
      agentId: theirAgent.id,
      summary: "THEIRS-did-a-thing",
    });

    // My read reflects ONLY my data — the session's user id scopes every figure.
    const view = await makeActions(db).load(mine.session);

    assert.equal(
      view.pendingApprovals,
      1,
      "the count is the session person's own pending approvals (1), never the other account's (2)",
    );
    const summaries = activitySummaries(view);
    assert.ok(summaries.includes("MINE-did-a-thing"), "the session person's own activity is present");
    assert.ok(
      !summaries.includes("THEIRS-did-a-thing"),
      "another account's activity must never leak into the session person's feed",
    );
  } finally {
    await db.close();
  }
});
