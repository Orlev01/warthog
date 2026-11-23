// Review fix W2.3 — the per-agent permissions page can change the tasks and life-admin records
// grants (migration 0068) and which connected services the agent may use (the grants the
// consent screen can give), not only the identity / card / memory toggles.
//
// Several accounts of one service (docs/adr/several-accounts-per-agent.md): the agent is given
// ACCOUNTS, not services. The page offers one row per connected account, each with its own
// settings, and the save writes them per account — only ever for the person's own accounts, and
// only with tools of that account's own service.
//
// Until now the page could not change any of these: it rendered no toggle for tasks or records
// (the upsert merely preserved them) and always rendered an empty "Connected services" list. The
// loader now reflects them from storage, offering each of the person's OWN connected accounts
// (member-scoped, named through the catalogue), and the save persists them. A ticked account is
// granted exactly as consent grants it — reads on, changes "ask me first" — and only when it is
// one of the person's own connected accounts (never trusting the form for that; anything else is
// refused). A partial edit keeps what it does not touch (OBS-022), including a grant for an
// account the page did not show.
//
// Driven through the REAL actions over an isolated PGlite with the real migrations, rendered
// through the real <PermissionsView>.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { join } from "node:path";

import { createPermissionsActions } from "./actions";
import { PermissionsView } from "@/components/agents/permissions-view";
import { activityEvidence } from "@/domain/activity/evidence";
import { listActivity } from "@/server/activity/list";
import { loadCatalogue } from "@/server/connectors/catalogue";
import { localAesKeyWrapper } from "@/server/crypto/key-wrapper";
import { createAgent } from "@/server/db/agents";
import { upsertPermissions, getConnectionPermissions, type PermissionGrants } from "@/server/db/agent-permissions";
import { createConnection } from "@/server/db/connections";
import { createUser } from "@/server/db/users";
import { fixedClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const NAMES: Record<string, string> = { "google-calendar": "Google Calendar", "google-gmail": "Gmail", notion: "Notion" };
const nameOf = (id: string): string | undefined => NAMES[id];

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return user.id;
}

function sessionFor(userId: string): Session {
  return { id: `sess-${userId}`, userId, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: null };
}

// Connect one account of a service for `userId`; returns its id.
async function connectService(db: Db, userId: string, connectorId: string, accountLabel = `${connectorId} account`, status?: "needs_reconnect"): Promise<string> {
  const connection = await createConnection(
    db,
    { userId, connectorId, accountLabel, credentials: { apiKey: "k" }, ...(status ? { status } : {}) } as Parameters<typeof createConnection>[1],
    randomBytes(32),
    fixedClock(NOW),
  );
  return connection.id;
}

// The real catalogue, so each account's own tools are listed.
const CATALOGUE = loadCatalogue({ dir: join(process.cwd(), "catalogue", "connectors"), isOAuthClientConfigured: () => false });

async function seedAgent(db: Db, userId: string, grants: Partial<PermissionGrants> = {}) {
  const connectionId = randomUUID();
  const agent = await createAgent(
    db,
    { userId, connectionId, displayName: "Claude", platform: "Claude", status: "connected" },
    fixedClock(NOW),
  );
  await upsertPermissions(db, {
    userId,
    connectionId,
    accounts: [],
    readTools: false,
    changeTools: "off",
    identityAccess: true,
    highTierAccess: false,
    cardAccess: false,
    cardBudget: null,
    skillsScope: [],
    memoryRead: false,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
    tasksAccess: false,
    recordsAccess: false,
    ...grants,
  });
  return { agentId: agent.id, connectionId };
}

function strip(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/&#x27;|&rsquo;/g, "'").replace(/\s+/g, " ").trim();
}

