// Executed only by the isolated local PostgreSQL 16 certification harness.
// These checks use independent pool connections and observe real lock waiters.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { withTransaction, type Db } from "../src/server/db/index";
import { createUser } from "../src/server/db/users";
import { createSession, verifySession } from "../src/server/auth/session";
import { createAuthCode, createClient, createClientWithinCap } from "../src/server/oauth/store";
import { exchangeToken } from "../src/server/oauth/token";
import { createRevokeHandler } from "../src/app/oauth/revoke/handler";
import { systemRandom } from "../src/server/seams/random";
import { createDbRecorder, readActivity } from "../src/server/activity/writer";
import { checkIntegrity } from "../src/server/activity/integrity";

const now = new Date("2026-11-09T00:00:00Z");
const clock = { now: () => now };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const tokenDeps = (db: Db) => ({ db, clock, random: systemRandom, hmacKey: new Uint8Array(32).fill(71) });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function beforeCompletion<T>(signal: Promise<T>, work: Promise<unknown>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([signal,
      work.then(() => { throw new Error(`${label}: operation ended before its expected checkpoint`); }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label}: checkpoint timed out`)), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function assertBlocked(db: Db, pid: number, label: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const row = (await db.query("SELECT cardinality(pg_blocking_pids($1::integer)) > 0 AS blocked", [pid])).rows[0];
    if (row?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`${label}: second PostgreSQL backend never waited on the expected lock`);
}

type Intercept = (text: string, values: unknown[] | undefined, run: () => ReturnType<Db["query"]>) => ReturnType<Db["query"]>;
function observed(db: Db, options: { intercept?: Intercept; pid?: (pid: number) => void }): Db {
  return {
    inTransaction: db.inTransaction,
    query: (text, values) => options.intercept ? options.intercept(text, values, () => db.query(text, values)) : db.query(text, values),
    async close() {},
    ...(db.transaction ? { transaction: <T>(fn: (tx: Db) => Promise<T>) => db.transaction!(async (tx) => {
      options.pid?.(Number((await tx.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid));
      return fn(observed(tx, { intercept: options.intercept }));
    }) } : {}),
  };
}

async function oauthChecks(runtime: Db) {
  const clientId = `local-security-${randomUUID()}`;
  const connections: string[] = [];
  await createClient(runtime, { clientId, registration: "cimd", redirectUris: ["https://synthetic.example/callback"] });
  const seed = async () => {
    const connectionId = randomUUID(); connections.push(connectionId);
    const code = randomUUID();
    await createAuthCode(runtime, { codeHash: hash(code), connectionId, clientId,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      redirectUri: "https://synthetic.example/callback", resource: "https://synthetic.example/mcp",
      expiresAt: new Date(now.getTime() + 60_000) });
    return { connectionId, params: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId,
      code, code_verifier: verifier, redirect_uri: "https://synthetic.example/callback" }) };
  };
  const refreshParams = (token: string) => new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: clientId });
  try {
    for (const grant of ["authorization_code", "refresh_token"] as const) {
      const fixture = await seed();
      let params = fixture.params;
      if (grant === "refresh_token") {
        const issued = await exchangeToken({ params }, tokenDeps(runtime));
        assert.ok(issued.ok);
        params = refreshParams(issued.body.refresh_token);
      }
      const snapshot = await runtime.query("SELECT token_hash, kind, expires_at FROM oauth_tokens WHERE connection_id = $1 ORDER BY token_hash", [fixture.connectionId]);
      const failing = observed(runtime, { intercept: async (text, values, run) => {
        if (/INSERT INTO oauth_tokens/.test(text) && values?.includes("refresh")) throw new Error("synthetic pair failure");
        return run();
      } });
      await assert.rejects(exchangeToken({ params }, tokenDeps(failing)), /synthetic pair failure/);
      assert.deepEqual((await runtime.query("SELECT token_hash, kind, expires_at FROM oauth_tokens WHERE connection_id = $1 ORDER BY token_hash", [fixture.connectionId])).rows, snapshot.rows);
      assert.ok((await exchangeToken({ params }, tokenDeps(runtime))).ok, `${grant}: failed pair leaves original credential usable`);
    }

    const fixture = await seed();
    const initial = await exchangeToken({ params: fixture.params }, tokenDeps(runtime));
    assert.ok(initial.ok);
    const paused = deferred<void>(), resume = deferred<void>(), secondPid = deferred<number>();
    const firstDb = observed(runtime, { intercept: async (text, _values, run) => {
      const result = await run();
      if (/UPDATE oauth_tokens SET expires_at/.test(text)) { paused.resolve(); await resume.promise; }
      return result;
    } });
    const refreshing = exchangeToken({ params: refreshParams(initial.body.refresh_token) }, tokenDeps(firstDb));
    let revoking: Promise<Response> | undefined;
    try {
      await beforeCompletion(paused.promise, refreshing, "refresh claim");
      revoking = createRevokeHandler({ db: observed(runtime, { pid: secondPid.resolve }) })(new Request("https://synthetic.example/oauth/revoke", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: initial.body.refresh_token }),
      }));
      const pid = await beforeCompletion(secondPid.promise, revoking, "revoke backend");
      await assertBlocked(runtime, pid, "revoke versus refresh");
      resume.resolve();
      await refreshing;
      assert.equal((await revoking).status, 200);
      assert.equal((await runtime.query("SELECT token_hash FROM oauth_tokens WHERE connection_id = $1", [fixture.connectionId])).rows.length, 0);
    } finally { resume.resolve(); await Promise.allSettled([refreshing, revoking]); }
  } finally {
    for (const id of connections) {
      await runtime.query("DELETE FROM oauth_tokens WHERE connection_id = $1", [id]);
      await runtime.query("DELETE FROM oauth_auth_codes WHERE connection_id = $1", [id]);
    }
    await runtime.query("DELETE FROM oauth_clients WHERE client_id = $1", [clientId]);
  }
}

async function registrationCheck(runtime: Db) {
  const ids = [`local-dcr-${randomUUID()}`, `local-dcr-${randomUUID()}`];
  const since = new Date(now.getTime() - 60_000);
  const existing = Number((await runtime.query("SELECT count(*) AS count FROM oauth_clients WHERE registration = 'dcr' AND created_at > $1", [since.toISOString()])).rows[0]?.count);
  const cap = { since, createdAt: now, max: existing + 1 };
  const client = (clientId: string) => ({ clientId, registration: "dcr" as const, redirectUris: ["https://synthetic.example/callback"] });
  const paused = deferred<void>(), resume = deferred<void>(), secondPid = deferred<number>();
  const first = createClientWithinCap(observed(runtime, { intercept: async (text, _values, run) => {
    const result = await run();
    if (/INSERT INTO oauth_clients/.test(text)) { paused.resolve(); await resume.promise; }
    return result;
  } }), client(ids[0]!), cap);
  let second: ReturnType<typeof createClientWithinCap> | undefined;
  try {
    await beforeCompletion(paused.promise, first, "DCR insertion");
    second = createClientWithinCap(observed(runtime, { pid: secondPid.resolve }), client(ids[1]!), cap);
    const pid = await beforeCompletion(secondPid.promise, second, "DCR backend");
    await assertBlocked(runtime, pid, "DCR final slot");
    resume.resolve();
    assert.ok(await first);
    assert.equal(await second, null);
    assert.equal((await runtime.query("SELECT client_id FROM oauth_clients WHERE client_id IN ($1, $2)", ids)).rows.length, 1);
  } finally {
    resume.resolve(); await Promise.allSettled([first, second]);
    await runtime.query("DELETE FROM oauth_clients WHERE client_id IN ($1, $2)", ids);
  }
}

async function sessionCheck(runtime: Db, purge: Db) {
  const user = await createUser(runtime, { email: `local-session-${randomUUID()}@example.test`, wrappedDek: "synthetic-only" });
  const previous = await createSession(runtime, user.id, { clock, random: systemRandom });
  const paused = deferred<void>(), resume = deferred<void>(), secondPid = deferred<number>();
  const deleting = withTransaction(runtime, async (tx) => {
    await tx.query("SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE", [user.id]);
    await tx.query("UPDATE users SET wrapped_dek = '' WHERE id = $1", [user.id]);
    await tx.query("DELETE FROM sessions WHERE user_id = $1", [user.id]);
    paused.resolve(); await resume.promise;
  });
  let signingIn: Promise<unknown> | undefined;
  try {
    await beforeCompletion(paused.promise, deleting, "account deletion");
    signingIn = withTransaction(runtime, async (tx) => {
      secondPid.resolve(Number((await tx.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid));
      return createSession(tx, user.id, { clock, random: systemRandom });
    });
    void signingIn.catch(() => {});
    const pid = await beforeCompletion(secondPid.promise, signingIn, "sign-in backend");
    await assertBlocked(runtime, pid, "session creation versus deletion");
    resume.resolve(); await deleting;
    await assert.rejects(signingIn, (error: unknown) => typeof error === "object" && error !== null && "status" in error && error.status === 401);
    assert.equal((await runtime.query("SELECT id FROM sessions WHERE user_id = $1", [user.id])).rows.length, 0);
    assert.equal(await verifySession(runtime, previous.token, { clock }), null);
  } finally {
    resume.resolve(); await Promise.allSettled([deleting, signingIn]);
    await purge.query("DELETE FROM users WHERE id = $1", [user.id]);
  }
}

async function activityChecks(runtime: Db, purge: Db) {
  for (const rollback of [false, true]) {
    const user = await createUser(runtime, { email: `local-activity-${randomUUID()}@example.test`, wrappedDek: "synthetic-only" });
    const dek = systemRandom.randomBytes(32);
    const recorder = (db: Db) => createDbRecorder({ db, clock, dekFor: async () => dek });
    const paused = deferred<void>(), resume = deferred<void>(), secondPid = deferred<number>();
    const first = withTransaction(runtime, async (tx) => {
      await recorder(tx).record({ userId: user.id, kind: "connection_change", source: "warthog", payload: { first: true } });
      paused.resolve(); await resume.promise;
      if (rollback) throw new Error("synthetic activity rollback");
    });
    void first.catch(() => {});
    let second: ReturnType<ReturnType<typeof createDbRecorder>["record"]> | undefined;
    try {
      await beforeCompletion(paused.promise, first, "activity append in transaction");
      second = recorder(observed(runtime, { pid: secondPid.resolve })).record({ userId: user.id,
        kind: "tool_call", source: "warthog", payload: { second: true } });
      const pid = await beforeCompletion(secondPid.promise, second, "activity outside backend");
      await assertBlocked(runtime, pid, "activity chain transaction");
      resume.resolve();
      if (rollback) await assert.rejects(first, /synthetic activity rollback/);
      else await first;
      const entry = await second;
      const count = rollback ? 1 : 2;
      assert.equal(entry.seq, count);
      assert.deepEqual(await checkIntegrity(runtime, user.id), { intact: true, checked: count, brokenSeq: null });
      const entries = await readActivity(runtime, user.id, dek);
      assert.equal(entries.length, count);
      assert.deepEqual(entries.at(-1)?.payload, { second: true });
    } finally {
      resume.resolve(); await Promise.allSettled([first, second]);
      await purge.query("DELETE FROM users WHERE id = $1", [user.id]);
      dek.fill(0);
    }
  }
}

export async function verifyPostgresSecurityContention(runtime: Db, purge: Db): Promise<void> {
  if (process.platform !== "linux" || process.env.WARTHOG_LOCAL_PG_CHECK !== "1") throw new Error("Local Compose check required");
  assert.equal((await runtime.query("SHOW cluster_name")).rows[0]?.cluster_name, "warthog-local-certification");
  await oauthChecks(runtime);
  await registrationCheck(runtime);
  await sessionCheck(runtime, purge);
  await activityChecks(runtime, purge);
  console.log("PostgreSQL security contention: OAuth rollback/revocation, DCR final-slot capacity, session/deletion and activity-chain locks passed.");
}
