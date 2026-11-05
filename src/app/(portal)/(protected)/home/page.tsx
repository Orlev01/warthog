import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { DashboardView } from "@/components/home/dashboard-view";
import { getServerDb } from "@/server/db/server";
import { verifySession } from "@/server/auth/session";
import { systemClock } from "@/server/seams/clock";
import { createHomeActions } from "./actions";

// E18-S13 — Early home page (the thin protected-page loader).
//
// Sign-up and sign-in land here, so /home mounts the home dashboard
// (<DashboardView>, E18-S07) behind the minimal `createHomeActions` loader until
// the full data-driven loader (E18-S08) extends it. The page lives inside the
// already-guarded `(protected)` route group, whose layout delegates the
// admit/redirect to `requireSession`; this loader re-derives the verified session
// from the `__Host-wh_session` cookie — never a client value (design §5) — to
// scope the person's own data, and sends an absent session back to sign-in rather
// than rendering an empty screen.
//
// Thin by design: per-request data (the cookie) is read BEFORE `getServerDb()` so
// touching it marks the page dynamic and `next build` never prerenders it; the
// database comes from the process-wide `getServerDb()`, never `createDb`, and the
// shared handle is never closed. The `(protected)` layout already wraps every page
// in the app shell (PortalChrome), so the page never wraps again.

const SESSION_COOKIE = "__Host-wh_session";

export default async function HomePage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const db = await getServerDb();
  const session = token ? await verifySession(db, token, { clock: systemClock }) : null;
  if (!session) {
    redirect("/signin");
  }
  const view = await createHomeActions({ db }).load(session);
  return <DashboardView {...view} />;
}
