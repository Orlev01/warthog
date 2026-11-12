"use client";

import * as React from "react";

import { ErrorScreen } from "@/components/shell/status-screens";

// The signed-in error boundary: a page under the workspace failed, so render the error panel
// inside the (protected) layout and keep the sidebar, top bar and drawer mounted. As with the
// app-wide boundary, the raw error message is never shown; only Next's opaque digest.
export default function ProtectedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorScreen digest={error.digest} reset={reset} variant="workspace" />;
}
