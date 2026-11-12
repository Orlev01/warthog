// Disposable local PostgreSQL 16 only. No destination, credentials or cloud URLs
// are accepted from arguments/environment. This is not an Azure PITR certificate.
import assert from "node:assert/strict";
import { randomBytes, randomUUID, generateKeyPairSync, publicEncrypt, privateDecrypt, constants } from "node:crypto";
import { createDb, loadMigrations, runMigrations, type Db } from "../src/server/db/index";
import { createUser } from "../src/server/db/users";
import { createInMemoryBlobStore } from "../src/server/storage/blob";
import { saveReceiptFile, getReceiptFile } from "../src/server/storage/receipt-files";
import { selectKeyWrapper } from "../src/server/crypto/key-wrapper";
import { createDeletionJournal, type JournalRecord } from "../src/server/account/deletion-journal";
import { deleteAccount } from "../src/server/account/delete";
import { createResetExecutor } from "../src/server/account/reset-executor";
import { runAccountPurge } from "../src/server/account/purge-job";
import { prepareIsolatedRestore } from "../src/server/account/restore";
import { createOutbox } from "../src/server/notify/outbox";

if (process.platform !== "linux" || process.env.WARTHOG_LOCAL_PG_CHECK !== "1") throw new Error("Local Compose recovery check required");
const suffix = randomUUID().replaceAll("-", "");
const sourceName = `recovery_source_${suffix}`, restoredName = `recovery_clone_${suffix}`;
const url = (database: string) => `postgresql://postgres@warthog-postgres-check:5432/${database}?sslmode=disable`;
const admin = await createDb(url("postgres"));
let source: Db | undefined, restored: Db | undefined;
const created: string[] = [];
const dek = randomBytes(32);
try {
  assert.equal((await admin.query("SHOW cluster_name")).rows[0]?.cluster_name, "warthog-local-certification");
  assert.match(String((await admin.query("SHOW server_version_num")).rows[0]?.server_version_num), /^16\d{4}$/);
  await admin.query(`CREATE DATABASE ${sourceName}`); created.push(sourceName);
  source = await createDb(url(sourceName));
  await runMigrations(source, await loadMigrations());

  // Exercise the real versioned RSA-OAEP-256 envelope with synthetic keys.
  const keys = new Map(["old", "new"].map(version => [version, generateKeyPairSync("rsa", { modulusLength: 3072 })]));
  let active = "old";
  const keyId = (version: string) => `https://synthetic.vault.azure.net/keys/recovery/${version}`;
  const client = (version: string) => ({
    async wrapKey() { return { result: publicEncrypt({ key: keys.get(version)!.publicKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, dek), keyID: keyId(version) }; },
    async unwrapKey(_algorithm: string, ciphertext: Uint8Array) {
      if (!keys.has(version)) throw new Error("Retained wrapping key unavailable");
      return { result: privateDecrypt({ key: keys.get(version)!.privateKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING }, ciphertext) };
    },
  });
  const wrapper = selectKeyWrapper({ nodeEnv: "production", keyVaultClient: client(active),
    keyVaultClientFor: id => client(id.slice(id.lastIndexOf("/") + 1)) });
  const wrapped = await wrapper.wrap(dek);
  const deleted = await createUser(source, { email: "deleted@restore.example.test", wrappedDek: wrapped });
  const survivor = await createUser(source, { email: "survivor@restore.example.test", wrappedDek: wrapped });
  const originalBlobs = createInMemoryBlobStore(), restoredBlobs = createInMemoryBlobStore();
  const files = [];
  for (const user of [deleted, survivor]) {
    const record = await source.query("INSERT INTO life_admin_records(user_id,kind,fields,status,source_kind) VALUES ($1,'receipt_warranty','synthetic','active','person') RETURNING id", [user.id]);
    const file = await saveReceiptFile(source, originalBlobs, { userId: user.id, recordId: String(record.rows[0]!.id),
      contentType: "text/plain", bytes: Buffer.from(`synthetic recovery receipt ${user.id}`) }, dek);
    files.push(file);
    await restoredBlobs.put(file.blobKey, (await originalBlobs.get(file.blobKey))!);
    await source.query("INSERT INTO passkeys(user_id,credential_id,public_key,counter) VALUES ($1,$2,'synthetic',0)", [user.id, randomUUID()]);
  }
  const point = new Date();
  await source.close(); source = undefined;
  // PostgreSQL copies a closed source at a defined point; later source mutations
  // cannot alter the clone. Blob ciphertext and versioned wrapped keys are retained.
  await admin.query(`CREATE DATABASE ${restoredName} TEMPLATE ${sourceName}`); created.push(restoredName);
  source = await createDb(url(sourceName));
  const journalRows = new Map<string, string>();
  const journal = createDeletionJournal({ async create(name, body) { if (!journalRows.has(name)) journalRows.set(name, body); } });
  const outbox = createOutbox();
  await deleteAccount({ db: source, revoker: createResetExecutor(source), journal,
    senders: { email: outbox, sms: outbox, push: outbox } }, { userId: deleted.id });
  await runAccountPurge(source, { blobStore: originalBlobs, journal });
  assert.equal((await source.query("SELECT id FROM users WHERE id = $1", [deleted.id])).rows.length, 0);
  assert.equal(journalRows.size, 2, "purging PostgreSQL does not purge the external journal");

  restored = await createDb(url(restoredName));
  assert.equal((await restored.query("SELECT id FROM users WHERE id = $1", [deleted.id])).rows.length, 1,
    "the database snapshot really resurrects the post-backup deletion before reconciliation");
  active = "new";
  const rotated = selectKeyWrapper({ nodeEnv: "production", keyVaultClient: client(active),
    keyVaultClientFor: id => client(id.slice(id.lastIndexOf("/") + 1)) });
  const restoredKey = await rotated.unwrap(String((await restored.query("SELECT wrapped_dek FROM users WHERE id = $1", [survivor.id])).rows[0]!.wrapped_dek));
  assert.deepEqual(Buffer.from(restoredKey), dek, "old key version still decrypts after rotation");
  const survivorFile = files[1]!;
  assert.equal(Buffer.from((await getReceiptFile(restored, restoredBlobs, { userId: survivor.id, id: survivorFile.id }, restoredKey))!.bytes).toString(), `synthetic recovery receipt ${survivor.id}`);
  const now = new Date();
  const result = await prepareIsolatedRestore({ db: restored, blobs: restoredBlobs, restorePoint: point, now,
    snapshot: { coverageFrom: new Date(point.getTime() - 1_000).toISOString(), capturedAt: now.toISOString(), retentionDays: 42,
      records: [...journalRows.values()].map(value => JSON.parse(value) as JournalRecord) } });
  assert.equal(result.deletedAccounts, 1); assert.equal(result.deletedReceiptBlobs, 1);
  assert.equal(result.trafficMayOpen, false);
  assert.equal(await restoredBlobs.get(files[0]!.blobKey), null);
  assert.ok(await restoredBlobs.get(survivorFile.blobKey));
  assert.equal((await restored.query("SELECT count(*)::int AS n FROM passkeys")).rows[0]?.n, 0);
  keys.delete("old");
  await assert.rejects(rotated.unwrap(wrapped), /Retained wrapping key unavailable/);
  restoredKey.fill(0);
  console.log("PASS: isolated PG16 snapshot, post-snapshot deletion/purge, independent journal, retained-key rotation, exact receipt bytes, deletion replay, credential invalidation, missing-key refusal and closed traffic");
} finally {
  dek.fill(0);
  await Promise.allSettled([source?.close(), restored?.close()]);
  for (const name of created.reverse()) await admin.query(`DROP DATABASE ${name}`);
  await admin.close();
}
