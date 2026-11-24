// Read-side protection — the connector result guard (`src/server/connectors/result-guard.ts`,
// docs/adr/read-side-protection.md).
//
// Pins BEHAVIOUR: every curated tool's success result is checked and marked; mail becomes the
// checked view; other services keep their shape with text values checked; a failed request,
// a cut-short mail reply, a provider result and a change are each handled the safe way; the
// numeric status survives (Undo reads it) and the evidence is counts only.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createResultGuard } from "./result-guard";
import { GOOGLE_CURATED_TOOLS } from "./curated/google";
import { MICROSOFT_CURATED_TOOLS } from "./curated/microsoft";
import { LINKEDIN_CURATED_TOOLS } from "./curated/linkedin";
import { successfulConnectorResult } from "../activity/calendar-reversal";
import type { AgentCall } from "../mcp/pipeline";

const guard = createResultGuard({ serviceName: (id) => ({ "google-gmail": "Gmail", "google-calendar": "Google Calendar" })[id] });
const call = (tool: string, extra: Partial<AgentCall> = {}): AgentCall => ({
  connector: tool.split("__")[0]!, tool, makesChange: false, connectorAccountLabel: "sam@example.com", ...extra,
});
const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

function gmailMessage(subject: string, text: string): string {
  return JSON.stringify({
    id: "18c1f2a3b4c5d6e7", threadId: "18c1f2a3b4c5d6e0", labelIds: ["INBOX"], snippet: text.slice(0, 40), internalDate: "1731712345678",
    payload: { mimeType: "text/plain", headers: [{ name: "Subject", value: subject }, { name: "From", value: "Ana <ana@example.com>" }], body: { size: text.length, data: b64url(text) } },
  });
}

