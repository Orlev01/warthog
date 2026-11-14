import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createAcsEmailSender, createAcsSmsSender, smsSegments } from "./acs";
import { renderMessageEmail } from "./email";

const key = Buffer.alloc(32, 7);
const connectionString = `endpoint=https://test.communication.azure.com/;accesskey=${key.toString("base64")}`;
const now = new Date("2026-11-09T00:00:00Z");

test("SMS refuses destinations outside the explicit calling-code list before reserving or sending", async () => {
  let attempts = 0;
  const options = { connectionString, from: "+61400000000", reserve: async () => { attempts++; }, fetch: async () => { attempts++; return Response.json({}); } };
  await assert.rejects(createAcsSmsSender(options).sendSms({ recipient: "+61400000001", body: "test" }), /destination/);
  await assert.rejects(createAcsSmsSender({ ...options, allowedCallingCodes: ["+61"] }).sendSms({ recipient: "+12025550123", body: "test" }), /destination/);
  assert.equal(attempts, 0);
});

test("SMS counts GSM extensions and UTF-16 multipart segments, including the link", () => {
  assert.equal(smsSegments("a".repeat(160)), 1);
  assert.equal(smsSegments("a".repeat(161)), 2);
  assert.equal(smsSegments("^".repeat(81)), 2);
  assert.equal(smsSegments("漢".repeat(70)), 1);
  assert.equal(smsSegments("漢".repeat(71)), 2);
  assert.equal(smsSegments("😀".repeat(36)), 2);
  assert.equal(smsSegments("^".repeat(153)), 3, "a GSM escape pair cannot straddle segments");
  assert.equal(smsSegments("😀".repeat(67)), 3, "a surrogate pair cannot straddle segments");
  assert.throws(() => smsSegments(""));
});

test("SMS reserves billable segments then signs the exact request and checks per-recipient acceptance", async () => {
  const events: string[] = [];
  const sms = createAcsSmsSender({ connectionString, from: "+61400000000", allowedCallingCodes: ["+61"], now: () => now,
    reserve: async (recipient, count) => { assert.equal(recipient, "+61400000001"); assert.equal(count, 2); events.push("reserve"); },
    fetch: async (url, init) => {
      events.push("send");
      assert.equal(String(url), "https://test.communication.azure.com/sms?api-version=2021-03-07");
      const body = String(init?.body);
      const hash = createHash("sha256").update(body).digest("base64");
      const signature = createHmac("sha256", key).update(`POST\n/sms?api-version=2021-03-07\n${now.toUTCString()};test.communication.azure.com;${hash}`).digest("base64");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`);
      assert.equal(headers.get("x-ms-content-sha256"), hash);
      assert.equal(init?.redirect, "error");
      assert.deepEqual(JSON.parse(body).smsRecipients, [{ to: "+61400000001" }]);
      assert.ok(JSON.parse(body).message.endsWith("\nhttps://example.test/inbox"));
      return Response.json({ value: [{ to: "+61400000001", successful: true, httpStatusCode: 202 }] });
    },
  });
  await sms.sendSms({ recipient: "+61400000001", body: "a".repeat(160), link: "https://example.test/inbox" });
  assert.deepEqual(events, ["reserve", "send"]);
});

test("SMS refuses invalid numbers, exhausted limits and provider rejection without leaking payload or keys", async () => {
  let calls = 0;
  const options = { connectionString, from: "+61400000000", allowedCallingCodes: ["+61"], reserve: async () => {},
    fetch: async () => { calls++; return Response.json({ value: [{ successful: false, errorMessage: "private-provider-detail" }] }); } };
  const sender = createAcsSmsSender(options);
  await assert.rejects(sender.sendSms({ recipient: "bad", body: "private-code" }), /recipient/);
  assert.equal(calls, 0);
  await assert.rejects(sender.sendSms({ recipient: "+61400000001", body: "private-code" }), (e: Error) => {
    assert.equal(e.message, "SMS delivery failed"); assert.equal(e.cause, undefined); return true;
  });
  const limited = createAcsSmsSender({ ...options, reserve: async () => { throw new Error("SMS limit reached"); } });
  await assert.rejects(limited.sendSms({ recipient: "+61400000001", body: "private-code" }), /limit/);
  assert.equal(calls, 1);
});

test("SMS rejects unsafe configured endpoints and refuses automatic redirects", () => {
  for (const endpoint of ["http://test.communication.azure.com", "https://localhost", "https://test.communication.azure.com.evil.test", "https://user:pass@test.communication.azure.com"]) {
    assert.throws(() => createAcsSmsSender({ connectionString: `endpoint=${endpoint};accesskey=${key.toString("base64")}`, from: "+61400000000", reserve: async () => {} }), /configuration/);
  }
});

test("Email sends the branded HTML and text and waits for successful ACS acceptance; errors contain no provider details", async () => {
  let message: unknown;
  const sender = createAcsEmailSender({ senderAddress: "no-reply@mail.example.test", client: {
    beginSend: async (input) => { message = input; return { pollUntilDone: async () => ({ status: "Succeeded" }) }; },
  } });
  await sender.sendEmail({ recipient: "person@example.test", body: "Your code", link: "https://example.test/" });
  const generic = renderMessageEmail({ recipient: "person@example.test", body: "Your code", link: "https://example.test/" });
  assert.deepEqual(message, { senderAddress: "no-reply@mail.example.test", recipients: { to: [{ address: "person@example.test" }] },
    content: { subject: "Warthog", plainText: generic.text, html: generic.html } });
  assert.match(generic.text, /Open Warthog: https:\/\/example\.test\//);
  const email = { subject: "New passkey added", heading: "A new passkey was added", paragraphs: ["A new passkey was added to your Warthog account."] };
  await sender.sendEmail({ recipient: "person@example.test", body: "plain", email });
  assert.equal((message as { content: { subject: string } }).content.subject, "New passkey added");
  assert.equal((message as { content: { html: string } }).content.html, renderMessageEmail({ recipient: "", body: "", email }).html);
  for (const status of ["Failed", "Canceled", "Running"]) {
    const failing = createAcsEmailSender({ senderAddress: "no-reply@mail.example.test", client: { beginSend: async () => ({ pollUntilDone: async () => ({ status }) }) } });
    await assert.rejects(failing.sendEmail({ recipient: "person@example.test", body: "secret" }), /^Error: Email delivery failed$/);
  }
  const failing = createAcsEmailSender({ senderAddress: "no-reply@mail.example.test", client: { beginSend: async () => { throw new Error("private-response-token"); } } });
  await assert.rejects(failing.sendEmail({ recipient: "person@example.test", body: "secret" }), (e: Error) => e.message === "Email delivery failed" && e.cause === undefined);
});
