import * as React from "react";

import { LoadingScreen } from "@/components/shell/status-screens";

// The route loading state (review fix G7): skeleton placeholders, announced to assistive
// technology as "Loading…", while a server page streams in.
export default function Loading() {
  return <LoadingScreen />;
}
