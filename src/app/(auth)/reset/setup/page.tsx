import * as React from "react";

import ResetFlow from "@/components/auth/reset-flow";

// Review fix W5 — "Reset finished? Set up a new passkey": the thin entry for a person whose
// account reset has finished and who now has no passkey and no recovery code. It mounts
// the client reset flow in set-up mode (email code → new passkey → new recovery code →
// /home). Linked from /reset and from sign-in; under (auth), outside any protected route
// group, so it renders for a signed-out visitor.
export default async function SetUpNewPasskeyPage() {
  return <ResetFlow mode="setup" />;
}