test("the loader reflects the tasks and records grants and offers each of the person's connected accounts", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const calendar = await connectService(db, alice, "google-calendar", "alice@example.com");
    const billing = await connectService(db, alice, "google-gmail", "billing@example.com");
    const booking = await connectService(db, alice, "google-gmail", "booking@example.com", "needs_reconnect");
    const { agentId } = await seedAgent(db, alice, {
      tasksAccess: true,
      recordsAccess: false,
      accounts: [{ accountId: calendar }, { accountId: billing, changeTools: "off" }],
      readTools: true,
      changeTools: "ask_first",
    });

    const props = await createPermissionsActions({ db, nameOf }).load(sessionFor(alice), agentId);
    assert.ok(props);
    assert.equal(props!.tasksAccess, true);
    assert.equal(props!.recordsAccess, false);
    const accounts = [...props!.accounts].sort((a, b) => a.label.localeCompare(b.label));
    assert.deepEqual(
      accounts.map((a) => ({ id: a.id, service: a.serviceName, label: a.label, connected: a.connected, grant: a.grant })),
      [
        { id: calendar, service: "Google Calendar", label: "alice@example.com", connected: true, grant: {} },
        { id: billing, service: "Gmail", label: "billing@example.com", connected: true, grant: { changeTools: "off" } },
        { id: booking, service: "Gmail", label: "booking@example.com", connected: false, grant: null },
      ],
    );

    const markup = renderToStaticMarkup(<PermissionsView {...props!} />);
    const text = strip(markup);
    assert.match(text, /Gmail · billing@example\.com Claude can use it/);
    assert.match(text, /Gmail · booking@example\.com Not allowed Reconnect needed/);
    assert.match(text, /Google Calendar · alice@example\.com Claude can use it/);
    assert.match(text, /3 accounts · 2 allowed for Claude/);
    assert.ok(/Your tasks/.test(text) && /Your life-admin records/.test(text));
    assert.match(markup, new RegExp(`<input[^>]*name="account:${billing}"[^>]*checked=""`));
    assert.doesNotMatch(markup, new RegExp(`<input[^>]*name="account:${booking}"[^>]*checked=""`));
    assert.match(markup, /<input[^>]*name="tasks"[^>]*checked=""/);
    assert.doesNotMatch(markup, /<input[^>]*name="records"[^>]*checked=""/);
  } finally {
    await db.close();
  }
});

test("the loader offers only the session person's own connected accounts", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    await connectService(db, bob, "notion");
    const { agentId } = await seedAgent(db, alice);

    const props = await createPermissionsActions({ db, nameOf }).load(sessionFor(alice), agentId);
    assert.deepEqual(props!.accounts, [], "Bob's connected account is never offered on Alice's screen");
  } finally {
    await db.close();
  }
});

test("each account lists its own tools, named <service>__<verb>, reads and changes apart", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const billing = await connectService(db, alice, "google-gmail", "billing@example.com");
    const booking = await connectService(db, alice, "google-gmail", "booking@example.com");
    const { agentId } = await seedAgent(db, alice);

    const props = await createPermissionsActions({ db, nameOf, catalogue: CATALOGUE }).load(sessionFor(alice), agentId);
    for (const id of [billing, booking]) {
      const account = props!.accounts.find((a) => a.id === id)!;
      assert.ok(account.readTools.includes("google-gmail__search") && account.readTools.includes("google-gmail__read"));
      assert.ok(account.changeTools.includes("google-gmail__send"));
      assert.ok(!account.readTools.includes("google-gmail__send"), "a change tool is never listed as a read");
    }
    // Two rows of the same service never share a control.
    const markup = renderToStaticMarkup(<PermissionsView {...props!} />);
    for (const id of [billing, booking]) {
      assert.equal((markup.match(new RegExp(`name="account:${id}"`, "g")) ?? []).length, 1);
      assert.ok((markup.match(new RegExp(`name="accountTool:${id}"`, "g")) ?? []).length >= 3);
    }
  } finally {
    await db.close();
  }
});

test("saving the tasks and records toggles persists them; other grants keep their values", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const { agentId, connectionId } = await seedAgent(db, alice, { memoryRead: true });
    const actions = createPermissionsActions({ db, nameOf });

    assert.deepEqual(await actions.save(sessionFor(alice), agentId, { tasks: true, records: true }), { ok: true });
    let stored = await getConnectionPermissions(db, alice, connectionId);
    assert.equal(stored?.tasksAccess, true);
    assert.equal(stored?.recordsAccess, true);
    assert.equal(stored?.memoryRead, true, "an untouched grant keeps its value");

    assert.deepEqual(await actions.save(sessionFor(alice), agentId, { tasks: false }), { ok: true });
    stored = await getConnectionPermissions(db, alice, connectionId);
    assert.equal(stored?.tasksAccess, false, "switched off");
    assert.equal(stored?.recordsAccess, true, "records untouched by a tasks-only edit");
  } finally {
    await db.close();
  }
});

