// "Contact us" messages (src/server/contact/messages.ts; docs/adr/requests-for-members.md): a
// signed-in person sends the operator a message, which is recorded as a request for the admin
// portal's Requests page. The text is cleaned before it is stored (no invisible characters,
// sign-in codes or card numbers), it must be 1–2,000 characters with one of the five topics,
// and a burst of messages is turned away.
import { test } from "node:test";
import assert from "node:assert/strict";

import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import { createUser } from "../db/users";
import { listConnectorRequestsForUser } from "../db/connector-requests";
import {
  CONTACT_DAILY_LIMIT,
  CONTACT_MESSAGE_MAX,
  CONTACT_TOPIC_LABELS,
  cleanContactMessage,
  listContactMessagesForUser,
  sendContactMessage,
} from "./messages";

const T0 = new Date("2026-11-20T01:00:00.000Z");

test("a message is cleaned before it is kept: invisible characters, sign-in codes and card numbers never reach the store", () => {
  assert.equal(cleanContactMessage("  Hello\r\nthere​  "), "Hello\nthere");
  assert.equal(
    cleanContactMessage("My verification code 482913 didn't work"),
    "My verification code [sign-in code hidden by Warthog] didn't work",
  );
  const card = cleanContactMessage("I was charged on 4111 1111 1111 1111 twice");
  assert.ok(!card.includes("4111 1111 1111 1111"), card);
  assert.ok(card.includes("1111"), "the last four digits stay so the person can be helped");
  assert.equal(cleanContactMessage("Booking code 482913 for Friday"), "Booking code 482913 for Friday", "a reference stays readable");
  assert.equal(cleanContactMessage("a\n\n\n\n\nb"), "a\n\nb", "runs of blank lines are folded");
});

test("a person sends a message: it is recorded for them with its topic, and they can read their own messages back", async () => {
  const db = await freshDb();
  try {
    const me = await createUser(db, { email: "me@example.test", wrappedDek: "w" });
    const other = await createUser(db, { email: "other@example.test", wrappedDek: "w" });
    const sent = await sendContactMessage({ userId: me.id, topic: "privacy", message: "Please send me a copy of my data." }, { db, clock: fixedClock(T0) });
    assert.equal(sent.ok, true);
    await sendContactMessage({ userId: other.id, topic: "idea", message: "Dark mode toggle?" }, { db, clock: fixedClock(T0) });

    const [stored] = await listConnectorRequestsForUser(db, me.id);
    assert.equal(stored!.kind, "contact");
    assert.equal(stored!.topic, "privacy");
    assert.equal(stored!.serviceName, CONTACT_TOPIC_LABELS.privacy);
    assert.equal(stored!.message, "Please send me a copy of my data.");

    const mine = await listContactMessagesForUser(db, me.id);
    assert.deepEqual(mine.map((m) => m.message), ["Please send me a copy of my data."], "only the person's own messages");
  } finally {
    await db.close();
  }
});

test("an empty, oversized or off-list message is refused and nothing is stored", async () => {
  const db = await freshDb();
  try {
    const me = await createUser(db, { email: "me@example.test", wrappedDek: "w" });
    const deps = { db, clock: fixedClock(T0) };
    assert.deepEqual(await sendContactMessage({ userId: me.id, topic: "question", message: "   ​ " }, deps), { ok: false, reason: "empty" });
    assert.deepEqual(
      await sendContactMessage({ userId: me.id, topic: "question", message: "x".repeat(CONTACT_MESSAGE_MAX + 1) }, deps),
      { ok: false, reason: "too_long" },
    );
    assert.deepEqual(await sendContactMessage({ userId: me.id, topic: "complaint", message: "hi" }, deps), { ok: false, reason: "topic" });
    assert.deepEqual(await listConnectorRequestsForUser(db, me.id), []);
  } finally {
    await db.close();
  }
});

test("after a day's worth of messages, the next one is turned away until a day has passed", async () => {
  const db = await freshDb();
  try {
    const me = await createUser(db, { email: "me@example.test", wrappedDek: "w" });
    for (let i = 0; i < CONTACT_DAILY_LIMIT; i += 1) {
      const sent = await sendContactMessage({ userId: me.id, topic: "other", message: `note ${i}` }, { db, clock: fixedClock(new Date(T0.getTime() + i * 60_000)) });
      assert.equal(sent.ok, true);
    }
    const later = new Date(T0.getTime() + 60 * 60_000);
    assert.deepEqual(await sendContactMessage({ userId: me.id, topic: "other", message: "one more" }, { db, clock: fixedClock(later) }), { ok: false, reason: "too_many" });
    const nextDay = new Date(T0.getTime() + 24 * 60 * 60_000 + 1);
    assert.equal((await sendContactMessage({ userId: me.id, topic: "other", message: "next day" }, { db, clock: fixedClock(nextDay) })).ok, true);
  } finally {
    await db.close();
  }
});
