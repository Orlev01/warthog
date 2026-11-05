import * as React from "react";

import { Landing } from "@/components/public/landing";

// Home — the public front door (brief feature "Public landing page"). A thin entry
// that mounts the landing VIEW, reachable by anyone with no authentication (it sits
// at the top level, not inside a protected route group). All content lives in the
// render-tested component.
export default function Home() {
  return <Landing />;
}
