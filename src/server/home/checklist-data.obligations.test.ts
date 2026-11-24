// E18-S04 — Set-up checklist status read, the obligation acceptance criteria
// (INV-102 validate-and-parameterize-input; INV-103 secrets-from-env).
//
// RED-first: `./checklist-data` does not exist yet, so importing `loadSetupChecklist`
// throws and every test here fails until the builder writes the module. That absence
// IS the point of test-first; do NOT implement anything to make these pass.
//
// The pinned reads are documented in the sibling `checklist-data.test.ts`; this file
// depends on the same surface and pins only the two obligation ACs, as BEHAVIOUR:
//
//   AC3 [obligation:validate-and-parameterize-input] (INV-102) —
//     • VALIDATE: a handler on the `../http/validate` boundary rejects a malformed,
//       oversized or mis-typed request body with a 4xx BEFORE the read runs, and takes
//       the owner from the SESSION — a `userId` smuggled in the body is stripped and
//       ignored (the handler below is a TEST FIXTURE — the intended usage — not an
//       implementation file); and
//     • PARAMETERIZE: the read binds the person id as a parameter, so a SQL-injection
//       probe routed through it travels as a BOUND value (placeholders, never spliced
//       into the SQL text) and cannot alter a query or drop a table.
//   AC4 [obligation:secrets-from-env] (INV-103) — the read runs purely from its
//       injected seams (db + keyWrapper + clock + the session id) and reads no
//       `process.env`, so a decoy secret planted in the environment never lands in the
//       assembled checklist, and the read still works with a decoy app env set.
//
// Database tests use `freshDb()` and a `recordingDb` that captures what reached the
// query layer; each real-db handle is closed in a `finally`. Tests touch no network
// and no Azure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

import { loadSetupChecklist } from "./checklist-data";
import { computeSetupChecklist } from "../../domain/home/checklist";
import { createUser } from "../db/users";
import { createRecord } from "../db/life-admin-records";
import { upsertPermissions } from "../db/agent-permissions";
import { addCard } from "../db/cards";
import { createConnection } from "../db/connections";
import { createAgent } from "../db/agents";
import { registerSubscription } from "../db/push-subscriptions";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";
import { localAesKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { fixedClock, type Clock } from "../seams/clock";
import { parseBody, HttpError } from "../http/validate";

// --- fixtures ----------------------------------------------------------------------

const DEK_BYTES = 32;
const KEK_BYTES = 32;
const T0 = new Date("2026-06-01T00:00:00.000Z");
const clock: Clock = fixedClock(T0);
const keyWrapper: KeyWrapper = localAesKeyWrapper(randomBytes(KEK_BYTES));

// The checklist the read returns, as a loose structural view so helpers do not depend
// on the (absent) module's exported item type at the point they run.
type ChecklistLike = ReadonlyArray<{ readonly label: string; readonly href: string; readonly done: boolean }>;

async function makeUserWithDek(db: Db, who: string): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

async function seedCard(db: Db, userId: string): Promise<void> {
  await addCard(db, {
    userId,
    brand: "visa",
    lastFour: "4242",
    expiryMonth: 11,
    expiryYear: 2029,
    nickname: "Everyday",
    billingAddressId: "addr-1",
    numberCiphertext: "v1:card-number-ciphertext",
  });
}

async function seedConnection(db: Db, userId: string, dek: Uint8Array): Promise<string> {
  const account = await createConnection(
    db,
    { userId, connectorId: "google-gmail", accountLabel: "person@gmail.com", credentials: { accessToken: "atok" } },
    dek,
    clock,
  );
  return account.id;
}

// Seed every one of the five signals, so a probe or a decoy must leave a FULL account
// untouched / unleaked.
async function seedEverything(db: Db, userId: string, dek: Uint8Array): Promise<void> {
  // Something an agent found that the person checked ("Build your profile").
  const record = await createRecord(db, { userId, kind: "item", type: "other.item", fields: { name: "Car" }, status: "active", source: { kind: "agent", agentId: randomUUID() } }, dek);
  await db.query("UPDATE life_admin_records SET review_state = 'confirmed' WHERE id = $1 AND user_id = $2", [record.id, userId]);
  await seedCard(db, userId);
  // A service an agent can read ("Connect a service").
  const accountId = await seedConnection(db, userId, dek);
  const connectionId = randomUUID();
  await createAgent(
    db,
    { userId, connectionId, displayName: "Claude", platform: "claude" },
    clock,
  );
  await upsertPermissions(db, {
    userId, connectionId, grantedConnectors: [], readTools: true, changeTools: "off", identityAccess: false, highTierAccess: false,
    cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: false, sharing: false, rulesScope: [], rateLimit: 120,
    accounts: [{ accountId }],
  } as Parameters<typeof upsertPermissions>[1]);
  await registerSubscription(
    db,
    { userId, endpoint: "https://push.example/endpoint-1", keys: { p256dh: "p256dh-key", auth: "auth-key" } },
    dek,
    clock,
  );
}

// The all-five-done checklist a fully set-up owner must read as.
function allDone(): ChecklistLike {
  return computeSetupChecklist({
    notificationsEnabled: true,
    profileBuilt: true,
    cardAdded: true,
    serviceConnected: true,
    agentConnected: true,
  });
}

// A db seam stand-in that records every call instead of running it, so a test can prove
// WHAT reached the query layer and HOW (a bound value vs. spliced text). Returns no rows
// and satisfies the `Db` shape structurally (query + close).
interface RecordingDb extends Db {
  readonly calls: { text: string; values: unknown[] }[];
}
function recordingDb(): RecordingDb {
  const calls: { text: string; values: unknown[] }[] = [];
  return {
    calls,
    query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return Promise.resolve({ rows: [] as Record<string, unknown>[] });
    },
    close() {
      return Promise.resolve();
    },
  };
}

