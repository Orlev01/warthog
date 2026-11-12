// The Activity screen's views, driven through the REAL loader over PGlite and rendered
// through the real <ActivityView> (the founder's 12 November request: a timeline across all
// agents, activity grouped by agent with a drill-down, and activity grouped by type).
//
//   • By agent shows one row per agent with exact counts and what needs attention, and a
//     row for entries with no agent; clicking an agent opens its filtered timeline with a
//     way back.
//   • By type counts reads and changes separately, and never counts an agent's own report.
//   • The timeline is headed by day and keeps every control's accessible name unique.
//   • The filter and integrity forms carry the current view and filters.
//   • Everything is the session person's own: another person's agent never appears.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createActivityActions } from "./actions";
import { ActivityView } from "@/components/activity/activity-view";
import { createDbRecorder } from "@/server/activity/writer";
import { localAesKeyWrapper, type KeyWrapper } from "@/server/crypto/key-wrapper";
import { createUser } from "@/server/db/users";
import { createAgent } from "@/server/db/agents";
import { createSession, type Session } from "@/server/auth/session";
import { fixedClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

const NOW = new Date("2026-11-12T03:00:00.000Z");

async function makePerson(db: Db, keyWrapper: KeyWrapper, who: string) {
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `${who}-${randomUUID()}@people.example`, wrappedDek: await keyWrapper.wrap(dek) });
  const session: Session = (await createSession(db, user.id, { clock: fixedClock(NOW), random: systemRandom })).session;
  return { userId: user.id, dek, session };
}

async function seed(db: Db, keyWrapper: KeyWrapper) {
  const alice = await makePerson(db, keyWrapper, "alice");
  const claude = await createAgent(db, { userId: alice.userId, connectionId: randomUUID(), displayName: "Claude", platform: "Claude" }, fixedClock(NOW));
  const chatgpt = await createAgent(db, { userId: alice.userId, connectionId: randomUUID(), displayName: "ChatGPT", platform: "ChatGPT" }, fixedClock(NOW));
  const at = (iso: string) => createDbRecorder({ db, clock: fixedClock(new Date(iso)), dekFor: async () => alice.dek });
  await at("2026-11-10T01:00:00Z").record({ userId: alice.userId, agentId: claude.id, kind: "tool_call", source: "warthog", tool: "search_memory", outcome: "executed", payload: { summary: "searched memory" } });
  await at("2026-11-11T01:00:00Z").record({ userId: alice.userId, agentId: claude.id, kind: "tool_call", source: "warthog", connectorId: "google-gmail", tool: "google-gmail__send", outcome: "denied", payload: { summary: "send blocked" } });
  await at("2026-11-12T01:00:00Z").record({ userId: alice.userId, agentId: chatgpt.id, kind: "tool_call", source: "warthog", tool: "remember", outcome: "executed", payload: { summary: "saved memory" } });
  await at("2026-11-12T01:30:00Z").record({ userId: alice.userId, agentId: chatgpt.id, kind: "agent_report", source: "agent_reported", payload: { summary: "booked the service" } });
  await at("2026-11-12T02:00:00Z").record({ userId: alice.userId, kind: "rule_created", source: "warthog", outcome: "saved", payload: { summary: "rule added" } });

  const bob = await makePerson(db, keyWrapper, "bob");
  const bobAgent = await createAgent(db, { userId: bob.userId, connectionId: randomUUID(), displayName: "Bob's helper", platform: "Other" }, fixedClock(NOW));
  await at("2026-11-12T02:00:00Z").record({ userId: bob.userId, agentId: bobAgent.id, kind: "tool_call", source: "warthog", tool: "remember", outcome: "executed", payload: { summary: "bob only" } });
  return { alice, claude, chatgpt };
}

function loaderFor(db: Db, keyWrapper: KeyWrapper) {
  return createActivityActions({
    db,
    keyWrapper,
    clock: fixedClock(NOW),
    disputes: { fileDispute: async () => undefined },
    undo: { undo: async () => ({ ok: false, reason: "unused" }) },
  });
}

const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

test("By agent: one row per agent with exact counts, attention and a no-agent row; only your own agents", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const { alice, claude } = await seed(db, keyWrapper);
    const view = await loaderFor(db, keyWrapper).load(alice.session, { view: "agents" });
    assert.equal(view.view, "agents");
    assert.deepEqual(view.groups?.map((g) => g.label), ["ChatGPT", "Claude", "Account and Warthog"]);
    const c = view.groups!.find((g) => g.label === "Claude")!;
    assert.equal(c.total, 2);
    assert.equal(c.blocked, 1);
    assert.equal(c.href, `/activity?agent=${claude.id}&via=agents`);
    const html = renderToStaticMarkup(<ActivityView {...view} />);
    const shown = text(html);
    assert.ok(shown.includes("Activity by agent"));
    assert.ok(shown.includes("Needs attention: 1 blocked"));
    assert.ok(!shown.includes("Bob's helper"), "another person's agent never appears");
    assert.match(html, /aria-current="page"[^>]*>By agent/);
  } finally {
    await db.close();
  }
});

