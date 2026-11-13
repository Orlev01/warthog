import * as React from "react";
import type { Metadata } from "next";
import { LogOut } from "lucide-react";

import { StatusScreen } from "@/components/shell/status-screens";
import { ButtonLink } from "@/components/ui/button-link";
import { loadConfig } from "@/server/config";

// The admin host's signed-out page (docs/design/admin-portal.md §2). It sits OUTSIDE the
// guarded (portal) group on purpose: sign-out lands here with no admin session, and this page
// offers the way back as plain links. The sign-out route cannot redirect to the app origin
// itself — Chrome applies CSP `form-action 'self'` to the redirects that follow a form
// submission — so the cross-origin step is a link the person clicks, never a redirect.
export const metadata: Metadata = { title: "Signed out of admin" };
export const dynamic = "force-dynamic";

export default function SignedOutPage() {
  const appOrigin = new URL(loadConfig().publicBaseUrl).origin;
  return (
    <StatusScreen
      icon={<LogOut aria-hidden size={22} strokeWidth={1.7} />}
      title="You've signed out of the admin portal"
      actions={
        <>
          <ButtonLink href={`${appOrigin}/settings`} variant="primary">Back to Settings</ButtonLink>
          <ButtonLink href={`${appOrigin}/home`}>Go to Warthog</ButtonLink>
        </>
      }
    >
      <p>Your Warthog session is still signed in. Open the admin portal again from Settings whenever you need it.</p>
    </StatusScreen>
  );
}
