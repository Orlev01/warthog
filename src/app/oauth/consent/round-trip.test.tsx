// Review fix A2 — the consent screen round-trips: what the person sees ticked on the
// rendered form is exactly what gets stored for the agent.
//
// The live <ConsentView> is rendered (server-side, as the page does) in the state the
// person leaves it in; its NAMED inputs are collected into FormData exactly as a browser
// submits a form (checked checkboxes and radios, text/number/hidden values, the selected
// option); the page's own parser (`approvalFromForm`) and the real decision then run, and
// the stored grants are compared with the visible toggles. Until this fix only the name,
// starting set, high-tier and sharing were ever submitted.

import * as React from "react";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { approvalFromForm, loadConsentView } from "./actions";
import { createAuthorizeActions } from "../authorize/actions";
import { ConsentView, consentToggleState } from "../../../components/agents/consent-view";
import { beginAuthorization } from "../../../server/oauth/authorize";
import { consentRequestTag, getPendingAuthorization } from "../../../server/oauth/pending";
import { createClient } from "../../../server/oauth/store";
import { createClientResolver } from "../../../server/oauth/clients";
import { getConnectionPermissions } from "../../../server/db/agent-permissions";
import { listAgentsForUser } from "../../../server/db/agents";
import { createConnection, setDefaultForAgents } from "../../../server/db/connections";
import { createUser } from "../../../server/db/users";
import { loadConfig } from "../../../server/config";
import { fixedClock } from "../../../server/seams/clock";
import { systemRandom } from "../../../server/seams/random";
import { HttpError } from "../../../server/http/validate";
import { freshDb } from "../../../test/db";
import type { Db } from "../../../server/db/index";
import type { Session } from "../../../server/auth/session";

const BASE_URL = "https://warthog.com.au";
const CLIENT_ID = "https://claude.ai/.well-known/oauth-client";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const NOW = new Date("2026-06-01T00:00:00.000Z");

const config = loadConfig({
  NODE_ENV: "development",
  PUBLIC_BASE_URL: BASE_URL,
  WEBAUTHN_RP_ID: "localhost",
  DATABASE_URL: "pglite:memory",
  WARTHOG_HMAC_KEY: "ERERERERERERERERERERERERERERERERERERERERERE=",
  WARTHOG_DEV_KEK: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=",
} as NodeJS.ProcessEnv);

function deps(db: Db) {
  return { keyWrapper: { wrap: async () => "test-wrapped", unwrap: async () => new Uint8Array(32).fill(7) },
    db,
    config,
    clock: fixedClock(NOW),
    random: systemRandom,
    alerts: { emailSender: { sendEmail: async () => {} } },
    resolveClient: createClientResolver({
      db,
      fetchCimd: async (clientId: string): Promise<Record<string, unknown>> => {
        throw new Error(`no CIMD fetch in tests (${clientId})`);
      },
    }),
  };
}

function sessionFor(userId: string): Session {
  // Approving needs a fresh "confirm it's you": this person has just confirmed.
  return { id: `sess-${userId}`, userId, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: NOW };
}

function attr(attrs: string, name: string): string | null {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`, "i"));
  return m ? m[1]!.replace(/&amp;/g, "&").replace(/&quot;/g, '"') : null;
}

function has(attrs: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?:=""|="${name}")?(?=\\s|/|>|$)`, "i").test(` ${attrs}`);
}

// Collect a rendered form's submission the way a browser does.
function formDataOf(markup: string): FormData {
  const form = new FormData();
  for (const m of markup.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1]!;
    const name = attr(attrs, "name");
    if (!name || has(attrs, "disabled")) continue;
    const type = (attr(attrs, "type") ?? "text").toLowerCase();
    if ((type === "checkbox" || type === "radio") && !has(attrs, "checked")) continue;
    form.append(name, attr(attrs, "value") ?? (type === "checkbox" || type === "radio" ? "on" : ""));
  }
  for (const m of markup.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = attr(m[1]!, "name");
    const selected = [...m[2]!.matchAll(/<option\b([^>]*)>/gi)].find((o) => has(o[1]!, "selected"));
    if (name && selected) form.append(name, attr(selected[1]!, "value") ?? "");
  }
  return form;
}

