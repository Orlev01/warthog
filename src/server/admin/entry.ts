// The way into the admin portal (docs/design/admin-portal.md §2, as amended on 13 November
// 2026). The member app shows no admin entry anywhere: the operator types the admin host's
// address, and its sign-in page sends them through the app's ordinary sign-in (passkeys are
// scoped to the app's RP ID, so only the app origin can check one), which returns to the
// app-host handoff route under the portal's internal prefix. That route mints the
// single-use handoff and redirects back to the admin host.

import { APP_HANDOFF_PATH } from "../http/admin-routing";

// Where the admin host's "Sign in" goes: the app's ordinary sign-in, returning to the
// handoff. A visitor already signed in is forwarded straight on by sign-in.
export function handoffSignInUrl(publicOrigin: string): string {
  return `${publicOrigin}/signin?next=${encodeURIComponent(APP_HANDOFF_PATH)}`;
}
