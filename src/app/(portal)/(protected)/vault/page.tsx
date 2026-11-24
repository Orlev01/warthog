import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { verifySession } from "@/server/auth/session";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { systemClock } from "@/server/seams/clock";
import { HttpError } from "@/server/http/validate";
import type { Session } from "@/server/auth/session";
import {
  createIdentityActions,
  type IdentityActions,
  type SaveLowTierFieldInput,
  type UpdateLowTierFieldInput,
  type SaveHighTierFieldInput,
  type RaiseFieldToHighTierInput,
} from "./actions";
import { IdentityView } from "@/components/vault/identity-view";
import { RecoveryPhraseSettings } from "@/components/vault/recovery-phrase-settings";
import { listMethods } from "@/server/db/vault-unlock-methods";
import { PageContainer } from "@/components/shell/page-container";
import type { Metadata } from "next";

// The page title (review fix G8, WCAG 2.4.2): "%s · Warthog" via the root template.
export const metadata: Metadata = { title: "About you" };

// E11-S15 — Vault identity page (the thin protected-page loader over the tested
// `createIdentityActions` seam, `./actions`). It reads the signed-in session from the
// host-locked `__Host-wh_session` cookie, turns it (via the seam's `load`) into the
// person's own identity — low-tier values decrypted, high-tier fields as metadata
// only — and mounts the already-render-tested <IdentityView/> over it.
//
// Thin by design (the server-composition-roots addendum): the per-request cookie is
// read BEFORE `getServerDb()` so `next build` marks the page dynamic and never
// prerenders it or opens the database at build time; config is read INSIDE the handler
// (`loadConfig()`), never at module load; the database comes from the process-wide
// `getServerDb()`, never `createDb`, and the shared handle is never closed. The
// `(protected)` layout already guards every page in the app shell. Config and secrets
// flow only through `loadConfig()` (INV-103) — this entry reads no `process.env` of
// its own.

const SESSION_COOKIE = "__Host-wh_session";

// Per-request resolution for the low-tier server actions: re-read the cookie, verify the
// session and build the actions over fresh handles (never the loader's — the
// server-composition-roots addendum). Null when the session no longer verifies.
async function requestIdentityActions(): Promise<{
  session: Session;
  actions: IdentityActions;
} | null> {
  const requestToken = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const requestConfig = loadConfig();
  const requestDb = await getServerDb();
  const requestSession = requestToken
    ? await verifySession(requestDb, requestToken, { clock: systemClock })
    : null;
  if (!requestSession) return null;
  const requestKeyWrapper = selectKeyWrapper({
    nodeEnv: requestConfig.nodeEnv,
    localKek: requestConfig.devKek,
  });
  return {
    session: requestSession,
    actions: createIdentityActions({ db: requestDb, keyWrapper: requestKeyWrapper }),
  };
}

// A boundary rejection (a 4xx HttpError — a malformed id, an empty or oversized value, a
// non-date) comes back to the form as a plain refusal it can explain, never a crash.
async function reportRefusals(
  run: () => Promise<{ ok: boolean; reason?: string }>,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof HttpError) return { ok: false, reason: "invalid_request" };
    throw error;
  }
}

// Save a NEW everyday detail for the session person (review fix G1 — the "Add a detail"
// form).
async function saveLowTierField(
  input: SaveLowTierFieldInput,
): Promise<{ ok: boolean; reason?: string }> {
  "use server";
  const request = await requestIdentityActions();
  if (!request) return { ok: false, reason: "unauthenticated" };
  const result = await reportRefusals(() => request.actions.saveLowTierField(request.session, input));
  if (result.ok) {
    revalidatePath("/vault");
  }
  return result;
}

