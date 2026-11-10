// E11-S10 — Approval release endpoint: the injectable sibling handler
// (`src/app/api/approvals/[id]/release/handler.ts`), the server half of a release
// (design §4.2 "Release" + the in-memory release store; §4.3 the released-value
// fingerprint; §5 step-up; brief "release — one-time hand-over of a high-tier value or
// card"). INV-101 admin-auth-required, INV-102 validate-and-parameterize-input,
// INV-103 secrets-from-env.
//
// RED-first: the sibling factory `./handler` (`createReleaseHandler`) does not exist
// yet, so importing it throws and EVERY test here fails until the builder writes the
// module. That absence IS the point of test-first — as the TESTER I must NOT create or
// edit any implementation/source file to make these pass; the builder writes
// `handler.ts` (and the thin `route.ts`) afterwards, to this contract.
//
// WHY this exists (task E11-S10): on approval, after a fresh step-up, the browser
// decrypts the high-tier value / card detail with the vault key (E11-S07..S09) and POSTs
// the PLAINTEXT to `/api/approvals/[id]/release`. This endpoint is the server half: it
//   1. requires an authenticated session (INV-101) AND a step-up within the last 5
//      minutes (design §5) — otherwise it releases nothing;
//   2. accepts the value only for an APPROVED approval OWNED BY THE SESSION USER;
//   3. places the value in the in-memory release store (TTL 5 min, single collection)
//      under the key the agent's `collect_release` will read it with; and
//   4. records a keyed one-way HMAC FINGERPRINT of the value (kept 90 days) — and NEVER
//      writes the value itself to the database, a log or a metric.
//
// These tests pin BEHAVIOUR (the HTTP outcome, what lands in the release store, and the
// persisted fingerprint — observed through the ALREADY-BUILT seams), never the source
// text of any module — a later behaviour-preserving rename must not redden them. State is
// arranged through the real repos (`createUser`, `createApproval` + `decide`, a real
// `KeyWrapper`) against an isolated in-memory PGlite (src/test/db). The release store is a
// real `createReleaseStore`, and the KEY a release is collected with is the SHARED
// one-source-of-truth `releaseKeyFor` the collector (`collect_release`, E07-S15) uses —
// so "collectable by the agent" is proven against the real key scheme, not a guess. Tests
// never touch the network or Azure; every db handle is closed in a `finally`.
//
// ───────────────────────────────────────────────────────────────────────────────────
// THE PINNED CONTRACT (chosen by the tester; the implementation conforms to it).
//
//   import type { Session } from "../../../../../server/auth/session";
//   import type { Db } from "../../../../../server/db/index";
//   import type { Clock } from "../../../../../server/seams/clock";
//   import type { ReleaseStore } from "../../../../../server/crypto/release-store";
//   import type { KeyWrapper } from "../../../../../server/crypto/key-wrapper";
//
//   interface ReleaseSeams {                               // every seam optional, with a
//     resolveSession?: (request: Request) => Promise<Session | null>; // production default
//     db?:            Db;            // the shared database (every query parameter-bound)
//     clock?:         Clock;         // judges step-up freshness + the 90-day fingerprint window
//     releaseStore?:  ReleaseStore;  // the process-wide in-memory store the value is put into
//     keyWrapper?:    KeyWrapper;    // unwraps the person's DEK to fingerprint the value
//   }
//
//   // route.ts exports ONLY POST (OBS-025, pinned in the sibling route.test.ts). The
//   // factory may return `{ POST(request, id) }` OR the bare `(request, id) => Response`;
//   // these tests accept either (see callPost), pinning the HTTP behaviour, not the shape.
//   createReleaseHandler(seams?: ReleaseSeams): { POST(request: Request, id: string): Promise<Response> }
//
//     POST (the browser posts `{ value }`; the approval id rides in the path, never the body):
//       1. Resolve the session (`resolveSession`). No session → 401 OR a redirect to
//          sign-in, before anything else (INV-101). Identity is the session's user id,
//          never a client value.
//       2. Require a step-up within the last 5 minutes (`requireStepUp` over the session's
//          `steppedUpAt` + the clock). No / stale step-up → a 4xx, nothing released.
//       3. Shape-guard the id: a value that is not a well-formed approval id (uuid) is a
//          4xx BEFORE `WHERE id = $1`, never a raw uuid cast / 500 (OBS-049, INV-102).
//       4. Load the approval MEMBER-SCOPED by the session user; it must be `approved`
//          and owned by that user — else a 4xx, nothing released (another user's approval
//          can never be released).
//       5. Validate the body (`{ value }`): malformed / oversized / mis-shaped → a 4xx
//          (never a 500, INV-102), before any store/db write.
//       6. Put the value in the release store under `releaseKeyFor` for the approval's
//          agent connection, and persist `fingerprint(dek, value)` for 90 days — the
//          value itself is never written to the db, a log or a metric.
//
// The obligation acceptance criteria (admin-auth-required, validate-and-parameterize-
// input, secrets-from-env) are pinned below alongside the behaviour, as the repo's route
// tests do (connect/callback). The entry's export shape is pinned in `route.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createReleaseHandler } from "./handler";

import { createUser } from "../../../../../server/db/users";
import { createAgent } from "../../../../../server/db/agents";
import { upsertPermissions } from "../../../../../server/db/agent-permissions";
import { listReleasesForConnectionPeriod, periodKeyFor, recordRelease } from "../../../../../server/db/card-spend-ledger";
import { savePreferences } from "../../../../../server/db/preferences";
import { createCollectReleaseTool } from "../../../../../server/mcp/tools/collect-release";
import { readActivity } from "../../../../../server/activity/writer";
import { createApproval, decide, getApproval } from "../../../../../server/db/approvals";
import { lookupForUser } from "../../../../../server/db/release-fingerprints";
import { fingerprint } from "../../../../../server/crypto/hmac";
import { createReleaseStore, type ReleaseStore } from "../../../../../server/crypto/release-store";
import { localAesKeyWrapper, type KeyWrapper } from "../../../../../server/crypto/key-wrapper";
import {
  createSession,
  verifySession,
  recordStepUp,
  COOKIE_NAME,
  type Session,
} from "../../../../../server/auth/session";
import { releaseKeyFor } from "../../../../../server/mcp/tools/collect-release";
import { fixedClock, type Clock } from "../../../../../server/seams/clock";
import { systemRandom } from "../../../../../server/seams/random";
import { freshDb } from "../../../../../test/db";
import { withTransaction, type Db } from "../../../../../server/db/index";
import type { AgentConnection } from "../../../../../server/mcp/context";
import { createHousehold, addMember, setMemberLimit, setHouseholdBudget } from "../../../../../server/db/households";
import { upsertRate } from "../../../../../server/db/exchange-rates";

// --- fixtures -----------------------------------------------------------------------

const DEK_BYTES = 32; // a 256-bit per-person data key
const KEK_BYTES = 32; // the local AES-256 key-encryption key for the KeyWrapper seam

// A frozen instant everything reads time through: the session, the step-up, the release
// store's TTL and the 90-day fingerprint window all anchor here, so freshness is
// deterministic with no wall-clock dependence.
const T0 = new Date("2026-11-15T12:00:00.000Z");
const CLOCK: Clock = fixedClock(T0);

const MINUTE_MS = 60 * 1000;

// The configured public origin every release POST's Origin header is checked against.
const PUBLIC_ORIGIN = "https://warthog.com.au";
const STEP_UP_WINDOW_MS = 5 * MINUTE_MS; // design §5: a step-up is fresh for 5 minutes
const DAY_MS = 24 * 60 * MINUTE_MS;

