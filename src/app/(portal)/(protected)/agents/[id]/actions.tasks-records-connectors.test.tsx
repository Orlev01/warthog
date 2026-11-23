// Review fix W2.3 — the per-agent permissions page can change the tasks and life-admin records
// grants (migration 0068) and which connected services the agent may use (the grants the
// consent screen can give), not only the identity / card / memory toggles.
//
// Until now the page could not change any of these: it rendered no toggle for tasks or records
// (the upsert merely preserved them) and always rendered an empty "Connected services" list. The
// loader now reflects them from storage, offering each of the person's OWN connected services
// (member-scoped, named through the catalogue), and the save persists them. A ticked service is
// granted exactly as consent grants it — its read tools on, its changes "ask me first" — and only
// when it is one of the person's own connected services (never trusting the form for that). A
// partial edit keeps what it does not touch (OBS-022), including a grant for a service the person
// has since disconnected, which the page does not show.
//
// Driven through the REAL actions over an isolated PGlite with the real migrations, rendered
// through the real <PermissionsView>.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createPermissionsActions } from "./actions";
import { PermissionsView } from "@/components/agents/permissions-view";
import { createAgent } from "@/server/db/agents";
import { upsertPermissions, getConnectionPermissions, type PermissionGrants } from "@/server/db/agent-permissions";
import { createConnection } from "@/server/db/connections";
import { createUser } from "@/server/db/users";
import { fixedClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const NAMES: Record<string, string> = { "google-calendar": "Google Calendar", notion: "Notion" };
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

async function connectService(db: Db, userId: string, connectorId: string): Promise<void> {
  await createConnection(
    db,
    { userId, connectorId, accountLabel: `${connectorId} account`, credentials: { apiKey: "k" } } as Parameters<typeof createConnection>[1],
    randomBytes(32),
    fixedClock(NOW),
  );
}

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
    grantedConnectors: [],
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

test("the loader reflects the tasks and records grants and offers each of the person's connected services", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    await connectService(db, alice, "google-calendar");
    await connectService(db, alice, "notion");
    const { agentId } = await seedAgent(db, alice, {
      tasksAccess: true,
      recordsAccess: false,
      grantedConnectors: ["google-calendar"],
      readTools: true,
      changeTools: "ask_first",
    });

    const props = await createPermissionsActions({ db, nameOf }).load(sessionFor(alice), agentId);
    assert.ok(props);
    assert.equal(props!.tasksAccess, true);
    assert.equal(props!.recordsAccess, false);
    const services = [...props!.connectors].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(
      services.map((c) => ({ id: c.id, name: c.name, granted: c.granted })),
      [
        { id: "google-calendar", name: "Google Calendar", granted: true },
        { id: "notion", name: "Notion", granted: false },
      ],
    );

    const markup = renderToStaticMarkup(<PermissionsView {...props!} />);
    const text = strip(markup);
    assert.ok(/Let Claude use Google Calendar/.test(text), text);
    assert.ok(/Let Claude use Notion/.test(text));
    assert.ok(/Your tasks/.test(text) && /Your life-admin records/.test(text));
    assert.match(markup, /<input[^>]*name="connector:google-calendar"[^>]*checked=""/);
    assert.match(markup, /<input[^>]*name="tasks"[^>]*checked=""/);
    assert.doesNotMatch(markup, /<input[^>]*name="records"[^>]*checked=""/);
  } finally {
    await db.close();
  }
});

test("the loader offers only the session person's own connected services", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    await connectService(db, bob, "notion");
    const { agentId } = await seedAgent(db, alice);

    const props = await createPermissionsActions({ db, nameOf }).load(sessionFor(alice), agentId);
    assert.deepEqual(props!.connectors, [], "Bob's connected service is never offered on Alice's screen");
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

test("ticking a connected service grants it as consent does: reads on, changes ask me first", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    await connectService(db, alice, "google-calendar");
    const { agentId, connectionId } = await seedAgent(db, alice);

    const result = await createPermissionsActions({ db, nameOf }).save(sessionFor(alice), agentId, {
      connectors: ["google-calendar"],
    });
    assert.deepEqual(result, { ok: true });
    const stored = await getConnectionPermissions(db, alice, connectionId);
    assert.deepEqual(stored?.grantedConnectors, ["google-calendar"]);
    assert.equal(stored?.readTools, true);
    assert.equal(stored?.changeTools, "ask_first");
  } finally {
    await db.close();
  }
});

