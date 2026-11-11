import * as React from "react";
import { safeReturnPath } from "@/server/auth/return-path";
import SigninFlow from "@/components/auth/signin-flow";
import { redirectSignedInVisitor } from "@/server/auth/public-entry";

// Thin sign-in entry (task E04-S13, wired by E04-S25): mounts the client sign-in flow,
// which starts on the passkey step (passkeys are the primary, phishing-resistant
// factor; design §5) and offers the authenticator-app path. The flow renders its first
// step from its own initial state, so this entry renders for a signed-out visitor.
// It lives under (auth) and OUTSIDE any protected route
// group, so a guard layout can never redirect sign-in to itself (a loop) and leave it
// unreachable.
// Review fix B6: a flow started while signed out (an agent connection, an approval link,
// a household invite) arrives as `?next=<relative path>`; it is validated here (and again
// in the flow) and the person goes back there after success, never off-site.
export default async function SignInPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = (await searchParams)?.next;
  await redirectSignedInVisitor(next);
  return <SigninFlow returnTo={safeReturnPath(next)} />;
}
