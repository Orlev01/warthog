// The app-host handoff route (src/server/admin/app-handoff-handler.ts): a signed-in live
// admin with a fresh step-up is redirected straight to the admin host's exchange; a stale
// step-up is sent to a fresh sign-in that returns here; everyone else gets a bare 404 that
// says nothing. No page, no client code.
import { test } from "node:test";
import assert from "node:assert/strict";

import { freshDb } from "../../test/db";
import { systemRandom } from "../seams/random";
import { COOKIE_NAME } from "../auth/session";
import { APP_HANDOFF_PATH } from "../http/admin-routing";
import { createAppHandoffHandler } from "./app-handoff-handler";
import { exchangeHandoff } from "./session";
import { createAccount, signIn, steerableClock } from "./test-fixtures";

const PUBLIC = "https://app.example.test";
const ADMIN = "https://admin.example.test";

function request(token: string | null): Request {
  const headers = new Headers();
  if (token) headers.set("cookie", `${COOKIE_NAME}=${token}`);
  return new Request(`${PUBLIC}${APP_HANDOFF_PATH}`, { headers });
}

test("a live admin with a fresh step-up goes straight to the admin host's exchange with a working single-use token", async () => {
  const db = await freshDb();
  try {
    const clock = steerableClock(new Date("2026-11-13T01:00:00Z"));
    const { userId } = await createAccount(db, { role: "admin" });
    const { token } = await signIn(db, userId, clock);
    const handoff = createAppHandoffHandler({ db, clock, random: systemRandom, adminOrigin: ADMIN });

    for (let i = 0; i < 2; i++) {
      const response = await handoff(request(token));
      assert.equal(response.status, 303);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const location = new URL(response.headers.get("location")!);
      assert.equal(location.origin + location.pathname, `${ADMIN}/session`);
      assert.ok(await exchangeHandoff(db, location.searchParams.get("handoff")!, { clock, random: systemRandom }), "the token exchanges");
    }
  } finally {
    await db.close();
  }
});

test("a stale step-up is sent to a fresh sign-in that returns to the handoff", async () => {
  const db = await freshDb();
  try {
    const clock = steerableClock(new Date("2026-11-13T01:00:00Z"));
    const { userId } = await createAccount(db, { role: "admin" });
    const { token } = await signIn(db, userId, clock, { stepUp: false });
    const response = await createAppHandoffHandler({ db, clock, random: systemRandom, adminOrigin: ADMIN })(request(token));
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `/signin?next=${encodeURIComponent(APP_HANDOFF_PATH)}&fresh=1`);
  } finally {
    await db.close();
  }
});

test("signed out, unknown, member or demoted: a bare 404 with no body and no hint", async () => {
  const db = await freshDb();
  try {
    const clock = steerableClock(new Date("2026-11-13T01:00:00Z"));
    const member = await createAccount(db);
    const admin = await createAccount(db, { role: "admin" });
    const memberSession = await signIn(db, member.userId, clock);
    const adminSession = await signIn(db, admin.userId, clock);
    const handoff = createAppHandoffHandler({ db, clock, random: systemRandom, adminOrigin: ADMIN });

    const refusals = [
      await handoff(request(null)),
      await handoff(request("not-a-session")),
      await handoff(request(memberSession.token)),
    ];
    await db.query("UPDATE users SET role = 'member' WHERE id = $1", [admin.userId]);
    refusals.push(await handoff(request(adminSession.token)));
    for (const response of refusals) {
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("location"), null);
      assert.equal(await response.text(), "");
    }
    const minted = await db.query("SELECT count(*)::int AS n FROM admin_sessions");
    assert.equal(minted.rows[0]?.n, 0, "no handoff was minted for any refusal");
  } finally {
    await db.close();
  }
});
