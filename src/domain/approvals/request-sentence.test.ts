// Review fix C6 — what an approval reads as in the inbox. The person approves card
// purchases and identity releases from their phone, so the request has to say, in plain
// words, what the agent wants: the amount and merchant of a card request, the field of
// a high-tier request, the tool of a held change (brief "Approval inbox": "what it wants
// to do in plain words, the exact details (recipient, amount, field requested)").

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatMoney, highTierFieldLabel, requestSentence } from "./request-sentence";

test("formatMoney shows an amount in its currency the Australian way", () => {
  assert.equal(formatMoney(149.99, "AUD"), "$149.99");
  assert.equal(formatMoney(42, "AUD"), "$42.00");
  assert.match(formatMoney(100, "USD"), /USD\s?100\.00|US\$100\.00/);
});

test("formatMoney never throws on an unknown currency code: it shows the amount and code", () => {
  assert.equal(formatMoney(12.5, "NOT-A-CODE"), "12.50 NOT-A-CODE");
});

test("a card request reads as the amount and merchant", () => {
  assert.equal(
    requestSentence({ tool: "request_card", request: "card", amount: 149.99, currency: "AUD", merchant: "JB Hi-Fi" }),
    "wants to use your card for $149.99 at JB Hi-Fi",
  );
});

test("a high-tier request reads as the field it wants", () => {
  assert.equal(requestSentence({ tool: "request_identity_detail", request: "high_tier", field: "passport" }), "wants to see your passport");
  assert.equal(
    requestSentence({ tool: "request_identity_detail", request: "high_tier", field: "driver_licence" }),
    "wants to see your driver licence",
  );
  assert.equal(
    requestSentence({ tool: "request_identity_detail", request: "high_tier" }),
    "wants to see one of your protected details",
  );
});

// UI/UX pass content-02: the person decides at a glance, so a held change names the tool
// and the service in words, never as `google-gmail__send on google-gmail`.
test("a held change reads as the tool in words, in its service when it has one", () => {
  assert.equal(
    requestSentence({ tool: "google-gmail__send", connector: "google-gmail", service: "Gmail" }),
    "wants to use “Send” in Gmail",
  );
  assert.equal(
    requestSentence({ tool: "google_calendar__create_event", connector: "google_calendar" }),
    "wants to use “Create event” in Google calendar",
    "without a catalogue name the service id is tidied into words, never shown raw",
  );
  assert.equal(requestSentence({ tool: "remember" }), "wants to save a memory");
  assert.equal(requestSentence({ tool: "create_task" }), "wants to add a task");
  assert.equal(requestSentence({ tool: "some_new_tool" }), "wants to use “Some new tool”");
  for (const sentence of [
    requestSentence({ tool: "google-gmail__send", connector: "google-gmail", service: "Gmail" }),
    requestSentence({ tool: "some_new_tool" }),
  ]) {
    assert.doesNotMatch(sentence, /__|_tool|google-gmail/, `no internal id in "${sentence}"`);
  }
});

test("highTierFieldLabel turns a field code into words, and passes custom labels through", () => {
  assert.equal(highTierFieldLabel("date_of_birth"), "date of birth");
  assert.equal(highTierFieldLabel("car_registration"), "car registration");
  assert.equal(highTierFieldLabel("Medicare card"), "Medicare card");
});

// Several accounts of one service (docs/adr/google-published-and-accounts.md): the sentence
// names the account only when the caller passes one (the person has more than one).
test("a person with several accounts of a service sees which one the request uses", () => {
  const email = { kind: "email" as const, subject: "Friday", excerpt: "", text: "", reply: false, to: ["ana@example.com"], cc: [], bcc: [], linkDomains: [] };
  assert.equal(
    requestSentence({ tool: "google-gmail__send", connector: "google-gmail", service: "Gmail", recipients: ["ana@example.com"], outgoing: email, account: "work@gmail.test" }),
    "wants to send an email to ana@example.com from work@gmail.test",
  );
  assert.equal(
    requestSentence({ tool: "google-gmail__send", connector: "google-gmail", service: "Gmail", recipients: ["ana@example.com"], outgoing: email }),
    "wants to send an email to ana@example.com",
    "one account needs no naming",
  );
  assert.equal(
    requestSentence({ tool: "google-calendar__create", connector: "google-calendar", outgoing: { kind: "invite", title: "Site visit", guests: [] }, account: "home@gmail.test" }),
    "wants to add “Site visit” to your calendar (home@gmail.test)",
  );
  assert.equal(
    requestSentence({ tool: "notion__create_page", connector: "notion", service: "Notion", account: "Family workspace" }),
    "wants to use “Create page” in Notion (Family workspace)",
  );
  assert.equal(requestSentence({ tool: "remember", account: "ignored" }), "wants to save a memory", "Warthog's own tools have no account");
});
