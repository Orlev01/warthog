import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { verifySession } from "@/server/auth/session";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { systemClock } from "@/server/seams/clock";
import { createCardsActions } from "./actions";
import { CardsView } from "@/components/vault/cards-view";

// E11-S16 — Vault cards page (the thin protected-page loader over the tested
// `createCardsActions` seam, `./actions`). It reads the signed-in session from the
// host-locked `__Host-wh_session` cookie, turns it (via the seam's `load`) into the
// person's own cards — METADATA ONLY — plus their postal addresses as billing
// choices, and mounts the already-render-tested <CardsView/> over it.
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

export default async function CardsPage() {
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
  // seam unwrap the session person's own DEK to decrypt their postal addresses.
  const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  const data = await createCardsActions({ db, keyWrapper }).load(session);

  return <CardsView cards={data.cards} billingAddresses={data.billingAddresses} />;
}
