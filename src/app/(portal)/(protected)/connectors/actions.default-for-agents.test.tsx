// "On for new agents" on the Connectors page (docs/adr/default-services.md): each of the
// person's accounts under Your services has a switch. Turning it on means every agent connected
// afterwards starts with that account ticked; agents already connected don't change. An agent
// can use several accounts of a service (docs/adr/several-accounts-per-agent.md), so each
// account's switch is its own: turning one on never turns another off.
//
// Drives the real factory over a real catalogue index and an isolated PGlite with the real
// migrations, rendered through the real <ConnectorsView>, as `actions.organise.test.tsx` does.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { createConnectorsActions } from "./actions";
import { ConnectorsView } from "@/components/connectors/connectors-view";
import { createConnection, defaultAccountsForAgents } from "@/server/db/connections";
import { readActivity } from "@/server/activity/writer";
import { createUser } from "@/server/db/users";
import { loadCatalogue, type CatalogueIndex } from "@/server/connectors/catalogue";
import { HttpError } from "@/server/http/validate";
import { fixedClock } from "@/server/seams/clock";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";
import type { Session } from "@/server/auth/session";

const NOW = new Date("2026-11-23T00:00:00.000Z");

const apiKey = (id: string, name: string) => ({
  id,
  name,
  aliases: [],
  category: "email",
  auth_kind: "api_key",
  base_url: `https://api.${id}.example`,
  auth: { header: "Authorization: Bearer {api_key}" },
});