async function connectAccount(db: Db, userId: string, accountLabel: string): Promise<string> {
  return (await createConnection(
    db,
    { userId, connectorId: "gmail", accountLabel, credentials: { token: "x" } },
    new Uint8Array(32).fill(7),
    fixedClock(NOW),
  )).id;
}

async function setUp(): Promise<{ db: Db; userId: string; handle: string; gmail: string }> {
  const db = await freshDb();
  await createClient(db, { clientId: CLIENT_ID, registration: "cimd", redirectUris: [REDIRECT_URI] });
  const user = await createUser(db, { email: "round-trip@warthog.com.au", wrappedDek: "d3JhcHBlZA==" });
  const gmail = await connectAccount(db, user.id, "me@example.com");
  const begun = await beginAuthorization({ params: authorizeParams(), session: sessionFor(user.id) }, deps(db));
  if (!begun.ok) throw new Error(`begin failed: ${begun.error}`);
  return { db, userId: user.id, handle: begun.handle, gmail };
}

function authorizeParams(): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    resource: `${BASE_URL}/mcp`,
    state: "s",
  });
}

test("the consent view lists the person's own connected accounts by service and account name", async () => {
  const { db, userId, handle, gmail } = await setUp();
  try {
    const props = await loadConsentView(handle, userId, { db, nameOf: (id) => (id === "gmail" ? "Gmail" : undefined) });
    assert.deepEqual(props?.accounts, [{ id: gmail, connectorId: "gmail", serviceName: "Gmail", label: "me@example.com", ticked: false }]);
  } finally {
    await db.close();
  }
});

test("the toggles the person leaves on the screen are exactly the grants stored", async () => {
  const { db, userId, handle, gmail } = await setUp();
  try {
    const props = await loadConsentView(handle, userId, { db, nameOf: () => "Gmail" });
    assert.ok(props != null);
    // The person keeps Standard, unticks shared memory and tasks, ticks their Gmail account
    // and card requests (leaving the A$200 a month default) and high-tier.
    const left = {
      ...consentToggleState("standard", []),
      memoryRead: false,
      memoryWrite: false,
      tasks: false,
      highTier: true,
      card: true,
      accounts: [gmail],
    };
    const markup = renderToStaticMarkup(
      <ConsentView {...props!} approveAction={async () => {}} refuseAction={async () => {}} initialState={left} />,
    );
    const form = formDataOf(markup);
    const approval = approvalFromForm(form, props!.platform);
    const decided = await createAuthorizeActions(deps(db)).approve(sessionFor(userId), handle, approval, String(form.get("request")));
    assert.ok(decided.ok, `approve succeeds, got ${JSON.stringify(decided)}`);

    const [agent] = await listAgentsForUser(db, userId);
    const grants = await getConnectionPermissions(db, userId, agent!.connectionId);
    assert.ok(grants != null);
    assert.equal(agent!.displayName, props!.defaultName, "the name field is submitted");
    assert.equal(grants!.identityAccess, true, "basic profile: ticked");
    assert.equal(grants!.memoryRead, false, "shared memory: unticked");
    assert.equal(grants!.memoryWrite, false, "saving memories: independently unticked");
    assert.equal(grants!.tasksAccess, false, "tasks: unticked");
    assert.equal(grants!.recordsAccess, true, "life-admin records: ticked");
    assert.equal(grants!.highTierAccess, true, "high-tier: ticked");
    assert.equal(grants!.sharing, false, "sharing: unticked");
    assert.equal(grants!.cardAccess, true, "card requests: ticked");
    assert.deepEqual(grants!.cardBudget, { amount: 200, currency: "AUD", period: "month" });
    assert.deepEqual(grants!.accounts, [{ accountId: gmail, connectorId: "gmail" }], "the ticked account");
    assert.deepEqual(grants!.grantedConnectors, ["gmail"], "so its service");
    assert.equal(grants!.changeTools, "ask_first");
  } finally {
    await db.close();
  }
});

