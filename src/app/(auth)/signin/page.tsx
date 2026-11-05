import * as React from "react";
import SigninFlow from "@/components/auth/signin-flow";

// Thin sign-in entry (task E04-S13, wired by E04-S25): mounts the client sign-in flow,
// which starts on the passkey step (passkeys are the primary, phishing-resistant
// factor; design §5) and offers the authenticator-app path. The flow renders its first
// step from its own initial state, so this entry renders for a signed-out visitor with
// no session or request scope. It lives under (auth) and OUTSIDE any protected route
// group, so a guard layout can never redirect sign-in to itself (a loop) and leave it
// unreachable.
export default function SignInPage() {
  return <SigninFlow />;
}
