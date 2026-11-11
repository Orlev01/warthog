import assert from "node:assert/strict";
import { test } from "node:test";
import { createPackageOperation } from "./package-operation";

test("package save and access updates share a synchronous pending guard", async () => {
  const busy: boolean[] = [], errors: string[] = [];
  const operation = createPackageOperation({ onBusy: (value) => busy.push(value), onError: (value) => errors.push(value) });
  const pending = Promise.withResolvers<void>();
  const writes: string[] = [];
  const saving = operation.run(async () => { writes.push("save files"); await pending.promise; });
  await operation.run(async () => { writes.push("save access"); });
  await operation.run(async () => { writes.push("delete package"); });
  assert.deepEqual(writes, ["save files"]);
  assert.equal(operation.isBusy(), true);
  assert.deepEqual(busy, [true]);
  pending.resolve();
  await saving;
  assert.equal(operation.isBusy(), false);
  assert.deepEqual(busy, [true, false]);
  assert.deepEqual(errors, [""]);
});

test("a lost save response reports safe failure and unlocks retained edits for retry", async () => {
  const errors: string[] = [];
  const operation = createPackageOperation({ onBusy: () => {}, onError: (value) => errors.push(value) });
  await assert.doesNotReject(operation.run(async () => { throw new Error("private database detail"); }));
  assert.equal(operation.isBusy(), false);
  assert.match(errors.at(-1)!, /try again/i);
  assert.doesNotMatch(errors.at(-1)!, /private database/);
  let retried = false;
  await operation.run(async () => { retried = true; });
  assert.equal(retried, true);
});
