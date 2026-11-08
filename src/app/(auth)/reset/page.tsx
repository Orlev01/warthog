import * as React from "react";

import ResetFlow from "@/components/auth/reset-flow";

// Review fix W3.3 — the thin reset entry: mounts the client reset flow for a person who has
// lost every passkey AND the recovery code (linked from sign-in: "Lost everything? Reset
// your account"). It lives under (auth), outside any protected route group, so it renders
// for a signed-out visitor with no session and a guard can never redirect it to itself.
export default async function ResetYourAccountPage() {
  return <ResetFlow />;
}
