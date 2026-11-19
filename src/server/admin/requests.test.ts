// The admin portal's Requests reads and its one write (src/server/admin/requests.ts;
// docs/adr/admin-portal.md, amendment of 20 November 2026): a static guard that the module
// selects the requester's address but nothing else personal, and behaviour over the seeded
// world — newest first, deleted accounts left out, the account facts beside each request, and
// marking a request done or waiting again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { freshDb } from "../../test/db";
import { listRequests, setRequestHandled } from "./requests";
import { NOW, SECRET_AGENT_NAME, SECRET_CREDENTIALS, SECRET_EMAIL, SECRET_IDENTITY, SECRET_LABEL, SECRET_PAYLOAD, seedAdminWorld } from "./seed.test-helper";

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

test("the requests module selects the requester's address and nothing else personal (static guard)", () => {
  const source = readFileSync(new URL("./requests.ts", import.meta.url), "utf8").replaceAll("wrapped_dek <> ''", "");
  for (const forbidden of ["payload_ct", "credentials", "wrapped_dek", "detail", "question", "args", "secret_enc", "public_key", "credential_id", "account_label", "display_name", "identity_fields", "mobile_numbers", "endpoint", "keys", "merchant", "amount", "key-wrapper", "envelope", "dekFor", "SELECT *"]) {
    assert.doesNotMatch(source, new RegExp(`\\b${forbidden.replace(/[-*]/g, "\\$&")}\\b`), `requests.ts must not mention ${forbidden}`);
  }
  assert.match(source, /\bu\.email\b/, "it shows who asked");
});

test("requests list newest first with the person who asked, leaving deleted accounts out", async () => {
  const db = await freshDb();
  try {
    const seeded = await seedAdminWorld(db);
    await db.query("INSERT INTO account_currency (user_id, currency) VALUES ($1, 'AUD')", [seeded.complete]);
    await db.query(
      "INSERT INTO connector_requests (user_id, kind, service_name, connector_id, status, requested_at) VALUES ($1, 'google_early_access', 'Gmail', 'google-gmail', 'requested', $2::timestamptz)",
      [seeded.fresh, hoursAgo(1)],
    );
    await db.query("INSERT INTO connector_requests (user_id, service_name, status, requested_at) VALUES ($1, 'Gone Service', 'requested', $2::timestamptz)", [seeded.tombstone, hoursAgo(0.5)]);

    const rows = await listRequests(db);
    assert.equal(rows.length, 4, "the deleted account's request is left out");
    assert.deepEqual(rows.slice(0, 2).map((r) => r.serviceName), ["Gmail", "Spotify"], "newest first");
    assert.deepEqual(rows.slice(2).map((r) => r.serviceName).sort(), [" spotify ", "Once Only Service"]);
    assert.ok(!rows.some((r) => r.serviceName === "Gone Service"));
    assert.ok(!JSON.stringify(rows).includes("gone@example.test"), "and so is its address");

    const [early, spotify] = rows;
    assert.equal(early!.kind, "google_early_access");
    assert.equal(early!.connectorId, "google-gmail");
    assert.equal(early!.person.email, "fresh@example.test");
    assert.equal(early!.person.requestsMade, 1);
    assert.deepEqual(early!.person.factors, []);

    assert.equal(spotify!.kind, "service");
    assert.equal(spotify!.person.email, SECRET_EMAIL, "the requester's address is shown beside their request");
    assert.equal(spotify!.person.reference, seeded.complete.slice(0, 8));
    assert.deepEqual(spotify!.person.factors, ["passkey"]);
    assert.equal(spotify!.person.currency, "AUD");
    assert.equal(spotify!.person.agentRequests, 12);
    assert.equal(spotify!.person.household, "owner");
    assert.equal(spotify!.person.role, "admin");
    assert.deepEqual(spotify!.person.agentsByPlatform.map((r) => [r.key, r.value]), [["claude", 1]]);
    assert.deepEqual(spotify!.person.connectionsByConnector.map((r) => [r.key, r.value, r.failing]), [["gmail", 1, 0]]);
    assert.equal(spotify!.handledAt, null);

    const reconnect = rows.filter((r) => r.person.email === "reconnect@example.test");
    assert.equal(reconnect.length, 2);
    assert.equal(reconnect[0]!.person.requestsMade, 2);
    assert.equal(reconnect[0]!.person.failingConnections, 1);
    assert.deepEqual(reconnect[0]!.person.connectionsByConnector.map((r) => [r.key, r.failing]), [["gmail", 1], ["outlook", 0]]);

    const serialised = JSON.stringify(rows);
    for (const secret of [SECRET_IDENTITY, SECRET_PAYLOAD, SECRET_CREDENTIALS, SECRET_LABEL, SECRET_AGENT_NAME]) {
      assert.ok(!serialised.includes(secret), `the requests read leaks ${secret}`);
    }
  } finally {
    await db.close();
  }
});

test("an empty database has no requests", async () => {
  const db = await freshDb();
  try {
    assert.deepEqual(await listRequests(db), []);
  } finally {
    await db.close();
  }
});

test("a request is marked done once, put back to waiting, and a deleted account's request can't be changed", async () => {
  const db = await freshDb();
  try {
    const seeded = await seedAdminWorld(db);
    const id = (await db.query("SELECT id FROM connector_requests WHERE service_name = 'Spotify'")).rows[0]!.id as string;
    const handled = async () => (await listRequests(db)).find((r) => r.id === id)!.handledAt;

    assert.equal(await setRequestHandled(db, id, new Date(hoursAgo(2))), true);
    assert.equal(await handled(), hoursAgo(2));
    assert.equal(await setRequestHandled(db, id, new Date(hoursAgo(1))), true, "a second 'done' is accepted");
    assert.equal(await handled(), hoursAgo(2), "and keeps the first instant");
    assert.equal(await setRequestHandled(db, id, null), true);
    assert.equal(await handled(), null);

    assert.equal(await setRequestHandled(db, "00000000-0000-4000-8000-000000000000", new Date(NOW)), false, "an unknown id changes nothing");
    const gone = (await db.query(
      "INSERT INTO connector_requests (user_id, service_name, status, requested_at) VALUES ($1, 'Gone', 'requested', $2::timestamptz) RETURNING id",
      [seeded.tombstone, hoursAgo(1)],
    )).rows[0]!.id as string;
    assert.equal(await setRequestHandled(db, gone, new Date(NOW)), false, "a deleted account's request is not touched");
    const left = await db.query("SELECT handled_at FROM connector_requests WHERE id = $1", [gone]);
    assert.equal(left.rows[0]!.handled_at, null);
  } finally {
    await db.close();
  }
});
