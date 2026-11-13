import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb, loadMigrations, runMigrations, withTransaction } from "../db/index";
import { issueEmailCode, verifyEmailCode } from "./email-code";
import { createUser } from "../db/users";
import { createSession, lockActiveAccount, verifySession } from "./session";
import { evictLostFactors } from "./recover-session";
import { checkPasskeyAttempt } from "./passkey-attempts";
import { SECURITY_ALERT_FOOTNOTE } from "../notify/email";
import type { OutgoingMessage } from "../notify/senders";

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

test("evicting lost factors removes the other passkeys, the authenticator app and every session of that account only", async () => {
  const db = await createDb("pglite:memory");
  try {
    await runMigrations(db, await loadMigrations());
    const person = await createUser(db, { email: "person@example.test", wrappedDek: "test-key" });
    const other = await createUser(db, { email: "other@example.test", wrappedDek: "test-key" });
    let sequence = 0;
    const deps = { clock: { now: () => new Date("2026-11-09T00:00:00Z") }, random: { randomBytes: (n: number) => new Uint8Array(n).fill(++sequence) } };
    const old = await createSession(db, person.id, deps), unrelated = await createSession(db, other.id, deps);
    await db.query("INSERT INTO passkeys (user_id, credential_id, public_key, counter) VALUES ($1, 'kept', 'k', 0), ($1, 'lost', 'l', 0), ($2, 'theirs', 't', 0)", [person.id, other.id]);
    await db.query("INSERT INTO totp_secrets (user_id, secret_enc) VALUES ($1, 'mine'), ($2, 'theirs')", [person.id, other.id]);
    const evicted = await withTransaction(db, async (tx) => {
      await lockActiveAccount(tx, person.id);
      return evictLostFactors(tx, person.id, "kept");
    });
    assert.deepEqual(evicted, { passkeys: 1, authenticator: true, sessions: 1 });
    assert.equal(await verifySession(db, old.token, deps), null);
    assert.ok(await verifySession(db, unrelated.token, deps));
    const passkeys = await db.query("SELECT credential_id FROM passkeys ORDER BY credential_id");
    assert.deepEqual(passkeys.rows.map((row) => row.credential_id), ["kept", "theirs"]);
    const totp = await db.query("SELECT user_id FROM totp_secrets");
    assert.deepEqual(totp.rows.map((row) => row.user_id), [other.id]);
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

test("the passkey-failures alert is a branded email with no link and no code", async () => {
  const db = await createDb("pglite:memory");
  try {
    await runMigrations(db, await loadMigrations());
    const person = await createUser(db, { email: "person@example.test", wrappedDek: "test-key" });
    const sent: OutgoingMessage[] = [];
    const deps = { clock: { now: () => new Date("2026-11-09T00:00:00Z") }, emailSender: { sendEmail: async (m: OutgoingMessage) => { sent.push(m); } } };
    for (let i = 0; i < 6; i++) await checkPasskeyAttempt(db, person.id, async () => false, deps);
    const email = sent[0]!.email!;
    assert.equal(email.subject, "Passkey sign-in attempts limited");
    assert.equal(email.heading, "Several passkey sign-ins failed");
    assert.match(email.paragraphs.join(" "), /temporarily limited further attempts/);
    assert.match(email.paragraphs.join(" "), /None of the failed attempts signed in to your account/);
    assert.equal(email.action, undefined);
    assert.equal(email.footnote, SECURITY_ALERT_FOOTNOTE);
  } finally { await db.close(); }
});

