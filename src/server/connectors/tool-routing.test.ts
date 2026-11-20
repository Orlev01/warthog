// Review fix D5 — the connector tool routing's pure pieces: which connector tools a
// connection is served, and the recipients a mail tool's body names (so recipient rules
// can match). The routing through the composed MCP dispatch is pinned end to end in
// src/server/mcp/compose.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";

import { connectorToolsetFor, messageRecipients, REQUEST_TOOL } from "./tool-routing";
import type { CatalogueIndex } from "./catalogue";
import type { CatalogueEntry } from "../../domain/catalogue/schema";
import type { Connection } from "../db/connections";

function entry(id: string): CatalogueEntry {
  return { id, name: id, aliases: [], category: "test", auth_kind: "api_key", base_url: "https://api.example", auth: {} };
}

const catalogue = {
  get: (id: string) => (["amadeus", "google-gmail"].includes(id) ? entry(id) : undefined),
} as unknown as CatalogueIndex;

function connection(connectorId: string, status: Connection["status"] = "connected"): Connection {
  return { id: `c-${connectorId}`, userId: "u", connectorId, accountLabel: "me", status, connectedAt: new Date(0) };
}

test("only granted, connected, catalogued services contribute tools; curated ones get no request tool", () => {
  const toolset = connectorToolsetFor(
    [connection("amadeus"), connection("google-gmail"), connection("unknown"), connection("alpaca", "needs_reconnect")],
    ["amadeus", "google-gmail", "unknown", "alpaca"],
    catalogue,
  );
  assert.deepEqual(Object.keys(toolset).sort(), ["amadeus", "google-gmail"]);
  const names = (id: string) => (toolset[id] ?? []).map((tool) => (typeof tool === "string" ? tool : tool.name));
  assert.deepEqual(names("amadeus"), [REQUEST_TOOL]);
  assert.ok(names("google-gmail").includes("send") && !names("google-gmail").includes(REQUEST_TOOL));
  const send = (toolset["google-gmail"] ?? []).find((tool) => typeof tool !== "string" && tool.name === "send");
  assert.ok(send && typeof send !== "string" && send.messageChannel === "email" && send.makesChange === true);
});

test("messageRecipients reads Gmail MIME headers and Outlook recipient lists", () => {
  const raw = Buffer.from("To: Ann <ann@a.example>, bob@b.example\r\nCc: cat@c.example\r\nSubject: x\r\n\r\nTo: not@body.example").toString("base64url");
  assert.deepEqual(messageRecipients(JSON.stringify({ message: { raw } })), ["ann@a.example", "bob@b.example", "cat@c.example"]);
  const outlook = { message: { toRecipients: [{ emailAddress: { address: "dan@d.example" } }], bccRecipients: [{ emailAddress: { address: "eve@e.example" } }] } };
  assert.deepEqual(messageRecipients(JSON.stringify(outlook)), ["dan@d.example", "eve@e.example"]);
  assert.deepEqual(messageRecipients("not json"), []);
  assert.deepEqual(messageRecipients(undefined), []);
});

test("Gmail discovery explains search/read arguments and distinguishes an unsent draft from sending", () => {
  const gmailCatalogue = { get: () => ({ ...entry("google-gmail"), name: "Gmail" }) } as unknown as CatalogueIndex;
  const tools = connectorToolsetFor([connection("google-gmail")], ["google-gmail"], gmailCatalogue)["google-gmail"]!;
  const get = (name: string) => {
    const tool = tools.find(t => typeof t !== "string" && t.name === name);
    assert.ok(tool && typeof tool !== "string");
    return tool;
  };
  assert.equal(get("search").title, "Gmail: Search messages");
  assert.match(get("search").description!, /query\.q/);
  assert.match(get("read").description!, /query\.id/);
  assert.match(get("draft").description!, /nothing is sent/i);
  assert.match(get("draft").description!, /to, subject and text/);
  assert.match(get("send").description!, /send an email/i);
  assert.match(get("send").description!, /Warthog builds a plain-text email/);
});

test("LinkedIn offers its profile, a post that always asks first, and deleting a post", () => {
  const linkedIn = { get: () => ({ ...entry("linkedin"), name: "LinkedIn", category: "social" }) } as unknown as CatalogueIndex;
  const tools = connectorToolsetFor([connection("linkedin")], ["linkedin"], linkedIn)["linkedin"]!;
  const get = (name: string) => {
    const tool = tools.find(t => typeof t !== "string" && t.name === name);
    assert.ok(tool && typeof tool !== "string", name);
    return tool;
  };
  assert.deepEqual(tools.map((t) => (typeof t === "string" ? t : t.name)), ["profile", "create_post", "delete_post"]);
  assert.equal(get("profile").makesChange, false);
  assert.equal(get("profile").alwaysAsk, undefined);
  const post = get("create_post");
  assert.equal(post.makesChange, true);
  assert.equal(post.alwaysAsk, true, "a post always asks the person, whatever the agent may do alone");
  assert.equal(post.messageChannel, "post", "a person's \"never post\" rule matches it");
  assert.equal(post.outbound, true);
  assert.equal(post.alwaysOutbound, true, "a post always reaches other people");
  assert.match(post.description!, /approv/i);
  assert.ok(post.schema!.safeParse({ text: "Hello", visibility: "PUBLIC", link: { url: "https://example.com" } }).success);
  assert.ok(!post.schema!.safeParse({ text: "x".repeat(3001) }).success, "LinkedIn's limit is checked at the boundary");
  assert.ok(!post.schema!.safeParse({ text: "Hi", visibility: "EVERYONE" }).success);
  // A post Warthog won't send is refused at the boundary, before anyone is asked to approve it.
  for (const bad of [
    { text: "Hi", link: { url: "http://example.com" } },
    { text: "Hi", link: { url: "https://user:pw@example.com" } },
    { text: "Hi", link: { url: "https://10.0.0.1/x" } },
    { text: "\u200b\u200b" },
    { text: "(".repeat(2000) + "x".repeat(999) },
  ]) assert.ok(!post.schema!.safeParse(bad).success, JSON.stringify(bad).slice(0, 60));
  const extra = post.schema!.safeParse({ text: "Hi", author: "urn:li:person:someone-else" });
  assert.ok(extra.success && !("author" in (extra.data as object)), "nothing else rides along");
  assert.equal(get("delete_post").makesChange, true);
  assert.equal(get("delete_post").alwaysAsk, true, "an agent's delete can't be undone, so the person is asked (Undo is the person's own action)");
  assert.match(get("delete_post").description!, /query\.id/);
});
