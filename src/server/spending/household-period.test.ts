import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { createHousehold, addMember } from "../db/households";
import { recordRelease, periodKeyFor } from "../db/card-spend-ledger";
import { fixedClock } from "../seams/clock";
import { readHouseholdSpending } from "./household-read";
import { checkHouseholdRelease } from "./release-household";
import { withTransaction } from "../db/index";

test("one UTC household month includes releases from members in different local months", async () => {
  const db = await freshDb();
  try {
    const now = new Date("2026-11-01T00:30:00Z");
    const users = await Promise.all(["sydney", "los-angeles"].map((name) => createUser(db,
      { email: name + "@example.test", wrappedDek: "synthetic-unused" })));
    const household = await createHousehold(db, { ownerId: users[0].id, currency: "AUD", monthlyBudget: 100 });
    await addMember(db, { householdId: household.id, userId: users[1].id });
    for (const [index, zone] of ["Australia/Sydney", "America/Los_Angeles"].entries()) {
      await recordRelease(db, { userId: users[index].id, connectionId: randomUUID(), householdId: household.id,
        amount: 40, currency: "AUD", merchant: "Synthetic", periodKeys: {
          day: periodKeyFor("day", now, zone), week: periodKeyFor("week", now, zone), month: periodKeyFor("month", now, zone),
        } }, { householdPeriodMonth: periodKeyFor("month", now, "UTC") });
    }
    for (const zone of ["Australia/Sydney", "America/Los_Angeles"]) {
      const report = await readHouseholdSpending(users[0].id, { db, clock: fixedClock(now), timeZone: zone });
      assert.equal(report!.budgetSpendToDate, 80);
      const check = await withTransaction(db, (tx) => checkHouseholdRelease(tx, users[0].id,
        { amount: 30, currency: "AUD" }, { clock: fixedClock(now), timeZone: zone }));
      assert.deepEqual(check, { ok: false, code: "over_household_budget" });
    }
    const before = await readHouseholdSpending(users[0].id, { db, clock: fixedClock(new Date("2026-10-31T23:59:59Z")), timeZone: "Australia/Sydney" });
    assert.equal(before!.budgetSpendToDate, 0);
  } finally { await db.close(); }
});

test("ambiguous historical household dates cannot silently create more budget", async () => {
  const db = await freshDb();
  try {
    const owner = await createUser(db, { email: "legacy@example.test", wrappedDek: "synthetic-unused" });
    const household = await createHousehold(db, { ownerId: owner.id, currency: "AUD", monthlyBudget: 100 });
    await recordRelease(db, { userId: owner.id, connectionId: randomUUID(), householdId: household.id,
      amount: 90, currency: "AUD", merchant: "Synthetic legacy", periodKeys: { day: "2026-10-31", week: "2026-W44", month: "2026-10" } },
      { householdPeriodMonth: null });
    const check = await withTransaction(db, (tx) => checkHouseholdRelease(tx, owner.id,
      { amount: 20, currency: "AUD" }, { clock: fixedClock(new Date("2026-11-01T00:30:00Z")) }));
    assert.deepEqual(check, { ok: false, code: "household_period_unavailable" });
  } finally { await db.close(); }
});
