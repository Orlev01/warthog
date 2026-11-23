// Email addresses in household invites (review 2026-11-23, High: "household invites keep
// plaintext addresses that the purge never touches"). An invite is keyed by its token hash and
// bound to a household and the INVITED address — not to an account — so the invited person's
// own deletion never reached it, and a used or lapsed invite was never removed at all.
//
//   deleteInvitesTo(db, email)  every invite sent to one address (any case or spacing), in any
//                               household — the account purge calls it with the deleted
//                               person's address.
//   pruneInvites(db, now)       the retention sweep: an invite is deleted 30 days after it was
//                               used or lapsed. Until then a lapsed link still reads as
//                               "expired" rather than unknown.
//
// Pins behaviour against a real in-memory PGlite with the real migrations.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { deleteInvitesTo, issueInvite, previewInvite, pruneInvites } from "./household-invites";
import { createHousehold } from "./households";
import { createUser } from "./users";
import { fixedClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import { freshDb } from "../../test/db";
import type { Db } from "./index";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-23T12:00:00.000Z");

async function household(db: Db, who: string): Promise<string> {
  const owner = await createUser(db, { email: `${who}@example.com`, wrappedDek: randomBytes(16).toString("base64") });
  return (await createHousehold(db, { ownerId: owner.id })).id;
}

// An invite to `email` stamped `daysAgo` days before NOW, valid seven days from then.
async function invite(db: Db, householdId: string, email: string, daysAgo: number, used = false): Promise<string> {
  const at = new Date(NOW.getTime() - daysAgo * DAY_MS);
  const issued = await issueInvite(db, { householdId, email }, { clock: fixedClock(at), random: systemRandom });
  if (used) await db.query("UPDATE household_invites SET used_at = created_at + interval '1 hour' WHERE email = $1 AND created_at = $2::timestamptz", [email, at.toISOString()]);
  return issued.token;
}

async function invitesTo(db: Db, email: string): Promise<number> {
  const result = await db.query("SELECT count(*)::int AS n FROM household_invites WHERE lower(btrim(email)) = lower(btrim($1))", [email]);
  return Number(result.rows[0]?.n ?? 0);
}

test("deleteInvitesTo removes every invite sent to one address, in every household, whatever its case", async () => {
  const db = await freshDb();
  try {
    const first = await household(db, "owner-one");
    const second = await household(db, "owner-two");
    await invite(db, first, "leaving@example.com", 1);
    await invite(db, second, " Leaving@Example.COM", 2);
    await invite(db, first, "staying@example.com", 1);

    await deleteInvitesTo(db, "LEAVING@example.com");

    assert.equal(await invitesTo(db, "leaving@example.com"), 0);
    assert.equal(await invitesTo(db, "staying@example.com"), 1, "an invite to someone else stays");
  } finally {
    await db.close();
  }
});

test("pruneInvites deletes an invite 30 days after it was used or lapsed, and keeps the rest", async () => {
  const db = await freshDb();
  try {
    const home = await household(db, "owner-prune");
    await invite(db, home, "open@example.com", 1); // still open
    const lapsed = await invite(db, home, "lapsed-recently@example.com", 20); // lapsed 13 days ago
    await invite(db, home, "lapsed-long-ago@example.com", 40); // lapsed 33 days ago
    await invite(db, home, "used-recently@example.com", 10, true); // used 10 days ago
    await invite(db, home, "used-long-ago@example.com", 35, true); // used 35 days ago

    await pruneInvites(db, NOW);

    assert.equal(await invitesTo(db, "open@example.com"), 1, "an open invite is kept");
    assert.equal(await invitesTo(db, "lapsed-recently@example.com"), 1, "lapsed under 30 days ago: kept");
    assert.equal(await invitesTo(db, "used-recently@example.com"), 1, "used under 30 days ago: kept");
    assert.equal(await invitesTo(db, "lapsed-long-ago@example.com"), 0, "lapsed over 30 days ago: deleted");
    assert.equal(await invitesTo(db, "used-long-ago@example.com"), 0, "used over 30 days ago: deleted");

    // A recently lapsed link still says it expired.
    const invitee = await createUser(db, { email: "lapsed-recently@example.com", wrappedDek: "d3JhcHBlZA==" });
    assert.deepEqual(await previewInvite(db, { token: lapsed, userId: invitee.id }, { clock: fixedClock(NOW) }), { ok: false, reason: "expired" });
  } finally {
    await db.close();
  }
});
