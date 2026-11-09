import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { createVaultUnlockHttpHandlers } from "./unlock-http";
import { createVaultProof } from "../../client/vault/unlock-proof";
import { createProofChallenges, saveProvenMethod } from "./unlock-proof";
import { getWrappedKey } from "../db/vault-unlock-methods";
import type { Session } from "../auth/session";
import { createDeviceVault } from "../../client/vault/device-vault";
import { createResetExecutor } from "../account/reset-executor";

const origin = "https://app.example.test";
const vk = new Uint8Array(32).fill(39);
const dek = new Uint8Array(32).fill(58);
const initial = new Date("2026-11-09T00:00:00Z");
const body = { method: "passphrase" as const, wrapped: "opaque-envelope", params: { salt: "public-salt" } };

async function setup() {
  const db = await freshDb();
  const user = await createUser(db, { email: "proof@example.test", wrappedDek: "fixture" });
  let now = initial;
  let session: Session = { id: "proof-session", userId: user.id, createdAt: now, lastSeenAt: now, steppedUpAt: now };
  const handlers = createVaultUnlockHttpHandlers({ db, resolveSession: async () => session, clock: { now: () => now },
    publicOrigin: origin, rpId: "example.test", getDek: async () => dek.slice(), challenges: createProofChallenges() });
  async function prepare(payload = body, key = vk) {
    const material = await handlers.getMaterial(new Request(`${origin}/api/vault/unlock-material/${payload.method}`), payload.method);
    const content = await material.json();
    assert.ok(!JSON.stringify(content).includes(Buffer.from(key).toString("base64")));
    return { ...payload, proof: await createVaultProof(key, content.proof, payload) };
  }
  const save = (payload: unknown) => handlers.saveMethod(new Request(`${origin}/api/vault/unlock-method`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(payload),
  }));
  return { db, user, handlers, prepare, save, setSession: (value: Session) => { session = value; }, session: () => session,
    advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

test("vault saves require a possession proof as well as step-up; stored verifier is encrypted and never returned", async () => {
  const f = await setup();
  try {
    assert.equal((await f.save(body)).status, 400);
    const enrolled = await f.prepare();
    assert.equal((await f.save(enrolled)).status, 200);
    const rows = await f.db.query("SELECT encrypted_key FROM vault_unlock_proofs WHERE user_id = $1", [f.user.id]);
    assert.ok(rows.rows[0]);
    assert.ok(!JSON.stringify(rows).includes(enrolled.proof.verifier!));
    const wrong = await f.prepare({ ...body, wrapped: "attacker-envelope" }, new Uint8Array(32).fill(99));
    assert.equal((await f.save(wrong)).status, 403);
    assert.equal((await getWrappedKey(f.db, f.user.id, "passphrase"))?.wrappedKey, body.wrapped);
    const correct = await f.prepare({ ...body, wrapped: "new-envelope" });
    assert.equal((await f.save(correct)).status, 200);
    assert.equal((await f.save(correct)).status, 403, "a valid proof is single-use");
    assert.equal((await getWrappedKey(f.db, f.user.id, "passphrase"))?.wrappedKey, "new-envelope");
  } finally { await f.db.close(); }
});

test("proof binds session, method and exact payload, expires and does not replace step-up", async () => {
  const f = await setup();
  try {
    assert.equal((await f.save(await f.prepare())).status, 200);
    const crossed = await f.prepare();
    const original = f.session();
    f.setSession({ ...original, id: "another-session" });
    assert.equal((await f.save(crossed)).status, 403);
    f.setSession(original);
    assert.equal((await f.save({ ...await f.prepare(), params: { salt: "tampered" } })).status, 403);
    assert.equal((await f.save({ ...await f.prepare(), method: "recovery" })).status, 403);
    f.setSession({ ...original, steppedUpAt: null });
    const response = await f.save(await f.prepare());
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "step_up_required");
    const expired = await f.prepare();
    f.advance(5 * 60_000 + 1);
    assert.equal((await f.save(expired)).status, 403);
    assert.equal((await getWrappedKey(f.db, f.user.id, "passphrase"))?.wrappedKey, body.wrapped);
  } finally { await f.db.close(); }
});

