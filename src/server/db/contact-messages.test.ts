// Messages and arrivals in the request store (db/migrations/0116_contact_messages.sql;
// docs/adr/requests-for-members.md): a "Contact us" message is a third kind of request, with
// a topic and the person's message; the arrivals sweep claims a request exactly once, and
// scans early access separately from service requests.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  claimArrivedRequest,
  countContactMessagesSince,
  createConnectorRequest,
  listConnectorRequestsForUser,
  listPendingConnectorRequests,
  listPendingEarlyAccessRequests,
} from "./connector-requests";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";

const T0 = new Date("2026-11-20T01:00:00.000Z");
const T1 = new Date("2026-11-20T02:00:00.000Z");

test("a contact message is stored with its topic and text, and the schema keeps the shapes apart", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "asks@example.test", wrappedDek: "w" });
    const message = await createConnectorRequest(
      db,
      { userId: user.id, kind: "contact", serviceName: "Question", topic: "question", message: "How do I add a second Gmail?" },
      fixedClock(T0),
    );
    assert.equal(message.kind, "contact");
    assert.equal(message.topic, "question");
    assert.equal(message.message, "How do I add a second Gmail?");

    const [stored] = await listConnectorRequestsForUser(db, user.id);
    assert.equal(stored!.topic, "question");
    assert.equal(stored!.message, "How do I add a second Gmail?");
    assert.deepEqual(await listPendingConnectorRequests(db), [], "a message is never matched against the catalogue");
    assert.deepEqual(await listPendingEarlyAccessRequests(db), []);

    const insert = (kind: string, topic: string | null, text: string | null) =>
      db.query(
        "INSERT INTO connector_requests (user_id, kind, service_name, topic, message, status, requested_at) VALUES ($1, $2, 'x', $3, $4, 'requested', $5::timestamptz)",
        [user.id, kind, topic, text, T0.toISOString()],
      );
    await assert.rejects(insert("contact", null, "no topic"), "a message needs a topic");
    await assert.rejects(insert("contact", "question", null), "a message needs its text");
    await assert.rejects(insert("service", "question", "hello"), "a service request carries no message");
    await assert.rejects(insert("contact", "complaint", "hello"), "an unknown topic is refused");
    await assert.rejects(insert("contact", "other", "x".repeat(4001)), "the text is capped");
    await assert.rejects(insert("support", null, null), "an unknown kind is still refused");
  } finally {
    await db.close();
  }
});

test("counting a person's recent messages sees only their own messages since the given time", async () => {
  const db = await freshDb();
  try {
    const a = await createUser(db, { email: "a@example.test", wrappedDek: "w" });
    const b = await createUser(db, { email: "b@example.test", wrappedDek: "w" });
    const note = { kind: "contact" as const, serviceName: "Question", topic: "question" as const, message: "hi" };
    await createConnectorRequest(db, { userId: a.id, ...note }, fixedClock(T0));
    await createConnectorRequest(db, { userId: a.id, ...note }, fixedClock(T1));
    await createConnectorRequest(db, { userId: a.id, serviceName: "LinkedIn" }, fixedClock(T1));
    await createConnectorRequest(db, { userId: b.id, ...note }, fixedClock(T1));

    assert.equal(await countContactMessagesSince(db, a.id, T0), 2);
    assert.equal(await countContactMessagesSince(db, a.id, new Date(T0.getTime() + 1)), 1);
    assert.equal(await countContactMessagesSince(db, b.id, T0), 1);
  } finally {
    await db.close();
  }
});

test("an arrived request is claimed once, and early access has its own pending scan", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "claims@example.test", wrappedDek: "w" });
    const service = await createConnectorRequest(db, { userId: user.id, serviceName: "linked in" }, fixedClock(T0));
    const early = await createConnectorRequest(
      db,
      { userId: user.id, serviceName: "Gmail", kind: "google_early_access", connectorId: "google-gmail" },
      fixedClock(T0),
    );
    assert.deepEqual((await listPendingEarlyAccessRequests(db)).map((r) => r.id), [early.id]);

    const first = await claimArrivedRequest(db, { id: service.id, connectorId: "linkedin" }, fixedClock(T1));
    assert.equal(first?.status, "matched");
    assert.equal(first?.matchedConnectorId, "linkedin");
    assert.equal(new Date(first!.matchedAt!).toISOString(), T1.toISOString());
    assert.equal(await claimArrivedRequest(db, { id: service.id, connectorId: "linkedin" }, fixedClock(T1)), null, "a second claim finds nothing");

    await claimArrivedRequest(db, { id: early.id, connectorId: "google-gmail" }, fixedClock(T1));
    assert.deepEqual(await listPendingEarlyAccessRequests(db), []);
    assert.deepEqual(await listPendingConnectorRequests(db), []);
  } finally {
    await db.close();
  }
});
