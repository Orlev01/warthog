import * as React from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";

import { SettingsIndex } from "@/components/settings/settings-index";
import { getServerDb } from "@/server/db/server";
import { verifySession } from "@/server/auth/session";
import { systemClock } from "@/server/seams/clock";
import { adminEntryFor, adminNoticeFrom } from "@/server/admin/entry";
import { startAdminHandoff, type HandoffResult } from "@/server/admin/handoff";
import { getAdminDeps } from "@/server/admin/compose";

// The page title (review fix G8, WCAG 2.4.2): "%s · Warthog" via the root template.
export const metadata: Metadata = { title: "Settings" };

// E18-S15 — the Settings index. A thin loader inside the already-guarded `(protected)`
// group (whose layout delegates the admit/redirect to `requireSession` and wraps the page
// in PortalChrome): it mounts the render-tested <SettingsIndex>, which lists every settings
// screen from the navigation IA as a labelled, described link.
//
// For a live admin it also passes the admin portal entry (docs/design/admin-portal.md §2):
// whether the person is an admin and which second factors they hold (so the inline step-up
// names only the ways they can confirm), plus the server action below. The role is read for
// the session's own user id — never a client value — and the action re-derives everything
// again from the cookie when it runs.

const SESSION_COOKIE = "__Host-wh_session";

// Start the admin handoff for the signed-in person: identity from the session cookie alone;
// the tested seam requires the admin role, a live account and a fresh step-up, and returns
// the admin origin's single-use exchange URL or a plain reason.
async function startAdminHandoffAction(): Promise<HandoffResult> {
  "use server";
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const deps = await getAdminDeps();
  return startAdminHandoff(token, deps);
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const db = await getServerDb();
  const session = token ? await verifySession(db, token, { clock: systemClock }) : null;
  if (!session) redirect("/signin");
  const entry = await adminEntryFor(db, session.userId);
  return (
    <SettingsIndex
      admin={entry.isAdmin ? { passkey: entry.passkey, authenticator: entry.authenticator, startHandoff: startAdminHandoffAction } : undefined}
      notice={adminNoticeFrom(params.notice)}
    />
  );
}
