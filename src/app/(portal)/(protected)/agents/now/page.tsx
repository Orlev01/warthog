import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";

import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { getUserById } from "@/server/db/users";
import { verifySession, type Session } from "@/server/auth/session";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { getProcessCatalogue } from "@/server/connectors/catalogue";
import { systemClock } from "@/server/seams/clock";
import { AgentsNowView } from "@/components/agents/agents-now-view";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import type { Db } from "@/server/db/index";
import { createNowActions } from "./actions";

// The Now tab of Agents (docs/adr/agent-runs.md, amendment of 25 November 2026): the thin
// loader over the tested `createNowActions` seam. It resolves the signed-in session from the
// host-locked cookie (sign-in if none) and renders the person's own agents' recent
// conversations. The view reloads itself every 30 seconds while it is in sight.

const SESSION_COOKIE = "__Host-wh_session";

async function resolveSession(db: Db): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  return token ? verifySession(db, token, { clock: systemClock }) : null;
}

// The Agents layout sets a plain title, which stops the root template reaching here.
export const metadata: Metadata = { title: { absolute: "Now · Agents · Warthog" } };

export default async function AgentsNowPage() {
  // Touch the request first so `next build` never prerenders the page.
  await cookies();
  const config = loadConfig();
  const db = await getServerDb();
  const session = await resolveSession(db);
  if (!session) {
    redirect("/signin");
  }
  const keyWrapper = selectKeyWrapper({ nodeEnv: config.nodeEnv, localKek: config.devKek });
  const view = await createNowActions({
    db,
    clock: systemClock,
    dekFor: async (userId) => {
      const user = await getUserById(db, userId);
      if (!user) throw new Error("no data key for this user");
      return keyWrapper.unwrap(user.wrappedDek);
    },
    nameOf: (connectorId) => getProcessCatalogue(config).get(connectorId)?.name,
  }).load(session);
  return <AgentsNowView {...view} refresh={<AutoRefresh updatedAt={view.updatedAt} updatedAtIso={view.updatedAtIso} />} />;
}
