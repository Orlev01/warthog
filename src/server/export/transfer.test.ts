import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { freshDb } from "@/test/db";
import { createUser } from "@/server/db/users";
import { createSession, recordStepUp, COOKIE_NAME } from "@/server/auth/session";
import { localAesKeyWrapper } from "@/server/crypto/key-wrapper";
import { fixedClock } from "@/server/seams/clock";
import { systemRandom } from "@/server/seams/random";
import { saveIdentityField, listIdentityFields } from "@/server/db/identity-fields";
import { saveHighTierField, listHighTierFields, getHighTierCiphertext } from "@/server/db/high-tier-fields";
import { addCard, listCards, getCardCiphertext } from "@/server/db/cards";
import { saveWrappedKey } from "@/server/db/vault-unlock-methods";
import { createExportHandler } from "@/app/(portal)/(protected)/settings/data/export/handler";
import { createTransferImportHandler as createImportHandler } from "@/server/import/transfer-handler";
import { encryptValue, decryptValue } from "@/client/vault/values";
import { buildDeviceProtected } from "@/client/vault/export";
import { reprotectDeviceProtected } from "@/client/vault/import";
import { emptyTransferDocument, TRANSFER_REQUEST_BYTES } from "@/domain/transfer-parts";

const origin = "https://warthog.test";
const clock = fixedClock(new Date("2026-11-09T00:00:00Z"));
const request = (path: string, cookie: string, body?: unknown, requestOrigin = origin) => new Request(origin + path, { method: "POST", headers: { origin: requestOrigin, cookie, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
async function setup() {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  async function person(name: string, steppedUp = true) {
    const dek = randomBytes(32);
    const user = await createUser(db, { email: `${name}@example.test`, wrappedDek: await keyWrapper.wrap(dek) });
    const session = await createSession(db, user.id, { clock, random: systemRandom });
    if (steppedUp) await recordStepUp(db, session.session.id, { clock });
    return { userId: user.id, dek, cookie: `${COOKIE_NAME}=${session.token}` };
  }
  return { db, person, deps: { db, keyWrapper, clock, publicOrigin: origin } };
}

test("legacy imports retain their size allowance while multipart payloads stay bounded", async () => {
  const f = await setup();
  try {
    const target = await f.person("legacy-large");
    const handle = createImportHandler(f.deps);
    const document = emptyTransferDocument(clock.now().toISOString());
    document.skills = Array.from({ length: 80 }, (_, i) => ({ title: `Skill ${i}`, fullText: "x".repeat(190_000) }));
    assert.ok(Buffer.byteLength(JSON.stringify({ document })) > TRANSFER_REQUEST_BYTES);
    const started = await handle(request("/api/data/import", target.cookie, { operation: "begin", partCount: 1 }));
    const { id } = await started.json();
    assert.equal((await handle(request("/api/data/import", target.cookie, { operation: "part", id, seq: 0, part: { document } }))).status, 413);
    assert.equal((await handle(request("/api/data/import", target.cookie, { document }))).status, 200);
    assert.equal(Number((await f.db.query("SELECT count(*) AS n FROM skills WHERE user_id = $1", [target.userId])).rows[0]!.n), 80);
    const oversized = request("/api/data/import", target.cookie, { document: emptyTransferDocument(clock.now().toISOString()) });
    oversized.headers.set("content-length", String(26 * 1024 * 1024 + 1));
    assert.equal((await handle(oversized)).status, 413);
  } finally { await f.db.close(); }
});

test("device export/import restores protected records only as locally resealed ciphertext and maps owned card addresses", async () => {
  const f = await setup();
  try {
    const source = await f.person("source"); const target = await f.person("target"); const other = await f.person("other");
    const sourceKey = new Uint8Array(randomBytes(32)); const targetKey = new Uint8Array(randomBytes(32));
    const address = await saveIdentityField(f.db, { userId: source.userId, kind: "postal_address", value: "Source address" }, source.dek);
    await saveHighTierField(f.db, { userId: source.userId, type: "passport", label: "Passport", ciphertext: await encryptValue(sourceKey, "secret-passport") });
    await saveHighTierField(f.db, { userId: other.userId, type: "passport", label: "Other person", ciphertext: await encryptValue(sourceKey, "not-yours") });
    await addCard(f.db, { userId: source.userId, brand: "Visa", lastFour: "4242", expiryMonth: 9, expiryYear: 2030, nickname: "Travel", cardholderName: "Source Person", billingAddressId: address.id, numberCiphertext: await encryptValue(sourceKey, "4242424242424242") });
    const response = await createExportHandler(f.deps)(request("/settings/data/export?device=1", source.cookie));
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.equal(text.includes("secret-passport"), false); assert.equal(text.includes("4242424242424242"), false); assert.equal(text.includes("Other person"), false);
    const bundle = JSON.parse(text);
    const plaintext = await buildDeviceProtected(sourceKey, bundle.protectedVault);
    const { sealed } = await reprotectDeviceProtected(targetKey, plaintext);
    const body = { document: bundle.document, protectedVault: sealed };
    assert.equal(JSON.stringify(body).includes("secret-passport"), false); assert.equal(JSON.stringify(body).includes("4242424242424242"), false);
    await saveWrappedKey(f.db, { userId: target.userId, method: "passphrase", wrappedKey: "test-only-wrapped-key" });
    await saveWrappedKey(f.db, { userId: target.userId, method: "recovery", wrappedKey: "test-only-recovery-key" });
    const imported = await createImportHandler(f.deps)(request("/api/data/import", target.cookie, body));
    assert.equal(imported.status, 200);
    const fields = await listHighTierFields(f.db, target.userId); assert.equal(fields.length, 1);
    const ciphertext = await getHighTierCiphertext(f.db, target.userId, fields[0]!.id);
    assert.equal(await decryptValue(targetKey, ciphertext!), "secret-passport");
    await assert.rejects(decryptValue(sourceKey, ciphertext!));
    const cards = await listCards(f.db, target.userId); assert.equal(cards.length, 1);
    const addresses = await listIdentityFields(f.db, target.userId, target.dek);
    assert.equal(cards[0]!.billingAddressId, addresses[0]!.id); assert.notEqual(cards[0]!.billingAddressId, address.id);
    assert.equal(cards[0]!.expiryMonth, 9); assert.equal(cards[0]!.cardholderName, "Source Person");
    assert.equal(await decryptValue(targetKey, (await getCardCiphertext(f.db, target.userId, cards[0]!.id))!), "4242424242424242");
  } finally { await f.db.close(); }
});

test("transfer rejects raw protected plaintext, foreign origin, stale sessions and missing address references atomically", async () => {
  const f = await setup();
  try {
    const target = await f.person("target"); const stale = await f.person("stale", false);
    const document = { version: 1, exportedAt: clock.now().toISOString(), profile: { fields: [{ id: "address", kind: "postal_address", value: "Imported address" }] }, preferences: {}, skills: [], memory: [], rules: [], tasks: [], lifeAdmin: [], connections: [], activity: [] };
    const handle = createImportHandler(f.deps);
    assert.equal((await handle(request("/api/data/import", target.cookie, { document: { ...document, deviceProtected: { highTierFields: [{ value: "secret" }], cards: [] } } }))).status, 400);
    assert.equal((await handle(request("/api/data/import", target.cookie, { document }, "https://evil.test"))).status, 403);
    assert.equal((await handle(request("/api/data/import", stale.cookie, { document }))).status, 403);
    assert.equal((await handle(request("/api/data/import", "", { document }))).status, 401);
    assert.equal((await createExportHandler(f.deps)(request("/settings/data/export?device=1", stale.cookie))).status, 403);
    await saveWrappedKey(f.db, { userId: target.userId, method: "passphrase", wrappedKey: "test-only-wrapped-key" });
    await saveWrappedKey(f.db, { userId: target.userId, method: "recovery", wrappedKey: "test-only-recovery-key" });
    const protectedVault = { highTierFields: [], cards: [{ brand: "Visa", lastFour: "4242", expiryMonth: 9, expiryYear: 2030, nickname: "Travel", billingAddressId: "other-person-address", numberCiphertext: await encryptValue(new Uint8Array(randomBytes(32)), "4242424242424242") }] };
    assert.equal((await handle(request("/api/data/import", target.cookie, { document, protectedVault }))).status, 400);
    assert.deepEqual(await listIdentityFields(f.db, target.userId, target.dek), []);
    assert.deepEqual(await listCards(f.db, target.userId), []);
  } finally { await f.db.close(); }
});
