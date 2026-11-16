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
  assert.match(get("send").description!, /Warthog builds the email/);
});
