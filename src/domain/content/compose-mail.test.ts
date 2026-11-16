// Approval-card truth — Warthog builds the email from plain fields, and summarises it for the
// approval card (`src/domain/content/compose-mail.ts`, `src/domain/approvals/outgoing.ts`,
// docs/adr/approval-card-truth.md).
//
// Pins BEHAVIOUR: the built message is exactly the fields given (recipients, subject, text),
// threads correctly as a reply, encodes non-English text, refuses header tricks and addresses
// it can't read; and the card's summary shows the subject, the opening words, text the
// recipient won't see and the domains it links to.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildMimeMessage, draftRecipients, mailboxAddress, MailComposeError, outgoingMail, replySubject } from "./compose-mail";
import { outgoingDetail } from "../approvals/outgoing";
import { requestSentence } from "../approvals/request-sentence";

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");
const bodyOf = (message: string) => Buffer.from(message.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString("utf8");

describe("buildMimeMessage", () => {
  it("builds a plain-text email from the fields given", () => {
    const message = decode(buildMimeMessage({ to: ["Sam Lee <sam@example.com>"], cc: ["tom@example.com"], subject: "Thursday", text: "See you at 10." }));
    assert.match(message, /^To: "Sam Lee" <sam@example\.com>\r\nCc: tom@example\.com\r\nSubject: Thursday\r\nMIME-Version: 1\.0\r\nContent-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n/);
    assert.equal(bodyOf(message), "See you at 10.");
  });

  it("threads a reply under the original and gives it a Re: subject", () => {
    const message = decode(buildMimeMessage({ to: ["sam@example.com"], text: "Yes" }, { messageId: "<b@x>", references: "<a@x>", subject: "Dinner?" }));
    assert.match(message, /Subject: Re: Dinner\?\r\n/);
    assert.match(message, /In-Reply-To: <b@x>\r\n/);
    assert.match(message, /References: <a@x> <b@x>\r\n/);
    assert.equal(replySubject("RE: Dinner?"), "RE: Dinner?");
  });

  it("encodes non-English names and subjects, and sends HTML alongside the text", () => {
    const message = decode(buildMimeMessage({ to: ["Zoë <zoe@example.com>"], subject: "Café ☕", text: "Hi", html: "<p>Hi</p>" }));
    assert.match(message, /To: =\?UTF-8\?B\?[^?]+\?= <zoe@example\.com>/);
    assert.match(message, /Subject: =\?UTF-8\?B\?[^?]+\?=/);
    assert.match(message, /multipart\/alternative/);
  });

  it("refuses header tricks and addresses it can't read", () => {
    assert.throws(() => buildMimeMessage({ to: ["sam@example.com"], subject: "hi\r\nBcc: evil@example.com", text: "x" }), MailComposeError);
    assert.throws(() => buildMimeMessage({ to: ["not an address"], text: "x" }), MailComposeError);
    assert.throws(() => mailboxAddress("a@b"), MailComposeError);
    assert.deepEqual(draftRecipients({ to: ["Sam <SAM@example.com>"], cc: ["sam@example.com"], bcc: ["boss@example.com"], text: "" }), ["sam@example.com", "boss@example.com"]);
  });
});

describe("outgoingMail and outgoingDetail", () => {
  it("summarises the subject, opening words, hidden text and link domains", () => {
    const summary = outgoingMail({
      subject: "Updated bank details",
      text: "Hi, as requested, here are the details: https://www.payfast-au.co/pay?id=1",
      html: "<p>Hi</p><div style=\"display:none\">account 123 to x@evil.example</div><a href=\"https://evil.example/x\">here</a>",
    });
    assert.equal(summary.subject, "Updated bank details");
    assert.match(summary.excerpt, /^Hi, as requested/);
    assert.ok(summary.hiddenFromRecipient >= 1);
    assert.deepEqual([...summary.linkDomains].sort(), ["evil.example", "payfast-au.co"]);
  });

  it("describes each kind of outgoing request from the same input the tool runs with", () => {
    assert.equal(outgoingDetail({ tool: "google-gmail__send", connector: "google-gmail", params: { to: ["a@b.co"], text: "Hello", reply: { id: "x" } } })?.kind, "email");
    assert.deepEqual(outgoingDetail({ tool: "google-calendar__create", connector: "google-calendar", recipients: ["sarah@acme.com.au"], params: { body: JSON.stringify({ summary: "Site visit", start: { dateTime: "2026-11-20T10:00:00+11:00" } }) } }),
      { kind: "invite", title: "Site visit", start: "2026-11-20T10:00:00+11:00", guests: ["sarah@acme.com.au"] });
    assert.deepEqual(outgoingDetail({ tool: "ntfy__request", connector: "ntfy", params: { method: "GET", path: "/topic/publish", query: { message: "x" } } }),
      { kind: "request", method: "GET", path: "/topic/publish", queryKeys: ["message"] });
    assert.deepEqual(outgoingDetail({ tool: "zapier__send", connector: "zapier", requiresApproval: true, params: { arguments: { to: "x@y.z", note: "hi​" } } }),
      { kind: "provider", arguments: [{ key: "to", preview: "x@y.z" }, { key: "note", preview: "hi" }] });
    assert.equal(outgoingDetail({ tool: "remember", connector: null, params: { text: "x" } }), undefined);
  });
});

describe("requestSentence for outgoing email and invitations", () => {
  const email = (tool: string, recipients: string[], reply = false) =>
    requestSentence({ tool, connector: "google-gmail", recipients, outgoing: { kind: "email", subject: "x", excerpt: "", reply, hiddenFromRecipient: 0, linkDomains: [] } });

  it("names who it goes to", () => {
    assert.equal(email("google-gmail__send", ["sam@example.com"]), "wants to send an email to sam@example.com");
    assert.equal(email("google-gmail__send", ["a@x.co", "b@x.co", "c@x.co"]), "wants to send an email to a@x.co and 2 others");
    assert.equal(email("google-gmail__draft", ["sam@example.com"], true), "wants to save a draft reply to sam@example.com");
    assert.equal(email("google-gmail__send", ["sam@example.com"], true), "wants to reply to sam@example.com");
  });

  it("names the event for a calendar invitation", () => {
    assert.equal(requestSentence({ tool: "google-calendar__create", connector: "google-calendar", outgoing: { kind: "invite", title: "Site visit", guests: [] } }), "wants to add “Site visit” to your calendar");
    assert.equal(requestSentence({ tool: "google-calendar__update", connector: "google-calendar", outgoing: { kind: "invite", title: "Site visit", guests: [] } }), "wants to change “Site visit” in your calendar");
  });
});