for (const hasRate of [true, false]) {
  test(`release refuses earlier foreign-currency spending ${hasRate ? "over budget after conversion" : "without a reference rate"}`, async () => {
    const db = await freshDb();
    try {
      const keyWrapper = keyWrapperFor();
      const person = await makePerson(db, "historic-currency-" + hasRate, keyWrapper);
      const agentId = await makeAgentFor(db, person.userId, { budget: 100 });
      await recordRelease(db, { userId: person.userId, connectionId: connectionOfAgent.get(agentId)!, householdId: null,
        amount: 60, currency: "USD", merchant: "Synthetic earlier release",
        periodKeys: { day: periodKeyFor("day", T0), week: periodKeyFor("week", T0), month: periodKeyFor("month", T0) } });
      if (hasRate) await upsertRate(db, { rateDate: "2026-11-14", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.5 });
      const id = await makePendingApproval(db, { ...person, agentId, detail: { ...CARD_DETAIL, amount: 20 } });
      const made = makeHandler({ db, keyWrapper, session: sessionFor(person.userId, T0) });
      const response = await callPost(made.handler, releaseRequest(id, { value: "synthetic-release" }), id);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, hasRate ? "over_budget" : "agent_rate_unavailable");
      assert.equal(made.store.size(), 0);
      assert.equal((await getApproval(db, person.userId, id, person.dek))!.status, "pending");
    } finally { await db.close(); }
  });
}

for (const cap of ["member", "household"] as const) {
  test(`release rechecks the ${cap} cap across approvals made before either is collected`, async () => {
    const db = await freshDb();
    try {
      const keyWrapper = keyWrapperFor();
      const owner = await makePerson(db, `cap-owner-${cap}`, keyWrapper);
      const other = await makePerson(db, `cap-member-${cap}`, keyWrapper);
      const household = await createHousehold(db, { ownerId: owner.userId, currency: "AUD", monthlyBudget: 1000 });
      await addMember(db, { householdId: household.id, userId: other.userId });
      const firstPerson = cap === "household" ? owner : other;
      const firstAgent = await makeAgentFor(db, firstPerson.userId);
      const secondAgent = await makeAgentFor(db, other.userId);
      const first = await makePendingApproval(db, { ...firstPerson, agentId: firstAgent, detail: CARD_DETAIL });
      const second = await makePendingApproval(db, { ...other, agentId: secondAgent, detail: CARD_DETAIL });
      if (cap === "member") await setMemberLimit(db, { householdId: household.id, actorId: owner.userId, userId: other.userId, monthlyLimit: 200 });
      else await setHouseholdBudget(db, { householdId: household.id, actorId: owner.userId, monthlyBudget: 200 });
      const a = makeHandler({ db, keyWrapper, session: sessionFor(firstPerson.userId, T0) });
      const b = makeHandler({ db, keyWrapper, session: sessionFor(other.userId, T0) });
      assert2xx(await callPost(a.handler, releaseRequest(first, { value: "synthetic-one" }), first));
      const refused = await callPost(b.handler, releaseRequest(second, { value: "synthetic-two" }), second);
      assert.equal(refused.status, 409);
      assert.equal((await refused.json()).error, cap === "member" ? "over_member_budget" : "over_household_budget");
      assert.equal(b.store.size(), 0);
      assert.equal((await getApproval(db, other.userId, second, other.dek))!.status, "pending");
      assert.equal((await listReleasesForConnectionPeriod(db, other.userId, connectionOfAgent.get(secondAgent)!, "month", periodKeyFor("month", T0))).length, 0);
    } finally { await db.close(); }
  });
}

for (const hasRate of [true, false]) {
  test(`release refuses mixed-currency household overspend with ${hasRate ? "a reference rate" : "a missing reference rate"}`, async () => {
    const db = await freshDb();
    try {
      const keyWrapper = keyWrapperFor();
      const person = await makePerson(db, `mixed-${hasRate}`, keyWrapper);
      const household = await createHousehold(db, { ownerId: person.userId, currency: "AUD", monthlyBudget: 200 });
      const agentId = await makeAgentFor(db, person.userId);
      await recordRelease(db, { userId: person.userId, connectionId: randomUUID(), householdId: household.id, amount: 100, currency: "USD", merchant: "synthetic", periodKeys: { day: periodKeyFor("day", T0), week: periodKeyFor("week", T0), month: periodKeyFor("month", T0) } });
      if (hasRate) await upsertRate(db, { rateDate: "2026-11-14", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.5 });
      const approvalId = await makePendingApproval(db, { ...person, agentId, detail: { ...CARD_DETAIL, amount: 75 } });
      const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(person.userId, T0) });
      const response = await callPost(handler, releaseRequest(approvalId, { value: "synthetic-value" }), approvalId);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, hasRate ? "over_household_budget" : "household_rate_unavailable");
      assert.equal(store.size(), 0);
      assert.equal((await getApproval(db, person.userId, approvalId, person.dek))!.releasedAt, undefined);
    } finally { await db.close(); }
  });
}

test("household recheck uses the ledger's month when the transaction crosses month-end", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const person = await makePerson(db, "month-end", keyWrapper);
    const agentId = await makeAgentFor(db, person.userId);
    const household = await createHousehold(db, { ownerId: person.userId, currency: "AUD", monthlyBudget: 200 });
    const before = new Date("2026-11-30T23:59:59Z"); // Shared month ends at UTC midnight.
    let instant = before;
    const clock = { now: () => instant };
    const approvalId = await makePendingApproval(db, { ...person, agentId, detail: CARD_DETAIL, clock });
    await recordRelease(db, { userId: person.userId, connectionId: randomUUID(), householdId: household.id,
      amount: 150, currency: "AUD", merchant: "synthetic-only",
      periodKeys: { day: periodKeyFor("day", before), week: periodKeyFor("week", before), month: periodKeyFor("month", before) } },
      { householdPeriodMonth: periodKeyFor("month", before, "UTC") });
    const movingDb: Db = { ...db, async transaction(fn) {
      instant = new Date("2026-12-01T00:00:01Z");
      return withTransaction(db, fn);
    } };
    const { handler, store } = makeHandler({ db: movingDb, keyWrapper, clock, session: sessionFor(person.userId, before) });
    const response = await callPost(handler, releaseRequest(approvalId, { value: "synthetic-value" }), approvalId);
    assert.equal(instant.toISOString(), "2026-12-01T00:00:01.000Z", "the transaction actually crosses the shared month boundary");
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "over_household_budget" });
    assert.equal(store.size(), 0);
    assert.equal((await getApproval(db, person.userId, approvalId, person.dek))!.releasedAt, undefined);
  } finally { await db.close(); }
});

for (const change of ["permission", "connection", "budget"] as const) {
  test(`release honours a ${change} change after the preliminary read`, async () => {
    const db = await freshDb();
    try {
      const keyWrapper = keyWrapperFor();
      const person = await makePerson(db, `changed-${change}`, keyWrapper);
      const agentId = await makeAgentFor(db, person.userId);
      const connectionId = connectionOfAgent.get(agentId)!;
      const approvalId = await makePendingApproval(db, { ...person, agentId, detail: CARD_DETAIL });
      let changed = false;
      // Emulate a settings/disconnect operation completing after preliminary reads
      // but before the release transaction. PGlite itself cannot run two sessions.
      const changingDb: Db = { ...db, async transaction(fn) {
        if (!changed) {
          changed = true;
          if (change === "connection") await db.query("UPDATE agents SET status = 'disconnected' WHERE id = $1 AND user_id = $2", [agentId, person.userId]);
          else if (change === "permission") await db.query("UPDATE agent_permissions SET card_access = false WHERE user_id = $1 AND connection_id = $2", [person.userId, connectionId]);
          else await db.query("UPDATE agent_permissions SET card_budget = $3::jsonb WHERE user_id = $1 AND connection_id = $2", [person.userId, connectionId, JSON.stringify({ amount: 100, currency: "AUD", period: "month" })]);
        }
        return withTransaction(db, fn);
      } };
      const { handler, store } = makeHandler({ db: changingDb, keyWrapper, session: sessionFor(person.userId, T0) });
      const response = await callPost(handler, releaseRequest(approvalId, { value: "synthetic-value" }), approvalId);
      assert.equal(changed, true);
      assert.equal(response.status, change === "budget" ? 409 : 403);
      assert.deepEqual(await response.json(), { error: change === "budget" ? "over_budget" : "not_releasable" });
      assert.equal(store.size(), 0);
      assert.equal((await getApproval(db, person.userId, approvalId, person.dek))!.releasedAt, undefined);
      assert.equal((await listReleasesForConnectionPeriod(db, person.userId, connectionId, "month", periodKeyFor("month", T0))).length, 0);
    } finally { await db.close(); }
  });
}

