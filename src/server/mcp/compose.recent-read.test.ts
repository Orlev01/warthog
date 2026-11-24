// The "recently read" heads-up and narrow holds, end to end through the real MCP dispatch
// (docs/adr/read-side-protection.md).
//
// Pins BEHAVIOUR: after an agent the person lets act alone reads an email from someone else,
// a send to an address the person has never emailed, or an invitation with guests, is held
// with a reason; a send to a known address, a draft, and anything after reading the person's
// OWN sent mail go ahead as before. An agent that already asks first gets no new approvals —
// its approvals just say what it recently read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createMcpDispatch } from "./compose";
import { loadConfig, type Config } from "../config";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { upsertPermissions } from "../db/agent-permissions";
import { createConnection } from "../db/connections";
import { decide, getApproval } from "../db/approvals";
import { createRule } from "../db/rules";
import { freshDb } from "../../test/db";
import type { Db } from "../db/index";

import { adoptStandIn, grantServices } from "../../test/grants";
const NOW = new Date("2026-11-16T00:00:00.000Z");

function devConfig(): Config {
  return loadConfig({
    NODE_ENV: "development",
    PUBLIC_BASE_URL: "https://warthog.example",
    WEBAUTHN_RP_ID: "localhost",
    DATABASE_URL: "pglite:memory",
    WARTHOG_HMAC_KEY: Buffer.alloc(48, 0x2a).toString("base64"),
    WARTHOG_DEV_KEK: Buffer.alloc(32, 0x5c).toString("base64"),
  } as NodeJS.ProcessEnv);
}

type Rpc = { result?: { content?: { text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> } };

async function rpc(dispatch: ReturnType<typeof createMcpDispatch>, connectionId: string, name: string, args: unknown): Promise<Rpc> {
  const res = await dispatch(connectionId, new Request("https://warthog.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }));
  const text = await res.text();
  const frame = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).at(-1)!
    : text;
  return JSON.parse(frame) as Rpc;
}

const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

function message(id: string, from: string, labels: string[]) {
  return {
    id, threadId: `t-${id}`, labelIds: labels, internalDate: "1763251200000",
    payload: { mimeType: "text/plain", headers: [{ name: "From", value: from }, { name: "Subject", value: "Invoice" }], body: { data: b64url("Please update the bank details.") } },
  };
}

// A fake Google: two messages to read, Sent mail that has only ever gone to the accountant.
function google() {
  const sent: { method: string; url: URL }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET");
    sent.push({ method, url });
    if (url.pathname.endsWith("/messages/stranger")) return Response.json(message("stranger", "Billing <billing@payfast-au.co>", ["INBOX"]));
    if (url.pathname.endsWith("/messages/mine")) return Response.json(message("mine", "Sam <sam@example.com>", ["SENT"]));
    if (url.pathname.endsWith("/messages") && url.searchParams.get("q")?.startsWith("in:sent")) {
      return Response.json(url.searchParams.get("q")!.includes("accountant@example.com") ? { messages: [{ id: "s1" }] } : {});
    }
    if (url.pathname.endsWith("/messages/s1")) return Response.json({ id: "s1", payload: { headers: [{ name: "To", value: "accountant@example.com" }] } });
    return Response.json({ id: "done" });
  }) as typeof globalThis.fetch;
  return { fetch, sends: () => sent.filter((s) => s.method === "POST") };
}

