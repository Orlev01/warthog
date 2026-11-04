// The runtime config seam. This is the ONLY module that reads `process.env`:
// feature code imports typed config from here and never touches the environment
// directly (constitution: secrets-from-env; INV-103). It also refuses to start an
// unsafe production process — dev tools or an in-process pglite database must never
// run in production.
//
// `loadConfig(env)` is a pure function of an env record so the contract is testable
// without mutating the real environment. `loadConfig()` with no argument reads the
// real `process.env` (the production call site).

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
}

export interface VapidConfig {
  readonly subject: string | undefined;
  readonly publicKey: string | undefined;
  readonly privateKey: string | undefined;
}

export interface Config {
  readonly nodeEnv: string;
  readonly publicBaseUrl: string;
  readonly webauthnRpId: string;
  readonly databaseUrl: string;
  readonly port: number;
  readonly devTools: boolean;
  readonly googleEarlyAccess: readonly string[];
  readonly keyVault: KeyVaultConfig;
  readonly acs: AcsConfig;
  readonly vapid: VapidConfig;
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
  const config: Config = {
    nodeEnv: env.NODE_ENV ?? "development",
    publicBaseUrl: required(env, "PUBLIC_BASE_URL"),
    webauthnRpId: required(env, "WEBAUTHN_RP_ID"),
    databaseUrl: required(env, "DATABASE_URL"),
    port: parsePort(env.PORT),
    devTools: env.WARTHOG_DEV_TOOLS === "1",
    googleEarlyAccess: parseEmailList(env.GOOGLE_EARLY_ACCESS),
    keyVault: {
      url: env.KEY_VAULT_URL,
      keyName: env.KEY_VAULT_KEY_NAME,
    },
    acs: {
      emailConnectionString: env.ACS_EMAIL_CONNECTION_STRING,
      smsConnectionString: env.ACS_SMS_CONNECTION_STRING,
    },
    vapid: {
      subject: env.VAPID_SUBJECT,
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
    },
  };
  assertProductionSafe(config);
  return config;
}
