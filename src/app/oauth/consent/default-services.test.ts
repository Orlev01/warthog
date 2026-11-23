// "On for new agents" (docs/adr/default-services.md) with several accounts of a service
// (docs/adr/several-accounts-per-agent.md): the consent and access-key screens list each of the
// person's connected accounts on its own, by service name and then account, and every account
// on for new agents starts ticked. Everything else stays unticked, for the person to opt in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { connectedAccounts } from "./actions";
import { createConnection, setDefaultForAgents } from "../../../server/db/connections";
import { createUser } from "../../../server/db/users";
import { freshDb } from "../../../test/db";

const clock = { now: () => new Date("2026-11-24T00:00:00Z") };
const NAMES: Record<string, string> = { "google-gmail": "Gmail", "google-calendar": "Google Calendar" };

test("each account is listed on its own, by service and then account; accounts on for new agents start ticked", async () => {
  const db = await freshDb();
  try {
    const userId = (await createUser(db, { email: "me@example.test", wrappedDek: "wrapped" })).id;
    const otherId = (await createUser(db, { email: "other@example.test", wrappedDek: "wrapped" })).id;
    const connect = async (connectorId: string, accountLabel: string, owner = userId) =>
      (await createConnection(db, { userId: owner, connectorId, accountLabel, credentials: { token: "x" } }, randomBytes(32), clock)).id;
    const booking = await connect("google-gmail", "levyorenbooking@gmail.com");
    const notion = await connect("notion", "Notion");
    const home = await connect("google-gmail", "levyoren1@gmail.com");
    const calendar = await connect("google-calendar", "levyoren1@gmail.com");
    const billing = await connect("google-gmail", "levyorenbilling@gmail.com");
    await connect("google-gmail", "them@gmail.com", otherId);
    await setDefaultForAgents(db, { userId, id: home, on: true });
    await setDefaultForAgents(db, { userId, id: billing, on: true });

    const accounts = await connectedAccounts({ db, nameOf: (id) => NAMES[id] }, userId);
    assert.deepEqual(accounts, [
      { id: home, connectorId: "google-gmail", serviceName: "Gmail", label: "levyoren1@gmail.com", ticked: true },
      { id: billing, connectorId: "google-gmail", serviceName: "Gmail", label: "levyorenbilling@gmail.com", ticked: true },
      { id: booking, connectorId: "google-gmail", serviceName: "Gmail", label: "levyorenbooking@gmail.com", ticked: false },
      { id: calendar, connectorId: "google-calendar", serviceName: "Google Calendar", label: "levyoren1@gmail.com", ticked: false },
      { id: notion, connectorId: "notion", serviceName: "notion", label: "Notion", ticked: false },
    ], "only the person's own accounts, two Gmail accounts ticked");
  } finally {
    await db.close();
  }
});