// A unique tag so accounts never collide on the users.email UNIQUE across tests.
function tag(): string {
  return Math.random().toString(36).slice(2);
}

function keyWrapperFor(): KeyWrapper {
  return localAesKeyWrapper(randomBytes(KEK_BYTES));
}

// Create a person whose wrapped DEK really unwraps under `keyWrapper`, returning their id
// and the raw DEK the approval detail is encrypted under (and the fingerprint is keyed by).
async function makePerson(
  db: Db,
  who: string,
  keyWrapper: KeyWrapper,
): Promise<{ userId: string; dek: Uint8Array }> {
  const dek = randomBytes(DEK_BYTES);
  const wrappedDek = await keyWrapper.wrap(dek);
  const user = await createUser(db, { email: `${who}-${tag()}@warthog.com.au`, wrappedDek });
  return { userId: user.id, dek };
}

// Each agent's connection id, by agent row id. A real agent's row id (what approvals
// are keyed by) is DISTINCT from its connection id (what the agent's collect_release
// reads under) — the production two-id model the release key must bridge.
const connectionOfAgent = new Map<string, string>();

// Connect a REAL agent for `userId` (a fresh, distinct connection id) and return its row
// id — the id the pipeline stores on the approvals it asks for.
// Its connection may request high-tier details and use a card on an A$500/month budget
// (a test overrides the budget it is about).
async function makeAgentFor(
  db: Db,
  userId: string,
  opts: { status?: "connected" | "disconnected"; budget?: number; highTierAccess?: boolean } = {},
): Promise<string> {
  const agent = await createAgent(
    db,
    { userId, connectionId: randomUUID(), displayName: "Claude", platform: "claude", status: opts.status },
    CLOCK,
  );
  connectionOfAgent.set(agent.id, agent.connectionId);
  await upsertPermissions(db, {
    userId,
    connectionId: agent.connectionId,
    grantedConnectors: [],
    readTools: true,
    changeTools: "ask_first",
    identityAccess: true,
    highTierAccess: opts.highTierAccess ?? true,
    cardAccess: true,
    cardBudget: { amount: opts.budget ?? 500, currency: "AUD", period: "month" },
    skillsScope: [],
    memoryRead: false,
    sharing: false,
    rulesScope: [],
    rateLimit: 120,
  });
  return agent.id;
}

// The detail the pipeline stores for a high-tier identity request (a RELEASE).
const HIGH_TIER_DETAIL = { tool: "request_identity_detail", request: "high_tier", field: "passport" };

// Arrange an APPROVED release approval owned by `userId`, requested by agent `agentId`:
// create it PENDING (real repo + envelope-encrypted detail) then move it to `approved`
// via the real `decide`. Returns the approval id.
async function makeApprovedApproval(
  db: Db,
  opts: { userId: string; agentId: string; dek: Uint8Array; clock?: Clock; detail?: Record<string, unknown> },
): Promise<string> {
  const clock = opts.clock ?? CLOCK;
  const created = await createApproval(
    db,
    { userId: opts.userId, agentId: opts.agentId, detail: opts.detail ?? HIGH_TIER_DETAIL },
    opts.dek,
    clock,
  );
  await decide(db, { userId: opts.userId, id: created.id, decision: { status: "approved" } }, opts.dek, clock);
  return created.id;
}

// Arrange a PENDING (not yet approved) release approval owned by `userId`. Returns its id.
async function makePendingApproval(
  db: Db,
  opts: { userId: string; agentId: string; dek: Uint8Array; clock?: Clock; detail?: Record<string, unknown> },
): Promise<string> {
  const created = await createApproval(
    db,
    { userId: opts.userId, agentId: opts.agentId, detail: opts.detail ?? HIGH_TIER_DETAIL },
    opts.dek,
    opts.clock ?? CLOCK,
  );
  return created.id;
}

// A plain session for `userId` with a chosen step-up instant — identity the endpoint must
// trust over any client value, and the `steppedUpAt` the step-up freshness check reads.
function sessionFor(userId: string, steppedUpAt: Date | null): Session {
  return { id: `sess-${userId}-${tag()}`, userId, createdAt: T0, lastSeenAt: T0, steppedUpAt };
}

// The release-store KEY the requesting agent's connection reads this approval's value
// with: the SAME `releaseKeyFor` the collector (`collect_release`) uses, over the
// agent's REAL connection (its connection id, not its row id) — the real cross-task
// contract, so "collectable by the agent" is proven, not guessed.
function keyForApproval(userId: string, agentId: string, approvalId: string): string {
  const connectionId = connectionOfAgent.get(agentId) ?? agentId;
  const connection: AgentConnection = { userId, connectionId, agentId, active: true };
  return releaseKeyFor(connection, approvalId);
}

// Read one cookie's value out of a request's Cookie header (the real resolver's job).
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header == null) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

// The REAL session resolver: read the `__Host-wh_session` cookie and verify it server-side
// over `db` (never trusting any other client value — INV-101). Used to prove a genuinely
// verified + stepped-up session is admitted and an unverifiable cookie is refused.
function realResolveSession(db: Db, clock: Clock) {
  return async (request: Request): Promise<Session | null> => {
    const token = readCookie(request, COOKIE_NAME);
    return token ? verifySession(db, token, { clock }) : null;
  };
}

// A POST to the release endpoint. The approval id rides in the path; the value rides in the
// JSON body. `rawBody` sends a verbatim string (for malformed JSON); `body` JSON-encodes an
// arbitrary shape; otherwise `{ value }` is sent. A session cookie is attached when given.
function releaseRequest(
  id: string,
  opts: { value?: unknown; body?: unknown; rawBody?: string; cookie?: string } = {},
): Request {
  const url = `https://warthog.com.au/api/approvals/${encodeURIComponent(id)}/release`;
  // The browser's same-origin post carries the app's own Origin (design §5).
  const headers: Record<string, string> = { "content-type": "application/json", origin: PUBLIC_ORIGIN };
  if (opts.cookie !== undefined) headers.cookie = `${COOKIE_NAME}=${opts.cookie}`;
  let payload: string;
  if (opts.rawBody !== undefined) payload = opts.rawBody;
  else if (opts.body !== undefined) payload = JSON.stringify(opts.body);
  else payload = JSON.stringify({ value: opts.value });
  return new Request(url, { method: "POST", headers, body: payload });
}

// Invoke the handler's POST, tolerant of EITHER factory return shape this repo uses: a
// single-verb factory may return the bare `(request, id) => Response` (as
// `createConnectCallbackHandler`'s sibling-style allows) or an object exposing
// `{ POST }` (as `createMcpRouteHandler` does). Both are valid ways for `route.ts` to
// export only its POST verb (OBS-025), so these tests pin the HTTP behaviour, not the shape.
function callPost(handler: unknown, request: Request, id: string): Promise<Response> {
  const fn =
    typeof handler === "function"
      ? (handler as (r: Request, id: string) => Promise<Response>)
      : (handler as { POST?: (r: Request, id: string) => Promise<Response> }).POST;
  if (typeof fn !== "function") {
    throw new Error("the release factory exposes no POST handler");
  }
  return fn(request, id);
}

