// The runtime config seam. This is the ONLY module that reads `process.env`:
// feature code imports typed config from here and never touches the environment
// directly (constitution: secrets-from-env; INV-103). It also refuses to start an
// unsafe production process — dev tools or an in-process pglite database must never
// run in production — and an incomplete one: production wraps every data key under the
// Key Vault KEK, so it refuses to load without the vault URL and key name, and it refuses
// the dev HMAC key published in .env.example.
//
// `loadConfig(env)` is a pure function of an env record so the contract is testable
// without mutating the real environment. `loadConfig()` with no argument reads the
// real `process.env` (the production call site).

import { createHash } from "node:crypto";
import { parseCountryRoutes, type TwilioConfig } from "./notify/twilio";
import type { SmsLimits } from "./notify/sms-budget";

// A local-development fallback only. When the host injects `PORT` (12-factor,
// INV-104) the server binds that value; this fallback never overrides it.
const DEV_FALLBACK_PORT = 3000;

export interface KeyVaultConfig {
  readonly url: string | undefined;
  readonly keyName: string | undefined;
}

export interface AcsConfig {
  readonly emailConnectionString: string | undefined;
  readonly smsConnectionString: string | undefined;
  readonly emailSenderAddress?: string;
  readonly smsFromNumber?: string;
  readonly smsAllowedCallingCodes?: readonly string[];
  readonly smsLimits?: { monthly: number; daily: number; recipientHourly: number };
}

export interface VapidConfig {
  readonly subject: string | undefined;
  readonly publicKey: string | undefined;
  readonly privateKey: string | undefined;
}

// The private blob storage account + container receipt files live in (design §2).
// Read from the environment here — never baked into source (INV-103) — and
// undefined when unset, like the keyVault / acs groups; the composition root wires
// them into the Azure-backed blob store in production.
export interface BlobConfig {
  readonly account: string | undefined;
  readonly container: string | undefined;
}

export interface Config {
  readonly nodeEnv: string;
  readonly publicBaseUrl: string;
  readonly webauthnRpId: string;
  readonly databaseUrl: string;
  readonly migrationDatabaseUrl?: string;
  readonly purgeDatabaseUrl?: string;
  readonly port: number;
  readonly devTools: boolean;
  readonly googleEarlyAccess: readonly string[];
  // The operator address a connector request is emailed to (brief: "emailed to the
  // operator address set in configuration"; design §7). Read from the environment here —
  // never baked into source (INV-103) — and undefined when unset.
  readonly operatorEmail: string | undefined;
  // The base URL of the free official daily-reference-rate source (Frankfurter / ECB
  // reference rates — "no paid tier, no plan that bills", constitution rule 11). Read
  // from the environment here so the provider host is never a literal in source (AC2;
  // INV-103 / constitution rule 21) — and undefined when unset.
  readonly exchangeRateBaseUrl: string | undefined;
  readonly keyVault: KeyVaultConfig;
  // Legacy test/config compatibility only. Production never routes through ACS.
  readonly acs: AcsConfig;
  readonly messaging?: {
    readonly email: { readonly apiKey?: string; readonly from?: string; readonly sendingDomain?: string; readonly replyTo?: string };
    readonly twilio: TwilioConfig;
    readonly smsLimits: SmsLimits;
  };
  readonly connectorClients?: {
    readonly google: { readonly clientId?: string; readonly clientSecret?: string };
    readonly microsoft: { readonly clientId?: string; readonly clientSecret?: string };
  };
  readonly vapid: VapidConfig;
  readonly blob: BlobConfig;
  // Keys the one-way HMAC of codes and link tokens (WARTHOG_HMAC_KEY, >= 32 bytes).
  readonly hmacKey: Uint8Array;
  // The local KeyWrapper's AES-256 KEK outside production (WARTHOG_DEV_KEK, exactly 32
  // bytes); always undefined in production, which wraps data keys with Key Vault.
  readonly devKek: Uint8Array | undefined;
}

// Read a required variable, failing loudly instead of inventing a default
// (validate-and-parameterize-input: a missing required variable is rejected).
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEV_FALLBACK_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return port;
}

