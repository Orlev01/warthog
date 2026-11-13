// The admin-area guard (src/server/admin/guard.ts): a verified admin token admits; anything
// else sends the person to the app's Settings with the sign-in notice.
import { test } from "node:test";
import assert from "node:assert/strict";

import { freshDb } from "../../test/db";
import { systemRandom } from "../seams/random";
import { requireAdminSession } from "./guard";
import { exchangeHandoff, mintHandoff } from "./session";
import { createAccount, signIn, steerableClock } from "./test-fixtures";

test("admits a live admin session and redirects everything else to the app's Settings", async () => {
  const db = await freshDb();
  try {
    const clock = steerableClock(new Date("2026-11-13T01:00:00Z"));
    const publicOrigin = "https://app.example.test";
    const { userId } = await createAccount(db, { role: "admin" });
    const { session } = await signIn(db, userId, clock);
    const minted = await mintHandoff(db, { sessionId: session.id, userId }, { clock, random: systemRandom });
    const live = (await exchangeHandoff(db, minted.token, { clock, random: systemRandom }))!;

    const admitted = await requireAdminSession(live.token, { db, clock, publicOrigin });
    assert.ok(admitted.ok);
    assert.equal(admitted.session.userId, userId);

    for (const token of [null, "", "garbage", minted.token]) {
      const refused = await requireAdminSession(token, { db, clock, publicOrigin });
      assert.equal(refused.ok, false);
      assert.equal((refused as { redirectTo: string }).redirectTo, "https://app.example.test/settings?notice=admin_signin_required");
    }
  } finally {
    await db.close();
  }
});
