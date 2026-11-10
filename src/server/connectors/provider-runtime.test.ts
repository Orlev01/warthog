import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { freshDb } from "../../test/db";
import { providerFixture, settings } from "../../test/provider-mcp";
import { createUser } from "../db/users";
import {
  getConnectionCredentials,
  getConnectionById,
  listConnectionsForUser,
} from "../db/connections";
import { loadCatalogue } from "./catalogue";
import { createProviderRuntime } from "./provider-runtime";
import { fixedClock } from "../seams/clock";

test("provider sign-in survives runtime recreation, isolates sessions, encrypts secrets, and reconnects in place", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32),
      user = await createUser(db, {
        email: "provider@warthog.test",
        wrappedDek: "unused",
      });
    const fixture = providerFixture(),
      base = loadCatalogue({
        dir: "catalogue/connectors",
        isOAuthClientConfigured: () => false,
      });
    const catalogue = {
      ...base,
      get: (id: string) => {
        const e = base.get(id);
        return e ? { ...e, base_url: settings.serverUrl } : undefined;
      },
    };
    const clock = fixedClock(new Date("2026-11-11T00:00:00Z"));
    const deps = {
      db,
      catalogue,
      clock,
      publicBaseUrl: settings.publicBaseUrl,
      dekFor: async () => dek,
      fetch: fixture.fetch,
    };
    const session = {
      id: randomUUID(),
      userId: user.id,
      createdAt: clock.now(),
      lastSeenAt: clock.now(),
      steppedUpAt: null,
    };
    const runtime = createProviderRuntime(deps);
    const url = new URL((await runtime.begin(session, "notion")).url),
      state = url.searchParams.get("state")!;
    assert.equal(
      (
        await db.query("SELECT payload FROM provider_mcp_flows")
      ).rows[0]?.payload
        ?.toString()
        .includes("registered"),
      false,
    );
    assert.equal(await runtime.take(user.id, randomUUID(), state), null);
    assert.equal(await runtime.take(randomUUID(), session.id, state), null);
    const restarted = createProviderRuntime(deps),
      flow = await restarted.take(user.id, session.id, state);
    assert.ok(flow);
    assert.equal(await runtime.take(user.id, session.id, state), null);
    const connection = await restarted.complete({
      ...flow,
      userId: user.id,
      state,
      code: "code",
      iss: "https://auth.example.test",
    });
    assert.equal(connection.status, "connected");
    const credentials = await getConnectionCredentials(
      db,
      user.id,
      connection.id,
      dek,
    );
    assert.ok(credentials?.providerMcp);
    const raw = (
      await db.query("SELECT credentials FROM connections WHERE id = $1", [
        connection.id,
      ])
    ).rows[0]?.credentials as string;
    assert.ok(!raw.includes("access") && !raw.includes("refresh"));
    const toolsets = await restarted.toolsets(user.id, [connection]);
    assert.equal(toolsets[connection.id]?.[0]?.requiresApproval, true);
    assert.equal(toolsets[connection.id]?.[0]?.makesChange, true);
    fixture.expire();
    fixture.failCalls(true);
    await assert.rejects(() =>
      restarted.execute(user.id, connection.id, "search", {
        arguments: { query: "hello" },
      }),
    );
    assert.equal(
      (
        (await getConnectionCredentials(db, user.id, connection.id, dek))
          ?.providerMcp as { tokens: { access_token: string } }
      ).tokens.access_token,
      "renewed",
    );
    fixture.failCalls(false);
    await restarted.execute(user.id, connection.id, "search", {
      arguments: { query: "retry" },
    });
    assert.equal(fixture.refreshes(), 1);
    await assert.rejects(() =>
      restarted.execute(randomUUID(), connection.id, "search", {
        arguments: {},
      }),
    );
    await assert.rejects(() =>
      restarted.execute(user.id, connection.id, "unknown", { arguments: {} }),
    );
    const again = new URL(
        (await runtime.begin(session, "notion", connection.id)).url,
      ),
      state2 = again.searchParams.get("state")!;
    const flow2 = await runtime.take(user.id, session.id, state2);
    assert.ok(flow2);
    const renewed = await runtime.complete({
      ...flow2,
      userId: user.id,
      state: state2,
      code: "another-code",
    });
    assert.equal(renewed.id, connection.id);
    assert.equal((await listConnectionsForUser(db, user.id)).length, 1);
    assert.equal(
      (await getConnectionById(db, user.id, connection.id))?.status,
      "connected",
    );
    const expiring = new URL(
      (await runtime.begin(session, "notion")).url,
    ).searchParams.get("state")!;
    const later = createProviderRuntime({
      ...deps,
      clock: fixedClock(new Date(clock.now().getTime() + 600_001)),
    });
    assert.equal(await later.take(user.id, session.id, expiring), null);
  } finally {
    await db.close();
  }
});
