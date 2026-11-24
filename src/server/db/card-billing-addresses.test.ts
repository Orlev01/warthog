// Card-only billing addresses (docs/adr/card-billing-addresses.md; migration 0123).
//
// A person can give a card a billing address that is NOT one of their About you postal
// addresses. It is personal content, so it is stored only DEK-encrypted, bound to its row; it
// lives in its own table so nothing that lists identity fields (get_context, About you, the
// per-agent detail toggles) can ever see it; and a card can point at one only when it is the
// card owner's own (a composite foreign key), never both kinds of reference at once.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import {
  deleteCardBillingAddressIfUnused,
  listCardBillingAddresses,
  ownsCardBillingAddress,
  saveCardBillingAddress,
} from "./card-billing-addresses";
import { addCard, listCards } from "./cards";
import { saveIdentityField } from "./identity-fields";
import { createUser } from "./users";
import { freshDb } from "../../test/db";
import { createDb, loadMigrations, runMigrations, withTransaction, type Db } from "./index";

const dek = () => randomBytes(32);

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek: Buffer.from(`w-${who}`).toString("base64") });
  return user.id;
}

function card(userId: string, ref: { billingAddressId?: string | null; billingEntryId?: string | null }) {
  return {
    userId,
    brand: "visa",
    lastFour: "4242",
    expiryMonth: 12,
    expiryYear: 2030,
    nickname: "Everyday",
    numberCiphertext: `v1:device-${randomUUID()}`,
    ...ref,
  };
}

test("a card-only billing address is stored encrypted, bound to its row, and read back only by its owner", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "billing-a");
    const b = await makeUser(db, "billing-b");
    const keyA = dek();
    const saved = await saveCardBillingAddress(db, { userId: a, value: "PO Box 12, Bondi Junction NSW 1355" }, keyA);

    const raw = await db.query("SELECT value FROM card_billing_addresses WHERE id = $1", [saved.id]);
    assert.match(String(raw.rows[0]!.value), /^v1:/, "stored as an envelope");
    assert.doesNotMatch(String(raw.rows[0]!.value), /PO Box/, "no plaintext in the column");

    assert.deepEqual((await listCardBillingAddresses(db, a, keyA)).map((x) => x.value), ["PO Box 12, Bondi Junction NSW 1355"]);
    assert.deepEqual(await listCardBillingAddresses(db, b, dek()), [], "another person sees none");
    await assert.rejects(listCardBillingAddresses(db, a, dek()), "the wrong data key can't decrypt it");

    // An envelope lifted into another row fails to decrypt.
    const other = await saveCardBillingAddress(db, { userId: a, value: "Somewhere else" }, keyA);
    await db.query("UPDATE card_billing_addresses SET value = (SELECT value FROM card_billing_addresses WHERE id = $1) WHERE id = $2", [saved.id, other.id]);
    await assert.rejects(listCardBillingAddresses(db, a, keyA), "a moved ciphertext is refused");
  } finally {
    await db.close();
  }
});

test("plaintext can never land in the table, and the app role can use it", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "billing-plain");
    await assert.rejects(
      db.query("INSERT INTO card_billing_addresses (id, user_id, value) VALUES ($1, $2, 'PO Box 1')", [randomUUID(), a]),
      "a value that isn't an envelope is refused by the table itself",
    );
    const role = await db.query("SELECT 1 FROM pg_roles WHERE rolname = 'warthog_app'");
    if (role.rows.length) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const has = await db.query("SELECT has_table_privilege('warthog_app', 'card_billing_addresses', $1) AS ok", [privilege]);
        assert.equal(has.rows[0]!.ok, true, `warthog_app has ${privilege}`);
      }
    }
  } finally {
    await db.close();
  }
});

test("ownership is checked by id shape and owner, never by a guessable id", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "billing-own-a");
    const b = await makeUser(db, "billing-own-b");
    const saved = await saveCardBillingAddress(db, { userId: a, value: "PO Box 1" }, dek());
    assert.equal(await ownsCardBillingAddress(db, a, saved.id), true);
    assert.equal(await ownsCardBillingAddress(db, b, saved.id), false, "not another person's");
    assert.equal(await ownsCardBillingAddress(db, a, "not-a-uuid"), false, "a malformed id is just not found");
    assert.equal(await ownsCardBillingAddress(db, a, "x'); DROP TABLE cards; --"), false);
    assert.ok((await db.query("SELECT 1 FROM cards LIMIT 1")).rows !== undefined, "the probe never reached SQL text");
  } finally {
    await db.close();
  }
});

