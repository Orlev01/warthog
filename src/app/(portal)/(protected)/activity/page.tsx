import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ActivityView } from "@/components/activity/activity-view";
import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { getUserById } from "@/server/db/users";
import { verifySession } from "@/server/auth/session";
import { selectKeyWrapper } from "@/server/crypto/key-wrapper";
import { createDbRecorder } from "@/server/activity/writer";
import { createDisputeRepo } from "@/server/activity/disputes";
import { createUndoService } from "@/server/activity/undo";
import { systemClock } from "@/server/seams/clock";
import type { Db } from "@/server/db/index";
import { createActivityActions } from "./actions";

// E08-S09 — Activity page (the thin protected-page loader).
//
// The loader triad: this async `page.tsx` reads the signed-in session from the
// host-locked `__Host-wh_session` cookie, turns it (via the tested
// `createActivityActions` seam's `load`) into the <ActivityView> props — the person's
// OWN entries, newest-first, narrowed by the view's filters/search — and renders the
// view. The record-wide Check-integrity control posts `verify=1`, which `load` runs;
// the Dispute/Undo controls post the entry seq the disputeEntry/undoEntry actions
// consume.
//
// Thin by design (the server-composition-roots addendum): per-request data (the
// cookie, the search params) is read BEFORE `getServerDb()` so touching it marks the
// page dynamic and `next build` never prerenders it or opens the database at build
// time; config is read inside the handler (`loadConfig()`), never at module load; the
// database comes from the process-wide `getServerDb()`, never `createDb`, and the
// shared handle is never closed. The `(protected)` layout already wraps every page in
// the app shell (PortalChrome), so the page never wraps again.

const SESSION_COOKIE = "__Host-wh_session";

// The declared reversals (design §7): a created calendar event is undone by deleting
// it. ONE table backs both the loader's `canUndo` and the undo service's "is this
// reversible?" decision, so an Undo control shows only where undoEntry can act.
const REVERSALS: Record<string, string> = {
  google_calendar__create_event: "google_calendar__delete_event",
};
function reversalFor(tool?: string): string | undefined {
  return tool ? REVERSALS[tool] : undefined;
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read the request first: touching per-request data marks the page dynamic, so
  // `next build` never prerenders it (and never opens the database at build time).
  const params = await searchParams;
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const config = loadConfig();
  const db = await getServerDb();
  const session = token ? await verifySession(db, token, { clock: systemClock }) : null;
  if (!session) {
    redirect("/signin");
  }

  const view = await buildActions(db, config.nodeEnv, config.devKek).load(session, params);
  return <ActivityView {...view} />;
}

// Build the activity actions with the real seams. The KeyWrapper (local AES outside
// production, Key Vault in production) lets `load` resolve the session person's DEK;
// `dekFor` is the loadAgentContext idiom (the person's wrapped DEK, unwrapped) the
// dispute repo and the undo recorder encrypt/decrypt the person's OWN content under.
function buildActions(db: Db, nodeEnv: string, devKek: Uint8Array | undefined) {
  const keyWrapper = selectKeyWrapper({ nodeEnv, localKek: devKek });
  const dekFor = async (userId: string): Promise<Uint8Array> => {
    const user = await getUserById(db, userId);
    if (!user) {
      throw new Error("no data key for this user");
    }
    return keyWrapper.unwrap(user.wrappedDek);
  };

  const disputes = createDisputeRepo({ db, clock: systemClock, dekFor });
  const undo = createUndoService({
    db,
    recorder: createDbRecorder({ db, clock: systemClock, dekFor }),
    reversalFor,
    // The reversal executor routes through the agent pipeline, wired by a later task;
    // until then it rejects loudly rather than silently doing nothing (the compose.ts
    // not-configured idiom). The loader never runs it — only undoEntry does.
    runReversal: async () => {
      throw new Error("undo execution is not configured");
    },
  });

  return createActivityActions({ db, disputes, undo, keyWrapper, reversalFor });
}
