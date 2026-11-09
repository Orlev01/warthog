import assert from "node:assert/strict";
import test from "node:test";
import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { createHousehold, setHouseholdBudget, setMemberLimit } from "../db/households";
import { withTransaction } from "../db/index";
import { checkHouseholdRelease } from "./release-household";

test("household release respects exact caps, zero caps, unset caps and account isolation", async () => {
  const db = await freshDb();
  try {
    const owner = await createUser(db, { email: "owner@example.test", wrappedDek: "synthetic" });
    const outsider = await createUser(db, { email: "outsider@example.test", wrappedDek: "synthetic" });
    const household = await createHousehold(db, { ownerId: owner.id, currency: "AUD", monthlyBudget: 200 });
    const deps = { clock: { now: () => new Date("2026-11-09T00:00:00Z") } };
    const check = (userId: string, amount: number) => withTransaction(db, (tx) => checkHouseholdRelease(tx, userId, { amount, currency: "AUD" }, deps));
    assert.deepEqual(await check(owner.id, 200), { ok: true, householdId: household.id });
    assert.deepEqual(await check(owner.id, 201), { ok: false, code: "over_household_budget" });
    assert.deepEqual(await check(outsider.id, 201), { ok: true, householdId: null });
    await setHouseholdBudget(db, { householdId: household.id, actorId: owner.id, monthlyBudget: 0 });
    assert.deepEqual(await check(owner.id, 1), { ok: false, code: "over_household_budget" });
    await setHouseholdBudget(db, { householdId: household.id, actorId: owner.id, monthlyBudget: null });
    await setMemberLimit(db, { householdId: household.id, actorId: owner.id, userId: owner.id, monthlyLimit: 0 });
    assert.deepEqual(await check(owner.id, 1), { ok: false, code: "over_member_budget" });
    await setMemberLimit(db, { householdId: household.id, actorId: owner.id, userId: owner.id, monthlyLimit: null });
    assert.deepEqual(await check(owner.id, 201), { ok: true, householdId: household.id });
  } finally { await db.close(); }
});
