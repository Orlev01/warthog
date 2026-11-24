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
import { saveCardBillingAddress, listCardBillingAddresses } from "@/server/db/card-billing-addresses";
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
    // A billing address kept with the cards only (docs/adr/card-billing-addresses.md), shared by two cards.
    const billing = await saveCardBillingAddress(f.db, { userId: source.userId, value: "9 Card-only Lane, Hobart TAS 7000" }, source.dek);
    await saveCardBillingAddress(f.db, { userId: other.userId, value: "Other person's billing address" }, other.dek);
    await saveHighTierField(f.db, { userId: source.userId, type: "passport", label: "Passport", ciphertext: await encryptValue(sourceKey, "secret-passport") });
    await saveHighTierField(f.db, { userId: other.userId, type: "passport", label: "Other person", ciphertext: await encryptValue(sourceKey, "not-yours") });
    const card = { userId: source.userId, brand: "Visa", lastFour: "4242", expiryMonth: 9, expiryYear: 2030, cardholderName: "Source Person" };
    await addCard(f.db, { ...card, nickname: "Travel", billingAddressId: address.id, numberCiphertext: await encryptValue(sourceKey, "4242424242424242") });
    await addCard(f.db, { ...card, nickname: "Work", billingEntryId: billing.id, numberCiphertext: await encryptValue(sourceKey, "4000056655665556") });
    await addCard(f.db, { ...card, nickname: "Backup", billingEntryId: billing.id, numberCiphertext: await encryptValue(sourceKey, "5555555555554444") });
    await addCard(f.db, { ...card, nickname: "Spare", numberCiphertext: await encryptValue(sourceKey, "378282246310005") });
    const response = await createExportHandler(f.deps)(request("/settings/data/export?device=1", source.cookie));
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    assert.equal(text.includes("secret-passport"), false); assert.equal(text.includes("4242424242424242"), false); assert.equal(text.includes("Other person"), false);
    const bundle = JSON.parse(text);
    assert.deepEqual(bundle.document.profile.cardBillingAddresses, [{ id: billing.id, value: "9 Card-only Lane, Hobart TAS 7000" }], "the device export carries the card-only address with its id");
    const exportedCards = new Map((bundle.protectedVault.cards as { nickname: string; billingAddressId?: string; billingEntryId?: string }[]).map((c) => [c.nickname, c]));
    assert.equal(exportedCards.get("Travel")!.billingAddressId, address.id); assert.equal("billingEntryId" in exportedCards.get("Travel")!, false);
    assert.equal(exportedCards.get("Work")!.billingEntryId, billing.id); assert.equal("billingAddressId" in exportedCards.get("Work")!, false);
    assert.equal("billingAddressId" in exportedCards.get("Spare")! || "billingEntryId" in exportedCards.get("Spare")!, false, "a card with no billing address exports no reference (never \"null\")");
    const plaintext = await buildDeviceProtected(sourceKey, bundle.protectedVault);
    const { sealed } = await reprotectDeviceProtected(targetKey, plaintext);
    const body = { document: bundle.document, protectedVault: sealed };
    assert.equal(JSON.stringify(body).includes("secret-passport"), false); assert.equal(JSON.stringify(body).includes("4242424242424242"), false);
    await saveWrappedKey(f.db, { userId: target.userId, method: "passphrase", wrappedKey: "test-only-wrapped-key" });
    await saveWrappedKey(f.db, { userId: target.userId, method: "recovery", wrappedKey: "test-only-recovery-key" });
    const imported = await createImportHandler(f.deps)(request("/api/data/import", target.cookie, body));
    assert.equal(imported.status, 200);
    assert.equal((await imported.json()).summary.cardsWithoutBillingAddress, 1, "only the card that had no billing address is reported");
    const fields = await listHighTierFields(f.db, target.userId); assert.equal(fields.length, 1);
    const ciphertext = await getHighTierCiphertext(f.db, target.userId, fields[0]!.id);
    assert.equal(await decryptValue(targetKey, ciphertext!), "secret-passport");
    await assert.rejects(decryptValue(sourceKey, ciphertext!));
    const cards = new Map((await listCards(f.db, target.userId)).map((c) => [c.nickname, c])); assert.equal(cards.size, 4);
    const addresses = await listIdentityFields(f.db, target.userId, target.dek);
    assert.deepEqual(addresses.map((a) => a.value), ["Source address"], "the card-only address is never added to About you");
    const travel = cards.get("Travel")!;
    assert.equal(travel.billingAddressId, addresses[0]!.id); assert.notEqual(travel.billingAddressId, address.id); assert.equal(travel.billingEntryId, null);
    const targetBilling = await listCardBillingAddresses(f.db, target.userId, target.dek);
    assert.deepEqual(targetBilling.map((b) => b.value), ["9 Card-only Lane, Hobart TAS 7000"], "one card-only address, re-encrypted for the importing person");
    assert.notEqual(targetBilling[0]!.id, billing.id, "the card-only address gets a new id");
    for (const name of ["Work", "Backup"]) {
      assert.equal(cards.get(name)!.billingEntryId, targetBilling[0]!.id, `${name} points at the new card-only address`);
      assert.equal(cards.get(name)!.billingAddressId, null);
    }
    assert.equal(cards.get("Spare")!.billingAddressId, null); assert.equal(cards.get("Spare")!.billingEntryId, null);
    assert.equal(travel.expiryMonth, 9); assert.equal(travel.cardholderName, "Source Person");
    assert.equal(await decryptValue(targetKey, (await getCardCiphertext(f.db, target.userId, travel.id))!), "4242424242424242");
    assert.equal((await listCardBillingAddresses(f.db, source.userId, source.dek)).length, 1, "the source keeps its own address");
  } finally { await f.db.close(); }
});