async function seed(db: Db, config: Config, changeTools: "allow" | "ask_first", connectors: string[]) {
  const keyWrapper = localAesKeyWrapper(config.devKek!);
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `p-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const connectionId = randomUUID();
  await createAgent(db, { userId: user.id, connectionId, displayName: "Claude", platform: "claude" }, fixedClock(NOW));
  await grantServices(db, {
    userId: user.id, connectionId, grantedConnectors: connectors, readTools: true, changeTools, identityAccess: true,
    highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false, rulesScope: [], rateLimit: 120,
  });
  for (const connectorId of connectors) {
    const created = await createConnection(db, { userId: user.id, connectorId, accountLabel: "sam@example.com", credentials: { access_token: "tok", api_key: "k" } }, dek, fixedClock(NOW));
    await adoptStandIn(db, user.id, connectorId, created.id);
  }
  return { userId: user.id, connectionId, dek };
}

const send = (to: string) => ({ to: [to], subject: "Bank details", text: "Here they are." });

test("after reading a stranger's email, an 'allowed' agent's send to a new address is held with a reason", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seed(db, config, "allow", ["google-gmail"]);
    const g = google();
    const dispatch = createMcpDispatch({ db, config, fetch: g.fetch });

    const before = await rpc(dispatch, connectionId, "google-gmail__send", send("billing@payfast-au.co"));
    assert.notEqual(before.result?.structuredContent?.status, "pending_approval", "before reading anything, an allowed agent just sends");

    await rpc(dispatch, connectionId, "google-gmail__read", { query: { id: "stranger" } });
    const held = await rpc(dispatch, connectionId, "google-gmail__send", send("billing@payfast-au.co"));
    assert.equal(held.result?.structuredContent?.status, "pending_approval");
    const detail = (await getApproval(db, userId, String(held.result!.structuredContent!.approval_id), dek))!.detail as Record<string, unknown>;
    assert.equal(detail.readCheck, true);
    assert.deepEqual(detail.newRecipients, ["billing@payfast-au.co"]);
    const sources = (detail.recentRead as { sources: { at?: string }[] }).sources;
    assert.deepEqual(sources.map(({ at, ...rest }) => (assert.ok(at), rest)), [{ service: "Gmail", kind: "email", sender: "billing@payfast-au.co", account: "sam@example.com" }], "who wrote it and the inbox it was read in, never what it said");

    const known = await rpc(dispatch, connectionId, "google-gmail__send", send("accountant@example.com"));
    assert.notEqual(known.result?.structuredContent?.status, "pending_approval", "a known address goes ahead");
    const draft = await rpc(dispatch, connectionId, "google-gmail__draft", send("newperson@example.org"));
    assert.notEqual(draft.result?.structuredContent?.status, "pending_approval", "a draft reaches no one, so it is never held for this");
    assert.equal(g.sends().length, 3, "the first send, the known address and the draft");
  } finally { await db.close(); }
});

test("reading the person's own sent mail opens no window", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seed(db, config, "allow", ["google-gmail"]);
    const dispatch = createMcpDispatch({ db, config, fetch: google().fetch });
    await rpc(dispatch, connectionId, "google-gmail__read", { query: { id: "mine" } });
    const sent = await rpc(dispatch, connectionId, "google-gmail__send", send("newperson@example.org"));
    assert.notEqual(sent.result?.structuredContent?.status, "pending_approval");
  } finally { await db.close(); }
});

test("after reading a stranger's email, an invitation with guests is held; one without guests isn't", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seed(db, config, "allow", ["google-gmail", "google-calendar"]);
    const dispatch = createMcpDispatch({ db, config, fetch: google().fetch });
    await rpc(dispatch, connectionId, "google-gmail__read", { query: { id: "stranger" } });
    const alone = await rpc(dispatch, connectionId, "google-calendar__create", { body: JSON.stringify({ summary: "Dentist" }) });
    assert.notEqual(alone.result?.structuredContent?.status, "pending_approval");
    const invite = await rpc(dispatch, connectionId, "google-calendar__create", { body: JSON.stringify({ summary: "Call", attendees: [{ email: "billing@payfast-au.co" }] }) });
    assert.equal(invite.result?.structuredContent?.status, "pending_approval");
    const edit = await rpc(dispatch, connectionId, "google-calendar__update", { query: { eventId: "evt1", sendUpdates: "all" }, body: JSON.stringify({ description: "New link: https://evil.example" }) });
    assert.equal(edit.result?.structuredContent?.status, "pending_approval", "editing an event notifies its existing guests, so it is checked too");
  } finally { await db.close(); }
});

test("an agent that already asks first gets no new approvals; its approvals say what it recently read", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seed(db, config, "ask_first", ["google-gmail"]);
    const dispatch = createMcpDispatch({ db, config, fetch: google().fetch });
    await rpc(dispatch, connectionId, "google-gmail__read", { query: { id: "stranger" } });
    const held = await rpc(dispatch, connectionId, "google-gmail__send", send("accountant@example.com"));
    assert.equal(held.result?.structuredContent?.status, "pending_approval", "held as it always was");
    const detail = (await getApproval(db, userId, String(held.result!.structuredContent!.approval_id), dek))!.detail as Record<string, unknown>;
    assert.equal(detail.readCheck, undefined, "not held because of the read");
    assert.ok(detail.recentRead, "but the card can say what it recently read");
  } finally { await db.close(); }
});

test("a never-allow rule still refuses while a window is open, and approving a held send carries it out", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seed(db, config, "allow", ["google-gmail"]);
    await createRule(db, { userId, kind: "never_allow", scope: { type: "any_agent" }, action: { type: "send_message", channel: "email" }, condition: { type: "recipient_in_domain", domain: "evil.example" } }, dek);
    const g = google();
    const dispatch = createMcpDispatch({ db, config, fetch: g.fetch });
    await rpc(dispatch, connectionId, "google-gmail__read", { query: { id: "stranger" } });
    const refused = await rpc(dispatch, connectionId, "google-gmail__send", send("drop@evil.example"));
    assert.equal(refused.result?.isError, true, "never-allow wins over the window's ask");
    const held = await rpc(dispatch, connectionId, "google-gmail__send", send("billing@payfast-au.co"));
    const approvalId = String(held.result?.structuredContent?.approval_id);
    await decide(db, { userId, id: approvalId, decision: { status: "approved" } }, dek, fixedClock(new Date()));
    await rpc(dispatch, connectionId, "check_approval", { approval_id: approvalId, wait_seconds: 0 });
    assert.ok(g.sends().some((s) => s.url.pathname.endsWith("/messages/send")), "approval satisfies the ask");
  } finally { await db.close(); }
});
