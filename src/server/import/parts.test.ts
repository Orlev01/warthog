import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { fixedClock } from "../seams/clock";
import { emptyTransferDocument, splitTransferDocument, splitPreparedTransfer } from "../../domain/transfer-parts";
import { saveWrappedKey } from "../db/vault-unlock-methods";
import { encryptValue, decryptValue } from "../../client/vault/values";
import { importParts } from "./parts";
import { buildExportDocument } from "../export/build";

const clock = fixedClock(new Date("2026-11-12T00:00:00Z"));
test("an export above 16 MiB restores packages atomically in bounded parts and commit retries are idempotent", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32), user = await createUser(db, {email: "large-import@example.test", wrappedDek: "test"});
    const document = emptyTransferDocument(clock.now().toISOString());
    document.skillPackages = Array.from({length: 20}, (_, i) => ({ id: randomUUID(), name: `Package ${i}`, files: [
      {path:"SKILL.md", content:`---\nname: Package ${i}\ndescription: Review import\n---\nInstructions ${i}`},
      ...Array.from({length: 5}, (_, j) => ({path:`support-${j}.txt`,content: "x".repeat(180_000)})),
    ]}));
    document.skills = document.skillPackages.map(p => ({title:p.name, packageId:p.id, fullText:"must not duplicate"}));
    assert.ok(Buffer.byteLength(JSON.stringify(document)) > 16 * 1024 * 1024);
    const parts = [...splitTransferDocument(document)];
    assert.ok(parts.length > 1);
    const started = await importParts(db,user.id,{operation:"begin",partCount:parts.length},dek,clock);
    assert.ok(started.id);
    const id = started.id!;
    await assert.rejects(()=>importParts(db,user.id,{operation:"commit",id},dek,clock), /missing parts/);
    for (let seq=0;seq<parts.length;seq++) {
      await importParts(db,user.id,{operation:"part",id,seq,part:{document:parts[seq]!}},dek,clock);
    }
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM skill_packages WHERE user_id=$1",[user.id])).rows[0]!.n),0);
    await importParts(db,user.id,{operation:"commit",id},dek,clock);
    await importParts(db,user.id,{operation:"commit",id},dek,clock);
    const restored = await buildExportDocument(db,user.id,dek,clock);
    assert.equal(restored.skillPackages?.length,20);
    assert.equal(restored.skills.length,20);
    assert.equal(restored.skillPackages?.[0]?.files.find(f=>f.path==="support-4.txt")?.content.length,180_000);
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM data_import_parts WHERE user_id=$1",[user.id])).rows[0]!.n),0);
    const other = await createUser(db,{email:"other-import@example.test",wrappedDek:"test"});
    await assert.rejects(()=>importParts(db,other.id,{operation:"commit",id},dek,clock),/unavailable/);
  } finally {await db.close();}
});

test("protected chunks keep remapped card addresses and a second export retains archived disputes", async () => {
 const db=await freshDb();
 try {
  const dek=randomBytes(32),key=new Uint8Array(randomBytes(32)),user=await createUser(db,{email:"protected-parts@example.test",wrappedDek:"test"});
  for (const method of ["passphrase","recovery"] as const) await saveWrappedKey(db,{userId:user.id,method,wrappedKey:"synthetic-key-envelope"});
  const doc=emptyTransferDocument(clock.now().toISOString());
  doc.profile={fields:[{id:"old-address",kind:"postal_address",value:"Synthetic address"}]};
  doc.activity=[{seq:99,occurredAt:clock.now().toISOString(),kind:"tool_call",source:"warthog",disputes:[{note:"Investigate synthetic event"}]}];
  const ciphertext=await encryptValue(key,"Protected-value".padEnd(50_000,"x"));
  const protectedVault={highTierFields:Array.from({length:100},(_,i)=>({type:"custom" as const,label:`Field ${i}`,ciphertext})),cards:[{brand:"Test",lastFour:"1111",nickname:"Synthetic card",expiryMonth:12,expiryYear:2030,billingAddressId:"old-address",numberCiphertext:await encryptValue(key,"4111111111111111")}]};
  const parts=[...splitPreparedTransfer(doc,protectedVault)];assert.ok(parts.length>2);
  const id=(await importParts(db,user.id,{operation:"begin",partCount:parts.length},dek,clock)).id!;
  for(let seq=0;seq<parts.length;seq++) await importParts(db,user.id,{operation:"part",id,seq,part:parts[seq]!},dek,clock);
  await importParts(db,user.id,{operation:"commit",id},dek,clock);
  const card=(await db.query("SELECT c.billing_address_id, c.number_ciphertext FROM cards c JOIN identity_fields f ON f.id::text=c.billing_address_id AND f.user_id=c.user_id WHERE c.user_id=$1",[user.id])).rows[0]!;
  assert.ok(card);assert.notEqual(card.billing_address_id,"old-address");assert.equal(await decryptValue(key,String(card.number_ciphertext)),"4111111111111111");
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM high_tier_fields WHERE user_id=$1",[user.id])).rows[0]!.n),100);
  const exported=await buildExportDocument(db,user.id,dek,clock);
  assert.equal(exported.importedActivity?.length,1);assert.match(JSON.stringify(exported.importedActivity),/Investigate synthetic event/);
  assert.equal(exported.activity.length,1,"only the import lifecycle event belongs to this account's live chain");
 } finally {await db.close();}
});

test("a failed later part rolls back earlier restored content and conflicting uploads cannot replace parts", async () => {
 const db=await freshDb();
 try {
  const dek=randomBytes(32),user=await createUser(db,{email:"rollback-import@example.test",wrappedDek:"test"});
  const doc=emptyTransferDocument(clock.now().toISOString());doc.memory=[{content:"Must roll back",scope:"shared"}];
  const started=await importParts(db,user.id,{operation:"begin",partCount:2},dek,clock),id=started.id!;
  await importParts(db,user.id,{operation:"part",id,seq:0,part:{document:doc}},dek,clock);
  await importParts(db,user.id,{operation:"part",id,seq:0,part:{document:doc}},dek,clock);
  await assert.rejects(()=>importParts(db,user.id,{operation:"part",id,seq:0,part:{document:emptyTransferDocument(doc.exportedAt)}},dek,clock),/conflicts/);
  const invalid=emptyTransferDocument(doc.exportedAt);invalid.skillPackages=[{name:"Invalid",files:[{path:"../SKILL.md",content:"must reject"}]}];
  await importParts(db,user.id,{operation:"part",id,seq:1,part:{document:invalid}},dek,clock);
  await assert.rejects(()=>importParts(db,user.id,{operation:"commit",id},dek,clock));
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM memories WHERE user_id=$1",[user.id])).rows[0]!.n),0);
 } finally {await db.close();}
});
