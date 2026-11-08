"use client";

import * as React from "react";

import { ErrorScreen } from "@/components/shell/status-screens";

// The app-wide error boundary (review fix G7): a calm, styled screen with "Try again"
// (re-renders the segment) and a way back Home. The raw error message is never shown;
// only Next's opaque digest, as a reference.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorScreen digest={error.digest} reset={reset} />;
}
