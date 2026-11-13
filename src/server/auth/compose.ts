import { notificationSenders } from "../notify/production";
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
import { metricSeamFor } from "../metrics/seam";
import type { Db } from "../db/index";
import type { SignupHandlerDeps } from "../../app/(auth)/signup/handler";
import type { SigninHandlerDeps } from "../../app/(auth)/signin/handler";
import type { RecoverHandlerDeps } from "../../app/(auth)/recover/handler";
import type { ResetHandlerDeps } from "../../app/(auth)/reset/handler";
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
    emailSender: notificationSenders(config, db).email,
    keyWrapper: keyWrapperFor(config),
    rpId: config.webauthnRpId,
    publicOrigin: publicOrigin(config),
    recordMetric: metricSeamFor(db, systemClock),
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
// that judges session freshness and stamps the recorded step-up, the random source the
// rotated session token is drawn from (a step-up replaces the session's token), the
// configured RP ID and the origin the Origin check (and assertion verification) uses.
export async function getStepUpDeps(
  overrides: ComposeOverrides = {},
): Promise<StepUpHandlerDeps> {
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

// Build the RecoverHandlerDeps bundle from validated config: the shared db, the clock
// and random that mint the recovery session and new recovery code, the HMAC key and
// email sender the email one-time code (and the recovery alert) need, the configured RP
// ID and the origin every recovery step checks the request against. Recovery is email
// code plus recovery code, then a new passkey (it never verifies an authenticator code).
export async function getRecoverDeps(
  overrides: ComposeOverrides = {},
): Promise<RecoverHandlerDeps> {
  const config = resolveConfig(overrides);
  const db = await resolveDb(overrides);
  return {
    db,
    clock: systemClock,
    random: systemRandom,
    hmacKey: config.hmacKey,
    emailSender: notificationSenders(config, db).email,
    rpId: config.webauthnRpId,
    publicOrigin: publicOrigin(config),
  };
}

// Build the ResetHandlerDeps bundle from validated config (review fix W3.3): the shared
// db, the clock and random the email code uses, the HMAC key it is stored under, every
// channel sender (the code email and the reset alerts on push, email and SMS), the
// WebAuthn RP ID a new passkey registers under after a finished reset (review fix W5) and
// the origin every reset step checks the request against.
export async function getResetDeps(overrides: ComposeOverrides = {}): Promise<ResetHandlerDeps> {
  const config = resolveConfig(overrides);
  const db = await resolveDb(overrides);
  return {
    db,
    clock: systemClock,
    random: systemRandom,
    hmacKey: config.hmacKey,
    senders: notificationSenders(config, db),
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
  const senders = notificationSenders(config, db);
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

// Build the SigninHandlerDeps bundle from validated config: the shared db, clock and
// random, the HMAC key the new-device cookie is bound under and the email sender that
// carries the new-device alert, the RP ID, the origin, and the TOTP secret store.
export async function getSigninDeps(
  overrides: ComposeOverrides = {},
): Promise<SigninHandlerDeps> {
  const config = resolveConfig(overrides);
  const db = await resolveDb(overrides);
  return {
    db,
    clock: systemClock,
    random: systemRandom,
    hmacKey: config.hmacKey,
    emailSender: notificationSenders(config, db).email,
    rpId: config.webauthnRpId,
    publicOrigin: publicOrigin(config),
    totpSecrets: createTotpSecretStore({ db, keyWrapper: keyWrapperFor(config) }),
    recordMetric: metricSeamFor(db, systemClock),
  };
}