// Build the handler under test from injected seams. `session` becomes the resolved session
// (or pass `resolveSession` for the real cookie→verifySession path). The release store
// defaults to a real store on the same clock, so the value's TTL is judged deterministically.
function makeHandler(opts: {
  db: Db;
  keyWrapper: KeyWrapper;
  session?: Session | null;
  resolveSession?: (request: Request) => Promise<Session | null>;
  clock?: Clock;
  releaseStore?: ReleaseStore;
}): { handler: unknown; store: ReleaseStore; clock: Clock } {
  const clock = opts.clock ?? CLOCK;
  const store = opts.releaseStore ?? createReleaseStore(clock);
  const resolveSession =
    opts.resolveSession ?? (async () => (opts.session === undefined ? null : opts.session));
  const handler = createReleaseHandler({
    db: opts.db,
    clock,
    releaseStore: store,
    keyWrapper: opts.keyWrapper,
    resolveSession,
    publicOrigin: PUBLIC_ORIGIN,
  });
  return { handler, store, clock };
}

// Redirect every console channel into an array for the duration of a call, so a test can
// assert the released value was never written to logs/metrics. Restores on teardown.
function captureConsole(): { lines: string[]; restore: () => void } {
  const methods = ["log", "info", "warn", "error", "debug", "trace"];
  const sink = console as unknown as Record<string, (...args: unknown[]) => void>;
  const originals = new Map<string, ((...args: unknown[]) => void) | undefined>();
  const lines: string[] = [];
  for (const m of methods) {
    originals.set(m, sink[m]);
    sink[m] = (...args: unknown[]): void => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
  return {
    lines,
    restore(): void {
      for (const m of methods) {
        const original = originals.get(m);
        if (original) sink[m] = original;
      }
    },
  };
}

// Whether a relation of this exact name exists — a non-throwing probe for survival tests.
async function tableExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query("SELECT to_regclass($1) AS t", [name]);
  return result.rows[0]?.t != null;
}

