import * as React from "react";
import { RecoverView } from "@/components/auth/auth-views";

// Thin recover entry (task E04-S14): mounts the recovery view at its entry step —
// the identify screen that proves it's the person with their email and a one-time
// code (RecoverView steps identify → recovery-code → passkey → new-recovery). It
// lives under (auth) and OUTSIDE any protected route group, so recovery stays
// reachable with no existing session (a guard could never redirect it to itself).
export default function RecoverYourAccountPage() {
  return <RecoverView step="identify" />;
}