// A comma-separated allow-list of emails, each trimmed; absent yields an empty list.
function parseEmailList(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// Decode a base64 secret. Errors name the variable but never echo its value.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
function decodeSecret(name: string, raw: string): Uint8Array {
  if (!BASE64.test(raw) || raw.length % 4 !== 0) {
    throw new Error(`Invalid configuration: ${name} must be base64`);
  }
  return new Uint8Array(Buffer.from(raw, "base64"));
}

// SHA-256 of the dev-only WARTHOG_HMAC_KEY published in .env.example. Anyone can read that
// key, so production refuses it (the fingerprint, not the key, lives in source).
const PUBLISHED_DEV_HMAC_KEY_SHA256 = "748968db1f82ef9e28babe06d84533dd8d0cf2b3af39da14ed9988fd6de2e89b";

// WARTHOG_HMAC_KEY: required in every environment, at least 32 bytes, and never the published
// dev key in production.
function parseHmacKey(env: NodeJS.ProcessEnv, nodeEnv: string): Uint8Array {
  const key = decodeSecret("WARTHOG_HMAC_KEY", required(env, "WARTHOG_HMAC_KEY"));
  if (key.length < 32) {
    throw new Error("Invalid configuration: WARTHOG_HMAC_KEY must decode to at least 32 bytes");
  }
  if (
    nodeEnv === "production" &&
    createHash("sha256").update(key).digest("hex") === PUBLISHED_DEV_HMAC_KEY_SHA256
  ) {
    throw new Error("Refusing to start in production with the published dev WARTHOG_HMAC_KEY");
  }
  return key;
}

// The Key Vault group: optional outside production (the local KEK wraps data keys there);
// required in production, where the vault URL must be an https URL. Errors name the variable,
// never a value.
function parseKeyVault(env: NodeJS.ProcessEnv, nodeEnv: string): KeyVaultConfig {
  if (nodeEnv !== "production") {
    return { url: env.KEY_VAULT_URL, keyName: env.KEY_VAULT_KEY_NAME };
  }
  const url = required(env, "KEY_VAULT_URL");
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    parsed = undefined;
  }
  if (parsed?.protocol !== "https:") {
    throw new Error("Invalid configuration: KEY_VAULT_URL must be an https URL");
  }
  return { url, keyName: required(env, "KEY_VAULT_KEY_NAME") };
}

// WARTHOG_DEV_KEK: refused in production; required and exactly 32 bytes everywhere else.
function parseDevKek(env: NodeJS.ProcessEnv, nodeEnv: string): Uint8Array | undefined {
  if (nodeEnv === "production") {
    if (env.WARTHOG_DEV_KEK !== undefined && env.WARTHOG_DEV_KEK !== "") {
      throw new Error("Refusing to start in production with WARTHOG_DEV_KEK set");
    }
    return undefined;
  }
  const kek = decodeSecret("WARTHOG_DEV_KEK", required(env, "WARTHOG_DEV_KEK"));
  if (kek.length !== 32) {
    throw new Error("Invalid configuration: WARTHOG_DEV_KEK must decode to exactly 32 bytes");
  }
  return kek;
}

