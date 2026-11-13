// The admin host's exchange and sign-out routes (src/server/admin/exchange-handler.ts,
// signout-handler.ts): one exchange sets the admin cookie and lands on the portal root;
// every failure is the same quiet redirect back to Settings; sign-out needs the admin
// Origin, ends only the admin session and clears the cookie; the audit metrics carry only
// outcomes.
import { test } from "node:test";
import assert from "node:assert/strict";

import { freshDb } from "../../test/db";
import { systemRandom } from "../seams/random";
import type { RecordMetricInput } from "../metrics/record";
import { createAdminExchangeHandler, createAdminExchangeRouteHandler } from "./exchange-handler";
import { createAdminSignoutHandler } from "./signout-handler";
import { ADMIN_COOKIE_NAME, mintHandoff, verifyAdminSession } from "./session";
import { createAccount, signIn, steerableClock } from "./test-fixtures";

const PUBLIC = "https://app.example.test";
const ADMIN = "https://admin.example.test";

async function minted(db: Awaited<ReturnType<typeof freshDb>>) {
  const clock = steerableClock(new Date("2026-11-13T01:00:00Z"));
  const { userId } = await createAccount(db, { role: "admin" });
  const { session } = await signIn(db, userId, clock);
  const handoff = await mintHandoff(db, { sessionId: session.id, userId }, { clock, random: systemRandom });
  return { clock, userId, handoff };
}

test("a fresh handoff exchanges into the admin cookie and lands on the portal root; reuse and garbage go quietly to the admin sign-in page", async () => {
  const db = await freshDb();
  try {
    const { clock, handoff } = await minted(db);
    const metrics: RecordMetricInput[] = [];
    const exchange = createAdminExchangeHandler({ db, clock, random: systemRandom, recordMetric: async (m) => { metrics.push(m); } });

    const ok = await exchange(new Request(`${ADMIN}/session?handoff=${handoff.token}`));
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get("location"), "/");
    assert.equal(ok.headers.get("cache-control"), "no-store");
    const cookie = ok.headers.get("set-cookie")!;
    assert.match(cookie, new RegExp(`^${ADMIN_COOKIE_NAME}=[0-9a-f]{64}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200$`));
    const token = cookie.split(";")[0]!.split("=")[1]!;
    assert.ok(await verifyAdminSession(db, token, { clock }), "the cookie's token is a live admin session");

    for (const url of [`${ADMIN}/session?handoff=${handoff.token}`, `${ADMIN}/session?handoff=zz`, `${ADMIN}/session`, `${ADMIN}/session?handoff=${"0".repeat(64)}`]) {
      const refused = await exchange(new Request(url));
      assert.equal(refused.status, 303, url);
      assert.equal(refused.headers.get("location"), "/signin?notice=expired");
      assert.equal(refused.headers.get("set-cookie"), null, "no cookie on a refusal");
    }
    assert.deepEqual(metrics.map((m) => m.dimensions?.outcome), ["exchanged", "rejected", "rejected", "rejected", "rejected"]);
    assert.ok(!JSON.stringify(metrics).includes(handoff.token));
  } finally {
    await db.close();
  }
});

test("the lazy route dispatcher builds the handler once from the composition seams", async () => {
  const db = await freshDb();
  try {
    const { clock, handoff } = await minted(db);
    let builds = 0;
    const dispatch = createAdminExchangeRouteHandler({ getDeps: async () => { builds++; return { db, clock, random: systemRandom, publicOrigin: PUBLIC, adminOrigin: ADMIN, recordMetric: async () => {} }; } });
    const first = await dispatch(new Request(`${ADMIN}/session?handoff=${handoff.token}`));
    const second = await dispatch(new Request(`${ADMIN}/session?handoff=${handoff.token}`));
    assert.equal(first.headers.get("location"), "/");
    assert.equal(second.headers.get("location"), "/signin?notice=expired");
    assert.equal(builds, 1);
  } finally {
    await db.close();
  }
});

test("sign-out requires the admin Origin, ends only the admin session, clears the cookie and lands on the admin host's signed-out page", async () => {
  const db = await freshDb();
  try {
    const { clock, handoff } = await minted(db);
    const exchange = createAdminExchangeHandler({ db, clock, random: systemRandom, recordMetric: async () => {} });
    const token = (await exchange(new Request(`${ADMIN}/session?handoff=${handoff.token}`))).headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
    const metrics: RecordMetricInput[] = [];
    const signout = createAdminSignoutHandler({ db, publicOrigin: PUBLIC, adminOrigin: ADMIN, recordMetric: async (m) => { metrics.push(m); } });

    for (const origin of [undefined, PUBLIC, "https://evil.example.test"]) {
      const headers: Record<string, string> = { cookie: `${ADMIN_COOKIE_NAME}=${token}` };
      if (origin) headers.origin = origin;
      const refused = await signout(new Request(`${ADMIN}/signout`, { method: "POST", headers }));
      assert.equal(refused.status, 403, String(origin));
    }
    assert.ok(await verifyAdminSession(db, token, { clock }), "a refused sign-out ends nothing");

    const done = await signout(new Request(`${ADMIN}/signout`, { method: "POST", headers: { origin: ADMIN, cookie: `other=1; ${ADMIN_COOKIE_NAME}=${token}` } }));
    assert.equal(done.status, 303);
    // Same origin on purpose: a cross-origin 303 after a form POST is blocked by CSP form-action.
    assert.equal(done.headers.get("location"), "/signed-out");
    assert.equal(done.headers.get("set-cookie"), `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    assert.equal(await verifyAdminSession(db, token, { clock }), null);
    assert.equal(Number((await db.query("SELECT count(*)::int AS n FROM sessions")).rows[0]!.n), 1, "the app session stays");
    assert.deepEqual(metrics.map((m) => m.name), ["admin.signout"]);

    const noCookie = await signout(new Request(`${ADMIN}/signout`, { method: "POST", headers: { origin: ADMIN } }));
    assert.equal(noCookie.status, 303, "signing out with no cookie is a harmless redirect");
  } finally {
    await db.close();
  }
});
