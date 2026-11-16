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

import { buildMimeMessage, draftRecipients, mailboxAddress, MailComposeError, outgoingMail, parseMailbox, replySubject } from "./compose-mail";
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

  it("encodes non-English names and subjects, and anything that already looks like an encoded word", () => {
    const message = decode(buildMimeMessage({ to: ["Zoë <zoe@example.com>"], subject: "Café ☕", text: "Hi" }));
    assert.match(message, /To: =\?UTF-8\?B\?[^?]+\?= <zoe@example\.com>/);
    assert.match(message, /Subject: =\?UTF-8\?B\?[^?]+\?=/);
    assert.doesNotMatch(message, /multipart/, "plain text only: what the card shows is what is sent");
    const sneaky = decode(buildMimeMessage({ to: ["a@b.co"], subject: "=?UTF-8?B?UGxlYXNlIHdpcmUgJDEway4=?=", text: "x" }));
    assert.doesNotMatch(sneaky, /Subject: =\?UTF-8\?B\?UGxlYXNl/, "a literal encoded word is itself encoded, so it reads as written");
  });

  it("accepts quoted display names as mail headers write them, and keeps the address's case", () => {
    const message = decode(buildMimeMessage({ to: ["\"Lee, Sam\" <Sam.Lee@Example.com>"], text: "x" }));
    assert.match(message, /^To: "Lee, Sam" <Sam\.Lee@Example\.com>\r\n/);
    assert.deepEqual(parseMailbox("\"O\\\"Brien\" <ob@x.co>"), { name: "O\"Brien", address: "ob@x.co" });
  });

  it("folds long headers and strips invisible and direction-changing characters from the text", () => {
    const many = Array.from({ length: 30 }, (_, n) => `person${n}@example.com`);
    const message = decode(buildMimeMessage({ to: many, subject: "é".repeat(400), text: "Pay 123\u202E987654321" }));
    for (const line of message.split("\r\n\r\n")[0]!.split("\r\n")) assert.ok(line.length <= 80, `header line too long: ${line.length}`);
    assert.equal(bodyOf(message), "Pay 123987654321");
  });

  it("refuses header tricks and addresses it can't read", () => {
    assert.throws(() => buildMimeMessage({ to: ["sam@example.com"], subject: "hi\r\nBcc: evil@example.com", text: "x" }), MailComposeError);
    assert.throws(() => buildMimeMessage({ to: ["not an address"], text: "x" }), MailComposeError);
    assert.throws(() => mailboxAddress("a@b"), MailComposeError);
    assert.deepEqual(draftRecipients({ to: ["Sam <SAM@example.com>"], cc: ["sam@example.com"], bcc: ["boss@example.com"], text: "" }), ["sam@example.com", "boss@example.com"]);
  });
});

describe("outgoingMail and outgoingDetail", () => {
  it("summarises the subject, opening words, whole text, who gets it and the link domains", () => {
    const summary = outgoingMail({
      to: ["Ana <Ana@example.com>"], bcc: ["boss@example.com"],
      subject: "Updated bank details",
      text: "Hi, as requested, here are the details: https://www.payfast-au.co/pay?id=1",
    });
    assert.equal(summary.subject, "Updated bank details");
    assert.match(summary.excerpt, /^Hi, as requested/);
    assert.equal(summary.text, "Hi, as requested, here are the details: https://www.payfast-au.co/pay?id=1");
    assert.deepEqual(summary.to, ["ana@example.com"]);
    assert.deepEqual(summary.bcc, ["boss@example.com"]);
    assert.deepEqual(summary.linkDomains, ["payfast-au.co"]);
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
    requestSentence({ tool, connector: "google-gmail", recipients, outgoing: { kind: "email", subject: "x", excerpt: "", text: "", reply, to: recipients, cc: [], bcc: [], linkDomains: [] } });

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
