import { test } from "node:test";
import assert from "node:assert/strict";

import { freshDb } from "../../test/db";
import { adminEntryFor, admitHandoff, handoffSignInUrl } from "./entry";
import { createAccount, signIn, steerableClock } from "./test-fixtures";

test("the entry knows who is a live admin and which factors they hold", async () => {
  const db = await freshDb();
  try {
    const member = await createAccount(db);
    assert.deepEqual(await adminEntryFor(db, member.userId), { isAdmin: false, passkey: false, authenticator: false });
    const admin = await createAccount(db, { role: "admin" });
    await db.query("INSERT INTO passkeys (user_id, credential_id, public_key, counter) VALUES ($1, 'c', 'k', 0)", [admin.userId]);
    assert.deepEqual(await adminEntryFor(db, admin.userId), { isAdmin: true, passkey: true, authenticator: false });
    await db.query("INSERT INTO totp_secrets (user_id, secret_enc) VALUES ($1, 'enc')", [admin.userId]);
    assert.deepEqual(await adminEntryFor(db, admin.userId), { isAdmin: true, passkey: true, authenticator: true });
    const ghost = await createAccount(db, { role: "admin", tombstone: true });
    assert.equal((await adminEntryFor(db, ghost.userId)).isAdmin, false);
  } finally {
    await db.close();
  }
});

test("the unlinked handoff route admits only a signed-in live admin; everyone else gets nothing", async () => {
  const db = await freshDb();
  try {
    const clock = steerableClock(new Date("2026-11-13T01:00:00Z"));
    const member = await createAccount(db);
    const admin = await createAccount(db, { role: "admin" });
    await db.query("INSERT INTO passkeys (user_id, credential_id, public_key, counter) VALUES ($1, 'c', 'k', 0)", [admin.userId]);
    const memberSession = await signIn(db, member.userId, clock);
    const adminSession = await signIn(db, admin.userId, clock, { stepUp: false });

    assert.equal(await admitHandoff(null, { db, clock }), null, "signed out");
    assert.equal(await admitHandoff("", { db, clock }), null);
    assert.equal(await admitHandoff("not-a-session", { db, clock }), null, "unknown token");
    assert.equal(await admitHandoff(memberSession.token, { db, clock }), null, "a member, even freshly confirmed");
    // Admission is about the role only; the step-up is enforced when the handoff is minted.
    assert.deepEqual(await admitHandoff(adminSession.token, { db, clock }), { isAdmin: true, passkey: true, authenticator: false });

    await db.query("UPDATE users SET role = 'member' WHERE id = $1", [admin.userId]);
    assert.equal(await admitHandoff(adminSession.token, { db, clock }), null, "demoted");
  } finally {
    await db.close();
  }
});

test("the admin host's sign-in link goes through the app's ordinary sign-in and back to the handoff", () => {
  assert.equal(handoffSignInUrl("https://app.example.test"), "https://app.example.test/signin?next=%2Fhandoff");
});
