// "On for new agents" (docs/adr/default-services.md): the consent and access-key screens list
// the person's connected services, one row per service, and a service with an account on for
// new agents starts ticked. Everything else stays unticked, for the person to opt in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { connectedServices } from "./actions";
import { createConnection, setDefaultForAgents } from "../../../server/db/connections";
import { createUser } from "../../../server/db/users";
import { freshDb } from "../../../test/db";

const clock = { now: () => new Date("2026-11-23T00:00:00Z") };

test("a service with an account on for new agents starts ticked; the rest start unticked", async () => {
  const db = await freshDb();
  try {
    const userId = (await createUser(db, { email: "me@example.test", wrappedDek: "wrapped" })).id;
    const connect = async (connectorId: string, accountLabel: string) =>
      (await createConnection(db, { userId, connectorId, accountLabel, credentials: { token: "x" } }, randomBytes(32), clock)).id;
    await connect("google-gmail", "home@gmail.test");
    const work = await connect("google-gmail", "work@gmail.test");
    await connect("notion", "Notion");
    await setDefaultForAgents(db, { userId, id: work, on: true });

    const services = await connectedServices({ db, nameOf: (id) => (id === "google-gmail" ? "Gmail" : undefined) }, userId);
    assert.deepEqual([...services].sort((a, b) => a.id.localeCompare(b.id)), [
      { id: "google-gmail", name: "Gmail", ticked: true },
      { id: "notion", name: "notion", ticked: false },
    ]);
  } finally {
    await db.close();
  }
});
