// Card billing addresses (docs/adr/card-billing-addresses.md; migration 0123): an address typed
// for a card is kept with the cards only. It is never an everyday detail, so even an agent with
// every detail granted ("All my details") and card access never reads it through get_context,
// the per-agent detail choices or ownership checks, and it never shows in About you. An agent
// gets it only inside a card release the person approves (inbox/page.test.tsx).
//
// Driven through the real tools and actions over an isolated PGlite with the real migrations.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createGetContextTool } from "./get-context";
import { createUser } from "../../db/users";
import { upsertPermissions, getConnectionPermissions } from "../../db/agent-permissions";
import { saveIdentityField } from "../../db/identity-fields";
import { saveCardBillingAddress } from "../../db/card-billing-addresses";
import { addCard } from "../../db/cards";
import { ownsVaultFields, vaultChoices } from "../../agents/resource-access";
import { createIdentityActions } from "../../../app/(portal)/(protected)/vault/actions";
import { freshDb } from "../../../test/db";
import { localAesKeyWrapper } from "../../crypto/key-wrapper";
import { fixedClock } from "../../seams/clock";

const NOW = new Date("2026-11-24T09:00:00.000Z");
const SENTINEL = "PO Box 4417 SENTINEL Bondi Junction";
const keyWrapper = localAesKeyWrapper(randomBytes(32));

test("a card-only billing address never reaches get_context, the agent detail choices or About you", async () => {
  const db = await freshDb();
  try {
    const dek = randomBytes(32);
    const user = await createUser(db, { email: `phil-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
    const connectionId = randomUUID();
    await upsertPermissions(db, {
      userId: user.id,
      connectionId,
      grantedConnectors: [],
      readTools: false,
      changeTools: "off",
      identityAccess: true,
      identityFields: null, // "All my details"
      highTierAccess: true,
      cardAccess: true,
      cardBudget: { amount: 200, currency: "AUD", period: "month" },
      skillsScope: [],
      memoryRead: false,
      sharing: false,
      rulesScope: [],
      rateLimit: 120,
      tasksAccess: false,
      recordsAccess: false,
    });
    await saveIdentityField(db, { userId: user.id, kind: "postal_address", value: "1 Home Street, Perth" }, dek);
    const entry = await saveCardBillingAddress(db, { userId: user.id, value: SENTINEL }, dek);
    await addCard(db, {
      userId: user.id,
      brand: "Visa",
      lastFour: "4242",
      expiryMonth: 11,
      expiryYear: 2029,
      nickname: "Everyday spending",
      billingEntryId: entry.id,
      numberCiphertext: "v1:device-sealed",
    });

    const view = await createGetContextTool({ db, keyWrapper, clock: fixedClock(NOW) }).handle({
      userId: user.id,
      connectionId,
      agentId: connectionId,
      active: true,
    });
    const context = JSON.stringify(view);
    assert.match(context, /1 Home Street, Perth/, "precondition: the agent does see everyday details");
    assert.ok(!context.includes(SENTINEL), "get_context never includes a card-only address");
    assert.ok(!context.includes(entry.id), "or its id");

    const grants = await getConnectionPermissions(db, user.id, connectionId);
    const choices = await vaultChoices(db, user.id, dek, grants!);
    assert.ok(!JSON.stringify(choices).includes(SENTINEL), "it is never offered as a detail to share with an agent");
    assert.ok(!choices.some((c) => c.id === entry.id));
    assert.equal(await ownsVaultFields(db, user.id, [entry.id]), false, "it can never be granted as a vault detail");

    const aboutYou = await createIdentityActions({ db, keyWrapper }).load({
      id: `sess-${user.id}`,
      userId: user.id,
      createdAt: NOW,
      lastSeenAt: NOW,
      steppedUpAt: null,
    });
    const aboutYouText = JSON.stringify(aboutYou);
    assert.match(aboutYouText, /1 Home Street, Perth/, "precondition: About you lists the person's details");
    assert.ok(!aboutYouText.includes(SENTINEL), "About you never shows a card-only address");
  } finally {
    await db.close();
  }
});
