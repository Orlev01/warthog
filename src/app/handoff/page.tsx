import * as React from "react";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import { HandoffContinue } from "@/components/admin/handoff-continue";
import { getServerDb } from "@/server/db/server";
import { systemClock } from "@/server/seams/clock";
import { admitHandoff } from "@/server/admin/entry";
import { startAdminHandoff, type HandoffResult } from "@/server/admin/handoff";
import { getAdminDeps } from "@/server/admin/compose";

// The unlinked handoff route on the app host (docs/design/admin-portal.md §2, as amended on
// 13 November 2026). Nothing in the member app links here: the admin host's "Sign in" sends
// the operator through the app's ordinary sign-in with `?next=/handoff`. For anyone who is
// not a signed-in live admin — signed out, a member, demoted, deleted — this is the app's
// ordinary not-found page, so the route reveals nothing. It sits outside every route group
// on purpose: the protected layout would send a signed-out visitor to sign-in, which would
// tell this path apart from one that does not exist.

const SESSION_COOKIE = "__Host-wh_session";

export const metadata: Metadata = { title: "Continue", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

// Start the admin handoff for the signed-in person: identity from the session cookie alone;
// the tested seam requires the admin role, a live account and a fresh step-up, and returns
// the admin origin's single-use exchange URL or a plain reason.
async function startHandoffAction(): Promise<HandoffResult> {
  "use server";
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const deps = await getAdminDeps();
  return startAdminHandoff(token, deps);
}

export default async function HandoffPage() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const entry = await admitHandoff(token, { db: await getServerDb(), clock: systemClock });
  if (!entry) notFound();
  return <HandoffContinue startHandoff={startHandoffAction} passkey={entry.passkey} authenticator={entry.authenticator} />;
}
