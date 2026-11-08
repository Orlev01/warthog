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
import { createClient } from "../../../server/oauth/store";
import { createClientResolver } from "../../../server/oauth/clients";
import { getConnectionPermissions } from "../../../server/db/agent-permissions";
import { listAgentsForUser } from "../../../server/db/agents";
import { createConnection } from "../../../server/db/connections";
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
  return {
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
  return { id: `sess-${userId}`, userId, createdAt: NOW, lastSeenAt: NOW, steppedUpAt: null };
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

async function setUp(): Promise<{ db: Db; userId: string; handle: string }> {
  const db = await freshDb();
  await createClient(db, { clientId: CLIENT_ID, registration: "cimd", redirectUris: [REDIRECT_URI] });
  const user = await createUser(db, { email: "round-trip@warthog.com.au", wrappedDek: "d3JhcHBlZA==" });
  await createConnection(
    db,
    { userId: user.id, connectorId: "gmail", accountLabel: "me@example.com", credentials: { token: "x" } },
    new Uint8Array(32).fill(7),
    fixedClock(NOW),
  );
  const begun = await beginAuthorization({ params: authorizeParams(), session: sessionFor(user.id) }, deps(db));
  if (!begun.ok) throw new Error(`begin failed: ${begun.error}`);
  return { db, userId: user.id, handle: begun.handle };
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

test("the consent view lists the person's own connected services by name", async () => {
  const { db, userId, handle } = await setUp();
  try {
    const props = await loadConsentView(handle, { db, userId, nameOf: (id) => (id === "gmail" ? "Gmail" : undefined) });
    assert.deepEqual(props?.services, [{ id: "gmail", name: "Gmail", ticked: false }]);
  } finally {
    await db.close();
  }
});

test("the toggles the person leaves on the screen are exactly the grants stored", async () => {
  const { db, userId, handle } = await setUp();
  try {
    const props = await loadConsentView(handle, { db, userId, nameOf: () => "Gmail" });
    assert.ok(props != null);
    // The person keeps Standard, unticks shared memory and tasks, ticks Gmail and card
    // requests (leaving the A$200 a month default) and high-tier.
    const left = {
      ...consentToggleState("standard", []),
      memoryRead: false,
      tasks: false,
      highTier: true,
      card: true,
      services: ["gmail"],
    };
    const markup = renderToStaticMarkup(
      <ConsentView {...props!} approveAction={async () => {}} refuseAction={async () => {}} initialState={left} />,
    );
    const approval = approvalFromForm(formDataOf(markup), props!.platform);
    const decided = await createAuthorizeActions(deps(db)).approve(sessionFor(userId), handle, approval);
    assert.ok(decided.ok, `approve succeeds, got ${JSON.stringify(decided)}`);

    const [agent] = await listAgentsForUser(db, userId);
    const grants = await getConnectionPermissions(db, userId, agent!.connectionId);
    assert.ok(grants != null);
    assert.equal(agent!.displayName, props!.defaultName, "the name field is submitted");
    assert.equal(grants!.identityAccess, true, "basic profile: ticked");
    assert.equal(grants!.memoryRead, false, "shared memory: unticked");
    assert.equal(grants!.tasksAccess, false, "tasks: unticked");
    assert.equal(grants!.recordsAccess, true, "life-admin records: ticked");
    assert.equal(grants!.highTierAccess, true, "high-tier: ticked");
    assert.equal(grants!.sharing, false, "sharing: unticked");
    assert.equal(grants!.cardAccess, true, "card requests: ticked");
    assert.deepEqual(grants!.cardBudget, { amount: 200, currency: "AUD", period: "month" });
    assert.deepEqual(grants!.grantedConnectors, ["gmail"], "the ticked service");
    assert.equal(grants!.changeTools, "ask_first");
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
      createAuthorizeActions(deps(db)).approve(sessionFor(userId), handle, approvalFromForm(form, "Claude")),
      (err: unknown) => err instanceof HttpError && err.status >= 400 && err.status < 500,
    );
    assert.equal((await listAgentsForUser(db, userId)).length, 0, "nothing is created");
    assert.ok((await loadConsentView(handle)) != null, "the pending request is still there to retry");
  } finally {
    await db.close();
  }
});
