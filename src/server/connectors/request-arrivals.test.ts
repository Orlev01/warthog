// Telling people their request has arrived (src/server/connectors/request-arrivals.ts; brief
// "Request a connector": "is notified when a catalogue entry is added whose name or listed
// aliases match"; docs/adr/requests-for-members.md). The hourly sweep (also run once at boot)
// finds each waiting request the person can now act on — a service now in the catalogue for
// them, or Google early access now that they're on the list — marks it, and sends that person
// ONE email naming everything that's ready. Each request is told once, a deleted account is
// never emailed, and a failed send doesn't stop the rest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { freshDb } from "../../test/db";
import { fixedClock } from "../seams/clock";
import { createUser } from "../db/users";
import { createConnectorRequest, listConnectorRequestsForUser } from "../db/connector-requests";
import { loadCatalogue } from "./catalogue";
import { connectableMatchFor, onGoogleEarlyAccessFor } from "./request-match";
import { runRequestArrivals, type RequestArrivalsDeps } from "./request-arrivals";
import type { EmailSender, OutgoingMessage } from "../notify/senders";

const T0 = new Date("2026-11-20T01:00:00.000Z");
const T1 = new Date("2026-11-20T02:00:00.000Z");
const BASE = "https://app.example.test";
const catalogue = loadCatalogue({ dir: join(process.cwd(), "catalogue", "connectors"), isOAuthClientConfigured: () => true });

function outbox(failFor: string[] = []): EmailSender & { sent: OutgoingMessage[] } {
  const sent: OutgoingMessage[] = [];
  return {
    sent,
    async sendEmail(message) {
      if (failFor.includes(message.recipient)) throw new Error(`bounce for ${message.recipient}`);
      sent.push(message);
    },
  };
}

function deps(db: RequestArrivalsDeps["db"], email: EmailSender, allowlist: string[] = [], logs: string[] = []): RequestArrivalsDeps {
  return {
    db,
    clock: fixedClock(T1),
    email,
    match: connectableMatchFor(catalogue, allowlist),
    onGoogleEarlyAccess: onGoogleEarlyAccessFor(allowlist),
    connectorName: (id) => catalogue.get(id)?.name,
    publicBaseUrl: BASE,
    log: (line) => logs.push(line),
  };
}

test("a requested service that is now in the catalogue is marked and the person gets one email about it, once", async () => {
  const db = await freshDb();
  try {
    const sam = await createUser(db, { email: "sam@example.test", wrappedDek: "w" });
    await createConnectorRequest(db, { userId: sam.id, serviceName: "TODOIST!" }, fixedClock(T0));
    await createConnectorRequest(db, { userId: sam.id, serviceName: "Fax machine" }, fixedClock(T0));
    const box = outbox();

    assert.deepEqual(await runRequestArrivals(deps(db, box)), { told: 1, requests: 1 });
    assert.equal(box.sent.length, 1);
    const [mail] = box.sent;
    assert.equal(mail!.recipient, "sam@example.test");
    assert.equal(mail!.email?.subject, "Todoist is ready to connect");
    assert.match(mail!.email!.paragraphs[0]!, /You asked for Todoist/);
    assert.deepEqual(mail!.email?.action, { label: "Open Connectors", url: `${BASE}/connectors?view=catalogue&q=Todoist` });
    assert.match(mail!.email!.reason!, /you asked for it/);

    const stored = await listConnectorRequestsForUser(db, sam.id);
    const byName = Object.fromEntries(stored.map((r) => [r.serviceName, r]));
    assert.equal(byName["TODOIST!"]!.status, "matched");
    assert.equal(byName["TODOIST!"]!.matchedConnectorId, "todoist");
    assert.equal(byName["Fax machine"]!.status, "requested", "nothing matches it, so it keeps waiting");

    assert.deepEqual(await runRequestArrivals(deps(db, box)), { told: 0, requests: 0 }, "the next sweep tells nobody again");
    assert.equal(box.sent.length, 1);
  } finally {
    await db.close();
  }
});

test("early access arrives once the person is on the list; a Google service request needs the list too", async () => {
  const db = await freshDb();
  try {
    const in_ = await createUser(db, { email: "In@Example.test", wrappedDek: "w" });
    const out = await createUser(db, { email: "out@example.test", wrappedDek: "w" });
    for (const user of [in_, out]) {
      await createConnectorRequest(db, { userId: user.id, serviceName: "Gmail", kind: "google_early_access", connectorId: "google-gmail" }, fixedClock(T0));
      await createConnectorRequest(db, { userId: user.id, serviceName: "Google Drive", kind: "google_early_access", connectorId: "google-drive" }, fixedClock(T0));
      await createConnectorRequest(db, { userId: user.id, serviceName: "google calendar" }, fixedClock(T0));
    }
    const box = outbox();

    assert.deepEqual(await runRequestArrivals(deps(db, box, ["in@example.test"])), { told: 1, requests: 3 });
    assert.equal(box.sent.length, 1, "one email for everything that's ready");
    const [mail] = box.sent;
    assert.equal(mail!.recipient, "in@example.test");
    assert.equal(mail!.email?.subject, "Services you asked for are ready to connect");
    assert.match(mail!.email!.paragraphs.join(" "), /Gmail, Google Calendar and Google Drive/);
    assert.match(mail!.email!.paragraphs.join(" "), /early access/);
    assert.deepEqual(mail!.email?.action, { label: "Open Connectors", url: `${BASE}/connectors?view=catalogue` });

    const waiting = (await listConnectorRequestsForUser(db, out.id)).filter((r) => r.status === "requested");
    assert.equal(waiting.length, 3, "not on the list, so nothing has arrived for them");
  } finally {
    await db.close();
  }
});

test("a deleted account is never emailed, a message is never matched, and one failed send doesn't stop the rest", async () => {
  const db = await freshDb();
  try {
    const gone = await createUser(db, { email: "gone@example.test", wrappedDek: "w" });
    await db.query("UPDATE users SET wrapped_dek = '' WHERE id = $1", [gone.id]);
    const bounce = await createUser(db, { email: "bounce@example.test", wrappedDek: "w" });
    const fine = await createUser(db, { email: "fine@example.test", wrappedDek: "w" });
    for (const user of [gone, bounce, fine]) {
      await createConnectorRequest(db, { userId: user.id, serviceName: "Notion" }, fixedClock(T0));
    }
    await createConnectorRequest(
      db,
      { userId: fine.id, kind: "contact", serviceName: "A question", topic: "question", message: "Is Notion coming?" },
      fixedClock(T0),
    );
    const box = outbox(["bounce@example.test"]);
    const logs: string[] = [];

    assert.deepEqual(await runRequestArrivals(deps(db, box, [], logs)), { told: 1, requests: 2 });
    assert.deepEqual(box.sent.map((m) => m.recipient), ["fine@example.test"]);
    assert.equal(logs.length, 1);
    assert.ok(!logs[0]!.includes("bounce@example.test"), "the log names no address");
    assert.equal((await listConnectorRequestsForUser(db, gone.id))[0]!.status, "requested");
    const message = (await listConnectorRequestsForUser(db, fine.id)).find((r) => r.kind === "contact");
    assert.equal(message!.status, "requested");
  } finally {
    await db.close();
  }
});
