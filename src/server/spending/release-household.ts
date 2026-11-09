import type { Db } from "../db/index";
import type { Clock } from "../seams/clock";
import { getHouseholdForMember } from "../db/households";
import { resolveCardRequestContext, type CardRequest } from "./household-context";

export type HouseholdReleaseCheck =
  | { ok: true; householdId: string | null }
  | { ok: false; code: "over_member_budget" | "over_household_budget" | "household_rate_unavailable" | "household_period_unavailable" };

// Call inside the SAME transaction as recordRelease, before locking the agent.
// These locks serialize all member/agent releases for a household and prevent a
// limit, currency or membership change midway through the check and ledger write.
export async function checkHouseholdRelease(
  db: Db,
  userId: string,
  spend: CardRequest,
  deps: { clock: Clock; timeZone?: string },
): Promise<HouseholdReleaseCheck> {
  const locked = await getHouseholdForMember(db, userId, { lock: true });
  if (!locked) return { ok: true, householdId: null };
  const resolved = await resolveCardRequestContext(userId, spend, { db, ...deps });
  const household = resolved.household;
  if (!household || household.householdId !== locked.id) throw new Error("Household membership changed during a locked release");
  if (household.periodUnavailable) return { ok: false, code: "household_period_unavailable" };
  if (resolved.deniable || household.totalsUnavailable) return { ok: false, code: "household_rate_unavailable" };
  const amount = resolved.converted?.amount ?? spend.amount;
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, code: "household_rate_unavailable" };
  if (household.memberLimit !== null && household.memberSpendToDate + amount > household.memberLimit) {
    return { ok: false, code: "over_member_budget" };
  }
  if (household.monthlyBudget !== null && household.budgetSpendToDate + amount > household.monthlyBudget) {
    return { ok: false, code: "over_household_budget" };
  }
  return { ok: true, householdId: household.householdId };
}
