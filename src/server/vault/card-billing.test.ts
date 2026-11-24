// The one place a card's billing reference is checked and turned into text
// (src/server/vault/card-billing.ts; docs/adr/card-billing-addresses.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { applyBillingSelection, listBillingChoices, resolveCardBilling } from "./card-billing";
import { listCardBillingAddresses, saveCardBillingAddress } from "../db/card-billing-addresses";
import { addCard, listCards } from "../db/cards";
import { listIdentityFields, saveIdentityField } from "../db/identity-fields";
import { createUser } from "../db/users";
import { freshDb } from "../../test/db";
import { withTransaction, type Db } from "../db/index";

async function makeUser(db: Db, who: string): Promise<string> {
  return (await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek: Buffer.from(who).toString("base64") })).id;
}
const card = (userId: string, nickname: string, ref: { billingAddressId?: string | null; billingEntryId?: string | null }) => ({
  userId, brand: "visa", lastFour: "4242", expiryMonth: 12, expiryYear: 2030, nickname, numberCiphertext: "v1:device", ...ref,
});

test("a card's billing address resolves from the owner's postal address or card-only address, else null", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "res-a");
    const b = await makeUser(db, "res-b");
    const key = randomBytes(32);
    const home = await saveIdentityField(db, { userId: a, kind: "postal_address", value: "1 Home St" }, key);
    const name = await saveIdentityField(db, { userId: a, kind: "name", value: "Phil" }, key);
    const bHome = await saveIdentityField(db, { userId: b, kind: "postal_address", value: "2 Other St" }, randomBytes(32));
    const box = await saveCardBillingAddress(db, { userId: a, value: "PO Box 7" }, key);

    await addCard(db, card(a, "postal", { billingAddressId: home.id }));
    await addCard(db, card(a, "billing", { billingEntryId: box.id }));
    await addCard(db, card(a, "none", {}));
    // References that slipped in before ownership was checked resolve to nothing.
    await db.query(`INSERT INTO cards (id, user_id, brand, last_four, expiry_month, expiry_year, nickname, billing_address_id, number_ciphertext)
                    VALUES ($1,$2,'visa','4242',12,2030,'theirs',$3,'v1:x'), ($4,$2,'visa','4242',12,2030,'name-field',$5,'v1:x')`,
      [randomUUID(), a, bHome.id, randomUUID(), name.id]);

    const cards = await listCards(db, a);
    const resolved = await resolveCardBilling(db, a, cards, key);
    const by = (nick: string) => resolved.get(cards.find((c) => c.nickname === nick)!.id);
    assert.deepEqual(by("postal"), { text: "1 Home St", source: "postal" });
    assert.deepEqual(by("billing"), { text: "PO Box 7", source: "billing" });
    assert.equal(by("none"), null);
    assert.equal(by("theirs"), null, "another person's address never resolves");
    assert.equal(by("name-field"), null, "a field that isn't an address never resolves");

    // The caller can pass the already-decrypted identity fields to save a second decrypt.
    const fields = await listIdentityFields(db, a, key);
    const again = await resolveCardBilling(db, a, cards, key, { identityFields: fields });
    assert.deepEqual([...again.values()], [...resolved.values()]);
  } finally {
    await db.close();
  }
});

test("billing choices list current postal addresses, then card-only ones with their cards, then upcoming moves", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "choices");
    const key = randomBytes(32);
    const now = new Date("2026-11-24T10:00:00Z");
    const moving = await saveIdentityField(db, { userId: a, kind: "postal_address", value: "9 New Rd", movingOn: "2027-03-01" }, key);
    const home = await saveIdentityField(db, { userId: a, kind: "postal_address", value: "1 Home St" }, key);
    const moved = await saveIdentityField(db, { userId: a, kind: "postal_address", value: "5 Past Ave", movingOn: "2026-01-01" }, key);
    await saveIdentityField(db, { userId: a, kind: "email", value: "phil@example.com" }, key);
    const box = await saveCardBillingAddress(db, { userId: a, value: "PO Box 7" }, key);
    await addCard(db, card(a, "Everyday", { billingEntryId: box.id }));

    const choices = await listBillingChoices(db, a, key, now, await listCards(db, a));
    assert.deepEqual(choices.map((c) => [c.value, c.source, c.upcoming]), [
      ["1 Home St", "postal", false],
      ["5 Past Ave", "postal", false],
      ["PO Box 7", "billing", false],
      ["9 New Rd", "postal", true],
    ]);
    assert.equal(choices.find((c) => c.id === moving.id)!.movingOn, "2027-03-01");
    assert.deepEqual(choices.find((c) => c.id === box.id)!.usedBy, ["Everyday"]);
    assert.ok(choices.find((c) => c.id === home.id) && choices.find((c) => c.id === moved.id));
    assert.ok(!choices.some((c) => c.value === "phil@example.com"), "only addresses are billing choices");
  } finally {
    await db.close();
  }
});

test("a selection is applied only when it is the person's own address of the right kind", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "apply-a");
    const b = await makeUser(db, "apply-b");
    const key = randomBytes(32);
    const home = await saveIdentityField(db, { userId: a, kind: "postal_address", value: "1 Home St" }, key);
    const name = await saveIdentityField(db, { userId: a, kind: "name", value: "Phil" }, key);
    const bHome = await saveIdentityField(db, { userId: b, kind: "postal_address", value: "2 Other" }, randomBytes(32));
    const bBox = await saveCardBillingAddress(db, { userId: b, value: "PO Box B" }, randomBytes(32));
    const apply = (sel: Parameters<typeof applyBillingSelection>[2]) => withTransaction(db, (tx) => applyBillingSelection(tx, a, sel, key));

    assert.deepEqual(await apply({ source: "postal", id: home.id }), { billingAddressId: home.id, billingEntryId: null });
    // The id is stored in the database's own form, so an uppercase id still matches everywhere.
    assert.deepEqual(await apply({ source: "postal", id: home.id.toUpperCase() }), { billingAddressId: home.id, billingEntryId: null });
    assert.equal(await apply({ source: "postal", id: bHome.id }), null, "not another person's postal address");
    assert.equal(await apply({ source: "postal", id: name.id }), null, "not a field that isn't an address");
    assert.equal(await apply({ source: "postal", id: "nope" }), null);
    assert.equal(await apply({ source: "billing", id: bBox.id }), null, "not another person's billing address");
    assert.equal(await apply({ source: "billing", id: randomUUID() }), null);

    const created = await apply({ source: "new", value: "PO Box 12, Bondi Junction" });
    assert.ok(created && created.billingEntryId && created.billingAddressId === null);
    const reused = await apply({ source: "new", value: "PO Box 12, Bondi Junction" });
    assert.equal(reused!.billingEntryId, created!.billingEntryId, "identical text reuses the same card-only address");
    assert.equal((await listCardBillingAddresses(db, a, key)).length, 1);
    assert.equal(await apply({ source: "billing", id: created!.billingEntryId! }) !== null, true);
    assert.equal((await listIdentityFields(db, a, key)).filter((f) => f.value.startsWith("PO Box")).length, 0, "a typed billing address never lands in About you");
  } finally {
    await db.close();
  }
});
