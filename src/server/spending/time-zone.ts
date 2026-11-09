// Review fix W4.3 — the person's own time zone for budget periods (brief "Skills,
// preferences and shared memory": a preferences profile with the person's time zone;
// "Card requests" / "Spending view": budgets per day, week or month).
//
// Budget periods used to follow UTC, so for a person in Sydney a daily budget reset at
// 10 or 11 in the morning and a purchase at 8am on 1 December counted toward November.
// Personal agent budget periods resolve the person's zone here. Shared household
// budgets instead use one UTC month for all members (AUD-012); they must not use
// this reader-specific preference.
//
// The zone lives in the person's preferences profile, stored DEK-encrypted
// (`../db/preferences`), so this read takes the person's already-unwrapped DEK and is
// member-scoped by the `userId` the caller passes (the session's or connection's id,
// never a client value). The saved value is free text, so anything that is not a real
// IANA zone falls back to the default rather than breaking every budget read.

import { getPreferences } from "../db/preferences";
import { accountTimeZone } from "../../domain/time-zone";
import type { Db } from "../db/index";

// The zone to bucket budget periods in for a saved preference: the preference when it
// is a real IANA zone, otherwise the default (Sydney).
export function budgetTimeZone(saved: string | null | undefined): string {
  return accountTimeZone(saved);
}

// The person's budget time zone: their own saved preference (decrypted under their
// DEK, member-scoped by `userId`), or the default when they have saved none.
export async function timeZoneFor(db: Db, userId: string, dek: Uint8Array): Promise<string> {
  const preferences = await getPreferences(db, userId, dek);
  return budgetTimeZone(preferences?.timeZone);
}
