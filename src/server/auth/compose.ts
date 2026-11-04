// E04-S21 — the auth composition root. The sign-up and sign-in handlers are
// injectable factories (`createSignupHandler` / `createSigninHandler`); this one
// place builds their dependency bundles from validated config so every thin HTTP
// entry wires them the same way (design §5; the server-composition-roots addendum).
//
// Config and the db getter are INJECTED (defaulting, in production, to the real
// `loadConfig()` / `getServerDb()`) so the bundles can be built — and tested —
// without a real environment, a real database, or Azure. Config is read at CALL
// time, never at module load: `next build` evaluates these modules where runtime
// config is absent (the addendum's rule).
//
// Every secret in a bundle flows from the injected config (env), never a constant
// baked into this source (INV-103 secrets-from-env): the HMAC key is `config.hmacKey`
// and the KeyWrapper's KEK is `config.devKek` (local AES outside production; Key
// Vault in production, wired when its crypto client exists). Nothing here reads
// `process.env` — that is `config.ts`'s sole job.

import { loadConfig, type Config } from "../config";
import { getServerDb } from "../db/server";
import { systemClock } from "../seams/clock";
import { systemRandom } from "../seams/random";
import {
  selectSenders,
  type Senders,
  type OutgoingMessage,
} from "../notify/senders";
import { selectKeyWrapper, type KeyWrapper } from "../crypto/key-wrapper";
import { createTotpSecretStore } from "./totp-store";
import type { Db } from "../db/index";
import type { SignupHandlerDeps } from "../../app/(auth)/signup/handler";
import type { SigninHandlerDeps } from "../../app/(auth)/signin/handler";

// The two injection points every entry shares: the validated config (defaulting to
// the real env seam) and a db getter (defaulting to the process-wide server db).
export interface ComposeOverrides {
  readonly config?: Config;
  readonly getDb?: () => Promise<Db>;
}

// The real notification senders. The Azure channel senders are built by later tasks;
// until then no channel is configured, so sending through one rejects loudly rather
// than silently dropping the message (constitution: never fail silently). With dev
// tooling on, `selectSenders` routes every channel to the dev outbox instead, so this
// bundle is only ever reached with dev tools off.
function notConfiguredSenders(): Senders {
  const reject = (channel: string) => async (_message: OutgoingMessage): Promise<void> => {
    throw new Error(`${channel} sending is not configured`);
  };
  return {
    push: { sendPush: reject("Push") },
    email: { sendEmail: reject("Email") },
    sms: { sendSms: reject("SMS") },
  };
}

// The origin (scheme + host + port) of the configured public base URL — any path or
// query on it is dropped. This is the value the handlers check every request's Origin
// against (design §5).
function publicOrigin(config: Config): string {
  return new URL(config.publicBaseUrl).origin;
}

// The KeyWrapper for this config: the local AES-256 wrapper over `config.devKek`
// outside production; Key Vault in production (its crypto client wired by a later
// task, so production currently rejects for the absent client rather than inventing
// a KEK).
function keyWrapperFor(config: Config): KeyWrapper {
  return selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
}

function resolveConfig(overrides: ComposeOverrides): Config {
  return overrides.config ?? loadConfig();
}

function resolveDb(overrides: ComposeOverrides): Promise<Db> {
  return (overrides.getDb ?? getServerDb)();
}

// Build the SignupHandlerDeps bundle from validated config.
export async function getSignupDeps(
  overrides: ComposeOverrides = {},
): Promise<SignupHandlerDeps> {
  const config = resolveConfig(overrides);
  const db = await resolveDb(overrides);
  return {
    db,
    clock: systemClock,
    random: systemRandom,
    hmacKey: config.hmacKey,
    emailSender: selectSenders(config, notConfiguredSenders()).email,
    keyWrapper: keyWrapperFor(config),
    rpId: config.webauthnRpId,
    publicOrigin: publicOrigin(config),
  };
}

// Build the SigninHandlerDeps bundle from validated config.
export async function getSigninDeps(
  overrides: ComposeOverrides = {},
): Promise<SigninHandlerDeps> {
  const config = resolveConfig(overrides);
  const db = await resolveDb(overrides);
  return {
    db,
    clock: systemClock,
    random: systemRandom,
    rpId: config.webauthnRpId,
    publicOrigin: publicOrigin(config),
    totpSecrets: createTotpSecretStore({ db, keyWrapper: keyWrapperFor(config) }),
  };
}
