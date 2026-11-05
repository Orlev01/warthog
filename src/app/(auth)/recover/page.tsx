import * as React from "react";
import RecoverFlow from "@/components/auth/recover-flow";

// Thin recover entry (task E04-S14, wired by E04-S33): mounts the client recovery flow,
// which walks a person who has lost every device from the identify step through the
// recovery-code, new-passkey and new-recovery-code steps (RecoverView steps identify →
// recovery-code → passkey → new-recovery). The flow renders its first step (the
// identify screen) from its own initial state, so this entry renders for a signed-out
// visitor with no session or request scope. It lives under (auth) and OUTSIDE any
// protected route group, so a guard could never redirect recovery to itself (a loop)
// and leave it unreachable with no existing session.
export default function RecoverYourAccountPage() {
  return <RecoverFlow />;
}