// Re-save one of the session person's OWN everyday details (review fix G1 — the per-field
// Save), including a postal address's moving-on date.
async function updateLowTierField(
  input: UpdateLowTierFieldInput,
): Promise<{ ok: boolean; reason?: string }> {
  "use server";
  const request = await requestIdentityActions();
  if (!request) return { ok: false, reason: "unauthenticated" };
  const result = await reportRefusals(() =>
    request.actions.updateLowTierField(request.session, input),
  );
  if (result.ok) {
    revalidatePath("/vault");
  }
  return result;
}

export default async function VaultPage() {
  // Read the request first: touching the cookie marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const config = loadConfig();
  const db = await getServerDb();
  const session = token ? await verifySession(db, token, { clock: systemClock }) : null;
  if (!session) {
    redirect("/signin");
  }

  // The KeyWrapper (local AES outside production, Key Vault in production) lets the
  // seam unwrap the session person's own DEK to decrypt their low-tier values.
  const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  const data = await createIdentityActions({ db, keyWrapper }).load(session);
  // Which unlock methods the session person has (never a wrapped key), so the recovery
  // phrase panel can say whether a vault recovery phrase exists (review fix W1).
  const unlockMethods = await listMethods(db, session.userId);

  // The live high-tier flows' submit seams: server actions that re-verify the session and
  // store ONLY the device-sealed submission (ciphertext + metadata) through the tested
  // `saveHighTierField` / `raiseFieldToHighTier` actions. Each re-resolves
  // config/db/session/KeyWrapper per request (never closing over the loader's handles — the
  // server-composition-roots addendum), takes the owner from the verified session (never the
  // body), and reports every outcome in plain words rather than failing silently.
  async function saveHighTierField(
    submission: SaveHighTierFieldInput,
  ): Promise<{ ok: boolean; reason?: string }> {
    "use server";
    const requestToken = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
    const requestConfig = loadConfig();
    const requestDb = await getServerDb();
    const requestSession = requestToken
      ? await verifySession(requestDb, requestToken, { clock: systemClock })
      : null;
    if (!requestSession) {
      return { ok: false, reason: "unauthenticated" };
    }
    const requestKeyWrapper = selectKeyWrapper({
      nodeEnv: requestConfig.nodeEnv,
      localKek: requestConfig.devKek,
    });
    const result = await createIdentityActions({
      db: requestDb,
      keyWrapper: requestKeyWrapper,
    }).saveHighTierField(requestSession, submission);
    if (result.ok) {
      // Re-run this page's loader so the new high-tier detail lists (by label) right after
      // the device flow submits — no manual reload.
      revalidatePath("/vault");
    }
    return result;
  }

  async function raiseFieldToHighTier(
    submission: RaiseFieldToHighTierInput,
  ): Promise<{ ok: boolean; reason?: string }> {
    "use server";
    const requestToken = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
    const requestConfig = loadConfig();
    const requestDb = await getServerDb();
    const requestSession = requestToken
      ? await verifySession(requestDb, requestToken, { clock: systemClock })
      : null;
    if (!requestSession) {
      return { ok: false, reason: "unauthenticated" };
    }
    const requestKeyWrapper = selectKeyWrapper({
      nodeEnv: requestConfig.nodeEnv,
      localKek: requestConfig.devKek,
    });
    const result = await createIdentityActions({
      db: requestDb,
      keyWrapper: requestKeyWrapper,
    }).raiseFieldToHighTier(requestSession, submission);
    if (result.ok) {
      // The low-tier plaintext is now removed and the detail is high tier — refresh the
      // loader so the screen reflects both.
      revalidatePath("/vault");
    }
    return result;
  }

  return (
    <PageContainer>
      <IdentityView
        lowTierFields={data.lowTierFields}
        highTierFields={data.highTierFields}
        saveHighTierField={saveHighTierField}
        raiseFieldToHighTier={raiseFieldToHighTier}
        saveLowTierField={saveLowTierField}
        updateLowTierField={updateLowTierField}
      />
      <RecoveryPhraseSettings
        hasRecoveryPhrase={unlockMethods.includes("recovery")}
        hasVault={unlockMethods.length > 0}
      />
    </PageContainer>
  );
}
