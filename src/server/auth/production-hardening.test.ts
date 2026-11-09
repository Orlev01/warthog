import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb, loadMigrations, runMigrations } from "../db/index";
import { issueEmailCode, verifyEmailCode } from "./email-code";
import { createUser } from "../db/users";
import { createSession, verifySession } from "./session";
import { recoverSession } from "./recover-session";
import { checkPasskeyAttempt } from "./passkey-attempts";

test("email codes cannot be redeemed in another authentication flow", async () => {
  const db = await createDb("pglite:memory");
  try {
    await runMigrations(db, await loadMigrations());
    let body = "";
    const deps = { clock: { now: () => new Date("2026-11-09T00:00:00Z") }, random: { randomBytes: (n: number) => new Uint8Array(n).fill(1) },
      hmacKey: new Uint8Array(32).fill(1), emailSender: { sendEmail: async (m: { body: string }) => { body = m.body; } } };
    await issueEmailCode(db, "person@example.test", { ...deps, purpose: "recovery" });
    const code = body.match(/\b\d{6}\b/)![0];
    assert.equal((await verifyEmailCode(db, "person@example.test", code, { ...deps, purpose: "device" })).ok, false);
    assert.equal((await verifyEmailCode(db, "person@example.test", code, { ...deps, purpose: "recovery" })).ok, true);
    assert.equal((await verifyEmailCode(db, "person@example.test", code, { ...deps, purpose: "recovery" })).ok, false);
  } finally { await db.close(); }
});

test("recovery atomically revokes older sessions while leaving other accounts signed in", async () => {
  const db = await createDb("pglite:memory");
  try {
    await runMigrations(db, await loadMigrations());
    const person = await createUser(db, { email: "person@example.test", wrappedDek: "test-key" });
    const other = await createUser(db, { email: "other@example.test", wrappedDek: "test-key" });
    let sequence = 0;
    const deps = { clock: { now: () => new Date("2026-11-09T00:00:00Z") }, random: { randomBytes: (n: number) => new Uint8Array(n).fill(++sequence) } };
    const old = await createSession(db, person.id, deps), unrelated = await createSession(db, other.id, deps);
    const recovered = await recoverSession(db, person.id, deps);
    assert.equal(await verifySession(db, old.token, deps), null);
    assert.ok(await verifySession(db, recovered.token, deps));
    assert.ok(await verifySession(db, unrelated.token, deps));
  } finally { await db.close(); }
});

test("passkey failures are bounded per account and generate only one safe alert in the window", async () => {
  const db = await createDb("pglite:memory");
  try {
    await runMigrations(db, await loadMigrations());
    const person = await createUser(db, { email: "person@example.test", wrappedDek: "test-key" });
    let verifications = 0, alerts = 0;
    const deps = { clock: { now: () => new Date("2026-11-09T00:00:00Z") }, emailSender: { sendEmail: async () => { alerts++; } } };
    const verify = async () => { verifications++; return false; };
    for (let i = 0; i < 5; i++) assert.equal((await checkPasskeyAttempt(db, person.id, verify, deps)).ok, false);
    const refused = await checkPasskeyAttempt(db, person.id, verify, deps);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "throttled");
    assert.equal(verifications, 5);
    assert.equal(alerts, 1);
  } finally { await db.close(); }
});
