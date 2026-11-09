import { createECDH } from "node:crypto";
import { isIP } from "node:net";
import { assertProductionDatabaseConfiguration, type Config } from "./config";
import { validateTwilioConfiguration } from "./notify/twilio";
import { createResendEmailSender } from "./notify/resend";

// Pure validation of the current draft contract; no provider calls. Valid settings
// do not prove account eligibility, grants, DNS, quota or actual delivery.
export function assertProductionReleaseConfiguration(config: Config): void {
  if (config.nodeEnv !== "production") return;
  assertProductionDatabaseConfiguration(config);
  function valid(name: string, ok: unknown): asserts ok {
    if (!ok) throw new Error(`Invalid production configuration: ${name}`);
  }
  function https(name: string, value: string | undefined): URL {
    try {
      const url = new URL(value ?? "");
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error();
      return url;
    } catch { throw new Error(`Invalid production configuration: ${name}`); }
  }
  const address = https("PUBLIC_BASE_URL", config.publicBaseUrl);
  valid("PUBLIC_BASE_URL", address.pathname === "/" && address.hostname.includes(".") && !isIP(address.hostname));
  valid("WEBAUTHN_RP_ID", /^[a-z0-9.-]+$/.test(config.webauthnRpId) && config.webauthnRpId.includes(".")
    && (address.hostname === config.webauthnRpId || address.hostname.endsWith(`.${config.webauthnRpId}`)));
  const email = (value: string | undefined) => typeof value === "string" && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
  valid("OPERATOR_EMAIL", email(config.operatorEmail));
  https("EXCHANGE_RATE_BASE_URL", config.exchangeRateBaseUrl);
  valid("STORAGE_ACCOUNT", /^[a-z0-9]{3,24}$/.test(config.blob.account ?? ""));
  valid("STORAGE_CONTAINER", /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.blob.container ?? ""));
  for (const [prefix, client] of [["GOOGLE", config.connectorClients?.google], ["MICROSOFT", config.connectorClients?.microsoft]] as const) {
    valid(`${prefix}_CLIENT_ID`, client?.clientId?.trim());
    valid(`${prefix}_CLIENT_SECRET`, client?.clientSecret?.trim());
  }
  valid("GOOGLE_EARLY_ACCESS", config.googleEarlyAccess.length > 0 && config.googleEarlyAccess.every(email));
  valid("VAPID_SUBJECT", config.vapid.subject?.startsWith("mailto:") && email(config.vapid.subject.slice(7)));
  valid("VAPID_PRIVATE_KEY", config.vapid.privateKey);
  let point: Buffer;
  try {
    const jwk = JSON.parse(config.vapid.privateKey) as Record<string, unknown>;
    if (jwk.kty !== "EC" || jwk.crv !== "P-256") throw new Error();
    const parts = ["d", "x", "y"].map((name) => {
      const value = jwk[name];
      if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error();
      const bytes = Buffer.from(value, "base64url");
      if (bytes.length !== 32 || bytes.toString("base64url") !== value) throw new Error();
      return bytes;
    });
    const ec = createECDH("prime256v1"); ec.setPrivateKey(parts[0]!);
    point = ec.getPublicKey();
    parts[0]!.fill(0);
    if (!point.subarray(1, 33).equals(parts[1]!) || !point.subarray(33).equals(parts[2]!)) throw new Error();
  } catch { throw new Error("Invalid production configuration: VAPID_PRIVATE_KEY"); }
  valid("VAPID_PUBLIC_KEY", config.vapid.publicKey === point.toString("base64url"));
  valid("MESSAGING_CONFIGURATION", config.messaging);
  validateTwilioConfiguration(config.messaging.twilio);
  createResendEmailSender(config.messaging.email); // construction validates; no network
  valid("SMS_COUNTRY_ROUTES_JSON", Object.keys(config.messaging.twilio.countryRoutes).length > 0 && !Object.hasOwn(config.messaging.twilio.countryRoutes, "CN"));
  const limits = config.messaging.smsLimits;
  for (const [name, value] of [["SMS_MONTHLY_SEGMENT_LIMIT", limits.monthly], ["SMS_DAILY_SEGMENT_LIMIT", limits.daily],
    ["SMS_RECIPIENT_HOURLY_SEGMENT_LIMIT", limits.recipientHourly], ["SMS_RECIPIENT_DAILY_MESSAGE_LIMIT", limits.recipientDailyMessages]] as const) {
    valid(name, Number.isSafeInteger(value) && value > 0);
  }
  valid("SMS_DAILY_SEGMENT_LIMIT", limits.daily <= limits.monthly);
  valid("SMS_RECIPIENT_HOURLY_SEGMENT_LIMIT", limits.recipientHourly <= limits.daily);
  valid("SMS_MAX_SEGMENTS_PER_MESSAGE", config.messaging.twilio.maxSegmentsPerMessage <= limits.recipientHourly);
}
