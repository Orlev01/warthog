import * as React from "react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LogIn } from "lucide-react";

import { StatusScreen } from "@/components/shell/status-screens";
import { ButtonLink } from "@/components/ui/button-link";
import { loadConfig } from "@/server/config";
import { getServerDb } from "@/server/db/server";
import { systemClock } from "@/server/seams/clock";
import { ADMIN_SIGN_IN_NOTICES, adminSignInNoticeFrom, requireAdminSession } from "@/server/admin/guard";
import { handoffSignInUrl } from "@/server/admin/entry";
import { ADMIN_COOKIE_NAME } from "@/server/admin/session";

// The admin host's sign-in page (docs/design/admin-portal.md §2, as amended on 13 November
// 2026), served at `admin.warthog.com.au/signin`. This is the only way into the portal: the
// member app links to it nowhere. Passkeys are scoped to the app's RP ID, so the check
// itself happens on the app's ordinary sign-in; "Sign in" goes there with `?next=/handoff`
// and the person comes back through the single-use handoff. Someone already signed in to
// the app is forwarded straight on by sign-in, and a fresh sign-in counts as the step-up, so
// normally one passkey prompt is all it takes. It sits outside the guarded (portal) group:
// it is where the guard sends everyone without an admin session.
export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function AdminSignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const token = (await cookies()).get(ADMIN_COOKIE_NAME)?.value ?? null;
  const signedIn = await requireAdminSession(token, { db: await getServerDb(), clock: systemClock });
  if (signedIn.ok) redirect("/");
  const notice = adminSignInNoticeFrom((await searchParams).notice);
  const appOrigin = new URL(loadConfig().publicBaseUrl).origin;
  return (
    <StatusScreen
      icon={<LogIn aria-hidden size={22} strokeWidth={1.7} />}
      title="Sign in"
      actions={<ButtonLink href={handoffSignInUrl(appOrigin)} variant="primary">Sign in</ButtonLink>}
    >
      {notice ? <p role="status">{ADMIN_SIGN_IN_NOTICES[notice]}</p> : null}
      <p>Sign in with your Warthog account to continue.</p>
    </StatusScreen>
  );
}
