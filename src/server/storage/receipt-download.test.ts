import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { createRecord } from "../db/life-admin-records";
import { createSession } from "../auth/session";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { systemClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import { createInMemoryBlobStore } from "./blob";
import { saveReceiptFile } from "./receipt-files";
import { createReceiptDownloadHandler } from "./receipt-download";

test("receipt download requires its owner's session and returns exact bytes as a private attachment", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32), keyWrapper = localAesKeyWrapper(randomBytes(32)), blob = createInMemoryBlobStore();
    const user = await createUser(db, { email: "download-owner@example.test", wrappedDek: await keyWrapper.wrap(dek) });
    const other = await createUser(db, { email: "download-other@example.test", wrappedDek: await keyWrapper.wrap(randomBytes(32)) });
    const record = await createRecord(db, { userId: user.id, kind: "receipt_warranty", fields: { name: "Synthetic receipt" }, status: "active", source: { kind: "person" } }, dek);
    const bytes = new TextEncoder().encode("<script>synthetic receipt must download, never execute</script>");
    const file = await saveReceiptFile(db, blob, { userId: user.id, recordId: record.id, bytes, contentType: "text/html" }, dek);
    const handler = createReceiptDownloadHandler({ db, blob, keyWrapper, clock: systemClock });
    const request = (token?: string) => new Request("https://app.example.test/api/receipts/" + file.id, { headers: token ? { cookie: `__Host-wh_session=${token}` } : {} });
    assert.equal((await handler(request(), file.id)).status, 401);
    const foreign = await createSession(db, other.id, { clock: systemClock, random: systemRandom });
    assert.equal((await handler(request(foreign.token), file.id)).status, 404);
    const owner = await createSession(db, user.id, { clock: systemClock, random: systemRandom });
    assert.equal((await handler(request(owner.token), "invalid-id")).status, 404);
    const response = await handler(request(owner.token), file.id);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.match(response.headers.get("content-disposition")!, /^attachment;/);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  } finally { await db.close(); }
});