// Flatten a response (status + headers + body) to a string, so a test can assert an
// ambient secret never appears anywhere in it.
async function serialiseResponse(res: Response): Promise<string> {
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}:${v}`).join(" ");
  let body = "";
  try {
    body = await res.clone().text();
  } catch {
    body = "";
  }
  return `${res.status} ${headers} ${body}`;
}

function assert2xx(res: Response): void {
  assert.ok(res.status >= 200 && res.status < 300, `expected a 2xx success, got ${res.status}`);
}

function assert4xx(res: Response): void {
  assert.ok(res.status >= 400 && res.status < 500, `expected a 4xx (never a 5xx), got ${res.status}`);
}

// An unauthenticated request is refused with 401 OR a redirect to sign-in — never a success.
function assertUnauthenticated(res: Response): void {
  if (res.status === 401) return;
  const loc = res.headers.get("location");
  assert.ok(
    res.status >= 300 && res.status < 400 && loc != null && /sign-?in/i.test(loc),
    `an unauthenticated release must be 401 or a redirect to sign-in, got ${res.status} (location: ${loc ?? "none"})`,
  );
}

// =====================================================================================
// AC1 — an approved approval for the session user WITH a fresh step-up releases the value
// (into the store) and writes its fingerprint; WITHOUT a recent step-up it releases nothing.
// =====================================================================================

test("AC1: an approved approval for the session user with a fresh step-up stores the value and writes its HMAC fingerprint", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-ok", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // A unique canary with characters outside hex, so any later appearance in the db or a
    // log could only be the raw value leaking.
    const VALUE = `passport ∂ ${randomUUID()} 42!!`;
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });

    const res = await callPost(handler, releaseRequest(approvalId, { value: VALUE }), approvalId);
    assert2xx(res);

    // The value is held in the in-memory release store, collectable under the SAME key
    // the agent's `collect_release` reads (and nowhere else).
    assert.equal(
      store.collect(keyForApproval(userId, agentId, approvalId)),
      VALUE,
      "the decrypted value is placed in the release store for the agent's single collection",
    );

    // A keyed one-way fingerprint of the value is persisted — the value never is.
    const fps = await lookupForUser(db, userId, CLOCK);
    assert.ok(
      fps.includes(fingerprint(dek, VALUE)),
      "the keyed HMAC fingerprint of the released value is persisted",
    );
  } finally {
    await db.close();
  }
});

test("AC1: a post without a recent step-up is rejected and releases nothing", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-nostepup", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // Signed in, but the session has NEVER stepped up (steppedUpAt === null).
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, null) });

    const res = await callPost(handler, releaseRequest(approvalId, { value: `v-${randomUUID()}` }), approvalId);
    assert4xx(res);

    assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), undefined, "no value is placed in the release store");
    assert.deepEqual(await lookupForUser(db, userId, CLOCK), [], "no fingerprint is persisted without a step-up");
  } finally {
    await db.close();
  }
});

test("AC1: a step-up older than five minutes is rejected and releases nothing", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-stalestepup", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // Stepped up six minutes ago — just past the 5-minute window at the clock (T0).
    const stale = new Date(T0.getTime() - (STEP_UP_WINDOW_MS + MINUTE_MS));
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, stale) });

    const res = await callPost(handler, releaseRequest(approvalId, { value: `v-${randomUUID()}` }), approvalId);
    assert4xx(res);

    assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), undefined, "a stale step-up releases nothing");
    assert.deepEqual(await lookupForUser(db, userId, CLOCK), [], "and writes no fingerprint");
  } finally {
    await db.close();
  }
});

test("AC1: a genuinely verified session that recorded a step-up is admitted (real cookie → verifySession → requireStepUp)", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-real-ok", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // A real session that then records a step-up at the clock — the whole chain exercised.
    const { token, session } = await createSession(db, userId, { clock: CLOCK, random: systemRandom });
    await recordStepUp(db, session.id, { clock: CLOCK });

    const VALUE = `real-${randomUUID()}`;
    const { handler, store } = makeHandler({ db, keyWrapper, resolveSession: realResolveSession(db, CLOCK) });

    const res = await callPost(handler, releaseRequest(approvalId, { value: VALUE, cookie: token }), approvalId);
    assert2xx(res);
    assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), VALUE, "the value is released for the agent's collection");
  } finally {
    await db.close();
  }
});

test("AC1: a genuinely verified session with NO step-up is rejected (a signed-in session is not enough)", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-real-nostepup", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // A real session, but it never stepped up.
    const { token } = await createSession(db, userId, { clock: CLOCK, random: systemRandom });

    const { handler, store } = makeHandler({ db, keyWrapper, resolveSession: realResolveSession(db, CLOCK) });
    const res = await callPost(handler, releaseRequest(approvalId, { value: `v-${randomUUID()}`, cookie: token }), approvalId);
    assert4xx(res);
    assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), undefined, "a signed-in-but-not-stepped-up session releases nothing");
  } finally {
    await db.close();
  }
});

// Review fix C7 — "Approve and release" is ONE step: the person approves a pending
// release on their device by releasing it (after a fresh step-up), so the endpoint
// approves the pending approval and releases the value together. A denied, expired or
// more-detail approval is never releasable.
test("AC1: a PENDING release approval is approved and released in one step with a fresh step-up", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-pending", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makePendingApproval(db, { userId, agentId, dek });

    const VALUE = `one-step-${randomUUID()}`;
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
    const res = await callPost(handler, releaseRequest(approvalId, { value: VALUE }), approvalId);
    assert2xx(res);

    assert.equal((await getApproval(db, userId, approvalId, dek))!.status, "approved", "the approval is now approved");
    assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), VALUE, "and the value is released for the agent");
  } finally {
    await db.close();
  }
});

test("AC1: a denied, expired or more-detail approval is never releasable", async () => {
  for (const decision of [
    { status: "denied" as const },
    { status: "more_detail" as const, question: "Which passport?" },
    { status: "expired" as const },
  ]) {
    const db = await freshDb();
    try {
      const keyWrapper = keyWrapperFor();
      const { userId, dek } = await makePerson(db, `release-${decision.status}`, keyWrapper);
      const agentId = await makeAgentFor(db, userId);
      const approvalId = await makePendingApproval(db, { userId, agentId, dek });
      // Expiry needs the window to have passed; the other decisions land at T0.
      const at = decision.status === "expired" ? fixedClock(new Date(T0.getTime() + 20 * MINUTE_MS)) : CLOCK;
      await decide(db, { userId, id: approvalId, decision }, dek, at);

      const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
      const res = await callPost(handler, releaseRequest(approvalId, { value: `v-${randomUUID()}` }), approvalId);
      assert4xx(res);
      assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), undefined, `${decision.status}: nothing is released`);
      assert.deepEqual(await lookupForUser(db, userId, CLOCK), [], `${decision.status}: no fingerprint is written`);
    } finally {
      await db.close();
    }
  }
});

// =====================================================================================
// AC2 — the value is never written to the database, a log or a metric; only its
// fingerprint is persisted, and for 90 days.
// =====================================================================================

test("AC2: the released value is never written to the database — only its one-way fingerprint is persisted", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-nodb", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    const VALUE = `tax-file ∂ ${randomUUID()} !!`;
    const { handler } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
    assert2xx(await callPost(handler, releaseRequest(approvalId, { value: VALUE }), approvalId));

    // Scope the absence check narrowly to the ONE table this endpoint writes to.
    const rows = (await db.query("SELECT * FROM release_fingerprints WHERE user_id = $1", [userId])).rows;
    assert.equal(rows.length, 1, "exactly one fingerprint row is written for the release");
    for (const row of rows) {
      for (const value of Object.values(row)) {
        assert.ok(
          !(typeof value === "string" && value.includes(VALUE)),
          "the plaintext value is never stored in any column of release_fingerprints",
        );
      }
    }
    assert.equal(rows[0]!.fingerprint, fingerprint(dek, VALUE), "the persisted column is the keyed HMAC fingerprint of the value");
    assert.notEqual(rows[0]!.fingerprint, VALUE, "what is persisted is the fingerprint, not the plaintext");
  } finally {
    await db.close();
  }
});

test("AC2: a successful release never writes the value to logs/metrics (console)", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-nolog", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    const VALUE = `log-canary ∂ ${randomUUID()} !!`;
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });

    const capture = captureConsole();
    let res: Response;
    try {
      res = await callPost(handler, releaseRequest(approvalId, { value: VALUE }), approvalId);
    } finally {
      capture.restore();
    }
    assert2xx(res);

    // The value still reaches the agent (through the store), but never a log line.
    assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), VALUE, "the value still round-trips to the store for the agent");
    for (const line of capture.lines) {
      assert.ok(!line.includes(VALUE), "the released value must never be written to logs/metrics in the clear");
    }
  } finally {
    await db.close();
  }
});

test("AC2: the fingerprint is persisted for ninety days (present inside the window, gone after it)", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-90d", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    const VALUE = `fp-${randomUUID()}`;
    const { handler } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
    assert2xx(await callPost(handler, releaseRequest(approvalId, { value: VALUE }), approvalId));

    const fp = fingerprint(dek, VALUE);
    const within = await lookupForUser(db, userId, fixedClock(new Date(T0.getTime() + 89 * DAY_MS)));
    assert.ok(within.includes(fp), "the fingerprint is still live 89 days after the release");
    const after = await lookupForUser(db, userId, fixedClock(new Date(T0.getTime() + 91 * DAY_MS)));
    assert.ok(!after.includes(fp), "the fingerprint has lapsed 91 days after the release (a 90-day window)");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC3 — a user cannot release against another user's approval; a malformed id is a 4xx
// (never a raw uuid cast / 500).
// =====================================================================================

test("AC3: a user cannot release against another user's approval, even when signed in and freshly stepped up", async () => {
  const db = await freshDb();
  try {
    const kwAlice = keyWrapperFor();
    const { userId: alice, dek: dekAlice } = await makePerson(db, "owner-alice", kwAlice);
    const agentId = await makeAgentFor(db, alice);
    const approvalId = await makeApprovedApproval(db, { userId: alice, agentId, dek: dekAlice });

    const kwBob = keyWrapperFor();
    const { userId: bob } = await makePerson(db, "intruder-bob", kwBob);

    // Bob is fully signed in AND freshly stepped up, posting against ALICE's approval id.
    const { handler, store } = makeHandler({ db, keyWrapper: kwBob, session: sessionFor(bob, T0) });
    const res = await callPost(handler, releaseRequest(approvalId, { value: `intrusion-${randomUUID()}` }), approvalId);
    assert4xx(res);

    assert.equal(store.collect(keyForApproval(alice, agentId, approvalId)), undefined, "nothing is released under the owner's key");
    assert.equal(store.collect(keyForApproval(bob, agentId, approvalId)), undefined, "nor under the intruder's key");
    assert.deepEqual(await lookupForUser(db, alice, CLOCK), [], "no fingerprint is written for the owner");
    assert.deepEqual(await lookupForUser(db, bob, CLOCK), [], "nor for the intruder");
  } finally {
    await db.close();
  }
});

test("AC3: an id that is not a well-formed approval id is rejected with a 4xx (never a raw cast / 500) and changes nothing", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId } = await makePerson(db, "release-badid", keyWrapper);

    // None of these is a uuid — a raw `WHERE id = $1` against the uuid column would throw a
    // 500; the boundary must shape-guard them to a 4xx first. The last is a SQL-injection
    // probe (OBS-049 / INV-102): bound/guarded as data, it cannot run as SQL.
    const badIds = ["not-a-uuid", "1", "0", "-1", "1.5", " ", "", "../../etc/passwd", "robert'); DROP TABLE approvals; --"];
    for (const badId of badIds) {
      const { handler } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
      const res = await callPost(handler, releaseRequest(badId, { value: `v-${randomUUID()}` }), badId);
      assert.ok(
        res.status >= 400 && res.status < 500,
        `a malformed id ${JSON.stringify(badId)} must be a 4xx (never a 5xx raw cast), got ${res.status}`,
      );
    }

    // The injection probe never ran as SQL: the approvals table is intact and nothing was released.
    await db.query("SELECT 1 FROM approvals LIMIT 1");
    assert.equal(await tableExists(db, "approvals"), true, "the approvals table survives every malformed id");
    assert.deepEqual(await lookupForUser(db, userId, CLOCK), [], "a malformed id releases nothing");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC [obligation:admin-auth-required] (INV-101) — the endpoint requires a server-verified
// session; identity is never a client value. (The public-route half of the obligation is
// satisfied by Warthog's public routes and their own tests — this task adds only an
// authenticated route, so only the admin half is exercised here.)
// =====================================================================================

test("[admin-auth-required] an unauthenticated request (no session) is rejected (401 or redirect to sign-in) and releases nothing", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-unauth", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    const { handler, store } = makeHandler({ db, keyWrapper, session: null });
    const res = await callPost(handler, releaseRequest(approvalId, { value: `v-${randomUUID()}` }), approvalId);

    assertUnauthenticated(res);
    assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), undefined, "an unauthenticated request releases nothing");
    assert.deepEqual(await lookupForUser(db, userId, CLOCK), [], "and writes no fingerprint");
  } finally {
    await db.close();
  }
});

test("[admin-auth-required] a garbage/unknown session cookie is treated as unauthenticated (real verifySession)", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-garbage", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    const { handler, store } = makeHandler({ db, keyWrapper, resolveSession: realResolveSession(db, CLOCK) });
    const res = await callPost(
      handler,
      releaseRequest(approvalId, { value: `v-${randomUUID()}`, cookie: `no-such-session-${randomUUID()}` }),
      approvalId,
    );

    assertUnauthenticated(res);
    assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), undefined, "an unverifiable cookie releases nothing");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC [obligation:validate-and-parameterize-input] (INV-102) — malformed / oversized /
// mis-shaped input is a 4xx (never a 500); a SQL-shaped value is treated purely as data
// (only its one-way fingerprint reaches the db, which survives).
// =====================================================================================

test("[validate-and-parameterize-input] a malformed or mis-shaped body is a 4xx (never a 500) and releases nothing", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-malformed", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // A valid session + fresh step-up + a valid approval id, so the ONLY reason to reject
    // is the body itself.
    const buildBad: Array<() => Request> = [
      () => releaseRequest(approvalId, { rawBody: "{ not valid json at all" }), // malformed JSON
      () => releaseRequest(approvalId, { body: {} }), // no value
      () => releaseRequest(approvalId, { body: { value: null } }),
      () => releaseRequest(approvalId, { body: { value: 123 } }),
      () => releaseRequest(approvalId, { body: { value: {} } }),
      () => releaseRequest(approvalId, { body: { value: [] } }),
    ];
    for (const build of buildBad) {
      const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
      const res = await callPost(handler, build(), approvalId);
      assert4xx(res);
      assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), undefined, "mis-shaped input releases nothing");
    }
    assert.deepEqual(await lookupForUser(db, userId, CLOCK), [], "mis-shaped input writes no fingerprint");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] an oversized value is rejected with a 4xx before any release", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-oversize", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // A value padded past any reasonable cap (~2 MiB), with a valid session + step-up.
    const huge = "x".repeat(2 * 1024 * 1024);
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
    const res = await callPost(handler, releaseRequest(approvalId, { value: huge }), approvalId);

    assert4xx(res);
    assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), undefined, "an oversized value releases nothing");
    assert.deepEqual(await lookupForUser(db, userId, CLOCK), [], "and writes no fingerprint");
  } finally {
    await db.close();
  }
});

test("[validate-and-parameterize-input] a SQL-shaped value is stored only as its fingerprint, the table survives, and the value round-trips to the store", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-sqlvalue", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // A value shaped like a classic injection. Only its one-way HMAC (hex) ever reaches the
    // db, bound as a parameter — so a SQL-shaped value cannot alter a statement.
    const VALUE = "robert'); DROP TABLE release_fingerprints; --";
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
    const res = await callPost(handler, releaseRequest(approvalId, { value: VALUE }), approvalId);
    assert2xx(res);

    await db.query("SELECT 1 FROM release_fingerprints LIMIT 1");
    assert.equal(await tableExists(db, "release_fingerprints"), true, "the release_fingerprints table survives the probe");
    assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), VALUE, "the SQL-shaped value round-trips verbatim as data to the store");
    assert.ok(
      (await lookupForUser(db, userId, CLOCK)).includes(fingerprint(dek, VALUE)),
      "only the keyed fingerprint of the value is persisted",
    );
  } finally {
    await db.close();
  }
});

// =====================================================================================
// AC [obligation:secrets-from-env] (INV-103) — config flows in through the injected seams;
// no ambient env secret is folded into the release response or its persisted state.
// =====================================================================================

test("[secrets-from-env] no ambient env secret is folded into a release response or the persisted fingerprint", async () => {
  const DECOY = "sk_live_DECOY_must_never_appear_in_warthog";
  const prev = process.env.WARTHOG_DECOY_SECRET;
  process.env.WARTHOG_DECOY_SECRET = DECOY;
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "release-secrets", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makeApprovedApproval(db, { userId, agentId, dek });

    // The handler runs purely from its injected seams (no config seam passed), so no
    // ambient process.env is read — a decoy secret can never surface.
    const { handler } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
    const res = await callPost(handler, releaseRequest(approvalId, { value: `v-${randomUUID()}` }), approvalId);

    const serialised = await serialiseResponse(res);
    assert.ok(!serialised.includes(DECOY), "no ambient env secret appears in the release response");
    for (const fp of await lookupForUser(db, userId, CLOCK)) {
      assert.ok(!fp.includes(DECOY), "no ambient env secret is folded into the persisted fingerprint");
    }
  } finally {
    await db.close();
    if (prev === undefined) delete process.env.WARTHOG_DECOY_SECRET;
    else process.env.WARTHOG_DECOY_SECRET = prev;
  }
});

// =====================================================================================
// Review fixes C1 / C3 / C7 — the release reaches the agent, happens once, and counts.
//
// C1: the value used to be stored under `${userId}:${agents.id}` while collect_release
//     reads `${userId}:${connection_id}` (two distinct uuids), so the agent ALWAYS got
//     "gone" and the plaintext was orphaned. The release is now keyed by the requesting
//     agent's REAL connection, resolved from the agents row.
// C3: an approved card release was never written to the spend ledger, so agent,
//     member and household budgets never filled. It is now recorded with the release,
//     in the budget currency, and the agent budget is re-checked at release time.
// Once-only: an approval used to be releasable again and again (any old approval,
//     overwriting the agent's slot). It is now released at most once.
// =====================================================================================

const CARD_DETAIL = {
  tool: "request_card",
  request: "card",
  amount: 150,
  currency: "AUD",
  merchant: "JB Hi-Fi",
};

test("C1: a released value is collected by the requesting agent's own collect_release, exactly once", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "c1-e2e", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const connectionId = connectionOfAgent.get(agentId)!;
    assert.notEqual(connectionId, agentId, "the agent's connection id differs from its row id");
    const approvalId = await makePendingApproval(db, { userId, agentId, dek });

    const VALUE = `P${randomUUID().slice(0, 8)}`;
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });
    assert2xx(await callPost(handler, releaseRequest(approvalId, { value: VALUE }), approvalId));

    // The agent's connection exactly as the MCP composition root resolves it.
    const connection: AgentConnection = { userId, connectionId, agentId, active: true };
    const collect = createCollectReleaseTool({ releaseStore: store });
    assert.deepEqual(await collect.handle({ approval_id: approvalId }, connection), { status: "collected", value: VALUE }, "the agent collects it");
    assert.deepEqual(await collect.handle({ approval_id: approvalId }, connection), { status: "gone" }, "exactly once");
  } finally {
    await db.close();
  }
});

test("an approval is released at most once: a second post is refused and never overwrites the first value", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "once-only", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makePendingApproval(db, { userId, agentId, dek });
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });

    assert2xx(await callPost(handler, releaseRequest(approvalId, { value: "first-value" }), approvalId));
    const again = await callPost(handler, releaseRequest(approvalId, { value: "second-value" }), approvalId);
    assert.equal(again.status, 409, "a second release of the same approval is refused as a conflict");
    assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), "first-value", "the first value is untouched");
  } finally {
    await db.close();
  }
});

test("two concurrent posts for one approval release it exactly once", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "concurrent", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makePendingApproval(db, { userId, agentId, dek, detail: CARD_DETAIL });
    const { handler } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });

    const results = await Promise.all([
      callPost(handler, releaseRequest(approvalId, { value: "card-a" }), approvalId),
      callPost(handler, releaseRequest(approvalId, { value: "card-b" }), approvalId),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1, "exactly one post releases");
    const rows = await listReleasesForConnectionPeriod(db, userId, connectionOfAgent.get(agentId)!, "month", periodKeyFor("month", T0));
    assert.equal(rows.length, 1, "and the spend is counted once");
  } finally {
    await db.close();
  }
});

test("an approval that is not a card or high-tier release is never releasable", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "not-a-release", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makeApprovedApproval(db, {
      userId,
      agentId,
      dek,
      detail: { tool: "send_email", connector: "gmail" },
    });
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });

    assert4xx(await callPost(handler, releaseRequest(approvalId, { value: "planted" }), approvalId));
    assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), undefined, "nothing is planted for the agent");
  } finally {
    await db.close();
  }
});

test("a release for an agent that has been disconnected is refused and leaves the approval pending", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "gone-agent", keyWrapper);
    const agentId = await makeAgentFor(db, userId, { status: "disconnected" });
    const approvalId = await makePendingApproval(db, { userId, agentId, dek });
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });

    assert4xx(await callPost(handler, releaseRequest(approvalId, { value: "secret" }), approvalId));
    assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), undefined, "nothing is released to a disconnected agent");
    assert.equal((await getApproval(db, userId, approvalId, dek))!.status, "pending", "the approval is not approved");
    assert.deepEqual(await lookupForUser(db, userId, CLOCK), [], "no fingerprint is written");
  } finally {
    await db.close();
  }
});

test("C3: a card release records its amount, currency and merchant against the agent's connection, once", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "c3-ledger", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const connectionId = connectionOfAgent.get(agentId)!;
    const approvalId = await makePendingApproval(db, { userId, agentId, dek, detail: CARD_DETAIL });
    const { handler } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });

    const card = JSON.stringify({ number: "4242424242424242", securityCode: "123" });
    assert2xx(await callPost(handler, releaseRequest(approvalId, { value: card }), approvalId));
    await callPost(handler, releaseRequest(approvalId, { value: card }), approvalId);

    const rows = await listReleasesForConnectionPeriod(db, userId, connectionId, "month", periodKeyFor("month", T0));
    assert.equal(rows.length, 1, "exactly one ledger row, however often the release is posted");
    assert.equal(rows[0]!.amount, 150, "the approved amount");
    assert.equal(rows[0]!.currency, "AUD", "in the budget currency");
    assert.equal(rows[0]!.merchant, "JB Hi-Fi", "with the merchant");
    assert.equal(rows[0]!.householdId, null, "a solo person's release counts toward no household");
    assert.equal(rows[0]!.periodKeys.day, periodKeyFor("day", T0), "bucketed in the release's day");
  } finally {
    await db.close();
  }
});

test("C3: a foreign-currency card release counts its converted amount in the budget currency", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "c3-converted", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makePendingApproval(db, {
      userId,
      agentId,
      dek,
      detail: { ...CARD_DETAIL, amount: 100, currency: "USD", converted: { amount: 152.5, currency: "AUD", rateDate: "2026-11-14" } },
    });
    const { handler } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });

    assert2xx(await callPost(handler, releaseRequest(approvalId, { value: "card" }), approvalId));
    const rows = await listReleasesForConnectionPeriod(db, userId, connectionOfAgent.get(agentId)!, "month", periodKeyFor("month", T0));
    assert.equal(rows[0]!.amount, 152.5, "the converted amount is what counts against the budget");
    assert.equal(rows[0]!.currency, "AUD", "in the budget's currency");
  } finally {
    await db.close();
  }
});

test("C3: two card approvals made before either was released cannot together exceed the agent's budget", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "c3-budget", keyWrapper);
    const agentId = await makeAgentFor(db, userId, { budget: 200 });
    const first = await makePendingApproval(db, { userId, agentId, dek, detail: CARD_DETAIL });
    const second = await makePendingApproval(db, { userId, agentId, dek, detail: CARD_DETAIL });
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });

    assert2xx(await callPost(handler, releaseRequest(first, { value: "card-1" }), first));
    assert.equal(store.collect(keyForApproval(userId, agentId, first)), "card-1", "the first release goes through");

    const over = await callPost(handler, releaseRequest(second, { value: "card-2" }), second);
    assert.equal(over.status, 409, "the second would put the agent over its A$200 budget: refused");
    assert.deepEqual(await over.json(), { error: "over_budget" }, "and says why");
    assert.equal(store.collect(keyForApproval(userId, agentId, second)), undefined, "nothing more is released");
    assert.equal((await getApproval(db, userId, second, dek))!.status, "pending", "the refused approval is left pending");
    const rows = await listReleasesForConnectionPeriod(db, userId, connectionOfAgent.get(agentId)!, "month", periodKeyFor("month", T0));
    assert.equal(rows.length, 1, "only the first release counts");
  } finally {
    await db.close();
  }
});

// Review fix W4.3: budget periods follow the person's own time zone. At 2026-12-01T05:00Z
// it is still 30 November in Los Angeles (and already 1 December in Sydney), so a person
// who lives in Los Angeles is still spending November's budget.
const LA_INSTANT = new Date("2026-12-01T05:00:00.000Z");

async function saveTimeZone(db: Db, userId: string, dek: Uint8Array, timeZone: string): Promise<void> {
  await savePreferences(
    db,
    { userId, tone: "warm", length: "short", language: "en-AU", units: "metric", timeZone, briefing: "brief" },
    dek,
  );
}

test("W4.3: a card release is bucketed in the person's own time zone", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const clock = fixedClock(LA_INSTANT);
    const { userId, dek } = await makePerson(db, "tz-write", keyWrapper);
    await saveTimeZone(db, userId, dek, "America/Los_Angeles");
    const agentId = await makeAgentFor(db, userId);
    const connectionId = connectionOfAgent.get(agentId)!;
    const approvalId = await makePendingApproval(db, { userId, agentId, dek, clock, detail: CARD_DETAIL });
    const { handler } = makeHandler({ db, keyWrapper, clock, session: sessionFor(userId, LA_INSTANT) });

    assert2xx(await callPost(handler, releaseRequest(approvalId, { value: "card" }), approvalId));
    const rows = await listReleasesForConnectionPeriod(db, userId, connectionId, "month", "2026-11");
    assert.equal(rows.length, 1, "counted in the person's November, not Sydney's December");
    assert.deepEqual(rows[0]!.periodKeys, { day: "2026-11-30", week: "2026-W49", month: "2026-11" });
  } finally {
    await db.close();
  }
});

test("W4.3: the budget check at release reads the same local period it writes", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const clock = fixedClock(LA_INSTANT);
    const { userId, dek } = await makePerson(db, "tz-budget", keyWrapper);
    await saveTimeZone(db, userId, dek, "America/Los_Angeles");
    const agentId = await makeAgentFor(db, userId, { budget: 200 });
    const connectionId = connectionOfAgent.get(agentId)!;
    // A$100 already spent earlier in the person's (local) November.
    await recordRelease(db, {
      userId,
      connectionId,
      householdId: null,
      amount: 100,
      currency: "AUD",
      merchant: "Earlier",
      periodKeys: { day: "2026-11-20", week: "2026-W47", month: "2026-11" },
    });
    const approvalId = await makePendingApproval(db, { userId, agentId, dek, clock, detail: CARD_DETAIL });
    const { handler } = makeHandler({ db, keyWrapper, clock, session: sessionFor(userId, LA_INSTANT) });

    const over = await callPost(handler, releaseRequest(approvalId, { value: "card" }), approvalId);
    assert.equal(over.status, 409, "A$100 + A$150 is over the A$200 November budget");
    assert.deepEqual(await over.json(), { error: "over_budget" });
  } finally {
    await db.close();
  }
});

test("a release is refused when the agent's high-tier access was switched off after it asked", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "access-off", keyWrapper);
    const agentId = await makeAgentFor(db, userId, { highTierAccess: false });
    const approvalId = await makePendingApproval(db, { userId, agentId, dek });
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });

    assert4xx(await callPost(handler, releaseRequest(approvalId, { value: "secret" }), approvalId));
    assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), undefined, "nothing is released");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Design §5: every route checks Origin. The release endpoint used to rely on SameSite
// alone and parse any content type, so a same-site origin (another subdomain) could
// plant a value for a freshly approved release. A missing or foreign Origin, or a
// non-JSON body, now changes nothing.
// =====================================================================================

test("a release with a missing or foreign Origin, or a non-JSON body, is refused and releases nothing", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "origin", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makePendingApproval(db, { userId, agentId, dek });
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });

    const url = `${PUBLIC_ORIGIN}/api/approvals/${approvalId}/release`;
    const body = JSON.stringify({ value: "planted" });
    const attempts: [string, Record<string, string>][] = [
      ["no Origin", { "content-type": "application/json" }],
      ["a foreign Origin", { "content-type": "application/json", origin: "https://evil.warthog.com.au" }],
      ["a text/plain body", { "content-type": "text/plain", origin: PUBLIC_ORIGIN }],
    ];
    for (const [label, headers] of attempts) {
      const res = await callPost(handler, new Request(url, { method: "POST", headers, body }), approvalId);
      assert4xx(res);
      assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), undefined, `${label}: nothing is released`);
    }
    assert.equal((await getApproval(db, userId, approvalId, dek))!.status, "pending", "the approval is untouched");
  } finally {
    await db.close();
  }
});

// =====================================================================================
// Review fix C10 — the brief: "the release is recorded in the activity feed without the
// value" (high-tier) and "the release, approved amount and merchant are recorded"
// (card). A release used to leave no trace in the tamper-evident record.
// =====================================================================================

test("C10: a high-tier release is recorded in the activity feed, naming the agent and field, never the value", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "c10-identity", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makePendingApproval(db, { userId, agentId, dek });
    const VALUE = `PA${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const { handler } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });

    assert2xx(await callPost(handler, releaseRequest(approvalId, { value: VALUE }), approvalId));

    const entries = (await readActivity(db, userId, dek)).filter((e) => e.kind === "identity_release");
    assert.equal(entries.length, 1, "exactly one release entry");
    assert.equal(entries[0]!.source, "warthog", "Warthog writes the record");
    assert.equal(entries[0]!.agentId, agentId, "attributed to the requesting agent");
    assert.equal(entries[0]!.outcome, "released");
    assert.match(JSON.stringify(entries[0]!.payload), /passport/, "it names the field released");
    assert.ok(!JSON.stringify(await readActivity(db, userId, dek)).includes(VALUE), "the value is never in the feed");
  } finally {
    await db.close();
  }
});

