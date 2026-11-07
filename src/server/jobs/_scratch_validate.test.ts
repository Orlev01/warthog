// TEMPORARY scratch — validates the EXISTING-module fixtures my E18-S21 tests rely on
// (createUser/createApproval/approval_links, runApprovalFallback, runApprovalExpiry, the
// seam fakes). Deleted after validation; NOT part of the suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import { fixedRandom } from "../seams/random";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fakeRateSource } from "../currency/rate-source";
import { createApproval } from "../db/approvals";
import { createUser } from "../db/users";
import { runApprovalFallback } from "../notify/fallback-job";
import { runApprovalExpiry } from "../approvals/expiry-job";
import type { OutgoingMessage } from "../notify/senders";

const T0 = new Date("2026-03-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

test("scratch: AC1b fixtures — a real fallback issues a link + email for a fresh pending approval", async () => {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const dek = randomBytes(32);
    const wrappedDek = await keyWrapper.wrap(dek);
    const user = await createUser(db, { email: `fb-${randomUUID()}@warthog.com.au`, wrappedDek });
    const approval = await createApproval(
      db,
      { userId: user.id, agentId: randomUUID(), detail: { field: "card", amount: 1 } },
      dek,
      fixedClock(T0),
    );

    const emails: OutgoingMessage[] = [];
    await runApprovalFallback(
      {
        db,
        clock: fixedClock(T0),
        random: fixedRandom(7),
        senders: {
          push: { sendPush: async () => {} },
          email: { sendEmail: async (m: OutgoingMessage) => { emails.push(m); } },
          sms: { sendSms: async () => {} },
        },
        publicBaseUrl: "https://warthog.com.au",
      },
      { approvalId: approval.id },
    );

    const links = await db.query("SELECT count(*)::int AS n FROM approval_links WHERE approval_id = $1", [approval.id]);
    assert.ok(Number(links.rows[0]?.n) > 0, "a single-use link row is created");
    assert.equal(emails.length, 1, "one fallback email is sent by default");
  } finally {
    await db.close();
  }
});

test("scratch: AC2 fixtures — runApprovalExpiry expires a day-old approval, leaves a just-created one", async () => {
  const NOW = new Date("2026-11-15T12:00:00.000Z");
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  try {
    const dek = randomBytes(32);
    const wrappedDek = await keyWrapper.wrap(dek);
    const user = await createUser(db, { email: `ex-${randomUUID()}@warthog.com.au`, wrappedDek });

    const due = await createApproval(
      db,
      { userId: user.id, agentId: randomUUID(), detail: { field: "card" } },
      dek,
      fixedClock(new Date(NOW.getTime() - DAY_MS)),
    );
    const notDue = await createApproval(
      db,
      { userId: user.id, agentId: randomUUID(), detail: { field: "card" } },
      dek,
      fixedClock(NOW),
    );

    const statusOf = async (id: string) =>
      (await db.query("SELECT status FROM approvals WHERE id = $1", [id])).rows[0]?.status;
    assert.equal(await statusOf(due.id), "pending");
    assert.equal(await statusOf(notDue.id), "pending");

    // What the sweep does per due approval:
    await runApprovalExpiry({ db, clock: fixedClock(NOW), keyWrapper }, { approvalId: due.id });
    await runApprovalExpiry({ db, clock: fixedClock(NOW), keyWrapper }, { approvalId: notDue.id });

    assert.equal(await statusOf(due.id), "expired", "the day-old approval is expired");
    assert.equal(await statusOf(notDue.id), "pending", "the just-created approval is left pending");
  } finally {
    await db.close();
  }
});

test("scratch: rate source fake shape is valid", async () => {
  const src = fakeRateSource({ rateDate: "2026-03-01", baseCurrency: "AUD", rates: { USD: 0.65 } });
  const daily = await src.fetchDailyRates();
  assert.equal(daily.baseCurrency, "AUD");
});