test("ticking a connected account grants it as consent does: reads on, changes ask me first", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const calendar = await connectService(db, alice, "google-calendar");
    const { agentId, connectionId } = await seedAgent(db, alice);

    const result = await createPermissionsActions({ db, nameOf }).save(sessionFor(alice), agentId, {
      accounts: [{ id: calendar, granted: true }],
    });
    assert.deepEqual(result, { ok: true });
    const stored = await getConnectionPermissions(db, alice, connectionId);
    assert.deepEqual(stored?.accounts, [{ accountId: calendar, connectorId: "google-calendar" }]);
    assert.deepEqual(stored?.grantedConnectors, ["google-calendar"]);
    assert.equal(stored?.readTools, true);
    assert.equal(stored?.changeTools, "ask_first");
  } finally {
    await db.close();
  }
});

test("each account's own settings are saved and read back; several accounts of one service at once", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const personal = await connectService(db, alice, "google-gmail", "levyoren1@example.com");
    const billing = await connectService(db, alice, "google-gmail", "billing@example.com");
    const booking = await connectService(db, alice, "google-gmail", "booking@example.com");
    const { agentId, connectionId } = await seedAgent(db, alice, { readTools: true, changeTools: "ask_first" });
    const actions = createPermissionsActions({ db, nameOf });

    assert.deepEqual(
      await actions.save(sessionFor(alice), agentId, {
        readTools: true,
        changeTools: "ask_first",
        accounts: [
          { id: personal, granted: true },
          { id: billing, granted: true, changeTools: "off", allowedTools: ["google-gmail__search", "google-gmail__read"] },
          { id: booking, granted: true, readTools: false, changeTools: "allow" },
        ],
      }),
      { ok: true },
    );
    let stored = await getConnectionPermissions(db, alice, connectionId);
    const byId = (id: string) => stored!.accounts.find((a) => a.accountId === id);
    assert.equal(stored!.accounts.length, 3, "all three Gmail accounts at once");
    assert.deepEqual(byId(personal), { accountId: personal, connectorId: "google-gmail" }, "no setting of its own: follows the agent");
    assert.deepEqual(byId(billing), { accountId: billing, connectorId: "google-gmail", changeTools: "off", allowedTools: ["google-gmail__search", "google-gmail__read"] });
    assert.deepEqual(byId(booking), { accountId: booking, connectorId: "google-gmail", readTools: false, changeTools: "allow" });

    // The screen shows them back as saved.
    const props = await actions.load(sessionFor(alice), agentId);
    assert.deepEqual(props!.accounts.find((a) => a.id === billing)!.grant, { changeTools: "off", allowedTools: ["google-gmail__search", "google-gmail__read"] });

    // Unticking one removes just that one; a row back to "same as this agent" drops its setting.
    assert.deepEqual(
      await actions.save(sessionFor(alice), agentId, {
        accounts: [
          { id: personal, granted: true },
          { id: billing, granted: true },
          { id: booking, granted: false, readTools: false },
        ],
      }),
      { ok: true },
    );
    stored = await getConnectionPermissions(db, alice, connectionId);
    assert.deepEqual(stored!.accounts.map((a) => a.accountId).sort(), [personal, billing].sort());
    assert.deepEqual(byId(billing), { accountId: billing, connectorId: "google-gmail" });
  } finally {
    await db.close();
  }
});

test("an account the form didn't show keeps its grant (one connected after the page loaded)", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const calendar = await connectService(db, alice, "google-calendar");
    const notion = await connectService(db, alice, "notion");
    const { agentId, connectionId } = await seedAgent(db, alice, {
      accounts: [{ accountId: calendar, readTools: false }],
      readTools: true,
      changeTools: "ask_first",
    });

    await createPermissionsActions({ db, nameOf }).save(sessionFor(alice), agentId, { accounts: [{ id: notion, granted: true }] });
    const stored = await getConnectionPermissions(db, alice, connectionId);
    assert.deepEqual(stored!.accounts, [
      { accountId: calendar, connectorId: "google-calendar", readTools: false },
      { accountId: notion, connectorId: "notion" },
    ]);
  } finally {
    await db.close();
  }
});

