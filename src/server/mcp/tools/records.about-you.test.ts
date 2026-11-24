// About you suggestions through save_record (docs/adr/profile-build.md): an agent that can read the
// person's About you suggests their own low-tier details, each waiting for the person to add; the
// agent gets one neutral answer, never what the person already has or declined.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createSaveRecordTool, MAX_ABOUT_YOU_WAITING, saveRecordSchema } from "./records";
import { createGetContextTool } from "./get-context";
import { createUser } from "../../db/users";
import { createAgent } from "../../db/agents";
import { upsertPermissions } from "../../db/agent-permissions";
import { listIdentityFields, saveIdentityField } from "../../db/identity-fields";
import { declineIdentitySuggestion, listIdentitySuggestions } from "../../db/identity-suggestions";
import { freshDb } from "../../../test/db";
import { localAesKeyWrapper } from "../../crypto/key-wrapper";
import { fixedClock } from "../../seams/clock";
import type { AgentConnection } from "../context";

const NOW = new Date("2026-11-24T01:00:00.000Z");
const clock = fixedClock(NOW);
const RECENT = { service: "gmail", messageId: "m1", date: "2026-10-03", sender: "agl.com.au" };

async function setup(options: { identityAccess?: boolean } = {}) {
  const db = await freshDb();
  const keyWrapper = localAesKeyWrapper(randomBytes(32));
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const connectionId = randomUUID();
  const agent = await createAgent(db, { userId: user.id, connectionId, displayName: "Claude", platform: "claude" }, clock);
  await upsertPermissions(db, {
    userId: user.id, connectionId, grantedConnectors: [], readTools: true, changeTools: "allow", identityAccess: options.identityAccess ?? true,
    highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false,
    rulesScope: [], rateLimit: 120, recordsAccess: true,
  } as Parameters<typeof upsertPermissions>[1]);
  const connection = { userId: user.id, connectionId, agentId: agent.id, active: true } as unknown as AgentConnection;
  const deps = { db, keyWrapper, clock };
  return { db, dek, connection, userId: user.id, save: createSaveRecordTool(deps), context: createGetContextTool(deps) };
}

test("a call with only About you suggestions saves them for the person to add, never as details yet", async () => {
  const t = await setup();
  try {
    const result = await t.save.handle({
      aboutYou: [
        { kind: "phone", value: "0412 345 678", source: RECENT },
        { kind: "postal_address", value: "9 New Rd, Fremantle WA 6160", movingOn: "2027-03-01", source: RECENT },
      ],
    }, t.connection);
    assert.equal(result.status, "ok");
    assert.deepEqual((result as { aboutYou: unknown }).aboutYou, {
      received: 2,
      note: "About you suggestions wait for the person to add them in Warthog → About you. Tell them what you suggested.",
    });
    const waiting = await listIdentitySuggestions(t.db, t.userId, t.dek);
    assert.deepEqual(waiting.map((item) => [item.kind, item.value]).sort(), [["phone", "0412 345 678"], ["postal_address", "9 New Rd, Fremantle WA 6160"]]);
    assert.equal(waiting.find((item) => item.kind === "postal_address")!.movingOn, "2027-03-01");
    assert.deepEqual(await listIdentityFields(t.db, t.userId, t.dek), [], "nothing reaches About you until the person adds it");
    const context = JSON.stringify(await t.context.handle(t.connection));
    assert.ok(!context.includes("0412 345 678") && !context.includes("Fremantle"), "no agent sees a suggestion");
  } finally {
    await t.db.close();
  }
});