test("unticking a service revokes it, and a service the person has not connected is never granted", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    await connectService(db, alice, "google-calendar");
    const { agentId, connectionId } = await seedAgent(db, alice, {
      grantedConnectors: ["google-calendar"],
      readTools: true,
      changeTools: "ask_first",
    });
    const actions = createPermissionsActions({ db, nameOf });

    // A forged body naming a service Alice never connected.
    await actions.save(sessionFor(alice), agentId, { connectors: ["gmail"] });
    const stored = await getConnectionPermissions(db, alice, connectionId);
    assert.deepEqual(stored?.grantedConnectors, [], "calendar revoked; gmail (not connected) never granted");
  } finally {
    await db.close();
  }
});

test("a grant for a service the person has since disconnected is kept by an edit (the screen does not show it)", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    await connectService(db, alice, "notion");
    const { agentId, connectionId } = await seedAgent(db, alice, {
      grantedConnectors: ["google-calendar"],
      readTools: true,
      changeTools: "ask_first",
    });

    await createPermissionsActions({ db, nameOf }).save(sessionFor(alice), agentId, { connectors: ["notion"] });
    const stored = await getConnectionPermissions(db, alice, connectionId);
    assert.deepEqual([...stored!.grantedConnectors].sort(), ["google-calendar", "notion"]);
  } finally {
    await db.close();
  }
});

test("another person's agent cannot be given services, tasks or records by id", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    const bob = await makeUser(db, "bob");
    await connectService(db, alice, "notion");
    const bobs = await seedAgent(db, bob);

    const result = await createPermissionsActions({ db, nameOf }).save(sessionFor(alice), bobs.agentId, {
      tasks: true,
      records: true,
      connectors: ["notion"],
    });
    assert.deepEqual(result, { ok: false, reason: "not_found" });
    const stored = await getConnectionPermissions(db, bob, bobs.connectionId);
    assert.equal(stored?.tasksAccess, false);
    assert.equal(stored?.recordsAccess, false);
    assert.deepEqual(stored?.grantedConnectors, []);
  } finally {
    await db.close();
  }
});

// The Connectors section always sends its "Defaults for every service" toggles as shown. An agent
// connected with no services stores them off (nothing was granted), so the first service ticked
// on its page used to be granted with reading and changes both off: the agent could "use" the
// service and still got none of its tools. The first grant now takes what consent gives (reads
// on, changes ask me first) unless the person changed a default in the same save.
test("the first service granted from the Connectors section gets reads on and changes ask me first", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    await connectService(db, alice, "notion");
    const { agentId, connectionId } = await seedAgent(db, alice);

    const result = await createPermissionsActions({ db, nameOf }).save(sessionFor(alice), agentId, {
      connectors: ["notion"],
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
    await connectService(db, alice, "notion");
    const { agentId, connectionId } = await seedAgent(db, alice, { readTools: true, changeTools: "off" });

    await createPermissionsActions({ db, nameOf }).save(sessionFor(alice), agentId, {
      connectors: ["notion"],
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

test("an agent that already has a service keeps the defaults the form sends", async () => {
  const db = await freshDb();
  try {
    const alice = await makeUser(db, "alice");
    await connectService(db, alice, "google-calendar");
    await connectService(db, alice, "notion");
    const { agentId, connectionId } = await seedAgent(db, alice, {
      grantedConnectors: ["google-calendar"],
      readTools: false,
      changeTools: "off",
    });

    await createPermissionsActions({ db, nameOf }).save(sessionFor(alice), agentId, {
      connectors: ["google-calendar", "notion"],
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
