// Agents only connect or disconnect; nothing renews a disconnected agent's connection, so
// Home must say "Disconnected" for one, never "Reconnect needed" (interaction-08).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createHomeActions } from "./actions";
import { DashboardView } from "@/components/home/dashboard-view";
import { createUser } from "@/server/db/users";
import { createSession } from "@/server/auth/session";
import { createAgent } from "@/server/db/agents";
import { localAesKeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";

const clock = fixedClock(new Date("2026-11-13T01:00:00Z"));
const keyWrapper = localAesKeyWrapper(randomBytes(32));

test("Home shows a disconnected agent as Disconnected, not as needing a reconnect", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32);
    const user = await createUser(db, { email: `dana-${randomUUID()}@people.example`, wrappedDek: await keyWrapper.wrap(dek) });
    const session = (await createSession(db, user.id, { clock, random: systemRandom })).session;
    const on = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "Still here", platform: "Claude" }, clock);
    const off = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "Gone now", platform: "Claude" }, clock);
    await db.query("UPDATE agents SET status = 'disconnected' WHERE id = $1", [off.id]);

    const view = await createHomeActions({ db, keyWrapper, clock }).load(session);
    const status = new Map(view.agents.map((a) => [a.id, a.status]));
    assert.equal(status.get(on.id), "connected");
    assert.equal(status.get(off.id), "disconnected");

    const text = renderToStaticMarkup(<DashboardView {...view} />).replace(/<[^>]+>/g, " ");
    assert.match(text, /Disconnected/);
    assert.doesNotMatch(text, /Reconnect needed/);
  } finally {
    await db.close();
  }
});