test("transfer rejects raw protected plaintext, foreign origin and stale sessions", async () => {
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
    assert.deepEqual(await listIdentityFields(f.db, target.userId, target.dek), []);
  } finally { await f.db.close(); }
});

// Approved change (docs/adr/card-billing-addresses.md): a billing reference the export doesn't
// carry — another person's address, one made protected, a card-only address that's gone — used
// to reject the whole import. The card now imports with no billing address and the person can
// give it one; nothing is guessed and no address is created that no card uses.
test("a card whose billing address is missing from the export imports with no billing address", async () => {
  const f = await setup();
  try {
    const target = await f.person("target");
    await saveWrappedKey(f.db, { userId: target.userId, method: "passphrase", wrappedKey: "test-only-wrapped-key" });
    await saveWrappedKey(f.db, { userId: target.userId, method: "recovery", wrappedKey: "test-only-recovery-key" });
    const document = { version: 1, exportedAt: clock.now().toISOString(), profile: { fields: [{ id: "address", kind: "postal_address", value: "Imported address" }], cardBillingAddresses: [{ id: "unused-billing", value: "Nobody's card uses this" }] }, preferences: {}, skills: [], memory: [], rules: [], tasks: [], lifeAdmin: [], connections: [], activity: [] };
    const numberCiphertext = await encryptValue(new Uint8Array(randomBytes(32)), "4242424242424242");
    const card = { brand: "Visa", lastFour: "4242", expiryMonth: 9, expiryYear: 2030, numberCiphertext };
    const protectedVault = { highTierFields: [], cards: [
      { ...card, nickname: "Postal gone", billingAddressId: "other-person-address" },
      { ...card, nickname: "Card-only gone", billingEntryId: "missing-billing" },
    ] };
    const response = await createImportHandler(f.deps)(request("/api/data/import", target.cookie, { document, protectedVault }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).summary.cardsWithoutBillingAddress, 2);
    const cards = await listCards(f.db, target.userId);
    assert.equal(cards.length, 2);
    for (const restored of cards) {
      assert.equal(restored.billingAddressId, null, `${restored.nickname} has no postal reference`);
      assert.equal(restored.billingEntryId, null, `${restored.nickname} has no card-only reference`);
    }
    assert.equal((await listIdentityFields(f.db, target.userId, target.dek)).length, 1, "the rest of the export is restored");
    assert.deepEqual(await listCardBillingAddresses(f.db, target.userId, target.dek), [], "an address no restored card uses is not created");
  } finally { await f.db.close(); }
});