test("a session cannot enrol a new verifier over a legacy vault or a winning first-setup race", async () => {
  const f = await setup();
  try {
    const first = await f.prepare();
    const loser = await f.prepare(body, new Uint8Array(32).fill(11));
    assert.equal((await f.save(first)).status, 200);
    assert.equal((await f.save(loser)).status, 409);
    await f.db.query("DELETE FROM vault_unlock_proofs WHERE user_id = $1", [f.user.id]);
    const legacy = await f.save({ ...first, proof: { ...first.proof, challenge: "invalid-legacy-challenge" } });
    assert.notEqual(legacy.status, 200);
    const material = await f.handlers.getMaterial(new Request(origin), "passphrase");
    const challenge = (await material.json()).proof;
    assert.equal(challenge.mode, "legacy");
    // Even a hand-crafted enrolment with a fresh valid challenge is refused.
    const forged = await createVaultProof(vk, { ...challenge, mode: "enroll" }, body);
    const refused = await f.save({ ...body, proof: forged });
    assert.equal(refused.status, 409);
    assert.equal((await refused.json()).error, "vault_proof_upgrade_required");
    assert.equal((await getWrappedKey(f.db, f.user.id, "passphrase"))?.wrappedKey, body.wrapped);
  } finally { await f.db.close(); }
});

test("challenge storage bounds both per-person and total outstanding work", () => {
  const store = createProofChallenges({ maxTotal: 2, maxPerUser: 1 });
  const a = store.issue("one", "session", "passphrase", 1000);
  store.issue("one", "session", "passphrase", 1001);
  assert.equal(store.take(a, "one", "session", "passphrase", 1002), false);
  store.issue("two", "session", "passphrase", 1003);
  assert.throws(() => store.issue("three", "session", "passphrase", 1004), /Too many/);
  assert.doesNotThrow(() => store.issue("three", "session", "passphrase", 302_000));
});

test("the real device helper proves vault possession and account reset permits a fresh independent vault", async () => {
  const f = await setup();
  try {
    const device = createDeviceVault({ startAuthentication: async () => { throw new Error("unused"); }, fetch: async (input, init) => {
      const request = new Request(new URL(String(input), origin), { ...init, headers: { ...init?.headers, origin } });
      return init?.method === "POST" ? f.handlers.saveMethod(request)
        : f.handlers.getMaterial(request, new URL(request.url).pathname.split("/").at(-1)!);
    } });
    await device.savePassphrase(vk, "a sufficiently long synthetic passphrase");
    assert.deepEqual(await device.unlockWithPassphrase("a sufficiently long synthetic passphrase"), vk);
    await assert.rejects(device.savePassphrase(new Uint8Array(32).fill(66), "attacker's replacement"));
    await device.savePassphrase(vk, "a changed synthetic passphrase");
    assert.deepEqual(await device.unlockWithPassphrase("a changed synthetic passphrase"), vk);
    await createResetExecutor(f.db).eraseVaultData(f.user.id);
    assert.equal((await f.db.query("SELECT * FROM vault_unlock_proofs")).rows.length, 0);
    const newKey = new Uint8Array(32).fill(93);
    await device.savePassphrase(newKey, "a fresh vault after explicit reset");
    assert.deepEqual(await device.unlockWithPassphrase("a fresh vault after explicit reset"), newKey);
  } finally { await f.db.close(); }
});


test("vault key lookup receives the active transaction instead of querying a busy outer connection", async () => {
  const db = await freshDb();
  try {
    const user = await createUser(db, { email: "transaction-vault@example.test", wrappedDek: "fixture" });
    const proof = await createVaultProof(vk, { challenge: "q".repeat(43), mode: "enroll" }, body);
    await saveProvenMethod({ db, userId: user.id, body: { ...body, proof }, replace: true,
      getDek: async (userId, tx) => {
        assert.ok(tx, "receive the transaction handle for the account lookup");
        assert.notEqual(tx, db);
        assert.equal((await tx.query("SELECT id FROM users WHERE id = $1", [userId])).rows.length, 1);
        return dek.slice();
      },
    });
    assert.ok(await getWrappedKey(db, user.id, "passphrase"));
  } finally { await db.close(); }
});