test("a card can point at its owner's billing address, never another person's, and never at both kinds", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "billing-fk-a");
    const b = await makeUser(db, "billing-fk-b");
    const keyA = dek();
    const mine = await saveCardBillingAddress(db, { userId: a, value: "PO Box 9" }, keyA);
    const theirs = await saveCardBillingAddress(db, { userId: b, value: "PO Box 10" }, dek());

    const ok = await addCard(db, card(a, { billingEntryId: mine.id }));
    assert.equal(ok.billingEntryId, mine.id);
    assert.equal(ok.billingAddressId, null);

    await assert.rejects(
      withTransaction(db, (tx) => addCard(tx, card(a, { billingEntryId: theirs.id }))),
      "the database refuses a card that points at another person's billing address",
    );
    const postal = await saveIdentityField(db, { userId: a, kind: "postal_address", value: "1 Home St" }, keyA);
    await assert.rejects(
      db.query(
        `INSERT INTO cards (id, user_id, brand, last_four, expiry_month, expiry_year, nickname, billing_address_id, billing_entry_id, number_ciphertext)
         VALUES ($1, $2, 'visa', '4242', 12, 2030, 'Both', $3, $4, 'v1:x')`,
        [randomUUID(), a, postal.id, mine.id],
      ),
      "a card never carries both references",
    );
  } finally {
    await db.close();
  }
});

test("addCard refuses both references before any query", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "billing-both");
    await assert.rejects(addCard(db, card(a, { billingAddressId: randomUUID(), billingEntryId: randomUUID() })), /both/i);
    assert.equal((await listCards(db, a)).length, 0);
  } finally {
    await db.close();
  }
});

test("an unused billing address is deleted, one a card still uses is kept", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "billing-gc");
    const b = await makeUser(db, "billing-gc-b");
    const key = dek();
    const used = await saveCardBillingAddress(db, { userId: a, value: "PO Box 1" }, key);
    const unused = await saveCardBillingAddress(db, { userId: a, value: "PO Box 2" }, key);
    await addCard(db, card(a, { billingEntryId: used.id }));

    assert.equal(await deleteCardBillingAddressIfUnused(db, a, used.id), false, "still used by a card");
    assert.equal(await deleteCardBillingAddressIfUnused(db, b, unused.id), false, "never another person's");
    assert.equal(await deleteCardBillingAddressIfUnused(db, a, unused.id), true);
    assert.deepEqual((await listCardBillingAddresses(db, a, key)).map((x) => x.id), [used.id]);
    assert.equal(await deleteCardBillingAddressIfUnused(db, a, "nope"), false);
  } finally {
    await db.close();
  }
});

test("deleting an account removes its cards and billing addresses together", async () => {
  const db = await freshDb();
  try {
    const a = await makeUser(db, "billing-purge");
    const saved = await saveCardBillingAddress(db, { userId: a, value: "PO Box 3" }, dek());
    await addCard(db, card(a, { billingEntryId: saved.id }));
    await db.query("DELETE FROM users WHERE id = $1", [a]);
    assert.equal((await db.query("SELECT 1 FROM card_billing_addresses WHERE user_id = $1", [a])).rows.length, 0);
    assert.equal((await db.query("SELECT 1 FROM cards WHERE user_id = $1", [a])).rows.length, 0);
  } finally {
    await db.close();
  }
});

test("migration 0123 keeps good card references and clears ones that were never the owner's postal address", async () => {
  const db = await createDb("pglite:memory");
  try {
    const all = await loadMigrations();
    assert.ok(all.some((m) => m.name.startsWith("0123_")), "a migration numbered 0123 is part of the project");
    await runMigrations(db, all.filter((m) => m.name < "0123"));

    const a = await makeUser(db, "mig-a");
    const b = await makeUser(db, "mig-b");
    const key = dek();
    const home = await saveIdentityField(db, { userId: a, kind: "postal_address", value: "1 Home St" }, key);
    const name = await saveIdentityField(db, { userId: a, kind: "name", value: "Phil" }, key);
    const bHome = await saveIdentityField(db, { userId: b, kind: "postal_address", value: "2 Other St" }, dek());
    const insert = (nickname: string, ref: string) =>
      db.query(
        `INSERT INTO cards (id, user_id, brand, last_four, expiry_month, expiry_year, nickname, billing_address_id, number_ciphertext)
         VALUES ($1, $2, 'visa', '4242', 12, 2030, $3, $4, 'v1:x')`,
        [randomUUID(), a, nickname, ref],
      );
    await insert("good", home.id);
    await insert("good-uppercase", home.id.toUpperCase());
    await insert("deleted", randomUUID());
    await insert("other-person", bHome.id);
    await insert("not-an-address", name.id);
    await insert("not-a-uuid", "addr-seed");

    await runMigrations(db, all);
    const rows = (await db.query("SELECT nickname, billing_address_id, billing_entry_id FROM cards WHERE user_id = $1 ORDER BY nickname", [a])).rows;
    const byName = Object.fromEntries(rows.map((r) => [r.nickname, r]));
    assert.equal(byName.good!.billing_address_id, home.id, "the owner's own postal address is kept");
    assert.equal(byName["good-uppercase"]!.billing_address_id, home.id, "an uppercase form of it is kept, in the usual form");
    for (const broken of ["deleted", "other-person", "not-an-address", "not-a-uuid"]) {
      assert.equal(byName[broken]!.billing_address_id, null, `${broken}: a broken reference becomes "no billing address"`);
      assert.equal(byName[broken]!.billing_entry_id, null);
    }
    assert.equal(rows.length, 6, "no card is lost");
  } finally {
    await db.close();
  }
});
