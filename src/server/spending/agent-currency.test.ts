import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { freshDb } from "../../test/db";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { upsertPermissions } from "../db/agent-permissions";
import { recordRelease, periodKeyFor } from "../db/card-spend-ledger";
import { upsertRate } from "../db/exchange-rates";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import { loadAgentContext, cardPolicyFor } from "../mcp/context";
import { evaluate } from "../../domain/policy/evaluate";
import { readOwnSpending } from "./own-read";
import { loadHomeMetrics } from "../home/page-data";

const now = new Date("2026-11-15T12:00:00.000Z");
const clock = fixedClock(now);

async function fixture(rate: boolean, currency = "AUD") {
  const db = await freshDb();
  const dek = randomBytes(32);
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  const user = await createUser(db, { email: "currency-" + randomUUID() + "@example.test", wrappedDek: await keyWrapper.wrap(dek) });
  const connectionId = randomUUID();
  const agent = await createAgent(db, { userId: user.id, connectionId, displayName: "Test agent", platform: "Other" }, clock);
  await upsertPermissions(db, { userId: user.id, connectionId,
    grantedConnectors: [], readTools: false, changeTools: "off", identityAccess: false,
    highTierAccess: false, cardAccess: true, cardBudget: { amount: 100, currency, period: "month" },
    skillsScope: [], memoryRead: false, sharing: false, rulesScope: [], rateLimit: 120 });
  await recordRelease(db, { userId: user.id, connectionId, householdId: null,
    amount: 60, currency: "USD", merchant: "Synthetic merchant",
    periodKeys: { day: periodKeyFor("day", now), week: periodKeyFor("week", now), month: periodKeyFor("month", now) } });
  if (rate) await upsertRate(db, { rateDate: "2026-11-14", baseCurrency: "USD", quoteCurrency: "AUD", rate: 1.5 });
  return { db, dek, keyWrapper, userId: user.id, connectionId, agentId: agent.id };
}

test("historical agent releases are converted to the current budget currency in all reads", async () => {
  const f = await fixture(true);
  try {
    const own = await readOwnSpending(f.db, f.userId, f.dek, clock);
    assert.equal(own.agents[0].approvedTotal, 90);
    assert.equal(own.agents[0].releases[0].currency, "USD");
    const home = await loadHomeMetrics({ db: f.db, keyWrapper: f.keyWrapper, clock }, f.userId);
    assert.equal(home.agents[0].spendThisPeriod, 90);
    const context = await loadAgentContext({ ...f, active: true }, { db: f.db, keyWrapper: f.keyWrapper, clock });
    assert.equal(context.spend, 90);
    const result = evaluate({ connector: null, tool: "request_card", makesChange: false, request: "card", amount: 20, currency: "AUD" }, {
      connectionActive: true, agentId: f.agentId, permission: { connectorGranted: false, grantedTools: [], readsAllowed: false, changes: "off", highTierAllowed: false },
      rules: [], accountCurrency: "AUD", card: cardPolicyFor(context, now), now });
    assert.equal(result.decision, "deny");
  } finally { await f.db.close(); }
});

test("a missing rate for earlier agent spending refuses a new request instead of assuming parity", async () => {
  const f = await fixture(false);
  try {
    const context = await loadAgentContext({ ...f, active: true }, { db: f.db, keyWrapper: f.keyWrapper, clock });
    const result = evaluate({ connector: null, tool: "request_card", makesChange: false, request: "card", amount: 20, currency: "AUD" }, {
      connectionActive: true, agentId: f.agentId, permission: { connectorGranted: false, grantedTools: [], readsAllowed: false, changes: "off", highTierAllowed: false },
      rules: [], accountCurrency: "AUD", card: cardPolicyFor(context, now), now });
    assert.equal(result.decision, "deny");
    assert.match(result.reason, /reference rate.*earlier/i);
  } finally { await f.db.close(); }
});

test("Home labels a budget with its currency even when the account uses another currency", async () => {
  const f = await fixture(false, "USD");
  try {
    const home = await loadHomeMetrics({ db: f.db, keyWrapper: f.keyWrapper, clock }, f.userId);
    assert.equal(home.agents[0].currency, "USD");
    assert.equal(home.agents[0].spendThisPeriod, 60);
  } finally { await f.db.close(); }
});
