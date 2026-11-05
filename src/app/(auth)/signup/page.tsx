import * as React from "react";
import SignupFlow from "@/components/auth/signup-flow";

// Thin sign-up entry (task E04-S13, wired by E04-S24): mounts the client sign-up flow,
// which walks the person from the details/email step through the code, passkey and
// recovery-code steps. It lives under (auth) and OUTSIDE any protected route group, so
// a guard can never redirect sign-up to itself. The flow renders its first step (the
// details form) from its own initial state, so this entry renders for a signed-out
// visitor with no session or request scope.
export default function CreateYourAccountPage() {
  return <SignupFlow />;
}