test("C10: a card release is recorded with its approved amount and merchant, never the card", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "c10-card", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makePendingApproval(db, { userId, agentId, dek, detail: CARD_DETAIL });
    const { handler } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });

    const card = JSON.stringify({ number: "4242424242424242", securityCode: "987" });
    assert2xx(await callPost(handler, releaseRequest(approvalId, { value: card }), approvalId));

    const entries = (await readActivity(db, userId, dek)).filter((e) => e.kind === "card_release");
    assert.equal(entries.length, 1, "exactly one card release entry");
    assert.equal(entries[0]!.merchant, "JB Hi-Fi", "with the merchant");
    assert.equal(entries[0]!.agentId, agentId, "attributed to the requesting agent");
    const payload = JSON.stringify(entries[0]!.payload);
    assert.match(payload, /150/, "with the approved amount");
    assert.match(payload, /AUD/, "and its currency");
    const feed = JSON.stringify(await readActivity(db, userId, dek));
    assert.ok(!feed.includes("4242424242424242"), "the card number is never in the feed");
    assert.ok(!feed.includes(card) && !feed.includes("securityCode"), "nor the released detail or its security code");
  } finally {
    await db.close();
  }
});

// ═══ Review fix W6 — the release cap fits a full card checkout payload ═════════════════
//
// A card release now carries {number, securityCode, expiryMonth, expiryYear, cardholderName,
// billingAddress}. The name on the card is capped at 256 characters and a saved postal
// address at 4096, so the largest legal payload — even one where every character of the
// name and address needs JSON escaping — must still be accepted and collected intact.