test("an account that isn't the person's own is refused, and nothing is saved", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    const mine = await connectService(db, alice, "google-gmail", "alice@example.com");
    const bobs = await connectService(db, bob, "google-gmail", "bob@example.com");
    const { agentId, connectionId } = await seedAgent(db, alice, { accounts: [{ accountId: mine }], readTools: true, changeTools: "ask_first" });
    const actions = createPermissionsActions({ db, nameOf });

    for (const accounts of [
      [{ id: bobs, granted: true }],
      [{ id: mine, granted: false }, { id: bobs, granted: true }],
      [{ id: randomUUID(), granted: true }],
      [{ id: mine, granted: true }, { id: mine, granted: false }],
    ]) {
      assert.deepEqual(await actions.save(sessionFor(alice), agentId, { tasks: true, accounts }), { ok: false, reason: "invalid_request" }, JSON.stringify(accounts));
    }
    const stored = await getConnectionPermissions(db, alice, connectionId);
    assert.deepEqual(stored!.accounts, [{ accountId: mine, connectorId: "google-gmail" }], "Alice's grant is untouched");
    assert.equal(stored!.tasksAccess, false, "a refused save writes nothing");
    const result = await db.query("SELECT count(*)::int AS n FROM agent_account_grants WHERE account_id = $1", [bobs]);
    assert.equal(result.rows[0]!.n, 0, "Bob's account is never granted to Alice's agent");
  } finally {
    await db.close();
  }
});

test("a tool of another service can't be chosen for an account", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const gmail = await connectService(db, alice, "google-gmail", "alice@example.com");
    const { agentId, connectionId } = await seedAgent(db, alice);
    const actions = createPermissionsActions({ db, nameOf });

    for (const allowedTools of [["google-calendar__create"], ["google-gmail__search", "notion__create_page"], ["google-gmail"], ["google-gmailx__send"]]) {
      assert.deepEqual(
        await actions.save(sessionFor(alice), agentId, { accounts: [{ id: gmail, granted: true, allowedTools }] }),
        { ok: false, reason: "invalid_request" },
        allowedTools.join(","),
      );
    }
    assert.deepEqual((await getConnectionPermissions(db, alice, connectionId))!.accounts, []);
    assert.deepEqual(
      await actions.save(sessionFor(alice), agentId, { accounts: [{ id: gmail, granted: true, allowedTools: ["google-gmail__search"] }] }),
      { ok: true },
      "its own service's tool is fine",
    );
  } finally {
    await db.close();
  }
});

test("a malformed or oversized account list is refused at the boundary", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const { agentId } = await seedAgent(db, alice);
    const actions = createPermissionsActions({ db, nameOf });
    await assert.rejects(() => actions.save(sessionFor(alice), agentId, { accounts: [{ id: "google-gmail", granted: true }] }));
    await assert.rejects(() =>
      actions.save(sessionFor(alice), agentId, { accounts: Array.from({ length: 101 }, () => ({ id: randomUUID(), granted: false })) }),
    );
  } finally {
    await db.close();
  }
});

test("another person's agent cannot be given accounts, tasks or records by id", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    const notion = await connectService(db, alice, "notion");
    const bobs = await seedAgent(db, bob);

    const result = await createPermissionsActions({ db, nameOf }).save(sessionFor(alice), bobs.agentId, {
      tasks: true,
      records: true,
      accounts: [{ id: notion, granted: true }],
    });
    assert.deepEqual(result, { ok: false, reason: "not_found" });
    const stored = await getConnectionPermissions(db, bob, bobs.connectionId);
    assert.equal(stored?.tasksAccess, false);
    assert.equal(stored?.recordsAccess, false);
    assert.deepEqual(stored?.accounts, []);
  } finally {
    await db.close();
  }
});

