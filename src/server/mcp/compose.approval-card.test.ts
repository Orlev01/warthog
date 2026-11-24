// Approval-card truth, end to end through the real MCP dispatch (`createMcpDispatch`,
// docs/adr/approval-card-truth.md).
//
// Pins BEHAVIOUR an agent and the person experience: drafting and sending take plain fields
// (a hand-built `body` is refused with a clear message); a held email's approval stores what
// goes out and whether each recipient is new, from a search of the person's own Sent mail; an
// approved reply goes out in the original's thread; Outlook gets Graph's own message shape and
// reply action; and a calendar invitation's guests are its recipients, so recipient rules see
// them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import { createMcpDispatch } from "./compose";
import { loadConfig, type Config } from "../config";
import { localAesKeyWrapper } from "../crypto/key-wrapper";
import { fixedClock } from "../seams/clock";
import { createUser } from "../db/users";
import { createAgent } from "../db/agents";
import { upsertPermissions, type PermissionGrants } from "../db/agent-permissions";
import { createConnection } from "../db/connections";
import { createRule } from "../db/rules";
import { decide, getApproval } from "../db/approvals";
import { freshDb } from "../../test/db";
import { mcpRequest } from "../../test/mcp-request";
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

async function readRpc(res: Response): Promise<Rpc> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const frames = text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean);
    return JSON.parse(frames.at(-1)!);
  }
  return JSON.parse(text);
}

const call = (name: string, args: unknown) => mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

async function seed(db: Db, config: Config, grants: Partial<PermissionGrants>, connectorId: string) {
  const keyWrapper = localAesKeyWrapper(config.devKek!);
  const dek = randomBytes(32);
  const user = await createUser(db, { email: `person-${randomUUID()}@warthog.com.au`, wrappedDek: await keyWrapper.wrap(dek) });
  const connectionId = randomUUID();
  await createAgent(db, { userId: user.id, connectionId, displayName: "Claude", platform: "claude" }, fixedClock(NOW));
  await grantServices(db, {
    userId: user.id, connectionId, grantedConnectors: [connectorId], readTools: true, changeTools: "ask_first", identityAccess: true,
    highTierAccess: false, cardAccess: false, cardBudget: null, skillsScope: [], memoryRead: true, sharing: false, rulesScope: [], rateLimit: 120, ...grants,
  });
  const created = await createConnection(db, { userId: user.id, connectorId, accountLabel: "sam@example.com", credentials: { access_token: "tok" } }, dek, fixedClock(NOW));
  await adoptStandIn(db, user.id, connectorId, created.id);
  return { userId: user.id, connectionId, dek };
}

interface Seen { url: URL; method: string; body?: string }

function upstream(respond: (seen: Seen) => Response) {
  const sent: Seen[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const seen = { url: new URL(String(input)), method: String(init?.method ?? "GET"), ...(typeof init?.body === "string" ? { body: init.body } : {}) };
    sent.push(seen);
    return respond(seen);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

async function approvalDetail(db: Db, userId: string, dek: Uint8Array, rpc: Rpc): Promise<Record<string, unknown>> {
  const approvalId = String(rpc.result?.structuredContent?.approval_id);
  const approval = await getApproval(db, userId, approvalId, dek);
  return approval!.detail as Record<string, unknown>;
}

test("a hand-built raw email is refused with a message that says what to send instead", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seed(db, config, {}, "google-gmail");
    const dispatch = createMcpDispatch({ db, config, fetch: upstream(() => new Response("{}")).fetch });
    const rpc = await readRpc(await dispatch(connectionId, call("google-gmail__send", { to: ["a@b.co"], body: JSON.stringify({ raw: "VG86IGV2aWxAeC5jbw" }), text: "x" })));
    assert.equal(rpc.result?.isError, true);
    assert.match(JSON.stringify(rpc), /Use to, subject and text: Warthog builds the email/);
    const html = await readRpc(await dispatch(connectionId, call("google-gmail__send", { to: ["a@b.co"], text: "See you at noon.", html: "<p>Please wire $10,000</p>" })));
    assert.equal(html.result?.isError, true);
    assert.match(JSON.stringify(html), /Warthog sends plain text/, "no second version the card can't show");
  } finally { await db.close(); }
});