test("clicking an agent opens its timeline, with a way back to all agents", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const { alice, claude } = await seed(db, keyWrapper);
    const view = await loaderFor(db, keyWrapper).load(alice.session, { agent: claude.id, via: "agents" });
    assert.equal(view.view, "timeline");
    assert.deepEqual(view.entries.map((e) => e.summary), ["send blocked", "searched memory"]);
    assert.deepEqual(view.breadcrumb, { label: "All agents", href: "/activity?view=agents" });
    assert.deepEqual(view.appliedFilters?.map((f) => f.label), ["Agent: Claude"]);
    const shown = text(renderToStaticMarkup(<ActivityView {...view} />));
    assert.ok(shown.includes("All agents"));
    assert.ok(shown.includes("Remove filter Agent: Claude"));
  } finally {
    await db.close();
  }
});

test("By type separates reads from changes and never counts an agent's report as either", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const { alice } = await seed(db, keyWrapper);
    const view = await loaderFor(db, keyWrapper).load(alice.session, { view: "types" });
    const count = (id: string) => view.groups!.find((g) => g.id === id)!.total;
    assert.equal(count("type-read"), 1);
    assert.equal(count("type-change"), 2);
    assert.equal(count("type-report"), 1);
    assert.equal(count("type-account"), 1);
    const reads = await loaderFor(db, keyWrapper).load(alice.session, { type: "read" });
    assert.deepEqual(reads.entries.map((e) => e.summary), ["searched memory"]);
  } finally {
    await db.close();
  }
});

test("the timeline is headed by day, labels reports, and keeps control names unique", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const { alice } = await seed(db, keyWrapper);
    const view = await loaderFor(db, keyWrapper).load(alice.session, {});
    const html = renderToStaticMarkup(<ActivityView {...view} disputeAction={async () => {}} />);
    const shown = text(html);
    assert.ok(shown.indexOf("Today") < shown.indexOf("Yesterday"), "newest day first");
    assert.ok(shown.includes("Reported by ChatGPT"));
    const names = [...html.matchAll(/>View details<span class="sr-only">([^<]*)</g)].map((m) => m[1]);
    assert.equal(names.length, 5);
    assert.equal(new Set(names).size, names.length, "each details control has its own accessible name");
  } finally {
    await db.close();
  }
});

test("the filter and integrity forms carry the current view and filters", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const { alice, claude } = await seed(db, keyWrapper);
    const view = await loaderFor(db, keyWrapper).load(alice.session, { view: "services", agent: claude.id, attention: "1" });
    const html = renderToStaticMarkup(<ActivityView {...view} />);
    assert.match(html, /<input type="hidden" name="view" value="services"\/>/);
    assert.match(html, /<input type="hidden" name="attention" value="1"\/>/);
    const integrityForm = html.slice(html.indexOf('<form method="get">'), html.indexOf("Check integrity"));
    for (const field of [`name="agent" value="${claude.id}"`, 'name="attention" value="1"', 'name="view" value="services"', 'name="verify" value="1"']) {
      assert.ok(integrityForm.includes(field), `the integrity form keeps ${field}`);
    }
    assert.ok(!html.includes('name="q"'), "grouped views have no page-only search box");
  } finally {
    await db.close();
  }
});

// UI/UX pass (content-04): every finished change appeared twice — "Starting: Save a record ·
// Attempted" under "Save a record · Executed". The intent record is now left out when its
// result is on the page, and an unmatched one stays and reads "Not confirmed".
test("each finished change appears once; an unfinished intent stays and says it isn't confirmed", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const alice = await makePerson(db, keyWrapper, "alice");
    const claude = await createAgent(db, { userId: alice.userId, connectionId: randomUUID(), displayName: "Claude", platform: "Claude" }, fixedClock(NOW));
    const at = (iso: string) => createDbRecorder({ db, clock: fixedClock(new Date(iso)), dekFor: async () => alice.dek });
    const base = { userId: alice.userId, agentId: claude.id, source: "warthog" as const, tool: "save_record" };
    const intent = await at("2026-11-12T01:00:00Z").record({ ...base, kind: "tool_attempt", outcome: "attempted", payload: { attemptId: "attempt-one", resultEvidence: { outcome: "attempted" } } });
    await at("2026-11-12T01:00:01Z").record({ ...base, kind: "tool_call", outcome: "executed", payload: { attemptId: "attempt-one", resultEvidence: { outcome: "executed" } } });
    const orphan = await at("2026-11-12T02:00:00Z").record({ ...base, kind: "tool_attempt", outcome: "attempted", payload: { attemptId: "attempt-two", resultEvidence: { outcome: "attempted" } } });

    const timeline = await loaderFor(db, keyWrapper).load(alice.session, {});
    assert.deepEqual(timeline.entries.map((e) => [e.title, e.outcome]), [["Started: Save a record", "Not confirmed"], ["Save a record", "Done"]]);
    assert.equal(timeline.entries[0]!.seq, orphan.seq, "the unmatched intent is the one kept");

    const intents = await loaderFor(db, keyWrapper).load(alice.session, { kind: "tool_attempt" });
    assert.deepEqual(intents.entries.map((e) => e.seq), [orphan.seq, intent.seq], "asking for intent records shows them all");
    const permalink = await loaderFor(db, keyWrapper).load(alice.session, { entry: String(intent.seq) });
    assert.deepEqual(permalink.entries.map((e) => e.seq), [intent.seq], "a permalink always shows its entry");
  } finally {
    await db.close();
  }
});