function catalogue(): CatalogueIndex {
  const dir = mkdtempSync(join(tmpdir(), "warthog-connectors-default-"));
  try {
    for (const entry of [apiKey("acme-mail", "Acme Mail"), apiKey("grid-db", "Grid DB")]) {
      writeFileSync(join(dir, `${entry.id}.json`), JSON.stringify(entry));
    }
    return loadCatalogue({ dir, isOAuthClientConfigured: () => false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const deks = new Map<string, Uint8Array>();
const dekFor = async (userId: string) => deks.get(userId)!;

function actionsFor(db: Db) {
  return createConnectorsActions({
    db,
    clock: fixedClock(NOW),
    catalogue: catalogue(),
    dekFor,
    fetch: (async () => {
      throw new Error("no fetch in these tests");
    }) as unknown as typeof fetch,
    googleEarlyAccess: [],
    oauthClientConfigFor: () => ({ clientId: "c", clientSecret: "s", redirectUri: "https://warthog.com.au/cb" }),
    providerMcpConfig: { clientMetadataUrl: "https://warthog.com.au/oauth/client-metadata.json" },
    listProviderTools: async () => [],
    revokeProviderAccess: async () => {},
  });
}

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-${who}`).toString("base64"),
  });
  deks.set(user.id, randomBytes(32));
  return user.id;
}

async function connect(db: Db, userId: string, connectorId: string, accountLabel: string): Promise<string> {
  const created = await createConnection(
    db,
    { userId, connectorId, accountLabel, credentials: { token: accountLabel } },
    await dekFor(userId),
    fixedClock(NOW),
  );
  return created.id;
}

function sessionFor(userId: string): Session {
  return { id: `sess-${userId}`, userId, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: null };
}

const fakeAction = async (_formData: FormData): Promise<void> => {};

function text(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&rsquo;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

test("turning an account on for new agents marks it on the page and records the change", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "default-on");
    const home = await connect(db, userId, "acme-mail", "home@acme.test");
    const work = await connect(db, userId, "acme-mail", "work@acme.test");
    const actions = actionsFor(db);

    assert.deepEqual(await actions.setDefaultForAgents(sessionFor(userId), { connectionId: work, on: true }), { ok: true });

    const data = await actions.load(sessionFor(userId));
    const byId = new Map(data.connections.map((c) => [c.id, c]));
    assert.equal(byId.get(work)?.defaultForAgents, true);
    assert.equal(byId.get(home)?.defaultForAgents, false);

    const entries = await readActivity(db, userId, await dekFor(userId));
    assert.equal(entries.length, 1, "exactly one activity entry is written");
    assert.equal(entries[0]!.kind, "agent_defaults_change");
    assert.equal(entries[0]!.connectorId, "acme-mail");
    assert.ok(JSON.stringify(entries[0]).includes("work@acme.test"), "the entry names the account");
  } finally {
    await db.close();
  }
});

test("two accounts of a service can both be on for new agents; turning one off leaves the other", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "default-both");
    const home = await connect(db, userId, "acme-mail", "home@acme.test");
    const work = await connect(db, userId, "acme-mail", "work@acme.test");
    const actions = actionsFor(db);

    await actions.setDefaultForAgents(sessionFor(userId), { connectionId: home, on: true });
    await actions.setDefaultForAgents(sessionFor(userId), { connectionId: work, on: true });
    assert.deepEqual([...(await defaultAccountsForAgents(db, userId))].sort(), [home, work].sort(), "both are on");
    const byId = new Map((await actions.load(sessionFor(userId))).connections.map((c) => [c.id, c]));
    assert.equal(byId.get(home)?.defaultForAgents, true);
    assert.equal(byId.get(work)?.defaultForAgents, true);

    await actions.setDefaultForAgents(sessionFor(userId), { connectionId: work, on: false });
    assert.deepEqual(await defaultAccountsForAgents(db, userId), [home]);

    // Each change is its own entry, naming the account and what it was before.
    const entries = await readActivity(db, userId, await dekFor(userId));
    assert.equal(entries.filter((entry) => entry.kind === "agent_defaults_change").length, 3);
  } finally {
    await db.close();
  }
});

test("another person's account cannot be turned on or off", async () => {
  const db = await freshDb();
  try {
    const me = await makeUser(db, "default-me");
    const other = await makeUser(db, "default-other");
    const theirs = await connect(db, other, "acme-mail", "them@acme.test");

    assert.deepEqual(await actionsFor(db).setDefaultForAgents(sessionFor(me), { connectionId: theirs, on: true }), { ok: false });
    assert.deepEqual(await defaultAccountsForAgents(db, other), []);
    assert.equal((await readActivity(db, me, await dekFor(me))).length, 0, "nothing is recorded");
  } finally {
    await db.close();
  }
});

test("a malformed connection id is refused with a 4xx before any query", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "default-bad");
    await assert.rejects(
      actionsFor(db).setDefaultForAgents(sessionFor(userId), { connectionId: "'; DROP TABLE connections; --", on: true }),
      (error: unknown) => error instanceof HttpError && error.status >= 400 && error.status < 500,
    );
  } finally {
    await db.close();
  }
});

test("each account under Your services has an On for new agents switch, bound to the action", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "default-view");
    const home = await connect(db, userId, "acme-mail", "home@acme.test");
    const work = await connect(db, userId, "acme-mail", "work@acme.test");
    await connect(db, userId, "acme-mail", "billing@acme.test");
    await connect(db, userId, "grid-db", "Grid DB");
    const actions = actionsFor(db);
    await actions.setDefaultForAgents(sessionFor(userId), { connectionId: home, on: true });
    await actions.setDefaultForAgents(sessionFor(userId), { connectionId: work, on: true });

    const markup = renderToStaticMarkup(
      <ConnectorsView {...(await actions.load(sessionFor(userId)))} initialView="connected" defaultForAgentsAction={fakeAction} />,
    );
    const switches = [...markup.matchAll(/<input[^>]*role="switch"[^>]*>/g)].map((m) => m[0]);
    assert.equal(switches.length, 4, "one switch per account");
    assert.equal(switches.filter((s) => /checked=""/.test(s)).length, 2, "both accounts that are on are checked");
    assert.match(markup, new RegExp(`<input[^>]*name="connectionId"[^>]*value="${work}"`));

    const words = text(markup);
    assert.match(words, /On for new agents/);
    assert.match(words, /Every agent you connect from now on starts with this Acme Mail account/);
    assert.doesNotMatch(words, /New agents use|instead/, "turning one on never claims to move it from another account");
    assert.match(words, /Agents already connected don't change/);
  } finally {
    await db.close();
  }
});

test("without the action the switch is shown disabled with a reason, never live over nothing", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "default-noaction");
    await connect(db, userId, "acme-mail", "home@acme.test");
    const markup = renderToStaticMarkup(
      <ConnectorsView {...(await actionsFor(db).load(sessionFor(userId)))} initialView="connected" />,
    );
    assert.match(markup, /<input[^>]*role="switch"[^>]*disabled=""/);
  } finally {
    await db.close();
  }
});
