import { smsSegments } from "./sms-content";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTwilioSmsSender, parseCountryRoutes } from "./twilio";
import { createResendEmailSender, normaliseMessagingEmail } from "./resend";
import { renderMessageEmail } from "./email";
import { normaliseInternationalPhone } from "../../domain/international-phone";

const sid = (prefix: string) => prefix + "a".repeat(32);
const config = { accountSid: sid("AC"), apiKeySid: sid("SK"), apiKeySecret: "synthetic-only-secret", region: "us1",
  countryRoutes: { US: sid("MG"), GB: sid("MG"), AU: sid("MG") }, maxSegmentsPerMessage: 2 };
const message = { recipient: "+14155552671", body: "Warthog code: 123456" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const emailConfig = { apiKey: "re_synthetic", from: "notifications@mail.example.test",
  sendingDomain: "mail.example.test", replyTo: "operator@support.example.test" };

test("international inputs never infer a default country", () => {
  assert.equal(normaliseInternationalPhone(" +44 (7700) 900-123 "), "+447700900123");
  assert.equal(normaliseInternationalPhone("+81 90 1234 5678"), "+819012345678");
  for (const value of ["0412345678", "0014155552671", "+0123456789", "+1234567890123456", "+14155552671 ext 5", "++14155552671"]) {
    assert.throws(() => normaliseInternationalPhone(value));
  }
});

test("country routes reject wildcards, prefixes and malformed configuration", () => {
  assert.deepEqual(parseCountryRoutes(JSON.stringify(config.countryRoutes)), config.countryRoutes);
  assert.deepEqual(parseCountryRoutes(undefined), {});
  for (const raw of ['{"+1":"x"}', '{"*":"x"}', '{"US":"https://evil.test"}', '[]', 'null', '{"us":"x"}', '{"ZZ":"x"}']) {
    assert.throws(() => parseCountryRoutes(raw), /SMS_COUNTRY_ROUTES_JSON/);
  }
});

test("Lookup country, not shared calling prefix, controls SMS; no paid enrichment", async () => {
  let sent = 0, reserved = 0;
  const sender = createTwilioSmsSender({ ...config, reserve: async () => { reserved++; }, fetch: async (url, init) => {
    sent++;
    assert.equal(String(url), "https://lookups.twilio.com/v2/PhoneNumbers/%2B14155552671");
    assert.equal(init?.redirect, "error");
    return json({ valid: true, phone_number: message.recipient, country_code: "CA" });
  } });
  await assert.rejects(sender.sendSms(message), /destination is not enabled/);
  assert.equal(sent, 1); assert.equal(reserved, 0);
});

test("Twilio sends only after reservation, preserves STOP handling, and requests body redaction", async () => {
  const order: string[] = [];
  const sender = createTwilioSmsSender({ ...config, reserve: async (phone, count) => {
    order.push("reserve"); assert.equal(phone, message.recipient); assert.equal(count, 1);
  }, fetch: async (url, init) => {
    assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    assert.ok(new Headers(init?.headers).get("Authorization")?.startsWith("Basic "));
    if (String(url).includes("lookups.")) { order.push("lookup"); return json({ valid: true, phone_number: message.recipient, country_code: "US" }); }
    order.push("send");
    assert.equal(String(url), `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`);
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("MessagingServiceSid"), sid("MG")); assert.equal(body.get("To"), message.recipient);
    assert.match(body.get("Body") ?? "", /Reply STOP to unsubscribe/);
    assert.equal(body.get("ContentRetention"), "discard"); assert.equal(body.get("AddressRetention"), null);
    assert.equal(body.get("SmartEncoded"), "false"); assert.equal(body.get("ValidityPeriod"), "120");
    assert.equal(body.get("From"), null); assert.equal(body.get("StatusCallback"), null);
    return json({ sid: sid("SM"), status: "queued" }, 201);
  } });
  await sender.sendSms(message); assert.deepEqual(order, ["lookup", "reserve", "send"]);
});

test("invalid, mismatched or non-geographic lookups cannot dispatch", async () => {
  for (const result of [{ valid: false }, { valid: true, phone_number: "+442079460000", country_code: "US" },
    { valid: true, phone_number: message.recipient, country_code: null }]) {
    let calls = 0;
    const sender = createTwilioSmsSender({ ...config, reserve: async () => assert.fail("must not reserve"), fetch: async () => { calls++; return json(result); } });
    await assert.rejects(sender.sendSms(message)); assert.equal(calls, 1);
  }
});

test("overlong messages and absent routes refuse before provider calls", async () => {
  const base = { ...config, reserve: async () => assert.fail(), fetch: async () => { assert.fail(); return json({}); } };
  await assert.rejects(createTwilioSmsSender(base).sendSms({ ...message, body: "界".repeat(135) }), /message limit/);
  await assert.rejects(createTwilioSmsSender({ ...base, countryRoutes: {} }).sendSms(message), /destination is not enabled/);
});

test("ambiguous provider failures are sanitized, never retried or refunded", async () => {
  let sends = 0, reservations = 0;
  const sender = createTwilioSmsSender({ ...config, reserve: async () => { reservations++; }, fetch: async (url) => {
    if (String(url).includes("lookups.")) return json({ valid: true, phone_number: message.recipient, country_code: "US" });
    sends++; throw new Error("private phone/code/API key payload");
  } });
  await assert.rejects(sender.sendSms(message), /SMS delivery failed$/);
  assert.equal(sends, 1); assert.equal(reservations, 1);
});

