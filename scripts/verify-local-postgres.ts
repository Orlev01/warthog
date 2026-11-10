// Fixed disposable Compose target only: never accept a production connection URL.
import assert from "node:assert/strict";
import { Client } from "pg";
import { createDb, loadMigrations, runMigrations, withTransaction } from "../src/server/db/index";
import { acquireOwnership } from "../src/server/db/ownership";
import { createUser } from "../src/server/db/users";
import { createHousehold, addMember } from "../src/server/db/households";
import { recordRelease, periodKeyFor } from "../src/server/db/card-spend-ledger";
import { checkHouseholdRelease } from "../src/server/spending/release-household";
import { randomUUID } from "node:crypto";
import { verifyPostgresAgentControls } from "./verify-local-postgres-agents";
import { verifyPostgresSecurityContention } from "./verify-local-postgres-security";

if (process.platform !== "linux" || process.env.WARTHOG_LOCAL_PG_CHECK !== "1") throw new Error("Local Compose check required");
const url = (role: string) => `postgresql://${role}@warthog-postgres-check:5432/warthog?sslmode=disable`;
const migrate = await createDb(url("warthog_migrate"));
const runtime = await createDb(url("warthog_runtime"));
const purge = await createDb(url("warthog_purger"));
let owner: { close(): Promise<void> } | undefined;

async function verifyConcurrentHouseholdReleases() {
  const alice = await createUser(runtime, { email: "concurrent-first@example.test", wrappedDek: "synthetic-only" });
  const bob = await createUser(runtime, { email: "concurrent-second@example.test", wrappedDek: "synthetic-only" });
  const household = await createHousehold(runtime, { ownerId: alice.id, currency: "AUD", monthlyBudget: 200 });
  await withTransaction(runtime, (tx) => addMember(tx, { householdId: household.id, userId: bob.id }));
  const now = new Date("2026-11-09T00:00:00Z");
  const clock = { now: () => now };
  const periodKeys = { day: periodKeyFor("day", now), week: periodKeyFor("week", now), month: periodKeyFor("month", now) };
  let reportLocked!: () => void, releaseFirst!: () => void, reportSecondPid!: (pid: number) => void;
  const firstLocked = new Promise<void>((resolve) => { reportLocked = resolve; });
  const allowFirstCommit = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondPid = new Promise<number>((resolve) => { reportSecondPid = resolve; });
  const first = withTransaction(runtime, async (tx) => {
    const result = await checkHouseholdRelease(tx, alice.id, { amount: 150, currency: "AUD" }, { clock });
    assert.ok(result.ok);
    reportLocked();
    await allowFirstCommit;
    await recordRelease(tx, { userId: alice.id, connectionId: randomUUID(), householdId: result.householdId,
      amount: 150, currency: "AUD", merchant: "synthetic-only", periodKeys }, { householdPeriodMonth: periodKeyFor("month", clock.now(), "UTC") });
    return result;
  });
  let second: Promise<unknown> | undefined;
  try {
    await Promise.race([firstLocked, first.then(() => { throw new Error("First release ended before the concurrency check"); })]);
    second = withTransaction(runtime, async (tx) => {
      reportSecondPid(Number((await tx.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid));
      const result = await checkHouseholdRelease(tx, bob.id, { amount: 150, currency: "AUD" }, { clock });
      if (result.ok) await recordRelease(tx, { userId: bob.id, connectionId: randomUUID(), householdId: result.householdId,
        amount: 150, currency: "AUD", merchant: "synthetic-only", periodKeys }, { householdPeriodMonth: periodKeyFor("month", clock.now(), "UTC") });
      return result;
    });
    const pid = await Promise.race([secondPid, second.then(() => { throw new Error("Second release ended without a backend PID"); })]);
    const deadline = Date.now() + 5000;
    let blocked = false;
    while (Date.now() < deadline) {
      blocked = (await runtime.query("SELECT cardinality(pg_blocking_pids($1::integer)) > 0 AS blocked", [pid])).rows[0]?.blocked === true;
      if (blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(blocked, "the second member must wait for the household lock");
    releaseFirst();
    await first;
    assert.deepEqual(await second, { ok: false, code: "over_household_budget" });
    assert.equal(Number((await runtime.query("SELECT sum(amount) AS total FROM card_spend_ledger WHERE household_id = $1", [household.id])).rows[0]?.total), 150);
  } finally {
    releaseFirst();
    await Promise.allSettled([first, second]);
    await purge.query("DELETE FROM users WHERE id IN ($1, $2)", [alice.id, bob.id]);
  }
}
try {
  assert.equal((await migrate.query("SHOW cluster_name")).rows[0]?.cluster_name, "warthog-local-certification");
  const version = Number((await migrate.query("SHOW server_version_num")).rows[0]?.server_version_num);
  assert.ok(version >= 160000 && version < 170000, "PostgreSQL 16 required");
  const migrations = await loadMigrations();
  await runMigrations(migrate, migrations);
  const before = (await migrate.query("SELECT count(*)::int AS count FROM schema_migrations")).rows[0]?.count;
  await runMigrations(migrate, migrations);
  assert.equal((await migrate.query("SELECT count(*)::int AS count FROM schema_migrations")).rows[0]?.count, before);
  assert.equal(before, migrations.length);
  assert.equal((await runtime.query("SELECT current_user")).rows[0]?.current_user, "warthog_runtime");
  for (const sql of ["CREATE TABLE forbidden (id int)", "DELETE FROM users WHERE false", "DELETE FROM activity_entries WHERE false", "DELETE FROM schema_migrations WHERE false", "SET ROLE warthog_migrate", "SET ROLE warthog_purger"]) {
    await assert.rejects(runtime.query(sql), /permission denied|must be member/);
  }
  await runtime.query("INSERT INTO users (email, wrapped_dek) VALUES ('local-check@example.test', 'synthetic-only')");
  const userId = (await runtime.query("SELECT id FROM users WHERE email = 'local-check@example.test'")).rows[0]!.id;
  await runtime.query("INSERT INTO passkeys (user_id, credential_id, public_key, counter) VALUES ($1, 'local-check-credential', 'synthetic-only', 0)", [userId]);
  await runtime.query("INSERT INTO vault_passkey_envelopes (user_id, credential_id, wrapped_key) VALUES ($1, 'local-check-credential', 'synthetic-only')", [userId]);
  await assert.rejects(purge.query("UPDATE activity_entries SET kind = kind WHERE false"), /permission denied/);
  await purge.query("DELETE FROM users WHERE id = $1", [userId]);
  assert.equal((await runtime.query("SELECT * FROM vault_passkey_envelopes WHERE user_id = $1", [userId])).rows.length, 0);
  const acquire = () => acquireOwnership({ client: new Client({ connectionString: url("warthog_runtime") }),
    onLost: () => { throw new Error("Unexpected loss of test ownership"); }, schedule: () => () => {} });
  owner = await acquire();
  await assert.rejects(acquire(), /already owned/);
  await owner.close(); owner = undefined;
  owner = await acquire();
  await verifyConcurrentHouseholdReleases();
  await verifyPostgresSecurityContention(runtime, purge);
  await verifyPostgresAgentControls(runtime, purge);
  console.log(`PostgreSQL 16: ${migrations.length} migrations, idempotence, role separation, cascade purge, exclusive ownership and concurrent household-budget checks passed.`);
} finally {
  await owner?.close();
  await Promise.allSettled([migrate.close(), runtime.close(), purge.close()]);
}
