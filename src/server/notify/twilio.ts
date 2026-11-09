import { normaliseInternationalPhone } from "../../domain/international-phone";
import { smsSegments } from "./sms-content";
import type { SmsSender } from "./senders";

// ISO 3166-1 alpha-2. Calling-code prefixes are deliberately not permissions:
// +1 includes multiple countries and +44 includes separate island territories.
const COUNTRIES = new Set("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" "));

export function parseCountryRoutes(raw: string | undefined): Readonly<Record<string, string>> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const entries = Object.entries(value);
    if (entries.some(([country, sid]) => !COUNTRIES.has(country) || typeof sid !== "string" || !/^MG[a-fA-F0-9]{32}$/.test(sid))) throw new Error();
    return Object.fromEntries(entries);
  } catch { throw new Error("Invalid configuration: SMS_COUNTRY_ROUTES_JSON"); }
}

export interface TwilioConfig {
  readonly accountSid?: string;
  readonly apiKeySid?: string;
  readonly apiKeySecret?: string;
  readonly region?: string;
  readonly countryRoutes: Readonly<Record<string, string>>;
  readonly maxSegmentsPerMessage: number;
}

export function validateTwilioConfiguration(config: TwilioConfig): void {
  for (const [name, valid] of [
    ["TWILIO_ACCOUNT_SID", /^AC[a-fA-F0-9]{32}$/.test(config.accountSid ?? "")],
    ["TWILIO_API_KEY_SID", /^SK[a-fA-F0-9]{32}$/.test(config.apiKeySid ?? "")],
    ["TWILIO_API_KEY_SECRET", !!config.apiKeySecret && !/[\s:]/.test(config.apiKeySecret)],
    ["TWILIO_REGION", config.region === "us1"],
    ["SMS_MAX_SEGMENTS_PER_MESSAGE", Number.isSafeInteger(config.maxSegmentsPerMessage) && config.maxSegmentsPerMessage > 0],
  ] as const) if (!valid) throw new Error(`Invalid configuration: ${name}`);
  parseCountryRoutes(JSON.stringify(config.countryRoutes));
}

export class SmsUnavailableError extends Error {
  constructor(message = "SMS is unavailable; use email or check Warthog") { super(message); this.name = "SmsUnavailableError"; }
}

export function createTwilioSmsSender(deps: TwilioConfig & {
  reserve: (recipient: string, segments: number) => Promise<void>;
  fetch?: typeof fetch;
}): SmsSender {
  validateTwilioConfiguration(deps);
  const request = deps.fetch ?? fetch;
  const authorization = `Basic ${Buffer.from(`${deps.apiKeySid}:${deps.apiKeySecret}`).toString("base64")}`;
  return { async sendSms(message) {
    const recipient = normaliseInternationalPhone(message.recipient);
    // First-release routes must support replies and provider STOP suppression.
    // One-way/alpha senders need a separately reviewed opt-out implementation.
    const text = (message.link ? `${message.body}\n${message.link}` : message.body) + "\nReply STOP to unsubscribe.";
    const segments = smsSegments(text, true);
    if (segments > deps.maxSegmentsPerMessage) throw new SmsUnavailableError("SMS message limit reached");
    if (!Object.keys(deps.countryRoutes).length) throw new SmsUnavailableError("SMS destination is not enabled");
    let country: string;
    try {
      // Basic Lookup only: never add Fields or paid enrichment packages. Do not
      // log this URL (it contains the number), response or credential headers.
      const response = await request(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(recipient)}`, {
        headers: { Authorization: authorization }, redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error();
      const result = await response.json() as { valid?: unknown; phone_number?: unknown; country_code?: unknown };
      if (result.valid !== true || result.phone_number !== recipient || typeof result.country_code !== "string" || !COUNTRIES.has(result.country_code)) throw new Error();
      country = result.country_code;
    } catch { throw new SmsUnavailableError("SMS number validation failed"); }
    // Existing approval messages contain URLs, prohibited by the current China
    // route guidance. Do not let a configuration entry silently override this.
    if (country === "CN") throw new SmsUnavailableError("SMS destination is not enabled");
    const service = Object.hasOwn(deps.countryRoutes, country) ? deps.countryRoutes[country] : undefined;
    if (!service) throw new SmsUnavailableError("SMS destination is not enabled");
    try { await deps.reserve(recipient, segments); }
    catch { throw new SmsUnavailableError("SMS limit reached"); }
    // No refunds/retries: a timeout may occur after acceptance. Acceptance does
    // not mean delivery. Retain provider STOP suppression; don't obfuscate numbers.
    try {
      const body = new URLSearchParams({ MessagingServiceSid: service, To: recipient, Body: text,
        ContentRetention: "discard", SmartEncoded: "false", ValidityPeriod: "120" });
      const response = await request(`https://api.twilio.com/2010-04-01/Accounts/${deps.accountSid}/Messages.json`, {
        method: "POST", headers: { Authorization: authorization, "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(), redirect: "error", signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error();
      const result = await response.json() as { sid?: unknown; status?: unknown };
      if (typeof result.sid !== "string" || !/^SM[a-fA-F0-9]{32}$/.test(result.sid) ||
        !["accepted", "queued", "sending", "sent", "delivered"].includes(String(result.status))) throw new Error();
    } catch { throw new SmsUnavailableError("SMS delivery failed"); }
  } };
}
