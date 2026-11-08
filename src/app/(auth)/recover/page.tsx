import * as React from "react";
import { safeReturnPath } from "@/server/auth/return-path";
import RecoverFlow from "@/components/auth/recover-flow";

// Thin recover entry (task E04-S14, wired by E04-S33): mounts the client recovery flow,
// which walks a person who has lost every device from the identify step through the
// recovery-code, new-passkey and new-recovery-code steps (RecoverView steps identify →
// recovery-code → passkey → new-recovery). The flow renders its first step (the
// identify screen) from its own initial state, so this entry renders for a signed-out
// visitor with no session or request scope. It lives under (auth) and OUTSIDE any
// protected route group, so a guard could never redirect recovery to itself (a loop)
// and leave it unreachable with no existing session.
// Review fix B6: a flow started while signed out (an agent connection, an approval link,
// a household invite) arrives as `?next=<relative path>`; it is validated here (and again
// in the flow) and the person goes back there after success, never off-site.
export default async function RecoverYourAccountPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = (await searchParams)?.next;
  return <RecoverFlow returnTo={safeReturnPath(next)} />;
}
