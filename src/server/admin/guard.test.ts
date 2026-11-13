// The admin-area guard (src/server/admin/guard.ts): a verified admin token admits; anything
// else sends the person to the admin host's own sign-in page, never to the member app.
import { test } from "node:test";
import assert from "node:assert/strict";

import { freshDb } from "../../test/db";
import { systemRandom } from "../seams/random";
import { adminSignInNoticeFrom, adminSignInUrl, requireAdminSession } from "./guard";
import { exchangeHandoff, mintHandoff } from "./session";
import { createAccount, signIn, steerableClock } from "./test-fixtures";

test("admits a live admin session and redirects everything else to the admin host's sign-in page", async () => {
  const db = await freshDb();
  try {
    const clock = steerableClock(new Date("2026-11-13T01:00:00Z"));
    const { userId } = await createAccount(db, { role: "admin" });
    const { session } = await signIn(db, userId, clock);
    const minted = await mintHandoff(db, { sessionId: session.id, userId }, { clock, random: systemRandom });
    const live = (await exchangeHandoff(db, minted.token, { clock, random: systemRandom }))!;

    const admitted = await requireAdminSession(live.token, { db, clock });
    assert.ok(admitted.ok);
    assert.equal(admitted.session.userId, userId);

    for (const token of [null, "", "garbage", minted.token]) {
      const refused = await requireAdminSession(token, { db, clock });
      assert.equal(refused.ok, false);
      assert.equal((refused as { redirectTo: string }).redirectTo, "/signin");
    }
  } finally {
    await db.close();
  }
});

test("the sign-in page's notices come only from known keys and never point at the app", () => {
  assert.equal(adminSignInUrl(), "/signin");
  assert.equal(adminSignInUrl("expired"), "/signin?notice=expired");
  assert.equal(adminSignInNoticeFrom("expired"), "expired");
  assert.equal(adminSignInNoticeFrom(["signed_out"]), "signed_out");
  assert.equal(adminSignInNoticeFrom("constructor"), null);
  assert.equal(adminSignInNoticeFrom("admin_signin_required"), null);
  assert.equal(adminSignInNoticeFrom(undefined), null);
});
