// Home after an account recovery (sign-in audit, founder decision 13 November 2026).
// Recovery keeps agents and their keys, so for two weeks after it Home shows a contained
// notice naming every agent that was connected at the time, each linking to its settings
// (Replace key) and to Agents (Disconnect). It says the agents are still connected and never
// that Warthog removed one. A dismissed notice stays hidden on that browser.
// Real PGlite, the real activity writer and the real loader; rendered with react-dom/server.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

import { createHomeActions } from "./actions";

import { DashboardView } from "@/components/home/dashboard-view";
import { createUser } from "@/server/db/users";
import { createSession, type Session } from "@/server/auth/session";
import { createAgent } from "@/server/db/agents";
import { createRedactingRecorder } from "@/server/mcp/recorder";
import { ACCOUNT_RECOVERED_KIND, ACCOUNT_RECOVERED_SUMMARY } from "@/server/auth/recovery-review";
import { localAesKeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { freshDb } from "@/test/db";
import type { Db } from "@/server/db/index";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const RECOVERED_AT = new Date("2026-11-14T03:00:00.000Z");
const clock = fixedClock(NOW);
const keyWrapper = localAesKeyWrapper(randomBytes(32));

async function seed(db: Db, email: string): Promise<{ userId: string; dek: Uint8Array; session: Session }> {
  const dek = randomBytes(32);
  const user = await createUser(db, { email, wrappedDek: await keyWrapper.wrap(dek) });
  const created = await createSession(db, user.id, { clock, random: systemRandom });
  return { userId: user.id, dek, session: created.session };
}

async function recordRecovery(db: Db, userId: string, dek: Uint8Array): Promise<string> {
  const entry = await createRedactingRecorder({ db, clock: fixedClock(RECOVERED_AT), dekFor: async () => dek }).record({
    userId, kind: ACCOUNT_RECOVERED_KIND, source: "warthog", outcome: "saved", payload: { summary: ACCOUNT_RECOVERED_SUMMARY },
  });
  return entry.entryHash;
}

function text(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

test("after a recovery Home lists the kept agents, each linking to its settings", async () => {
  const db = await freshDb();
  try {
    const owner = await seed(db, "home-recovered@example.com");
    const claude = await createAgent(db, { userId: owner.userId, connectionId: randomUUID(), displayName: "Claude Desktop", platform: "claude" }, fixedClock(new Date("2026-11-01T00:00:00Z")));
    await recordRecovery(db, owner.userId, owner.dek);

    const view = await createHomeActions({ db, keyWrapper, clock }).load(owner.session);
    assert.ok(view.recoveryReview, "the review notice is offered");
    assert.deepEqual(view.recoveryReview.agents.map((a) => [a.name, a.href]), [
      ["Claude Desktop", `/agents/${claude.id}?section=settings`],
    ]);

    const markup = renderToStaticMarkup(<DashboardView {...view} dismissRecoveryReview={async () => undefined} />);
    const words = text(markup);
    assert.match(words, /Your account was recovered on/);
    assert.match(words, /old passkeys and authenticator app were removed/i);
    assert.match(words, /still connected/i);
    assert.doesNotMatch(words, /(agents?|keys?) (was|were) removed|removed (your|the) agents?/i, "never implies Warthog removed an agent");
    assert.ok(markup.includes(`href="/agents/${claude.id}?section=settings"`), "a link to the agent's settings");
    assert.ok(markup.includes(`href="/agents"`), "a link to Agents, where an agent is disconnected");
    assert.match(words, /Dismiss/);
    assert.match(markup, /data-tone="warning"/, "inside a notice, never loose on the page");
  } finally {
    await db.close();
  }
});

test("a dismissed review, or no recovery at all, shows no notice", async () => {
  const db = await freshDb();
  try {
    const owner = await seed(db, "home-dismissed@example.com");
    const other = await seed(db, "home-never@example.com");
    await createAgent(db, { userId: owner.userId, connectionId: randomUUID(), displayName: "Claude", platform: "claude" }, fixedClock(new Date("2026-11-01T00:00:00Z")));
    await createAgent(db, { userId: other.userId, connectionId: randomUUID(), displayName: "Claude", platform: "claude" }, fixedClock(new Date("2026-11-01T00:00:00Z")));
    const id = await recordRecovery(db, owner.userId, owner.dek);
    const actions = createHomeActions({ db, keyWrapper, clock });

    const dismissed = await actions.load(owner.session, { dismissedRecoveryReview: id });
    assert.equal(dismissed.recoveryReview, undefined);
    const never = await actions.load(other.session);
    assert.equal(never.recoveryReview, undefined, "another account's recovery is not shown");
    assert.doesNotMatch(text(renderToStaticMarkup(<DashboardView {...never} />)), /was recovered/);
  } finally {
    await db.close();
  }
});
