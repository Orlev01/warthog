import { test } from "node:test";
import assert from "node:assert/strict";
import { RECEIPT_MAX_BYTES, receiptUploadError } from "../../lib/receipt-upload";

test("receipt picker accepts the file limit and refuses empty or oversized files", () => {
  assert.equal(receiptUploadError(1024), null);
  assert.equal(receiptUploadError(RECEIPT_MAX_BYTES), null);
  assert.match(receiptUploadError(RECEIPT_MAX_BYTES + 1)!, /25 MiB/);
  assert.match(receiptUploadError(27 * 1024 * 1024)!, /25 MiB/);
  assert.match(receiptUploadError(0)!, /non-empty/);
});
