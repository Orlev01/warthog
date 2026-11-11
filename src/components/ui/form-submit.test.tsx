import assert from "node:assert/strict";
import { test } from "node:test";
import { createFormSubmissionGuard } from "./form-submit";

test("a native form reserves its submission before React runs the action, preventing queued duplicate adds", async () => {
  const guard = createFormSubmissionGuard();
  const response = Promise.withResolvers<void>();
  let writes = 0;
  assert.equal(guard.reserve(), true);
  assert.equal(guard.reserve(), false, "the second submit event is rejected before a render or action call");
  const action = async () => { writes++; await response.promise; };
  const first = guard.run(action, new FormData());
  await guard.run(action, new FormData());
  assert.equal(writes, 1);
  response.resolve();
  await first;
  assert.equal(guard.reserve(), true, "a later deliberate submission is allowed");
});

test("form failures and framework redirects release the guard without swallowing framework control flow", async () => {
  const guard = createFormSubmissionGuard();
  const redirect = new Error("NEXT_REDIRECT");
  guard.reserve();
  await assert.rejects(guard.run(async () => { throw redirect; }, new FormData()), (error) => error === redirect);
  assert.equal(guard.reserve(), true);
});