test("the agent gets the same answer whether a detail is new, already saved, already waiting or declined before", async () => {
  const t = await setup();
  try {
    await saveIdentityField(t.db, { userId: t.userId, kind: "phone", value: "0412 345 678" }, t.dek);
    await t.save.handle({ aboutYou: [{ kind: "email", value: "sam@work.example", source: RECENT }] }, t.connection);
    const [declined] = await listIdentitySuggestions(t.db, t.userId, t.dek);
    await declineIdentitySuggestion(t.db, t.userId, declined!.id);
    await t.save.handle({ aboutYou: [{ kind: "language", value: "English", source: RECENT }] }, t.connection);

    const result = await t.save.handle({
      aboutYou: [
        { kind: "phone", value: "0412 345 678", source: RECENT }, // already saved
        { kind: "email", value: "sam@work.example", source: RECENT }, // declined before
        { kind: "language", value: "English", source: RECENT }, // already waiting
        { kind: "time_zone", value: "Australia/Perth", source: RECENT }, // new
      ],
    }, t.connection);
    assert.deepEqual((result as { aboutYou: { received: number } }).aboutYou.received, 4);
    assert.ok(!JSON.stringify(result).match(/already|declined|saved_before/i), "nothing says which was which");
    assert.deepEqual((await listIdentitySuggestions(t.db, t.userId, t.dek)).map((item) => item.kind).sort(), ["language", "time_zone"]);
  } finally {
    await t.db.close();
  }
});

test("only an agent that can read About you may suggest; old sources and a full queue are skipped", async () => {
  const blind = await setup({ identityAccess: false });
  try {
    const result = await blind.save.handle({ aboutYou: [{ kind: "phone", value: "0412 345 678", source: RECENT }] }, blind.connection);
    assert.match(JSON.stringify((result as { aboutYou: unknown }).aboutYou), /can't read the person's About you/);
    assert.deepEqual(await listIdentitySuggestions(blind.db, blind.userId, blind.dek), []);
  } finally {
    await blind.db.close();
  }

  const t = await setup();
  try {
    const old = await t.save.handle({ aboutYou: [{ kind: "phone", value: "0499 000 111", source: { ...RECENT, date: "2025-06-01" } }] }, t.connection);
    assert.match(JSON.stringify(old), /within the last 12 months/);
    assert.deepEqual(await listIdentitySuggestions(t.db, t.userId, t.dek), []);

    for (let batch = 0; batch < MAX_ABOUT_YOU_WAITING / 5; batch += 1) {
      await t.save.handle({ aboutYou: Array.from({ length: 5 }, (_, index) => ({ kind: "email" as const, value: `me${batch}-${index}@example.org`, source: RECENT })) }, t.connection);
    }
    const full = await t.save.handle({ aboutYou: [{ kind: "phone", value: "0499 000 222", source: RECENT }] }, t.connection);
    assert.match(JSON.stringify(full), new RegExp(`${MAX_ABOUT_YOU_WAITING} suggestions are already waiting`));
    assert.equal((await listIdentitySuggestions(t.db, t.userId, t.dek)).length, MAX_ABOUT_YOU_WAITING);
  } finally {
    await t.db.close();
  }
});

test("the schema refuses a name, anything for the Vault, what Warthog never keeps, and a suggestion with no dated source", () => {
  const refused = (aboutYou: unknown) => saveRecordSchema.safeParse({ aboutYou }).success === false;
  assert.ok(refused([{ kind: "name", value: "Sam Smith", source: RECENT }]));
  assert.ok(refused([{ kind: "date_of_birth", value: "1990-01-01", source: RECENT }]));
  assert.ok(refused([{ kind: "passport", value: "PA1234567", source: RECENT }]));
  assert.ok(refused([{ kind: "phone", value: "My TFN is 123 456 782", source: RECENT }]));
  assert.ok(refused([{ kind: "phone", value: "0412 345 678" }]), "a source is required");
  assert.ok(refused([{ kind: "phone", value: "0412 345 678", source: { service: "gmail" } }]), "with its date");
  assert.ok(refused(Array.from({ length: 6 }, () => ({ kind: "phone", value: "0412 345 678", source: RECENT }))), "at most 5 a call");
  const message = saveRecordSchema.safeParse({ aboutYou: [{ kind: "phone", value: "My TFN is 123 456 782", source: RECENT }] });
  assert.ok(!JSON.stringify(message.error?.issues).includes("123 456 782"), "never the value");
  assert.equal(saveRecordSchema.safeParse({ aboutYou: [{ kind: "phone", value: "0412 345 678", source: RECENT }] }).success, true);
  assert.equal(saveRecordSchema.safeParse({}).success, false, "an empty call still needs something to save");
});
