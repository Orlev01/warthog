import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { loadConfig } from "./config";
import { assertProductionReleaseConfiguration } from "./production-readiness";

const ec = createECDH("prime256v1"); ec.generateKeys();
const point = ec.getPublicKey();
const jwk = { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url"), d: ec.getPrivateKey().toString("base64url") };
const url = (user: string) => `postgresql://${user}:synthetic-secret@db.example.test/warthog?sslmode=verify-full`;
const base = {
  DELETION_JOURNAL_CONTAINER: "account-deletions",
  NODE_ENV: "production", PUBLIC_BASE_URL: "https://app.example.test", WEBAUTHN_RP_ID: "example.test",
  DATABASE_URL: url("runtime"), MIGRATION_DATABASE_URL: url("migrate"), PURGE_DATABASE_URL: url("purge"),
  WARTHOG_HMAC_KEY: Buffer.alloc(32, 99).toString("base64"), KEY_VAULT_URL: "https://test.vault.azure.net", KEY_VAULT_KEY_NAME: "test-key",
  STORAGE_ACCOUNT: "warthogtest", STORAGE_CONTAINER: "receipts", OPERATOR_EMAIL: "operator@example.test", EXCHANGE_RATE_BASE_URL: "https://api.frankfurter.dev/v1",
  GOOGLE_CLIENT_ID: "google-id", GOOGLE_CLIENT_SECRET: "synthetic-google-secret", GOOGLE_EARLY_ACCESS: "owner@example.test",
  MICROSOFT_CLIENT_ID: "microsoft-id", MICROSOFT_CLIENT_SECRET: "synthetic-microsoft-secret",
  VAPID_SUBJECT: "mailto:operator@example.test", VAPID_PUBLIC_KEY: point.toString("base64url"), VAPID_PRIVATE_KEY: JSON.stringify(jwk),
  RESEND_API_KEY: "re_synthetic-secret", RESEND_FROM_ADDRESS: "notifications@mail.example.test",
  RESEND_SENDING_DOMAIN: "mail.example.test", RESEND_REPLY_TO_ADDRESS: "operator@support.example.test",
  TWILIO_ACCOUNT_SID: "AC" + "a".repeat(32), TWILIO_API_KEY_SID: "SK" + "b".repeat(32), TWILIO_API_KEY_SECRET: "synthetic-only",
  TWILIO_REGION: "us1", SMS_COUNTRY_ROUTES_JSON: JSON.stringify({ AU: "MG" + "c".repeat(32), GB: "MG" + "d".repeat(32) }),
  SMS_MONTHLY_SEGMENT_LIMIT: "200", SMS_DAILY_SEGMENT_LIMIT: "20", SMS_RECIPIENT_HOURLY_SEGMENT_LIMIT: "3",
  SMS_RECIPIENT_DAILY_MESSAGE_LIMIT: "3", SMS_MAX_SEGMENTS_PER_MESSAGE: "2",
};

test("production refuses a missing journal or one that shares the receipt container", () => {
  for (const value of ["", "receipts", "INVALID!"]) {
    assert.throws(() => assertProductionReleaseConfiguration(loadConfig({ ...base, DELETION_JOURNAL_CONTAINER: value })), /DELETION_JOURNAL_CONTAINER/);
  }
});

test("first-release startup requires the entire configured feature set and matching VAPID keys", () => {
  assert.doesNotThrow(() => assertProductionReleaseConfiguration(loadConfig(base)));
  for (const name of ["GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_ID", "VAPID_PRIVATE_KEY", "STORAGE_ACCOUNT", "OPERATOR_EMAIL", "RESEND_FROM_ADDRESS", "RESEND_API_KEY", "TWILIO_API_KEY_SECRET", "TWILIO_REGION", "SMS_COUNTRY_ROUTES_JSON", "SMS_RECIPIENT_DAILY_MESSAGE_LIMIT", "SMS_MAX_SEGMENTS_PER_MESSAGE"]) {
    assert.throws(() => assertProductionReleaseConfiguration(loadConfig({ ...base, [name]: "" })), new RegExp(name));
  }
  for (const change of [
    { PUBLIC_BASE_URL: "http://app.example.test" }, { WEBAUTHN_RP_ID: "unrelated.test" },
    { SMS_MONTHLY_SEGMENT_LIMIT: "0" }, { SMS_DAILY_SEGMENT_LIMIT: "201" }, { SMS_RECIPIENT_HOURLY_SEGMENT_LIMIT: "1.5" },
    { SMS_COUNTRY_ROUTES_JSON: '{"+1":"bad"}' }, { TWILIO_REGION: "au1" }, { SMS_MAX_SEGMENTS_PER_MESSAGE: "4" }, { VAPID_PUBLIC_KEY: Buffer.alloc(65, 9).toString("base64url") },
    { VAPID_PRIVATE_KEY: JSON.stringify({ ...jwk, d: "wrong-secret" }) },
  ]) {
    assert.throws(() => assertProductionReleaseConfiguration(loadConfig({ ...base, ...change })), (error: Error) => {
      assert.ok(!error.message.includes("synthetic-secret") && !error.message.includes("wrong-secret")); return true;
    });
  }
});

test("an app-scoped RP ID accepts the separately configured sibling email domain", () => {
  const config = loadConfig({ ...base, WEBAUTHN_RP_ID: "app.example.test" });
  assert.doesNotThrow(() => assertProductionReleaseConfiguration(config));
  assert.equal(config.webauthnRpId, "app.example.test");
  assert.throws(() => assertProductionReleaseConfiguration(loadConfig({ ...base,
    WEBAUTHN_RP_ID: "other.example.test" })), /WEBAUTHN_RP_ID/);
});

test("explicit SMS-off production needs no Twilio settings but still requires email and push", () => {
  const env = { ...base, SMS_ENABLED: "false" };
  for (const name of Object.keys(env)) {
    if (name.startsWith("TWILIO_") || (name.startsWith("SMS_") && name !== "SMS_ENABLED")) delete env[name];
  }
  assert.doesNotThrow(() => assertProductionReleaseConfiguration(loadConfig(env)));
  for (const name of ["RESEND_API_KEY", "VAPID_PRIVATE_KEY", "GOOGLE_CLIENT_SECRET"]) {
    assert.throws(() => assertProductionReleaseConfiguration(loadConfig({ ...env, [name]: "" })), new RegExp(name));
  }
  for (const enabled of [undefined, "true"]) {
    assert.throws(() => assertProductionReleaseConfiguration(loadConfig({ ...env, SMS_ENABLED: enabled })), /TWILIO/);
  }
  for (const enabled of ["", "0", "False", "typo"]) {
    assert.throws(() => loadConfig({ ...base, SMS_ENABLED: enabled }), /SMS_ENABLED/);
  }
});

test("production mail requires an exact sending domain and valid reply-to without leaking input", () => {
  for (const [name, value] of [
    ["RESEND_SENDING_DOMAIN", ""], ["RESEND_SENDING_DOMAIN", "https://mail.example.test"],
    ["RESEND_SENDING_DOMAIN", "*.example.test"], ["RESEND_SENDING_DOMAIN", "mail.example.test:443"],
    ["RESEND_FROM_ADDRESS", "notifications@mail.example.test.attacker.test"],
    ["RESEND_FROM_ADDRESS", "notifications@child.mail.example.test"],
    ["RESEND_FROM_ADDRESS", "notifications@other.example.test"],
    ["RESEND_REPLY_TO_ADDRESS", ""], ["RESEND_REPLY_TO_ADDRESS", "operator@support.example.test\r\nBcc: hidden@example.test"],
  ] as const) {
    assert.throws(() => assertProductionReleaseConfiguration(loadConfig({ ...base, [name]: value })), (error: Error) => {
      assert.match(error.message, new RegExp(name));
      assert.ok(!error.message.includes("synthetic-secret"));
      if (value) assert.ok(!error.message.includes(value));
      return true;
    });
  }
});