test("Resend supports international domains without exposing metadata or retrying errors", async () => {
  let calls = 0;
  const sender = createResendEmailSender({ ...emailConfig, fetch: async (url, init) => {
    calls++; assert.equal(url, "https://api.resend.com/emails"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    assert.match(new Headers(init?.headers).get("Idempotency-Key") ?? "", /^[a-f0-9-]{36}$/);
    // A message with no email content renders the generic layout: subject "Warthog", the
    // body as its paragraph and the link as an "Open Warthog" button, in HTML and text.
    const generic = renderMessageEmail({ recipient: "person@example.jp", body: "Your code: 123456", link: "https://app.example.test/signin" });
    assert.deepEqual(JSON.parse(String(init?.body)), { from: "Warthog <notifications@mail.example.test>", reply_to: "operator@support.example.test", to: ["person@example.jp"],
      subject: "Warthog", html: generic.html, text: generic.text });
    assert.match(generic.html, /href="https:\/\/app\.example\.test\/signin"/);
    assert.match(generic.text, /Your code: 123456/);
    assert.match(generic.text, /Open Warthog: https:\/\/app\.example\.test\/signin/);
    return json({ id: "synthetic-message-id" });
  } });
  await sender.sendEmail({ recipient: "person@example.jp", body: "Your code: 123456", link: "https://app.example.test/signin" });
  assert.equal(calls, 1);
  const failing = createResendEmailSender({ ...emailConfig, fetch: async () => { throw new Error("private payload"); } });
  await assert.rejects(failing.sendEmail({ recipient: "person@example.de", body: "code" }), /^Error: Email delivery failed$/);
  await assert.rejects(sender.sendEmail({ recipient: "person@example.jp\r\nBcc: leak@example.test", body: "code" }));
  assert.equal(calls, 1);
});


test("Resend sends the branded email's subject, HTML and text, with the configured logo", async () => {
  let sent: Record<string, unknown> | undefined;
  const sender = createResendEmailSender({ ...emailConfig, logoUrl: "https://app.example.test/icons/icon-192.png",
    fetch: async (_url, init) => { sent = JSON.parse(String(init?.body)); return json({ id: "synthetic" }); } });
  const email = { subject: "Your Warthog verification code", heading: "Your verification code",
    paragraphs: ["Enter this code in Warthog to continue. It expires in 10 minutes."], code: "246810",
    footnote: "If you didn't request this, you can ignore this email." };
  await sender.sendEmail({ recipient: "person@example.test", body: "Your Warthog verification code is 246810.", email });
  const rendered = renderMessageEmail({ recipient: "person@example.test", body: "", email }, { logoUrl: "https://app.example.test/icons/icon-192.png" });
  assert.deepEqual(Object.keys(sent ?? {}).sort(), ["from", "html", "reply_to", "subject", "text", "to"]);
  assert.equal(sent?.subject, "Your Warthog verification code");
  assert.equal(sent?.html, rendered.html);
  assert.equal(sent?.text, rendered.text);
  assert.match(String(sent?.html), /<img src="https:\/\/app\.example\.test\/icons\/icon-192\.png"/);
  assert.match(String(sent?.text), /^246810$/m);
  assert.ok(!String(sent?.subject).includes("246810"), "the code never reaches the subject");
});

test("international email domains are IDNA-normalized while unsupported SMTPUTF8 is explicit", () => {
  assert.equal(normaliseMessagingEmail("person@bücher.de"), "person@xn--bcher-kva.de");
  assert.equal(normaliseMessagingEmail("person@example.co.nz"), "person@example.co.nz");
  assert.throws(() => normaliseMessagingEmail("人@example.jp"), /Invalid email/);
});

test("sender identity normalizes domain casing and reply-to IDNA without changing the mailbox", async () => {
  let sent: Record<string, unknown> | undefined;
  const sender = createResendEmailSender({ ...emailConfig, from: "Notifications@MAIL.EXAMPLE.TEST",
    sendingDomain: "MAIL.EXAMPLE.TEST", replyTo: "Support@bücher.de",
    fetch: async (_url, init) => { sent = JSON.parse(String(init?.body)); return json({ id: "synthetic" }); } });
  await sender.sendEmail({ recipient: "person@example.test", body: "synthetic code" });
  assert.equal(sent?.from, "Warthog <Notifications@mail.example.test>");
  assert.equal(sent?.reply_to, "Support@xn--bcher-kva.de");
});

test("Resend quota refusal is reported without retries or a success acknowledgement", async () => {
  let calls = 0;
  const sender = createResendEmailSender({ ...emailConfig, fetch: async () => {
    calls++;
    return json({ message: "daily quota exceeded; private account metadata" }, 429);
  } });
  await assert.rejects(sender.sendEmail({ recipient: "person@example.test", body: "synthetic code" }), /^Error: Email delivery failed$/);
  assert.equal(calls, 1);
});


test("multipart budgets include smaller US/Canada toll-free segments and whole Unicode pairs", () => {
  assert.equal(smsSegments("a".repeat(305), true), 3);
  assert.equal(smsSegments("界".repeat(133), true), 3);
  assert.equal(smsSegments("😀".repeat(67), true), 3);
});

test("China cannot be enabled by configuration while approval messages contain links", async () => {
  const sender = createTwilioSmsSender({ ...config, countryRoutes: { CN: sid("MG") },
    reserve: async () => assert.fail("must not reserve"), fetch: async () => json({ valid: true, phone_number: "+8613800138000", country_code: "CN" }) });
  await assert.rejects(sender.sendSms({ recipient: "+8613800138000", body: "Approval", link: "https://app.example.test" }), /destination is not enabled/);
});
