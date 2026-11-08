// E11-S11 — Vault unlock server actions (design §4.2 "Device-held vault"; brief
// "Vault unlock methods").
//
// The browser crypto (E11-S07..S10) creates a random vault key (VK) and seals
// high-tier values and card data with it; the server never holds VK, the
// passphrase, the PRF output or the recovery code in clear. These actions are the
// SERVER SEAM between that browser crypto and the already-built unlock-methods
// store (`../db/vault-unlock-methods`): they let the browser FETCH its per-person
// PRF salt + the wrapped VK for a method (so it can unlock VK locally) and STORE a
// freshly wrapped VK when a new unlock method is added — composing the store, adding
// no SQL and no crypto of their own.
//
// They also enforce the account-shape rules SERVER-SIDE, never trusting the client
// (brief: "An account that uses only an authenticator app must set a vault
// passphrase before adding high-tier details or cards. Changing or removing the
// passphrase requires unlocking first."): `assertVaultUnlockable` is the policy gate
// the caller runs BEFORE a protected save or a passphrase change/removal.
//
// Every read/write is member-scoped by the `userId` the caller passes — the
// SESSION's verified id, which the thin server-action wrapper derives from the
// session, NEVER a client value (design §4.2: "every member-scoped query is filtered
// by the session's user id") — so one person can never read or write another's
// unlock material, PRF salt or gate verdict.
//
// Validate-and-parameterize (INV-102): a method outside the enum, or a malformed /
// oversized / mis-shaped save input, is refused at the boundary with a 4xx
// `HttpError` (via `../http/validate`) before any query runs — never a 500, never a
// failing cast. The wrapped VK and its params travel as BOUND values through the
// store, so a value shaped like SQL is stored as data and cannot alter a statement.
// Secrets-from-env (INV-103): this module reads no `process.env` and holds no key —
// the db and randomness are INJECTED seams — so no ambient env value can surface in
// the returned material or a stored row.

import { z } from "zod";

import { parseParams } from "../http/validate";
import {
  getOrCreatePrfSalt,
  getWrappedKey,
  insertWrappedKeyIfAbsent,
  listMethods,
  saveWrappedKey,
  type UnlockMethod,
  type UnlockParams,
} from "../db/vault-unlock-methods";
import type { Db } from "../db/index";
import type { Random } from "../seams/random";

// The material the browser needs to unlock VK locally for one method: the person's
// fixed PRF salt (fed to the authenticator's PRF eval), the requested method echoed
// back, the opaque wrapped VK for it (null when none is saved) and that method's
// public params ({} when none).
export interface UnlockMaterial {
  readonly prfSalt: string;
  readonly method: UnlockMethod;
  readonly wrapped: string | null;
  readonly params: UnlockParams;
}

// What the browser hands back to persist a newly wrapped VK for a method: the
// opaque ciphertext and the method's public params (omitted ⇒ {}).
export interface SaveUnlockMethodInput {
  readonly method: UnlockMethod;
  readonly wrapped: string;
  readonly params?: UnlockParams;
}

// Every action reports its outcome — never a silent success (conventions: a server
// action reports success, the refusal reason, or a 4xx from the boundary).
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

// The policy gate's question: a protected save, or a passphrase change/removal that
// first requires the person to have unlocked the vault.
export type VaultGate =
  | { readonly action: "save_protected" }
  | { readonly action: "change_passphrase"; readonly unlocked: boolean }
  | { readonly action: "remove_passphrase"; readonly unlocked: boolean };

// The three unlock methods VK can be wrapped for (= the store's enum).
const methodSchema = z.enum(["passkey_prf", "passphrase", "recovery"]);

// A real wrapped-VK envelope is a short opaque string; anything far larger is
// malformed input, so cap it well above any genuine envelope and reject the rest at
// the boundary with a 4xx (INV-102) rather than letting it reach a query.
const MAX_WRAPPED_LENGTH = 64 * 1024;

// The save input's shape: a known method, a non-empty bounded opaque wrapped VK,
// and optional public params (an object of public values — salts, iteration counts,
// never a secret). A violation throws a 4xx `HttpError`, so nothing is persisted.
const saveInputSchema = z.object({
  method: methodSchema,
  wrapped: z.string().min(1).max(MAX_WRAPPED_LENGTH),
  params: z.record(z.string(), z.unknown()).optional(),
});