// Production must never run with dev tools enabled or an in-process pglite database.
function assertProductionSafe(config: Config): void {
  if (config.nodeEnv !== "production") return;
  const unsafe: string[] = [];
  if (config.devTools) unsafe.push("WARTHOG_DEV_TOOLS=1");
  if (config.databaseUrl.startsWith("pglite:")) unsafe.push("a pglite: DATABASE_URL");
  if (unsafe.length > 0) {
    throw new Error(`Refusing to start in production with ${unsafe.join(" and ")}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV ?? "development";
  const config: Config = {
    nodeEnv,
    publicBaseUrl: required(env, "PUBLIC_BASE_URL"),
    webauthnRpId: required(env, "WEBAUTHN_RP_ID"),
    databaseUrl: required(env, "DATABASE_URL"),
    migrationDatabaseUrl: env.MIGRATION_DATABASE_URL,
    purgeDatabaseUrl: env.PURGE_DATABASE_URL,
    port: parsePort(env.PORT),
    devTools: env.WARTHOG_DEV_TOOLS === "1",
    googleEarlyAccess: parseEmailList(env.GOOGLE_EARLY_ACCESS),
    operatorEmail: env.OPERATOR_EMAIL,
    exchangeRateBaseUrl: env.EXCHANGE_RATE_BASE_URL,
    keyVault: parseKeyVault(env, nodeEnv),
    acs: {
      emailConnectionString: env.ACS_EMAIL_CONNECTION_STRING,
      smsConnectionString: env.ACS_SMS_CONNECTION_STRING,
      emailSenderAddress: env.ACS_EMAIL_SENDER_ADDRESS,
      smsFromNumber: env.ACS_SMS_FROM_NUMBER,
      smsAllowedCallingCodes: (env.SMS_ALLOWED_CALLING_CODES ?? "").split(",").map((code) => code.trim()).filter(Boolean),
      smsLimits: {
        monthly: Number(env.SMS_MONTHLY_SEGMENT_LIMIT ?? 0),
        daily: Number(env.SMS_DAILY_SEGMENT_LIMIT ?? 0),
        recipientHourly: Number(env.SMS_RECIPIENT_HOURLY_SEGMENT_LIMIT ?? 6),
      },
    },
    messaging: {
      email: { apiKey: env.RESEND_API_KEY, from: env.RESEND_FROM_ADDRESS,
        sendingDomain: env.RESEND_SENDING_DOMAIN, replyTo: env.RESEND_REPLY_TO_ADDRESS },
      twilio: {
        accountSid: env.TWILIO_ACCOUNT_SID, apiKeySid: env.TWILIO_API_KEY_SID,
        apiKeySecret: env.TWILIO_API_KEY_SECRET, region: env.TWILIO_REGION,
        countryRoutes: parseCountryRoutes(env.SMS_COUNTRY_ROUTES_JSON),
        maxSegmentsPerMessage: Number(env.SMS_MAX_SEGMENTS_PER_MESSAGE ?? 0),
      },
      smsLimits: {
        monthly: Number(env.SMS_MONTHLY_SEGMENT_LIMIT ?? 0),
        daily: Number(env.SMS_DAILY_SEGMENT_LIMIT ?? 0),
        recipientHourly: Number(env.SMS_RECIPIENT_HOURLY_SEGMENT_LIMIT ?? 0),
        recipientDailyMessages: Number(env.SMS_RECIPIENT_DAILY_MESSAGE_LIMIT ?? 0),
      },
    },
    connectorClients: {
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
      microsoft: { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET },
    },
    vapid: {
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    },
    blob: {
      account: env.STORAGE_ACCOUNT,
      container: env.STORAGE_CONTAINER,
    },
    hmacKey: parseHmacKey(env, nodeEnv),
    devKek: parseDevKek(env, nodeEnv),
  };
  assertProductionSafe(config);
  return config;
}

// Called at production boot and before opening the shared database. Kept separate
// so build-time imports and configuration-only tooling do not open connections.
export function assertProductionDatabaseConfiguration(config: Config): void {
  if (config.nodeEnv !== "production") return;
  const entries = [["DATABASE_URL", config.databaseUrl], ["MIGRATION_DATABASE_URL", config.migrationDatabaseUrl], ["PURGE_DATABASE_URL", config.purgeDatabaseUrl]] as const;
  const urls = entries.map(([name, value]) => {
    try {
      const url = new URL(value ?? "");
      // pg accepts host/user/password and repeated SSL overrides in query parameters.
      // Keep the reviewed authority and TLS contract unambiguous instead of validating
      // one identity while the driver connects with another.
      if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.password ||
          !/^[a-zA-Z0-9.-]+$/.test(url.hostname) || url.pathname.length < 2 || url.hash ||
          [...url.searchParams.keys()].some((key) => key !== "sslmode") ||
          url.searchParams.getAll("sslmode").length !== 1 || url.searchParams.get("sslmode") !== "verify-full") throw new Error();
      return url;
    } catch { throw new Error(`Invalid configuration: ${name} requires a PostgreSQL login with sslmode=verify-full`); }
  });
  if (new Set(urls.map((url) => `${url.hostname}:${url.port || "5432"}${url.pathname}`)).size !== 1 || new Set(urls.map((url) => decodeURIComponent(url.username))).size !== 3) {
    throw new Error("Invalid database configuration: use three distinct logins for the same server and database");
  }
}