// The Connectors section always sends its "Defaults for every service" toggles as shown. An agent
// connected with no accounts stores them off (nothing was granted), so the first account ticked
// on its page used to be granted with reading and changes both off: the agent could "use" the
// account and still got none of its tools. The first grant now takes what consent gives (reads
// on, changes ask me first) unless the person changed a default in the same save.
test("the first account granted from the Connectors section gets reads on and changes ask me first", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const notion = await connectService(db, alice, "notion");
    const { agentId, connectionId } = await seedAgent(db, alice);

    const result = await createPermissionsActions({ db, nameOf }).save(sessionFor(alice), agentId, {
      accounts: [{ id: notion, granted: true }],
      readTools: false,
      changeTools: "off",
    });
    assert.deepEqual(result, { ok: true });
    const stored = await getConnectionPermissions(db, alice, connectionId);
    assert.deepEqual(stored?.grantedConnectors, ["notion"]);
    assert.equal(stored?.readTools, true, "the untouched reading default does not switch the new grant off");
    assert.equal(stored?.changeTools, "ask_first", "the untouched changes default does not switch the new grant off");
  } finally {
    await db.close();
  }
});

test("on a first grant, a default the person changed in the same save is kept", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const notion = await connectService(db, alice, "notion");
    const { agentId, connectionId } = await seedAgent(db, alice, { readTools: true, changeTools: "off" });

    await createPermissionsActions({ db, nameOf }).save(sessionFor(alice), agentId, {
      accounts: [{ id: notion, granted: true }],
      readTools: false,
      changeTools: "allow",
    });
    const stored = await getConnectionPermissions(db, alice, connectionId);
    assert.equal(stored?.readTools, false, "the person turned reading off");
    assert.equal(stored?.changeTools, "allow", "the person chose to allow changes");
  } finally {
    await db.close();
  }
});

test("an agent that already has an account keeps the defaults the form sends", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const calendar = await connectService(db, alice, "google-calendar");
    const notion = await connectService(db, alice, "notion");
    const { agentId, connectionId } = await seedAgent(db, alice, {
      accounts: [{ accountId: calendar }],
      readTools: false,
      changeTools: "off",
    });

    await createPermissionsActions({ db, nameOf }).save(sessionFor(alice), agentId, {
      accounts: [{ id: calendar, granted: true }, { id: notion, granted: true }],
      readTools: false,
      changeTools: "off",
    });
    const stored = await getConnectionPermissions(db, alice, connectionId);
    assert.deepEqual([...(stored?.grantedConnectors ?? [])].sort(), ["google-calendar", "notion"]);
    assert.equal(stored?.readTools, false);
    assert.equal(stored?.changeTools, "off");
  } finally {
    await db.close();
  }
});

test("the saved change is recorded with the accounts before and after, never as raw ids", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = localAesKeyWrapper(randomBytes(32));
    const dek = randomBytes(32);
    const alice = (await createUser(db, { email: `alice-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) })).id;
    const billing = await connectService(db, alice, "google-gmail", "billing@example.com");
    const booking = await connectService(db, alice, "google-gmail", "booking@example.com");
    const { agentId } = await seedAgent(db, alice, { accounts: [{ accountId: billing }], readTools: true, changeTools: "ask_first" });

    assert.deepEqual(
      await createPermissionsActions({ db, nameOf, keyWrapper, clock: fixedClock(NOW) }).save(sessionFor(alice), agentId, {
        accounts: [{ id: billing, granted: true, changeTools: "off" }, { id: booking, granted: true }],
      }),
      { ok: true },
    );
    const [entry] = await listActivity(db, alice, { agentId }, dek);
    assert.equal(entry?.kind, "permission_change");
    const payload = entry!.payload as { before: { accounts: unknown[] }; after: { accounts: { accountId: string; changeTools?: string }[] } };
    assert.equal(payload.before.accounts.length, 1);
    assert.deepEqual(payload.after.accounts.map((a) => [a.accountId, a.changeTools ?? null]).sort(), [[billing, "off"], [booking, null]].sort());
    const evidence = activityEvidence(entry!);
    const changed = evidence.facts.find((line) => line.label === "What changed")?.value ?? "";
    assert.match(changed, /Service accounts: 1 added, 1 with new settings/);
    assert.ok(!JSON.stringify(evidence.facts).includes(billing) && !JSON.stringify(evidence.facts).includes(booking), "no account id is shown");
  } finally {
    await db.close();
  }
});