// The gate's shape, validated at the boundary so a mis-shaped action is a 4xx, never
// a silent pass.
const gateSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save_protected") }),
  z.object({ action: z.literal("change_passphrase"), unlocked: z.boolean() }),
  z.object({ action: z.literal("remove_passphrase"), unlocked: z.boolean() }),
]);

export interface VaultUnlockActionsDeps {
  readonly db: Db;
  readonly random: Random;
}

// How a save may treat a method the person already has. Replacing one is a security
// change, so only a caller holding a fresh step-up passes `replace: true`; without it the
// save inserts only and refuses an existing method (review fix W1).
export interface SaveUnlockMethodOptions {
  readonly replace: boolean;
}

// The refusal reason when a save would replace an existing method without `replace`.
export const STEP_UP_REQUIRED = "step_up_required";

export interface VaultUnlockActions {
  getUnlockMaterial(userId: string, method: UnlockMethod): Promise<UnlockMaterial>;
  saveUnlockMethod(
    userId: string,
    input: SaveUnlockMethodInput,
    options?: SaveUnlockMethodOptions,
  ): Promise<ActionResult>;
  assertVaultUnlockable(userId: string, gate: VaultGate): Promise<ActionResult>;
}

// Wire the actions to the injected db + randomness seams. The whole module's state
// flows through these two — no process.env, no key (INV-103).
export function createVaultUnlockActions(deps: VaultUnlockActionsDeps): VaultUnlockActions {
  const { db, random } = deps;

  return {
    // Fetch the person's PRF salt (created once, stable thereafter) and the wrapped
    // VK + params for `method` (null/{} when none is saved). Member-scoped by the
    // session's `userId`. An unknown method is a 4xx at the boundary.
    async getUnlockMaterial(userId, method) {
      const validMethod = parseParams(methodSchema, method);
      const prfSalt = await getOrCreatePrfSalt(db, userId, { random });
      const stored = await getWrappedKey(db, userId, validMethod);
      return {
        prfSalt,
        method: validMethod,
        wrapped: stored?.wrappedKey ?? null,
        params: stored?.params ?? {},
      };
    },

    // Persist the wrapped VK + params for the session's `userId` + method — one wrapped
    // key per method — after validating the input at the boundary. Writes only the
    // acting person's row. With `replace` (the caller holds a fresh step-up) a re-save
    // replaces the method; without it (the default) the save is INSERT-ONLY in one
    // atomic statement and an existing method is refused with `step_up_required`, so a
    // stolen session cannot swap a working envelope for garbage and two first-time
    // saves racing each other keep one vault key (review fix W1).
    async saveUnlockMethod(userId, input, options = { replace: false }) {
      const valid = parseParams(saveInputSchema, input);
      const row = { userId, method: valid.method, wrappedKey: valid.wrapped, params: valid.params };
      if (options.replace) {
        await saveWrappedKey(db, row);
        return { ok: true };
      }
      const inserted = await insertWrappedKeyIfAbsent(db, row);
      return inserted ? { ok: true } : { ok: false, reason: STEP_UP_REQUIRED };
    },

    // The policy gate, member-scoped by `userId`:
    //   • save_protected: allowed only when the person has a PRF-passkey OR a
    //     passphrase unlock method — a recovery code alone is a backup, not enough;
    //     an account that can only use an authenticator app (neither) may not save
    //     high-tier fields or cards.
    //   • change/remove_passphrase: allowed only when the person unlocked the vault
    //     first (`unlocked` is true).
    async assertVaultUnlockable(userId, gate) {
      const valid = parseParams(gateSchema, gate);

      if (valid.action === "save_protected") {
        const methods = await listMethods(db, userId);
        const canUnlock = methods.includes("passkey_prf") || methods.includes("passphrase");
        return canUnlock
          ? { ok: true }
          : {
              ok: false,
              reason:
                "Add a passkey that can unlock your vault, or set a vault passphrase, before you save high-tier details or cards.",
            };
      }

      if (valid.unlocked) return { ok: true };
      const verb = valid.action === "change_passphrase" ? "change" : "remove";
      return { ok: false, reason: `Unlock your vault before you ${verb} your passphrase.` };
    },
  };
}
