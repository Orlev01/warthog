import * as React from "react";

import { LoadingScreen } from "@/components/shell/status-screens";

// The route loading state (review fix G7): skeleton placeholders, announced to assistive
// technology as "Loading…", while a server page streams in. It lives INSIDE the protected
// layout, not at the app root: a root loading boundary starts the streamed 200 response
// before this layout's session check runs, so a signed-out visitor got a 200 page with a
// client-side redirect instead of a 307 to /signin.
export default function Loading() {
  return <LoadingScreen />;
}