test("an export with structurally invalid billing references or addresses imports nothing", async () => {
  const f = await setup();
  try {
    const target = await f.person("target");
    await saveWrappedKey(f.db, { userId: target.userId, method: "passphrase", wrappedKey: "test-only-wrapped-key" });
    await saveWrappedKey(f.db, { userId: target.userId, method: "recovery", wrappedKey: "test-only-recovery-key" });
    const handle = createImportHandler(f.deps);
    const profile = { fields: [{ id: "address", kind: "postal_address", value: "Imported address" }], cardBillingAddresses: [{ id: "billing", value: "1 Card St" }] };
    const base = { version: 1, exportedAt: clock.now().toISOString(), profile, preferences: {}, skills: [], memory: [{ content: "must not be restored", scope: "shared" }], rules: [], tasks: [], lifeAdmin: [], connections: [], activity: [] };
    const numberCiphertext = await encryptValue(new Uint8Array(randomBytes(32)), "4242424242424242");
    const card = { brand: "Visa", lastFour: "4242", expiryMonth: 9, expiryYear: 2030, nickname: "Travel", numberCiphertext };
    const cases = [
      { name: "a card with both kinds of reference", document: base, cards: [{ ...card, billingAddressId: "address", billingEntryId: "billing" }] },
      { name: "two card-only addresses with the same id", document: { ...base, profile: { ...profile, cardBillingAddresses: [{ id: "billing", value: "1 Card St" }, { id: "billing", value: "2 Card St" }] } }, cards: [{ ...card, billingEntryId: "billing" }] },
      { name: "a blank card-only address", document: { ...base, profile: { ...profile, cardBillingAddresses: [{ id: "billing", value: "   " }] } }, cards: [{ ...card, billingEntryId: "billing" }] },
      { name: "a card-only address that isn't text", document: { ...base, profile: { ...profile, cardBillingAddresses: [{ id: "billing", value: { street: "1 Card St" } }] } }, cards: [] },
      { name: "card-only addresses that aren't a list", document: { ...base, profile: { ...profile, cardBillingAddresses: { id: "billing", value: "1 Card St" } } }, cards: [] },
    ];
    for (const c of cases) {
      const response = await handle(request("/api/data/import", target.cookie, { document: c.document, protectedVault: { highTierFields: [], cards: c.cards } }));
      assert.equal(response.status, 400, c.name);
    }
    assert.deepEqual(await listIdentityFields(f.db, target.userId, target.dek), []);
    assert.deepEqual(await listCards(f.db, target.userId), []);
    assert.deepEqual(await listCardBillingAddresses(f.db, target.userId, target.dek), []);
    assert.equal(Number((await f.db.query("SELECT count(*) AS n FROM memories WHERE user_id = $1", [target.userId])).rows[0]!.n), 0);
  } finally { await f.db.close(); }
});

test("an export from before card-only billing addresses still imports its postal billing references", async () => {
  const f = await setup();
  try {
    const target = await f.person("target");
    await saveWrappedKey(f.db, { userId: target.userId, method: "passphrase", wrappedKey: "test-only-wrapped-key" });
    await saveWrappedKey(f.db, { userId: target.userId, method: "recovery", wrappedKey: "test-only-recovery-key" });
    const document = { version: 1, exportedAt: clock.now().toISOString(), profile: { fields: [{ id: "address", kind: "postal_address", value: "Imported address" }] }, preferences: {}, skills: [], memory: [], rules: [], tasks: [], lifeAdmin: [], connections: [], activity: [] };
    const protectedVault = { highTierFields: [], cards: [{ brand: "Visa", lastFour: "4242", expiryMonth: 9, expiryYear: 2030, nickname: "Travel", billingAddressId: "address", numberCiphertext: await encryptValue(new Uint8Array(randomBytes(32)), "4242424242424242") }] };
    const response = await createImportHandler(f.deps)(request("/api/data/import", target.cookie, { document, protectedVault }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).summary.cardsWithoutBillingAddress, undefined, "nothing to report when every card keeps its address");
    const [address] = await listIdentityFields(f.db, target.userId, target.dek);
    const [restored] = await listCards(f.db, target.userId);
    assert.equal(restored!.billingAddressId, address!.id);
    assert.equal(restored!.billingEntryId, null);
  } finally { await f.db.close(); }
});

test("importing a card-only address the person already has, or one text under two ids, keeps one address", async () => {
  const f = await setup();
  try {
    const target = await f.person("dedupe");
    await saveWrappedKey(f.db, { userId: target.userId, method: "passphrase", wrappedKey: "test-only-wrapped-key" });
    await saveWrappedKey(f.db, { userId: target.userId, method: "recovery", wrappedKey: "test-only-recovery-key" });
    const existing = await saveCardBillingAddress(f.db, { userId: target.userId, value: "PO Box 7, Hobart" }, target.dek);
    const document = { version: 1, exportedAt: clock.now().toISOString(), profile: { fields: [], cardBillingAddresses: [{ id: "a", value: "PO Box 7, Hobart" }, { id: "b", value: "PO Box 7, Hobart" }] }, preferences: {}, skills: [], memory: [], rules: [], tasks: [], lifeAdmin: [], connections: [], activity: [] };
    const numberCiphertext = await encryptValue(new Uint8Array(randomBytes(32)), "4242424242424242");
    const card = { brand: "Visa", lastFour: "4242", expiryMonth: 9, expiryYear: 2030, numberCiphertext };
    const protectedVault = { highTierFields: [], cards: [{ ...card, nickname: "One", billingEntryId: "a" }, { ...card, nickname: "Two", billingEntryId: "b" }] };
    const response = await createImportHandler(f.deps)(request("/api/data/import", target.cookie, { document, protectedVault }));
    assert.equal(response.status, 200);
    const addresses = await listCardBillingAddresses(f.db, target.userId, target.dek);
    assert.deepEqual(addresses.map((a) => a.id), [existing.id], "no duplicate of the same text");
    assert.deepEqual((await listCards(f.db, target.userId)).map((c) => c.billingEntryId), [existing.id, existing.id]);
  } finally { await f.db.close(); }
});
