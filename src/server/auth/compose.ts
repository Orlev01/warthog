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
import type { RecoverHandlerDeps } from "../../app/(auth)/recover/handler";
import type { DeviceHandlerDeps } from "../../app/(auth)/device/handler";
import type { SignoutHandlerDeps } from "./signout-handler";
import type { StepUpHandlerDeps } from "./step-up-handler";

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
export function notConfiguredSenders(): Senders {
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
export function keyWrapperFor(config: Config): KeyWrapper {
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

// Build the SignoutHandlerDeps bundle from validated config: the shared db plus the
// origin the Origin check accepts. No clock/random — sign-out deletes the presented
// session by its token hash and clears the cookie; it mints nothing.
export async function getSignoutDeps(
  overrides: ComposeOverrides = {},
): Promise<SignoutHandlerDeps> {
  const config = resolveConfig(overrides);
  const db = await resolveDb(overrides);
  return {
    db,
    publicOrigin: publicOrigin(config),
  };
}

// Build the StepUpHandlerDeps bundle from validated config: the shared db, the clock
// that judges session freshness and stamps the recorded step-up, the configured RP ID
// and the origin the Origin check (and assertion verification) uses. No random — a
// step-up mints no new token; it stamps the existing session.
export async function getStepUpDeps(
  overrides: ComposeOverrides = {},
): Promise<StepUpHandlerDeps> {
  const config = resolveConfig(overrides);
  const db = await resolveDb(overrides);
  return {
    db,
    clock: systemClock,
    rpId: config.webauthnRpId,
    publicOrigin: publicOrigin(config),
  };
}

// Build the RecoverHandlerDeps bundle from validated config: the shared db, the clock
// and random that mint the recovery session and new recovery code, the configured RP
// ID and the origin every recovery step checks the request against. The same shape as
// sign-in minus the TOTP store — recovery re-establishes the second factor by
// registering a new passkey, not by verifying an authenticator code.
export async function getRecoverDeps(
  overrides: ComposeOverrides = {},
): Promise<RecoverHandlerDeps> {
  const config = resolveConfig(overrides);
  const db = await resolveDb(overrides);
  return {
    db,
    clock: systemClock,
    random: systemRandom,
    rpId: config.webauthnRpId,
    publicOrigin: publicOrigin(config),
  };
}

// Build the DeviceHandlerDeps bundle from validated config: the shared db, the clock
// and random the handshake uses, the HMAC key the email-code first factor verifies
// against, the email sender carrying that factor's throttle alert, the push sender that
// delivers the one approval push, and the origin every device step checks the request
// against (design §5).
export async function getDeviceDeps(
  overrides: ComposeOverrides = {},
): Promise<DeviceHandlerDeps> {
  const config = resolveConfig(overrides);
  const db = await resolveDb(overrides);
  const senders = selectSenders(config, notConfiguredSenders());
  return {
    db,
    clock: systemClock,
    random: systemRandom,
    hmacKey: config.hmacKey,
    emailSender: senders.email,
    pushSender: senders.push,
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
