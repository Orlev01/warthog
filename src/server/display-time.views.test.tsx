import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { freshDb } from "../test/db";
import { createUser } from "./db/users";
import { createAgent } from "./db/agents";
import { createApproval, decide } from "./db/approvals";
import { createMemory } from "./db/memories";
import { savePreferences } from "./db/preferences";
import { registerSubscription } from "./db/push-subscriptions";
import { createSession } from "./auth/session";
import { createDbRecorder } from "./activity/writer";
import { localAesKeyWrapper } from "./crypto/key-wrapper";
import { createReleaseStore } from "./crypto/release-store";
import { createOutbox } from "./notify/outbox";
import { fixedClock } from "./seams/clock";
import { systemRandom } from "./seams/random";
import { createHomeActions } from "@/app/(portal)/(protected)/home/actions";
import { createActivityActions } from "@/app/(portal)/(protected)/activity/actions";
import { createInboxActions } from "@/app/(portal)/(protected)/inbox/actions";
import { createNotificationsActions } from "@/app/(portal)/(protected)/settings/notifications/actions";
import { createAgentsActions } from "@/app/(portal)/(protected)/agents/actions";
import { createMemoryActions } from "@/app/(portal)/(protected)/memory/actions";
import { DashboardView } from "@/components/home/dashboard-view";
import { ActivityView } from "@/components/activity/activity-view";
import { ResetView } from "@/components/auth/auth-views";
import { PendingResetBanner } from "@/components/auth/pending-reset-banner";

test("loaders and rendered activity consistently use the encrypted account zone across date boundaries", async () => {
  const db = await freshDb();
  try {
    const clock = fixedClock(new Date("2026-11-09T02:15:00Z"));
    const dek = new Uint8Array(32);
    const keyWrapper = localAesKeyWrapper(new Uint8Array(32));
    const user = await createUser(db, { email: "time-display@example.test", wrappedDek: await keyWrapper.wrap(dek) });
    const session = (await createSession(db, user.id, { clock, random: systemRandom })).session;
    const agent = await createAgent(db, { userId: user.id, connectionId: randomUUID(), displayName: "Example agent", platform: "test" }, clock);
    const recorder = createDbRecorder({ db, clock, dekFor: async () => dek });
    await recorder.record({ userId: user.id, kind: "tool_call", source: "warthog", payload: { summary: "Example action" } });
    const approval = await createApproval(db, { userId: user.id, agentId: agent.id, detail: { sentence: "Example request" } }, dek, clock);
    await decide(db, { userId: user.id, id: approval.id, decision: { status: "approved" } }, dek, clock);
    await createMemory(db, { userId: user.id, content: "Example memory", sourceAgentId: null, scope: "shared" }, dek, clock);
    await registerSubscription(db, { userId: user.id, endpoint: "https://push.example.test/synthetic", keys: { auth: "synthetic", p256dh: "synthetic" } }, dek, clock);
    const outbox = createOutbox();
    const home = createHomeActions({ db, keyWrapper, clock });
    const activity = createActivityActions({ db, keyWrapper, disputes: { fileDispute: async () => {} },
      undo: { undo: async () => ({ ok: false, reason: "unused" }) } });
    const inbox = createInboxActions({ db, keyWrapper, clock, executeApprovedHold: async () => { throw new Error("not used by loader"); } });
    const notifications = createNotificationsActions({ db, keyWrapper, clock, random: systemRandom,
      hmacKey: new Uint8Array(32), senders: { email: outbox, sms: outbox, push: outbox } });
    const agents = createAgentsActions({ db, clock, releaseStore: createReleaseStore(clock), dekFor: async () => dek });
    const memories = createMemoryActions({ db, keyWrapper, clock });
    for (const [preference, zone, day] of [
      ["UTC", "UTC", "9 Nov 2026"],
      ["Australia/Sydney", "Australia/Sydney", "9 Nov 2026"],
      ["America/Los_Angeles", "America/Los_Angeles", "8 Nov 2026"],
      ["invalid preference", "Australia/Sydney", "9 Nov 2026"],
    ]) {
      await savePreferences(db, { userId: user.id, tone: "", length: "", language: "", units: "", briefing: "", timeZone: preference! }, dek);
      const dashboard = await home.load(session);
      const timeline = await activity.load(session, {});
      const labels = [dashboard.activity[0]!.at, timeline.entries[0]!.at,
        (await inbox.load(session)).history[0]!.decidedAt,
        (await notifications.load(session)).devices[0]!.label,
        (await agents.load(session)).agents[0]!.connectedAt,
        (await memories.load(session)).memories[0]!.savedAt];
      for (const label of labels) {
        assert.ok(label?.includes(day!), String(label));
        assert.ok(label?.includes(`(${zone})`), String(label));
      }
      assert.ok(renderToStaticMarkup(<DashboardView {...dashboard} />).includes(`(${zone})`));
      const markup = renderToStaticMarkup(<ActivityView {...timeline} />);
      assert.ok(markup.includes(`(${zone})`));
      assert.ok(markup.includes("From (UTC)") && markup.includes("To (UTC)"), "date filters keep explicit UTC bounds");
    }
  } finally { await db.close(); }
});

test("reset notices label UTC before sign-in and use the saved account zone after sign-in", () => {
  const instant = "2026-11-09T02:15:00Z";
  const publicNotice = renderToStaticMarkup(<ResetView step="requested" completesAt={instant} />);
  assert.ok(publicNotice.includes("9 Nov 2026, 2:15 am (UTC)"));
  const accountNotice = renderToStaticMarkup(<PendingResetBanner requestedAt={instant} completesAt={instant} timeZone="America/Los_Angeles" />);
  assert.ok(accountNotice.includes("8 Nov 2026, 6:15 pm (America/Los_Angeles)"));
});
