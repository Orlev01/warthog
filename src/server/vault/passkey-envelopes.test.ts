import assert from "node:assert/strict";
import test from "node:test";
import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { createVaultUnlockHttpHandlers } from "./unlock-http";
import { createProofChallenges } from "./unlock-proof";
import { createDeviceVault } from "../../client/vault/device-vault";
import { createVaultProof } from "../../client/vault/unlock-proof";
import { listMethods, saveWrappedKey } from "../db/vault-unlock-methods";
import { createResetExecutor } from "../account/reset-executor";
import { wrapVaultKey } from "../../client/vault/key";
import { deriveWrappingKeyFromPrf } from "../../client/vault/derive";

const origin = "https://app.example.test";
const vk = new Uint8Array(32).fill(61);
const prfs = { YQ: new Uint8Array(32).fill(27), Yg: new Uint8Array(32).fill(28) };

async function setup() {
  const db = await freshDb();
  const user = await createUser(db, { email: "keys@example.test", wrappedDek: "fixture" });
  const other = await createUser(db, { email: "other@example.test", wrappedDek: "fixture" });
  for (const [id, owner] of [["YQ", user.id], ["Yg", user.id], ["Yw", other.id]]) {
    await db.query("INSERT INTO passkeys (user_id, credential_id, public_key, counter) VALUES ($1, $2, 'fixture', 0)", [owner, id]);
  }
  const now = new Date("2026-11-09T00:00:00Z");
  let steppedUp = true;
  const handlers = createVaultUnlockHttpHandlers({ db, publicOrigin: origin, rpId: "example.test",
    clock: { now: () => now }, getDek: async () => new Uint8Array(32).fill(31), challenges: createProofChallenges(),
    resolveSession: async () => ({ id: "fixture-session", userId: user.id, createdAt: now, lastSeenAt: now, steppedUpAt: steppedUp ? now : null }) });
  const material = async () => (await handlers.getMaterial(new Request(origin), "passkey_prf")).json();
  const save = (body: unknown) => handlers.saveMethod(new Request(origin, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const device = (id: keyof typeof prfs) => createDeviceVault({
    createVaultKey: () => vk.slice(),
    startAuthentication: async () => ({ id, clientExtensionResults: { prf: { results: { first: Buffer.from(prfs[id]).toString("base64url") } } } }),
    fetch: async (input, init) => {
      const path = String(input);
      // Authentication ceremony is the injected boundary. Existing WebAuthn tests cover signature verification.
      if (path.endsWith("/step-up/begin")) return Response.json({ options: {} });
      if (path.endsWith("/step-up/finish")) { steppedUp = true; return Response.json({ ok: true }); }
      if (init?.method === "POST") return save(JSON.parse(String(init.body)));
      return handlers.getMaterial(new Request(origin), path.split("/").at(-1)!);
    },
  });
  const proven = async (id: string) => {
    const payload = { method: "passkey_prf" as const, wrapped: "synthetic-envelope", params: { credentialId: id } };
    return { ...payload, proof: await createVaultProof(vk, (await material()).proof, payload) };
  };
  return { db, user, other, device, material, save, proven, setStepUp: (v: boolean) => { steppedUp = v; } };
}

test("adopting a second registered passkey preserves both vault keys and reset removes both envelopes", async () => {
  const f = await setup();
  try {
    assert.deepEqual(await f.device("YQ").unlockWithPasskey({ createIfMissing: true }), { vaultKey: vk, created: true });
    assert.equal(await f.device("Yg").adoptPasskey(vk), "adopted");
    assert.deepEqual((await f.device("YQ").unlockWithPasskey({ createIfMissing: false })).vaultKey, vk);
    assert.deepEqual((await f.device("Yg").unlockWithPasskey({ createIfMissing: false })).vaultKey, vk);
    const envelopes = (await f.material()).credentials;
    assert.deepEqual(envelopes.map((v: { credentialId: string }) => v.credentialId).sort(), ["YQ", "Yg"]);
    assert.ok((await listMethods(f.db, f.user.id)).includes("passkey_prf"));
    assert.equal((await f.db.query("SELECT * FROM vault_unlock_methods WHERE user_id = $1", [f.user.id])).rows.length, 0);
    await createResetExecutor(f.db).eraseVaultData(f.user.id);
    assert.deepEqual((await f.material()).credentials, []);
    assert.deepEqual(await listMethods(f.db, f.user.id), []);
  } finally { await f.db.close(); }
});

test("credential ownership and possession-proof binding prevent cross-account and substituted envelopes", async () => {
  const f = await setup();
  try {
    await f.device("YQ").unlockWithPasskey({ createIfMissing: true });
    const withoutCredential = { method: "passkey_prf" as const, wrapped: "synthetic-envelope" };
    assert.equal((await f.save({ ...withoutCredential, proof: await createVaultProof(vk, (await f.material()).proof, withoutCredential) })).status, 400);
    assert.equal((await f.save(await f.proven("Yw"))).status, 400, "another person's registered credential is refused");
    await assert.rejects(f.db.query("INSERT INTO vault_passkey_envelopes (user_id, credential_id, wrapped_key) VALUES ($1, 'Yw', 'synthetic-only')", [f.user.id]), /foreign key/);
    assert.equal((await f.save(await f.proven("missing"))).status, 400);
    const substituted = await f.proven("YQ");
    assert.equal((await f.save({ ...substituted, params: { credentialId: "Yg" } })).status, 403);
    f.setStepUp(false);
    assert.equal((await f.save(await f.proven("YQ"))).status, 403, "replacement still needs step-up");
    assert.deepEqual((await f.device("YQ").unlockWithPasskey({ createIfMissing: false })).vaultKey, vk);
    await f.device("Yg").adoptPasskey(vk);
    await f.db.query("DELETE FROM passkeys WHERE user_id = $1 AND credential_id = $2", [f.user.id, "YQ"]);
    assert.deepEqual((await f.material()).credentials.map((row: { credentialId: string }) => row.credentialId), ["Yg"]);
    assert.deepEqual((await f.device("Yg").unlockWithPasskey({ createIfMissing: false })).vaultKey, vk, "the remaining credential still unlocks");
    await f.db.query("DELETE FROM passkeys WHERE user_id = $1 AND credential_id = $2", [f.user.id, "Yg"]);
    assert.deepEqual((await f.material()).credentials, [], "removing a passkey cascades its envelope");
    await assert.rejects(f.device("Yg").unlockWithPasskey({ createIfMissing: true }), /existing vault|unlock/i);
  } finally { await f.db.close(); }
});

test("legacy unlabelled envelopes remain readable without guessing their credential or rekeying", async () => {
  const f = await setup();
  try {
    await saveWrappedKey(f.db, { userId: f.user.id, method: "passkey_prf", wrappedKey: await wrapVaultKey(await deriveWrappingKeyFromPrf(prfs.YQ), vk) });
    assert.deepEqual((await f.device("YQ").unlockWithPasskey({ createIfMissing: false })).vaultKey, vk);
    await assert.rejects(f.device("Yg").unlockWithPasskey({ createIfMissing: true }));
    assert.deepEqual((await f.material()).credentials, []);
  } finally { await f.db.close(); }
});