// docs/adr/several-accounts-per-agent.md — each account is its own checkbox: two Gmail accounts
// on for new agents arrive ticked and are both granted, and the one left off is not.
test("two accounts of a service on for new agents arrive ticked and are both granted", async () => {
  const { db, userId, handle, gmail } = await setUp();
  try {
    const billing = await connectAccount(db, userId, "billing@example.com");
    const booking = await connectAccount(db, userId, "booking@example.com");
    await setDefaultForAgents(db, { userId, id: gmail, on: true });
    await setDefaultForAgents(db, { userId, id: billing, on: true });

    const props = await loadConsentView(handle, userId, { db, nameOf: () => "Gmail" });
    const form = formDataOf(renderToStaticMarkup(<ConsentView {...props!} approveAction={async () => {}} refuseAction={async () => {}} />));
    assert.deepEqual([...form.getAll("account")].sort(), [gmail, billing].sort(), "the two accounts on for new agents are ticked");
    assert.equal(form.getAll("service").length, 0, "the screen no longer sends services");

    const decided = await createAuthorizeActions(deps(db)).approve(sessionFor(userId), handle, approvalFromForm(form, props!.platform), String(form.get("request")));
    assert.ok(decided.ok, `approve succeeds, got ${JSON.stringify(decided)}`);
    const [agent] = await listAgentsForUser(db, userId);
    const grants = await getConnectionPermissions(db, userId, agent!.connectionId);
    assert.deepEqual(grants!.accounts.map((a) => a.accountId).sort(), [gmail, billing].sort(), "both ticked accounts are granted");
    assert.ok(!grants!.accounts.some((a) => a.accountId === booking), "the unticked account is not");
  } finally {
    await db.close();
  }
});

// A screen loaded before the accounts were listed one by one still posts services. It must not
// grant nothing, or the wrong accounts: nothing is connected, the request is kept, and the
// person is shown the accounts to check.
test("an older screen that sends services connects nothing and keeps the request to review", async () => {
  const { db, userId, handle } = await setUp();
  try {
    const form = new FormData();
    form.append("name", "Claude");
    form.append("starting-set", "standard");
    form.append("service", "gmail");
    form.append("request", consentRequestTag(handle));
    const decided = await createAuthorizeActions(deps(db)).approve(sessionFor(userId), handle, approvalFromForm(form, "Claude"), String(form.get("request")));
    assert.deepEqual(decided, { ok: false, error: "accounts_changed" });
    assert.equal((await listAgentsForUser(db, userId)).length, 0, "nothing is connected");
    assert.ok((await loadConsentView(handle, userId)) != null, "the request is still there to review and approve");
  } finally {
    await db.close();
  }
});

test("a malformed card budget is refused at the boundary (a 4xx), and the request stays usable", async () => {
  const { db, userId, handle } = await setUp();
  try {
    const form = new FormData();
    form.append("name", "Claude");
    form.append("starting-set", "standard");
    form.append("card", "on");
    form.append("cardBudgetAmount", "lots");
    form.append("cardBudgetPeriod", "month");
    form.append("cardBudgetCurrency", "AUD");
    await assert.rejects(
      createAuthorizeActions(deps(db)).approve(sessionFor(userId), handle, approvalFromForm(form, "Claude"), consentRequestTag(handle)),
      (err: unknown) => err instanceof HttpError && err.status >= 400 && err.status < 500,
    );
    assert.equal((await listAgentsForUser(db, userId)).length, 0, "nothing is created");
    assert.ok((await loadConsentView(handle, userId)) != null, "the pending request is still there to retry");
  } finally {
    await db.close();
  }
});

// Review 2026-11-23 — the consent swap, through the real screen: the form carries the request it
// was rendered for, so an Approve after another request replaced the cookie connects nothing.
test("the consent form is bound to the request it shows; a swapped request isn't approved", async () => {
  const { db, userId, handle } = await setUp();
  try {
    const props = await loadConsentView(handle, userId, { db });
    const form = formDataOf(renderToStaticMarkup(<ConsentView {...props!} approveAction={async () => {}} refuseAction={async () => {}} />));
    assert.equal(form.get("request"), consentRequestTag(handle), "the form names the request on screen");

    const begun = await beginAuthorization(
      { params: new URLSearchParams(Object.fromEntries(getPendingAuthorization(handle, userId)!.params)), session: sessionFor(userId) },
      deps(db),
    );
    if (!begun.ok) throw new Error("a second request should begin");
    const decided = await createAuthorizeActions(deps(db)).approve(sessionFor(userId), begun.handle, approvalFromForm(form, props!.platform), String(form.get("request")));
    assert.deepEqual(decided, { ok: false, error: "request_changed" });
    assert.equal((await listAgentsForUser(db, userId)).length, 0, "nothing is connected");
  } finally {
    await db.close();
  }
});
