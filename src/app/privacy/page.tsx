import * as React from "react";

import { Privacy } from "@/components/public/privacy";
import { publicLinksFromEnv } from "@/server/config";

// E05-S03 — Privacy page entry. A PUBLIC `/privacy` page, reachable by anyone with no
// authentication (it sits at the top level, under no guard layout), that returns 200
// and mounts the privacy policy / security-FAQ VIEW. Its content is static (no runtime
// config in scope), so the entry is a thin, synchronous shell over the render-tested
// view in src/components/public/privacy.tsx. Its only input is where the brand and account
// links point when the website has its own host (docs/adr/website-root-domain.md).

export default function PrivacyPage() {
  return <Privacy links={publicLinksFromEnv()} />;
}
