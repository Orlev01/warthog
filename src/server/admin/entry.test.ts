import { test } from "node:test";
import assert from "node:assert/strict";

import { freshDb } from "../../test/db";
import { adminEntryFor, adminNoticeFrom } from "./entry";
import { createAccount } from "./test-fixtures";

test("the Settings entry knows who is a live admin and which factors they hold", async () => {
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

test("only the known notice keys are accepted from the query string", () => {
  assert.equal(adminNoticeFrom("admin_signed_out"), "admin_signed_out");
  assert.equal(adminNoticeFrom(["admin_handoff_expired"]), "admin_handoff_expired");
  assert.equal(adminNoticeFrom("constructor"), null);
  assert.equal(adminNoticeFrom("saved"), null);
  assert.equal(adminNoticeFrom(undefined), null);
});
