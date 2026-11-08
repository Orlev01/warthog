// Review fix W4.3 — the person's own time zone for budget periods
// (src/server/spending/time-zone.ts).
//
// Budget periods follow the person's saved time zone (preferences.time_zone, stored
// DEK-encrypted), defaulting to Sydney. The saved value is free text from the Skills
// screen, so anything that is not a real IANA zone falls back to the default rather than
// breaking every budget read. The read is member-scoped: it never uses another person's
// preference.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { savePreferences } from "../db/preferences";
import type { Db } from "../db/index";
import { budgetTimeZone, timeZoneFor } from "./time-zone";

async function makeUser(db: Db, who: string): Promise<string> {
  const user = await createUser(db, {
    email: `${who}-${randomUUID()}@warthog.com.au`,
    wrappedDek: Buffer.from(`wrapped-dek-${who}`).toString("base64"),
  });
  return user.id;
}

async function saveZone(db: Db, userId: string, dek: Uint8Array, timeZone: string): Promise<void> {
  await savePreferences(
    db,
    { userId, tone: "warm", length: "short", language: "en-AU", units: "metric", timeZone, briefing: "brief" },
    dek,
  );
}

test("budgetTimeZone keeps a real IANA zone and falls back to Sydney otherwise", () => {
  assert.equal(budgetTimeZone("America/New_York"), "America/New_York");
  assert.equal(budgetTimeZone("UTC"), "UTC");
  assert.equal(budgetTimeZone("Sydney"), "Australia/Sydney");
  assert.equal(budgetTimeZone(""), "Australia/Sydney");
  assert.equal(budgetTimeZone(null), "Australia/Sydney");
  assert.equal(budgetTimeZone(undefined), "Australia/Sydney");
});

test("timeZoneFor defaults to Sydney when the person has saved no preferences", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "nopref");
    assert.equal(await timeZoneFor(db, userId, randomBytes(32)), "Australia/Sydney");
  } finally {
    await db.close();
  }
});

test("timeZoneFor reads the person's own saved zone", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "perth");
    const dek = randomBytes(32);
    await saveZone(db, userId, dek, "Australia/Perth");
    assert.equal(await timeZoneFor(db, userId, dek), "Australia/Perth");
  } finally {
    await db.close();
  }
});

test("timeZoneFor falls back to Sydney when the saved zone is not a real IANA name", async () => {
  const db = await freshDb();
  try {
    const userId = await makeUser(db, "typo");
    const dek = randomBytes(32);
    await saveZone(db, userId, dek, "Sydney time");
    assert.equal(await timeZoneFor(db, userId, dek), "Australia/Sydney");
  } finally {
    await db.close();
  }
});

test("timeZoneFor never uses another person's preference", async () => {
  const db = await freshDb();
  try {
    const other = await makeUser(db, "other");
    await saveZone(db, other, randomBytes(32), "Europe/London");
    const me = await makeUser(db, "me");
    assert.equal(await timeZoneFor(db, me, randomBytes(32)), "Australia/Sydney");
  } finally {
    await db.close();
  }
});