// interaction-21: an old or wrong permalink was described as a filter problem.
test("a permalink to an entry that isn't there says so, with a way back", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const { alice } = await seed(db, keyWrapper);
    for (const entry of ["999999", "abc"]) {
      const view = await loaderFor(db, keyWrapper).load(alice.session, { entry });
      assert.deepEqual(view.entries, [], `entry=${entry} lists nothing`);
      assert.equal(view.singleEntry, true, `entry=${entry} is still a permalink`);
      const shown = text(renderToStaticMarkup(<ActivityView {...view} />));
      assert.match(shown, /We couldn(?:'|&#x27;)t find that activity entry/, `entry=${entry}: ${shown}`);
      assert.ok(!shown.includes("No activity matches these filters"), "it is not described as a filter problem");
      assert.match(renderToStaticMarkup(<ActivityView {...view} />), /<a [^>]*href="\/activity"[^>]*>Back to the timeline<\/a>/);
    }
  } finally {
    await db.close();
  }
});

// newcomer-02/05: a brand-new record shows only its empty state, with the next step.
test("a first-run record shows only the empty state, offering to connect an agent when there is none", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const lone = await makePerson(db, keyWrapper, "lone");
    const view = await loaderFor(db, keyWrapper).load(lone.session, {});
    assert.equal(view.hasAgents, false);
    const html = renderToStaticMarkup(<ActivityView {...view} />);
    assert.match(html, /href="\/agents\/connect"[^>]*>Connect your first agent/);
    assert.ok(!html.includes('aria-label="Find activity"'), "no filter toolbar over an empty record");
    assert.ok(html.includes("Check integrity"), "the record-wide check stays available");
  } finally {
    await db.close();
  }
});

// The page is contained: the toolbar, every day and the page links are bounded surfaces.
test("the timeline is one toolbar, a list-group panel per day and a closing page bar", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const { alice } = await seed(db, keyWrapper);
    const view = await loaderFor(db, keyWrapper).load(alice.session, {});
    const html = renderToStaticMarkup(<ActivityView {...view} nextHref="/activity?before=1" />);
    assert.equal((html.match(/class="wh-toolbar"/g) ?? []).length, 1, "one toolbar holds the views, quick filters, search and filters");
    const toolbar = html.slice(html.indexOf('class="wh-toolbar"'), html.indexOf('class="wh-list-group"'));
    for (const part of ['aria-label="Activity views"', 'aria-label="Quick filters"', 'name="q"', ">Filters"]) {
      assert.ok(toolbar.includes(part), `the toolbar holds ${part}`);
    }
    assert.equal((html.match(/class="wh-list-group"/g) ?? []).length, 3, "one list-group panel per day (Today, Yesterday, Tue 10 Nov)");
    assert.match(html, /<nav aria-label="Activity pages"><div class="wh-form-actions">/, "the page links sit in a bounded bar");
    assert.ok(!html.includes("wh-card flex flex-col gap-3 rounded-card border"), "the search form is no longer its own card");
  } finally {
    await db.close();
  }
});

test("an empty grouped view with nothing applied is a first run, not a filter problem", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const lone = await makePerson(db, keyWrapper, "lone");
    const view = await loaderFor(db, keyWrapper).load(lone.session, { view: "agents" });
    assert.deepEqual(view.groups, []);
    const shown = text(renderToStaticMarkup(<ActivityView {...view} />));
    assert.ok(shown.includes("No activity yet"), shown);
    assert.ok(shown.includes("Connect your first agent"));
    assert.ok(!shown.includes("No activity matches these filters"));
  } finally {
    await db.close();
  }
});