// Whether a relation of this exact name exists on this handle — a non-throwing probe
// scoped to the one table under test (behaviour, not source text).
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Assert the probe reached the query layer as a BOUND value and never as spliced SQL
// text, scoped to each recorded call (the parameterize half of INV-102).
function assertBoundNotSpliced(db: RecordingDb, probe: string): void {
  assert.ok(db.calls.length >= 1, "at least one query was issued");
  assert.ok(db.calls.some((c) => c.values.includes(probe)), "the probe travels as a bound value");
  for (const call of db.calls) {
    assert.ok(!call.text.includes(probe), "the input is bound, never concatenated into the SQL");
    assert.ok(!call.text.includes("DROP TABLE"), "no injected statement appears in the SQL text");
  }
}

function restoreEnv(name: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

// ===========================================================================
// AC3 (VALIDATE) — a handler on the validation boundary rejects bad input and takes the
// owner from the SESSION; a userId in the body is ignored.
//
// The read takes no client filter, so the handler only validates the request envelope
// (a well-formed JSON object within a size cap) and reads for the SESSION's id from the
// closure. This handler is a TEST FIXTURE (the intended usage) — not an implementation
// file.
// ===========================================================================

function checklistHandler(
  deps: { db: Db; keyWrapper: KeyWrapper; clock: Clock },
  sessionUserId: string,
): (req: Request) => Promise<{ status: number; reached: boolean; checklist: ChecklistLike | null }> {
  const schema = z.object({});
  return async (req: Request) => {
    let reached = false;
    try {
      await parseBody(schema, req, { maxBytes: 4 * 1024 });
      reached = true;
      const checklist = (await loadSetupChecklist(deps, sessionUserId)) as ChecklistLike;
      return { status: 200, reached, checklist };
    } catch (err) {
      if (err instanceof HttpError) return { status: err.status, reached, checklist: null };
      // A non-HttpError escaping the boundary is an uncontrolled 500; surface it so a
      // test sees the raw failure rather than a masked success.
      return { status: 500, reached, checklist: null };
    }
  };
}

function jsonRequest(body: string): Request {
  return new Request("https://warthog.com.au/home", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("[validate-and-parameterize-input] the handler rejects malformed JSON with a 4xx before the read runs", async () => {
  const db = await freshDb();
  try {
    const { userId } = await makeUserWithDek(db, "cl-malformed");
    const handler = checklistHandler({ db, keyWrapper, clock }, userId);
    const res = await handler(jsonRequest("{ not valid json"));
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.equal(res.reached, false, "malformed input never reaches the read");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] the handler rejects an oversized body with a 4xx before the read runs", async () => {
  const db = await freshDb();
  try {
    const { userId } = await makeUserWithDek(db, "cl-oversized");
    const handler = checklistHandler({ db, keyWrapper, clock }, userId);
    // ~8 KiB body, well over the handler's 4 KiB cap: rejected by size before parse.
    const res = await handler(jsonRequest(JSON.stringify({ junk: "a".repeat(8 * 1024) })));
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.equal(res.reached, false, "an oversized body never reaches the read");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] the handler rejects a mis-typed body (not an object) with a 4xx", async () => {
  const db = await freshDb();
  try {
    const { userId } = await makeUserWithDek(db, "cl-mistyped");
    const handler = checklistHandler({ db, keyWrapper, clock }, userId);
    // A bare number is not the expected object shape — a schema violation, rejected
    // before the read.
    const res = await handler(jsonRequest(JSON.stringify(42)));
    assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx, got ${res.status}`);
    assert.equal(res.reached, false, "a mis-typed body never reaches the read");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] a well-formed request reaches the read and returns the session person's checklist", async () => {
  const db = await freshDb();
  try {
    const { userId, dek } = await makeUserWithDek(db, "cl-ok");
    await seedCard(db, userId);
    const handler = checklistHandler({ db, keyWrapper, clock }, userId);

    const res = await handler(jsonRequest(JSON.stringify({})));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    assert.equal(res.reached, true, "a valid body reaches the read");
    assert.deepEqual(
      res.checklist,
      computeSetupChecklist({ cardAdded: true }),
      "the session person's real set-up state (a saved card) is returned",
    );
    void dek;
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] the owner is the SESSION — a userId smuggled in the body is ignored (AC2)", async () => {
  const db = await freshDb();
  try {
    const session = await makeUserWithDek(db, "cl-session");
    const attacker = await makeUserWithDek(db, "cl-attacker");
    // The session person has a card; the attacker has a connected service — DIFFERENT
    // signals, so a mix-up would be unmistakable.
    await seedCard(db, session.userId);
    await seedConnection(db, attacker.userId, attacker.dek);

    const handler = checklistHandler({ db, keyWrapper, clock }, session.userId);

    // The body tries to redirect the read at the attacker. The handler validates the
    // envelope, strips the unknown key, and reads for the SESSION's id regardless.
    const res = await handler(jsonRequest(JSON.stringify({ userId: attacker.userId })));
    assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx, got ${res.status}`);
    assert.deepEqual(
      res.checklist,
      computeSetupChecklist({ cardAdded: true }),
      "the checklist is the SESSION person's (the card), never the body-supplied user's service",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC3 (PARAMETERIZE) — the person id reaches the db as a BOUND value, never spliced; a
// SQL-injection id cannot alter a query, drop a table, or leak another person's state.
// ===========================================================================

test("[validate-and-parameterize-input] the person id reaches the db as a BOUND value, never spliced into the SQL", async () => {
  const db = recordingDb();
  const probe = "p'); DROP TABLE cards; --";
  // The recording db returns no rows, so the read cannot resolve the person — but the
  // member-scoped query it DID issue must have bound the probe, never spliced it.
  try {
    await loadSetupChecklist({ db, keyWrapper, clock }, probe);
  } catch {
    /* no user row ⇒ the read reports a failure; we assert on HOW it queried */
  }
  assertBoundNotSpliced(db, probe);
});

test("[validate-and-parameterize-input] a SQL-injection person id cannot alter a query, drop a table, or leak another person's state", async () => {
  const db = await freshDb();
  try {
    // A real owner with a FULL account; the probe must neither reach nor harm it.
    const { userId, dek } = await makeUserWithDek(db, "probe-owner");
    await seedEverything(db, userId, dek);

    const probe = "p'); DROP TABLE cards; --";
    // Bound as a parameter, the probe is at worst a value the uuid-typed id column
    // rejects (OBS-049: an id-typed selector); it is NEVER executed as SQL. Either
    // outcome — the DB rejects it, or it simply matches nothing — proves it did not run.
    let rejectedOrEmpty = false;
    try {
      const checklist = (await loadSetupChecklist({ db, keyWrapper, clock }, probe)) as ChecklistLike;
      rejectedOrEmpty = checklist.every((item) => item.done === false);
    } catch {
      rejectedOrEmpty = true;
    }
    assert.ok(rejectedOrEmpty, "the probe is bound, not executed — it yields nothing or is rejected");

    // The decisive proof: every table and the real owner's whole account are intact.
    for (const table of [
      "cards",
      "identity_fields",
      "connections",
      "agents",
      "push_subscriptions",
      "users",
    ]) {
      assert.equal(await tableExists(db, table), true, `the ${table} table is intact`);
    }
    assert.deepEqual(
      await loadSetupChecklist({ db, keyWrapper, clock }, userId),
      allDone(),
      "the real owner's full set-up survived the probe",
    );
  } finally {
    await db.close();
  }
});

// ===========================================================================
// AC4 [secrets-from-env] — the read uses injected deps only; no ambient env value lands
// in the assembled checklist, and it runs with a decoy app env set.
// ===========================================================================

test("[secrets-from-env] no ambient env secret appears in the checklist; the read runs from its injected seams alone", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prevDecoy = process.env.WARTHOG_DECOY_SECRET;
  const prevDbUrl = process.env.DATABASE_URL;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  // Prove the read does not reach for an ambient database URL: point it at a decoy and
  // rely solely on the injected db seam.
  process.env.DATABASE_URL = `postgres://decoy:${DECOY}@127.0.0.1:1/decoy`;

  const db = await freshDb();
  try {
    const { userId, dek } = await makeUserWithDek(db, "env-user");
    await seedCard(db, userId);

    const checklist = (await loadSetupChecklist({ db, keyWrapper, clock }, userId)) as ChecklistLike;

    // The read worked purely from the injected db + keyWrapper + clock + session id.
    assert.deepEqual(
      checklist,
      computeSetupChecklist({ cardAdded: true }),
      "the read works from its injected inputs alone (the injected db supplied the card)",
    );
    assert.ok(!JSON.stringify(checklist).includes(DECOY), "no ambient env secret appears in the checklist");
    void dek;
  } finally {
    await db.close();
    restoreEnv("WARTHOG_DECOY_SECRET", prevDecoy);
    restoreEnv("DATABASE_URL", prevDbUrl);
  }
});