describe("createResultGuard", () => {
  it("checks and marks every curated tool's successful result (no tool is left unchecked)", () => {
    for (const tool of [...GOOGLE_CURATED_TOOLS, ...MICROSOFT_CURATED_TOOLS, ...LINKEDIN_CURATED_TOOLS]) {
      const guarded = guard.review(call(tool.name, { makesChange: tool.makesChange }), { status: 200, body: "{}", truncated: false });
      const result = guarded.result as Record<string, unknown>;
      assert.match(String(result.notice), /^Checked by Warthog/, tool.name);
      assert.equal(result.status, 200, `${tool.name} keeps its numeric status`);
    }
  });

  it("turns a Gmail read into the checked view, with the notice first", () => {
    const guarded = guard.review(call("google-gmail__read", { params: { query: { id: "x", format: "raw" } } }), {
      status: 200, truncated: false,
      body: gmailMessage("Quote", "Hi Sam, your verification code is 482913. Track: https://auspost.com.au/track/1 Reset: https://x.example/reset-password?t=12345678"),
    });
    const result = guarded.result as { notice: string; source: Record<string, unknown>; message: Record<string, unknown> };
    assert.deepEqual(Object.keys(result).slice(0, 2), ["notice", "source"]);
    assert.deepEqual(result.source, { service: "Gmail", account: "sam@example.com" });
    assert.match(String(result.message.text), /\[sign-in code hidden by Warthog\]/);
    assert.match(String(result.message.text), /https:\/\/auspost\.com\.au\/track\/1/);
    assert.match(String(result.message.text), /\[sign-in link hidden by Warthog\]/);
    assert.ok(!JSON.stringify(result).includes("482913"));
    assert.equal(guarded.evidence.outcome, "masked");
    // The code is counted once: a full read's preview comes from the checked text.
    assert.deepEqual(guarded.evidence.counts, { signInLinks: 1, codes: 1 });
  });

  it("stubs a sign-in code email and reports it as stubbed", () => {
    const guarded = guard.review(call("google-gmail__read"), { status: 200, truncated: false, body: gmailMessage("123456 is your Instagram code", "Your code is 123456") });
    const message = (guarded.result as { message: Record<string, unknown> }).message;
    assert.equal(message.withheld, true);
    assert.equal(message.text, undefined);
    assert.equal(guarded.evidence.outcome, "stubbed");
  });

  it("withholds a mail reply that was cut short instead of guessing at it", () => {
    const guarded = guard.review(call("google-gmail__read"), { status: 200, truncated: true, body: '{"id":"x","payload":{"body":{"data":"SGVsbG' });
    const result = guarded.result as Record<string, unknown>;
    assert.equal(result.withheld, true);
    assert.equal(result.status, 200);
    assert.equal(guarded.evidence.outcome, "withheld");
  });

  it("keeps a calendar reply's shape, ids and meeting passcodes, and checks its text", () => {
    const guarded = guard.review(call("google-calendar__list"), {
      status: 200, truncated: false,
      body: JSON.stringify({ items: [{ id: "evt1", summary: "Dinner​", description: "Zoom https://us02web.zoom.us/j/845 Passcode: 123456", htmlLink: "https://calendar.google.com/event?eid=1" }] }),
    });
    const result = guarded.result as { body: string; status: number };
    assert.deepEqual(JSON.parse(result.body), { items: [{ id: "evt1", summary: "Dinner", description: "Zoom https://us02web.zoom.us/j/845 Passcode: 123456", htmlLink: "https://calendar.google.com/event?eid=1" }] });
    assert.equal(result.status, 200);
  });

  it("keeps a change's reply usable for Undo (numeric 2xx status) and empty bodies intact", () => {
    const created = guard.review(call("google-calendar__create", { makesChange: true }), { status: 200, truncated: false, body: '{"id":"evt9","summary":"Site visit"}' });
    assert.equal(successfulConnectorResult(created.result), true);
    const deleted = guard.review(call("google-calendar__delete", { makesChange: true }), { status: 204, truncated: false, body: "" });
    assert.equal(successfulConnectorResult(deleted.result), true);
  });

  it("drops OneDrive's pre-authenticated download link", () => {
    const guarded = guard.review(call("microsoft-onedrive__read"), { status: 200, truncated: false, body: JSON.stringify({ id: "i1", name: "Quote.pdf", "@microsoft.graph.downloadUrl": "https://public.example/dl?tempauth=x" }) });
    assert.ok(!(guarded.result as { body: string }).body.includes("tempauth"));
    assert.equal(guarded.evidence.counts?.downloadLinks, 1);
  });

  it("passes a failed request's reply through unchanged (the pipeline never shows it to the agent)", () => {
    const failed = { status: 403, body: '{"error":"denied"}', truncated: false };
    assert.equal(guard.review(call("google-gmail__read"), failed).result, failed);
  });

  it("checks a provider tool's text blocks and withholds what it can't check", () => {
    const guarded = guard.review(call("notion__search", { makesChange: true, requiresApproval: true }), {
      content: [{ type: "text", text: "Page: Plans​ — login code 482913" }, { type: "image", data: "iVBORw0", mimeType: "image/png" }],
      structuredContent: { title: "Plans\u{E0041}" },
      _meta: { secret: "x" },
    });
    const result = guarded.result as { notice: string; content: { text: string }[]; structuredContent: { title: string }; _meta?: unknown };
    assert.match(result.notice, /^Checked by Warthog/);
    assert.equal(result.content[0]!.text, "Page: Plans — login code [sign-in code hidden by Warthog]");
    assert.equal(result.content[1]!.text, "[non-text content withheld by Warthog]");
    assert.equal(result.structuredContent.title, "Plans");
    assert.equal(result._meta, undefined);
  });

  it("checks Outlook search results one message at a time", () => {
    const guarded = guard.review(call("microsoft-outlook-mail__search"), {
      status: 200, truncated: false,
      body: JSON.stringify({ value: [
        { id: "m1", subject: "Lunch?", body: { contentType: "html", content: "<p>Lunch at 12?</p>" }, from: { emailAddress: { address: "tom@example.com" } } },
        { id: "m2", subject: "Your Microsoft account security code", body: { contentType: "text", content: "Security code: 558812" } },
      ], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skip=25" }),
    });
    const result = guarded.result as { messages: Record<string, unknown>[]; nextLink: string; nextSkip?: string };
    assert.equal(result.messages[0]!.text, "Lunch at 12?");
    assert.equal(result.messages[1]!.withheld, true);
    assert.ok(!JSON.stringify(result).includes("558812"));
    assert.match(result.nextLink, /\$skip=25/);
    assert.equal(result.nextSkip, "25", "the view says how to ask for the next page");
    const searched = guard.review(call("microsoft-outlook-mail__search"), {
      status: 200, truncated: false,
      body: JSON.stringify({ value: [], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?%24search=%22lunch%22&%24skiptoken=MSZZ%3d%3d" }),
    });
    assert.equal((searched.result as { nextSkipToken?: string }).nextSkipToken, "MSZZ==", "a search pages with Graph's token");
  });

  it("opens the recently-read window for what someone else wrote, and only that", () => {
    const guard2 = createResultGuard({ serviceName: () => "Svc", category: (id) => ({ nylas: "calendar", ntfy: "messaging", todoist: "productivity" })[id] });
    // A display name can't fake the sender: the last angle-address is the real one.
    const spoof = guard2.review(call("google-gmail__read"), { status: 200, truncated: false, body: gmailMessage("Hi", "x").replace("Ana <ana@example.com>", "\\\"Westpac <alerts@westpac.com.au>\\\" <evil@x.co>") });
    assert.equal(spoof.exposure?.sender, "evil@x.co");
    // A cut-short event list was still shown, so it counts.
    assert.equal(guard2.review(call("google-calendar__list"), { status: 200, truncated: true, body: '{"items":[{"summary":"x' }).exposure?.kind, "event");
    // A Gmail search shows previews: the first message someone else wrote counts, the person's own sent mail doesn't.
    const meta = (id: string, from: string, labelIds: string[]) => ({ id, threadId: id, labelIds, snippet: "Hi", payload: { mimeType: "text/plain", headers: [{ name: "From", value: from }, { name: "Subject", value: "Hi" }] } });
    const searched = guard2.review(call("google-gmail__search"), { status: 200, truncated: false, body: JSON.stringify({ summaries: true, messages: [meta("a", "Sam <sam@example.com>", ["SENT"]), meta("b", "Billing <billing@payfast-au.co>", ["INBOX"])] }) });
    assert.equal(searched.exposure?.sender, "billing@payfast-au.co");
    // It says which of the person's inboxes it was read in.
    const inInbox = guard2.review(call("google-gmail__search", { connectorAccountLabel: "levyoren1@gmail.com" }), { status: 200, truncated: false, body: JSON.stringify({ summaries: true, messages: [meta("b", "Billing <billing@payfast-au.co>", ["INBOX"])] }) });
    assert.deepEqual(inInbox.exposure, { service: "Svc", kind: "email", sender: "billing@payfast-au.co", account: "levyoren1@gmail.com" });
    const ownOnly = guard2.review(call("google-gmail__search"), { status: 200, truncated: false, body: JSON.stringify({ summaries: true, messages: [meta("a", "Sam <sam@example.com>", ["SENT"])] }) });
    assert.equal(ownOnly.exposure, undefined);
    // A Drive file Warthog couldn't read, or one link asked for again, shows nothing new.
    assert.equal(guard2.review(call("google-drive__read_text"), { status: 200, truncated: false, body: JSON.stringify({ name: "a.pdf", unreadable: true, note: "x" }) }).exposure, undefined);
    assert.equal(guard2.review(call("google-drive__read_text"), { status: 200, truncated: false, body: "Budget,2026" }).exposure?.kind, "file");
    assert.equal(guard2.review(call("google-gmail__read", { params: { query: { id: "m", link: "1" } } }), { status: 200, truncated: false, body: gmailMessage("Hi", "see https://a.example/x") }).exposure, undefined);
    // The person's own Outlook mail doesn't.
    const own = guard2.review(call("microsoft-outlook-mail__read"), { status: 200, truncated: false, body: JSON.stringify({ id: "m", subject: "Re: hi", from: { emailAddress: { address: "sam@example.com" } }, body: { contentType: "text", content: "x" } }) });
    assert.equal(own.exposure, undefined);
    // Reads (by method) through email, messaging and calendar services count; the person's own tools don't.
    const get = (tool: string) => call(tool, { params: { method: "GET", path: "/x" }, makesChange: tool.startsWith("ntfy") });
    assert.equal(guard2.review(get("nylas__request"), { status: 200, truncated: false, body: "{}" }).exposure?.kind, "message");
    assert.equal(guard2.review(get("ntfy__request"), { status: 200, truncated: false, body: "{}" }).exposure?.kind, "message");
    assert.equal(guard2.review(get("todoist__request"), { status: 200, truncated: false, body: "{}" }).exposure, undefined);
  });
});

// The person's "what agents see" level (docs/adr/read-side-protection.md, amendment 24 November
// 2026), carried on the call by the pipeline: every path checks at that level, and the evidence
// says when a result was shown at a level other than the default.
describe("createResultGuard at the person's level", () => {
  const signIn = () => gmailMessage("123456 is your Instagram code", "Your code is 123456. Reset: https://x.example/reset-password?t=12345678");

  it("checks at standard when the call carries no level, and says nothing about the level", () => {
    const guarded = guard.review(call("google-gmail__read"), { status: 200, truncated: false, body: signIn() });
    assert.equal((guarded.result as { message: Record<string, unknown> }).message.withheld, true);
    assert.equal((guarded.evidence as { level?: string }).level, undefined);
    const standard = guard.review(call("google-gmail__read", { readLevel: "standard" }), { status: 200, truncated: false, body: signIn() });
    assert.deepEqual(standard.evidence, guarded.evidence);
  });

  it("at open, shows a sign-in email in full, still strips hidden characters, and records the level", () => {
    const guarded = guard.review(call("google-gmail__read", { readLevel: "open" }), { status: 200, truncated: false, body: gmailMessage("123456 is your Instagram code", "Your code​ is 123456. Reset: https://x.example/reset-password?t=12345678") });
    const message = (guarded.result as { notice: string; message: Record<string, unknown> }).message;
    assert.match(String((guarded.result as { notice: string }).notice), /^Checked by Warthog/);
    assert.equal(message.withheld, undefined);
    assert.equal(message.text, "Your code is 123456. Reset: https://x.example/reset-password?t=12345678");
    assert.deepEqual(guarded.evidence, { outcome: "shown", counts: { hiddenCharacters: 1 }, level: "open" });
    // The recently-read window still opens.
    assert.equal(guarded.exposure?.sender, "ana@example.com");
  });

  it("at open, a search's sign-in email is a preview like any other and download links stay", () => {
    const meta = { id: "b", threadId: "b", labelIds: ["INBOX"], snippet: "Your code is 123456", payload: { mimeType: "text/plain", headers: [{ name: "From", value: "Instagram <security@mail.instagram.com>" }, { name: "Subject", value: "123456 is your Instagram code" }] } };
    const searched = guard.review(call("google-gmail__search", { readLevel: "open" }), { status: 200, truncated: false, body: JSON.stringify({ summaries: true, messages: [meta] }) });
    const first = (searched.result as { messages: Record<string, unknown>[] }).messages[0]!;
    assert.equal(first.withheld, undefined);
    assert.equal(first.subject, "123456 is your Instagram code");
    const file = guard.review(call("microsoft-onedrive__read", { readLevel: "open" }), { status: 200, truncated: false, body: JSON.stringify({ id: "i1", "@microsoft.graph.downloadUrl": "https://public.example/dl?tempauth=x" }) });
    assert.match((file.result as { body: string }).body, /tempauth/);
  });

  it("at private, hides identifying numbers in every path and counts them", () => {
    const line = "Your TFN is 123 456 782 and BSB 062-000.";
    const mail = guard.review(call("google-gmail__read", { readLevel: "private" }), { status: 200, truncated: false, body: gmailMessage("Tax return", line) });
    assert.equal((mail.result as { message: { text: string } }).message.text, "Your TFN is [number hidden by Warthog] and BSB [number hidden by Warthog].");
    assert.deepEqual(mail.evidence, { outcome: "masked", counts: { identifiers: 2 }, level: "private" });

    const rest = guard.review(call("xero__request", { readLevel: "private" }), { status: 200, truncated: false, body: JSON.stringify({ BankAccountNumber: "062000 12345678", Name: "Everyday" }) });
    assert.deepEqual(JSON.parse((rest.result as { body: string }).body), { BankAccountNumber: "[number hidden by Warthog]", Name: "Everyday" });

    const text = guard.review(call("google-drive__read_text", { readLevel: "private" }), { status: 200, truncated: false, body: `Medicare card 2123 45670 1` });
    assert.equal((text.result as { body: string }).body, "Medicare card [number hidden by Warthog]");

    const provider = guard.review(call("notion__search", { makesChange: true, requiresApproval: true, readLevel: "private" }), {
      content: [{ type: "text", text: "Passport number PA1234567" }], structuredContent: { note: "Acct: 98765432" },
    });
    const result = provider.result as { content: { text: string }[]; structuredContent: { note: string } };
    assert.equal(result.content[0]!.text, "Passport number [number hidden by Warthog]");
    assert.equal(result.structuredContent.note, "Acct: [number hidden by Warthog]");
    assert.equal(provider.evidence.counts?.identifiers, 2);

    const outlook = guard.review(call("microsoft-outlook-mail__search", { readLevel: "private" }), {
      status: 200, truncated: false,
      body: JSON.stringify({ value: [{ id: "m1", subject: "Your bill", body: { contentType: "text", content: "Account number 1234 5678" } }] }),
    });
    assert.equal((outlook.result as { messages: Record<string, unknown>[] }).messages[0]!.text, "Account number [number hidden by Warthog]");
  });
});