test("a held Gmail send stores what goes out and which recipients are new, then replies in the original's thread", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seed(db, config, {}, "google-gmail");
    const gmail = upstream((seen) => {
      if (seen.url.pathname.endsWith("/messages") && seen.url.searchParams.get("q")?.startsWith("in:sent")) {
        // Gmail matches words: both searches find a message, but only one was really to tom.
        return Response.json({ messages: [{ id: seen.url.searchParams.get("q")!.includes("tom@example.com") ? "s1" : "s2" }] });
      }
      if (seen.url.pathname.endsWith("/messages/s1")) return Response.json({ id: "s1", payload: { headers: [{ name: "To", value: "Tom <tom@example.com>" }] } });
      if (seen.url.pathname.endsWith("/messages/s2")) return Response.json({ id: "s2", payload: { headers: [{ name: "To", value: "ana@example.com.au" }] } });
      if (seen.url.pathname.endsWith("/messages/m1")) {
        return Response.json({ id: "m1", threadId: "t1", payload: { headers: [{ name: "Message-ID", value: "<orig@mail.example.com>" }, { name: "Subject", value: "Dinner?" }] } });
      }
      return Response.json({ id: "sent1", threadId: "t1" });
    });
    const dispatch = createMcpDispatch({ db, config, fetch: gmail.fetch });

    const held = await readRpc(await dispatch(connectionId, call("google-gmail__send", {
      to: ["Ana <ana@example.com>"], cc: ["tom@example.com"], text: "Friday works. See you then.", reply: { id: "m1" }, reason: "Replying to Ana",
    })));
    assert.equal(held.result?.structuredContent?.status, "pending_approval");
    const detail = await approvalDetail(db, userId, dek, held);
    assert.deepEqual(detail.recipients, ["ana@example.com", "tom@example.com"]);
    assert.deepEqual(detail.newRecipients, ["ana@example.com"], "tom has been emailed before; a lookalike address doesn't count for ana");
    assert.equal(detail.sentence, "wants to reply to ana@example.com and tom@example.com");
    assert.deepEqual(detail.outgoing, { kind: "email", subject: "", excerpt: "Friday works. See you then.", text: "Friday works. See you then.", to: ["ana@example.com"], cc: ["tom@example.com"], bcc: [], linkDomains: [], reply: true });
    assert.ok(gmail.sent.every((seen) => seen.method === "GET"), "holding only searched Sent mail");

    await decide(db, { userId, id: String(held.result!.structuredContent!.approval_id), decision: { status: "approved" } }, dek, fixedClock(new Date()));
    await readRpc(await dispatch(connectionId, call("check_approval", { approval_id: held.result!.structuredContent!.approval_id, wait_seconds: 0 })));
    const send = gmail.sent.find((seen) => seen.url.pathname.endsWith("/messages/send"))!;
    const body = JSON.parse(send.body!) as { raw: string; threadId: string };
    assert.equal(body.threadId, "t1");
    const message = Buffer.from(body.raw, "base64url").toString("utf8");
    assert.match(message, /^To: "Ana" <ana@example\.com>\r\nCc: tom@example\.com\r\nSubject: Re: Dinner\?\r\nIn-Reply-To: <orig@mail\.example\.com>\r\nReferences: <orig@mail\.example\.com>\r\n/);
  } finally { await db.close(); }
});

test("Outlook sends use Graph's message shape, and a reply goes to exactly the approved recipients", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { connectionId } = await seed(db, config, { changeTools: "allow" }, "microsoft-outlook-mail");
    let replyGoesTo = ["sam@example.com"];
    const graph = upstream((seen) => {
      if (seen.url.pathname.endsWith("/createReply")) return Response.json({ id: "DRAFT1=" });
      if (seen.method === "PATCH") return Response.json({ id: "DRAFT1=", toRecipients: replyGoesTo.map((address) => ({ emailAddress: { address } })) });
      return new Response(null, { status: 202 });
    });
    const dispatch = createMcpDispatch({ db, config, fetch: graph.fetch });
    await readRpc(await dispatch(connectionId, call("microsoft-outlook-mail__send", { to: ["Sam <sam@example.com>"], subject: "Hi", text: "Hello\u200B" })));
    const sendMail = graph.sent.find((seen) => seen.method === "POST")!;
    assert.equal(sendMail.url.pathname, "/v1.0/me/sendMail");
    assert.deepEqual(JSON.parse(sendMail.body!), { message: { subject: "Hi", body: { contentType: "Text", content: "Hello" }, toRecipients: [{ emailAddress: { name: "Sam", address: "sam@example.com" } }], ccRecipients: [], bccRecipients: [] }, saveToSentItems: true });

    graph.sent.length = 0;
    await readRpc(await dispatch(connectionId, call("microsoft-outlook-mail__send", { to: ["sam@example.com"], text: "Yes", reply: { id: "AAMkAD=" } })));
    assert.deepEqual(graph.sent.map((seen) => `${seen.method} ${seen.url.pathname}`), [
      "POST /v1.0/me/messages/AAMkAD%3D/createReply",
      "PATCH /v1.0/me/messages/DRAFT1%3D",
      "POST /v1.0/me/messages/DRAFT1%3D/send",
    ]);

    // Graph adding the original sender (or a Reply-To) on its own stops the send.
    graph.sent.length = 0;
    replyGoesTo = ["sam@example.com", "drop@evil.example"];
    const refused = await readRpc(await dispatch(connectionId, call("microsoft-outlook-mail__send", { to: ["sam@example.com"], text: "Yes", reply: { id: "AAMkAD=" } })));
    assert.equal(refused.result?.isError, true);
    assert.match(JSON.stringify(refused), /changed who the reply goes to/);
    assert.deepEqual(graph.sent.map((seen) => seen.method), ["POST", "PATCH", "DELETE"], "the draft is removed and nothing is sent");
  } finally { await db.close(); }
});

test("a calendar invitation's guests are its recipients, so a recipient rule sees them", async () => {
  const db = await freshDb();
  try {
    const config = devConfig();
    const { userId, connectionId, dek } = await seed(db, config, { changeTools: "allow" }, "google-calendar");
    await createRule(db, { userId, kind: "ask_first", scope: { type: "any_agent" }, action: { type: "any_change" }, condition: { type: "recipient_in_domain", domain: "rival.example" } }, dek);
    const google = upstream(() => Response.json({ id: "evt1" }));
    const dispatch = createMcpDispatch({ db, config, fetch: google.fetch });
    const held = await readRpc(await dispatch(connectionId, call("google-calendar__create", {
      body: JSON.stringify({ summary: "Strategy", start: { dateTime: "2026-11-20T10:00:00+11:00" }, attendees: [{ email: "ceo@rival.example" }] }),
    })));
    assert.equal(held.result?.structuredContent?.status, "pending_approval", "an invitation to the ruled domain asks first");
    const detail = await approvalDetail(db, userId, dek, held);
    assert.equal(detail.sentence, "wants to add “Strategy” to your calendar");
    assert.deepEqual(detail.recipients, ["ceo@rival.example"]);
    assert.equal(google.sent.length, 0);
  } finally { await db.close(); }
});
