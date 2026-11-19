// Marking a request done from the admin portal (src/server/admin/request-handler.ts): the
// portal's one write needs the admin Origin and a live admin session, accepts only a request id
// and a closed set of states, returns to the Requests page with a notice, and records only an
// outcome metric.
import { test } from "node:test";
import assert from "node:assert/strict";

import { freshDb } from "../../test/db";
import { systemRandom } from "../seams/random";
import type { RecordMetricInput } from "../metrics/record";
import { createAdminExchangeHandler } from "./exchange-handler";
import { createAdminRequestUpdateHandler, createAdminRequestUpdateRouteHandler } from "./request-handler";
import { ADMIN_COOKIE_NAME, mintHandoff } from "./session";
import { createAccount, signIn, steerableClock } from "./test-fixtures";

const PUBLIC = "https://app.example.test";
const ADMIN = "https://admin.example.test";

async function world(db: Awaited<ReturnType<typeof freshDb>>, role: "admin" | "member" = "admin") {
  const clock = steerableClock(new Date("2026-11-20T01:00:00Z"));
  const { userId } = await createAccount(db, { role });
  const { session } = await signIn(db, userId, clock);
  const handoff = await mintHandoff(db, { sessionId: session.id, userId }, { clock, random: systemRandom });
  const exchange = createAdminExchangeHandler({ db, clock, random: systemRandom, recordMetric: async () => {} });
  const cookie = (await exchange(new Request(`${ADMIN}/session?handoff=${handoff.token}`))).headers.get("set-cookie");
  const token = cookie ? cookie.split(";")[0]!.split("=")[1]! : "";
  const asker = await createAccount(db, { email: "asker@example.test" });
  const request = (await db.query(
    "INSERT INTO connector_requests (user_id, service_name, status, requested_at) VALUES ($1, 'LinkedIn', 'requested', $2::timestamptz) RETURNING id",
    [asker.userId, "2026-11-19T01:00:00Z"],
  )).rows[0]!.id as string;
  return { clock, token, request };
}

function post(body: Record<string, string>, headers: Record<string, string>): Request {
  return new Request(`${ADMIN}/requests/update`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });
}

const handledAt = async (db: Awaited<ReturnType<typeof freshDb>>, id: string) =>
  (await db.query("SELECT handled_at FROM connector_requests WHERE id = $1", [id])).rows[0]!.handled_at;

test("marking a request done needs the admin Origin and a live admin session", async () => {
  const db = await freshDb();
  try {
    const { clock, token, request } = await world(db);
    const metrics: RecordMetricInput[] = [];
    const update = createAdminRequestUpdateHandler({ db, clock, adminOrigin: ADMIN, recordMetric: async (m) => { metrics.push(m); } });

    for (const origin of [undefined, PUBLIC, "https://evil.example.test"]) {
      const headers: Record<string, string> = { cookie: `${ADMIN_COOKIE_NAME}=${token}` };
      if (origin) headers.origin = origin;
      const refused = await update(post({ id: request, to: "done" }, headers));
      assert.equal(refused.status, 403, String(origin));
    }
    for (const cookie of ["", `${ADMIN_COOKIE_NAME}=${"0".repeat(64)}`]) {
      const signedOut = await update(post({ id: request, to: "done" }, { origin: ADMIN, cookie }));
      assert.equal(signedOut.status, 303);
      assert.equal(signedOut.headers.get("location"), "/signin");
    }
    assert.equal(await handledAt(db, request), null, "nothing changed");
    assert.deepEqual(metrics, []);
  } finally {
    await db.close();
  }
});

test("a member's session can't mark anything done", async () => {
  const db = await freshDb();
  try {
    const { clock, token, request } = await world(db, "member");
    const update = createAdminRequestUpdateHandler({ db, clock, adminOrigin: ADMIN, recordMetric: async () => {} });
    const refused = await update(post({ id: request, to: "done" }, { origin: ADMIN, cookie: `${ADMIN_COOKIE_NAME}=${token}` }));
    assert.equal(refused.headers.get("location"), "/signin");
    assert.equal(await handledAt(db, request), null);
  } finally {
    await db.close();
  }
});

test("an admin marks a request done and back to waiting, returning to the same filter with a notice", async () => {
  const db = await freshDb();
  try {
    const { clock, token, request } = await world(db);
    const metrics: RecordMetricInput[] = [];
    const update = createAdminRequestUpdateHandler({ db, clock, adminOrigin: ADMIN, recordMetric: async (m) => { metrics.push(m); } });
    const headers = { origin: ADMIN, cookie: `${ADMIN_COOKIE_NAME}=${token}` };

    const done = await update(post({ id: request, to: "done", filter: "all" }, headers));
    assert.equal(done.status, 303);
    assert.equal(done.headers.get("location"), "/requests?filter=all&notice=done");
    assert.equal(done.headers.get("cache-control"), "no-store");
    assert.equal(new Date(await handledAt(db, request)).toISOString(), clock.now().toISOString());

    const back = await update(post({ id: request, to: "waiting", filter: "done" }, headers));
    assert.equal(back.headers.get("location"), "/requests?filter=done&notice=waiting");
    assert.equal(await handledAt(db, request), null);

    assert.deepEqual(metrics.map((m) => [m.name, m.dimensions?.outcome]), [["admin.request", "done"], ["admin.request", "waiting"]]);
    assert.ok(!JSON.stringify(metrics).includes(request), "the metric carries no id");
  } finally {
    await db.close();
  }
});

test("a malformed form changes nothing and says so", async () => {
  const db = await freshDb();
  try {
    const { clock, token, request } = await world(db);
    const metrics: RecordMetricInput[] = [];
    const update = createAdminRequestUpdateHandler({ db, clock, adminOrigin: ADMIN, recordMetric: async (m) => { metrics.push(m); } });
    const headers = { origin: ADMIN, cookie: `${ADMIN_COOKIE_NAME}=${token}` };
    for (const body of [
      { id: "not-a-uuid", to: "done" },
      { id: request, to: "delete" },
      { id: request },
      { id: "00000000-0000-4000-8000-000000000000", to: "done" },
      { id: `${request}' OR 1=1 --`, to: "done" },
    ]) {
      const refused = await update(post({ ...body, filter: "javascript:alert(1)" }, headers));
      assert.equal(refused.status, 303, JSON.stringify(body));
      assert.equal(refused.headers.get("location"), "/requests?filter=waiting&notice=problem", "an unknown filter returns to Waiting");
    }
    const notForm = await update(new Request(`${ADMIN}/requests/update`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" }));
    assert.equal(notForm.headers.get("location"), "/requests?filter=waiting&notice=problem");
    assert.equal(await handledAt(db, request), null);
    assert.deepEqual(metrics, []);
  } finally {
    await db.close();
  }
});

test("the lazy route dispatcher builds the handler once from the composition seams", async () => {
  const db = await freshDb();
  try {
    const { clock, token, request } = await world(db);
    let builds = 0;
    const dispatch = createAdminRequestUpdateRouteHandler({
      getDeps: async () => { builds++; return { db, clock, random: systemRandom, publicOrigin: PUBLIC, adminOrigin: ADMIN, recordMetric: async () => {} }; },
    });
    const headers = { origin: ADMIN, cookie: `${ADMIN_COOKIE_NAME}=${token}` };
    await dispatch(post({ id: request, to: "done" }, headers));
    await dispatch(post({ id: request, to: "waiting" }, headers));
    assert.equal(builds, 1);
  } finally {
    await db.close();
  }
});
