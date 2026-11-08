import * as React from "react";
import { safeReturnPath } from "@/server/auth/return-path";
import SignupFlow from "@/components/auth/signup-flow";

// Thin sign-up entry (task E04-S13, wired by E04-S24): mounts the client sign-up flow,
// which walks the person from the details/email step through the code, passkey and
// recovery-code steps. It lives under (auth) and OUTSIDE any protected route group, so
// a guard can never redirect sign-up to itself. The flow renders its first step (the
// details form) from its own initial state, so this entry renders for a signed-out
// visitor with no session or request scope.
// Review fix B6: a flow started while signed out (an agent connection, an approval link,
// a household invite) arrives as `?next=<relative path>`; it is validated here (and again
// in the flow) and the person goes back there after success, never off-site.
export default async function CreateYourAccountPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = (await searchParams)?.next;
  return <SignupFlow returnTo={safeReturnPath(next)} />;
}