test("W6: a full card payload at the largest legal name and address is released and collected intact", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "w6-full-card", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makePendingApproval(db, { userId, agentId, dek, detail: CARD_DETAIL });
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });

    // Every character escapes to six in JSON (a control character), and to seven in the
    // posted body: the worst case for both the value cap and the body cap.
    const card = JSON.stringify({
      number: "4242424242424242424",
      securityCode: "1234",
      expiryMonth: 11,
      expiryYear: 2030,
      cardholderName: "\u0001".repeat(256),
      billingAddress: "\u0001".repeat(4096),
    });
    const res = await callPost(handler, releaseRequest(approvalId, { value: card }), approvalId);
    assert2xx(res);
    assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), card, "the agent collects the whole payload, once");
  } finally {
    await db.close();
  }
});

test("W6: a realistic full card payload (multi-line address, accented name) is released", async () => {
  const db = await freshDb();
  try {
    const keyWrapper = keyWrapperFor();
    const { userId, dek } = await makePerson(db, "w6-real-card", keyWrapper);
    const agentId = await makeAgentFor(db, userId);
    const approvalId = await makePendingApproval(db, { userId, agentId, dek, detail: CARD_DETAIL });
    const { handler, store } = makeHandler({ db, keyWrapper, session: sessionFor(userId, T0) });

    const card = JSON.stringify({
      number: "4242424242424242",
      securityCode: "123",
      expiryMonth: 11,
      expiryYear: 2030,
      cardholderName: "Zoë O'Brien-Łukasz",
      billingAddress: ("Unit 5, \"The Quokka\"\n12 Banksia Street\nPerth WA 6000\n").repeat(80).slice(0, 4096),
    });
    assert2xx(await callPost(handler, releaseRequest(approvalId, { value: card }), approvalId));
    assert.equal(store.collect(keyForApproval(userId, agentId, approvalId)), card);
  } finally {
    await db.close();
  }
});

