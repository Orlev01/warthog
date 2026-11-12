// Explicit capacity acceptance, outside the fast regression suite. Synthetic
// local PGlite only: no environment URL, provider or customer account is used.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { freshDb } from "../src/test/db";
import { createUser } from "../src/server/db/users";
import { saveWrappedKey } from "../src/server/db/vault-unlock-methods";
import { listIdentityFields } from "../src/server/db/identity-fields";
import { emptyTransferDocument, splitPreparedTransfer, TRANSFER_REQUEST_BYTES } from "../src/domain/transfer-parts";
import { importParts } from "../src/server/import/parts";
import { buildExportDocument } from "../src/server/export/build";
import { encryptValue } from "../src/client/vault/values";
import type { ExportDocument } from "../src/server/export/schema";

const db = await freshDb();
const clock = { now: () => new Date("2026-11-12T00:00:00Z") };
const dek = randomBytes(32), key = new Uint8Array(randomBytes(32));
const started = performance.now();
try {
  const source = await createUser(db, { email: "capacity-source@example.test", wrappedDek: "synthetic" });
  const destination = await createUser(db, { email: "capacity-destination@example.test", wrappedDek: "synthetic" });
  for (const user of [source, destination]) {
    for (const method of ["passphrase", "recovery"] as const) await saveWrappedKey(db, { userId: user.id, method, wrappedKey: "synthetic-envelope" });
  }
  const protectedVault = {
    highTierFields: Array.from({ length: 1000 }, (_, i) => ({ type: "custom" as const, label: `Synthetic field ${i}`, ciphertext: "" })),
    cards: Array.from({ length: 1000 }, (_, i) => ({ brand: "Test", lastFour: "1111", nickname: `Synthetic card ${i}`, expiryMonth: 12, expiryYear: 2030, billingAddressId: "source-address", numberCiphertext: "" })),
  };
  const protectedCipher = await encryptValue(key, "synthetic protected value"), cardCipher = await encryptValue(key, "4111111111111111");
  for (const field of protectedVault.highTierFields) field.ciphertext = protectedCipher;
  for (const card of protectedVault.cards) card.numberCiphertext = cardCipher;
  let document: ExportDocument = emptyTransferDocument(clock.now().toISOString());
  document.profile = { fields: [{ id: "source-address", kind: "postal_address", value: "Synthetic billing address" }] };
  document.skillPackages = Array.from({ length: 100 }, (_, i) => ({ id: randomUUID(), name: `Package ${i}`, files: [
    { path: "SKILL.md", content: `---\nname: Package ${i}\ndescription: Capacity check\n---\nSynthetic instructions` },
    { path: "support.txt", content: "x".repeat(180_000) },
  ] }));
  document.skills = Array.from({ length: 900 }, (_, i) => ({ title: `Standalone ${i}`, text: `Standalone ${i}\n\nUse this when: Capacity check\n\n${"s".repeat(21_000)}`, scope: "chosen", enabled: true }));
  document.memory = Array.from({ length: 5000 }, (_, i) => ({ content: `${i}: ${"m".repeat(2790)}`, scope: "shared" }));
  document.activity = Array.from({ length: 100_000 }, (_, i) => ({ seq: i + 1, occurredAt: clock.now().toISOString(), kind: "tool_call", source: "warthog", outcome: "executed", payload: { reason: `Synthetic request ${i}` }, ...(i === 0 ? { disputes: [{ note: "Synthetic dispute retained" }] } : {}) }));
  const fixtureBytes = Buffer.byteLength(JSON.stringify(document));
  async function restore(userId: string, data: ExportDocument) {
    const parts = [...splitPreparedTransfer(data, protectedVault)];
    const id = (await importParts(db, userId, { operation: "begin", partCount: parts.length }, dek, clock)).id!;
    for (let seq = 0; seq < parts.length; seq++) {
      assert.ok(Buffer.byteLength(JSON.stringify(parts[seq])) < TRANSFER_REQUEST_BYTES - 1024);
      await importParts(db, userId, { operation: "part", id, seq, part: parts[seq]! }, dek, clock);
    }
    await importParts(db, userId, { operation: "commit", id }, dek, clock);
    return parts.length;
  }
  const firstParts = await restore(source.id, document);
  document = await buildExportDocument(db, source.id, dek, clock);
  // The device-export handler enriches the ordinary export with these owned
  // address references so its opaque card envelopes can be reassigned safely.
  document.profile.fields = (await listIdentityFields(db, source.id, dek)).map(({id,kind,value,movingOn})=>({id,kind,value,movingOn}));
  assert.equal(document.skills.length, 1000); assert.equal(document.memory.length, 5000);
  assert.ok(document.skills.some(skill => typeof skill.text === "string" && skill.text.includes("s".repeat(21_000))));
  assert.equal(document.skillPackages?.length, 100); assert.equal(document.importedActivity?.length, 100_000);
  const address = (document.profile.fields as { id: string }[])[0]!;
  for (const card of protectedVault.cards) card.billingAddressId = address.id;
  const secondParts = await restore(destination.id, document);
  for (const [table, expected] of [["skills", 1000], ["skill_packages", 100], ["memories", 5000], ["high_tier_fields", 1000], ["cards", 1000], ["imported_history", 100_001]] as const) {
    assert.equal(Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE user_id=$1`, [destination.id])).rows[0]!.n), expected, table);
  }
  const final = await buildExportDocument(db, destination.id, dek, clock);
  assert.ok(final.skills.some(skill => typeof skill.text === "string" && skill.text.includes("s".repeat(21_000))));
  assert.equal(final.skillPackages?.[0]?.files.find(file => file.path === "support.txt")?.content.length, 180_000);
  assert.ok(final.importedActivity?.some(entry => JSON.stringify(entry.disputes).includes("Synthetic dispute retained")));
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM cards c JOIN identity_fields f ON f.id::text=c.billing_address_id AND f.user_id=c.user_id WHERE c.user_id=$1", [destination.id])).rows[0]!.n), 1000);
  console.log(JSON.stringify({ passed: true, fixtureBytes, firstParts, secondParts, skills: 1000, packages: 100, memories: 5000, protectedFields: 1000, cards: 1000, history: 100_000, durationMs: Math.round(performance.now() - started) }));
} finally { key.fill(0); await db.close(); }