test("a chosen vault field is required at release and remains revocable before collection",async()=>{
 const db=await freshDb();
 try {
  const {saveHighTierField}=await import("../../../../../server/db/high-tier-fields");
  const {getConnectionPermissions}=await import("../../../../../server/db/agent-permissions");
  const {mayCollectReleasedField}=await import("../../../../../server/agents/resource-access");
  const keyWrapper=keyWrapperFor(),{userId,dek}=await makePerson(db,"field-scope",keyWrapper);
  const agentId=await makeAgentFor(db,userId),connectionId=connectionOfAgent.get(agentId)!;
  const chosen=await saveHighTierField(db,{userId,type:"passport",label:"Chosen",ciphertext:"opaque"});
  const other=await saveHighTierField(db,{userId,type:"passport",label:"Other",ciphertext:"opaque"});
  const initial=(await getConnectionPermissions(db,userId,connectionId))!;
  await upsertPermissions(db,{...initial,identityFields:[chosen.id]});
  const approvalId=await makeApprovedApproval(db,{userId,agentId,dek});
  const {handler,store}=makeHandler({db,keyWrapper,session:sessionFor(userId,CLOCK.now())});
  assert4xx(await callPost(handler,releaseRequest(approvalId,{value:"synthetic"}),approvalId));
  assert4xx(await callPost(handler,releaseRequest(approvalId,{body:{value:"synthetic",fieldId:other.id}}),approvalId));
  assert.equal(store.collect(keyForApproval(userId,agentId,approvalId)),undefined);
  assert2xx(await callPost(handler,releaseRequest(approvalId,{body:{value:"synthetic",fieldId:chosen.id}}),approvalId));
  assert.equal(await mayCollectReleasedField(db,userId,approvalId,(await getConnectionPermissions(db,userId,connectionId))!),true);
  await upsertPermissions(db,{...initial,identityFields:[]});
  assert.equal(await mayCollectReleasedField(db,userId,approvalId,(await getConnectionPermissions(db,userId,connectionId))!),false);
 } finally {await db.close();}
});
