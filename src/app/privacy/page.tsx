import * as React from "react";

import { Privacy } from "@/components/public/privacy";

// E05-S03 — Privacy page entry. A PUBLIC `/privacy` page, reachable by anyone with no
// authentication (it sits at the top level, under no guard layout), that returns 200
// and mounts the privacy policy / security-FAQ VIEW. Its content is static (no runtime
// config in scope), so the entry is a thin, synchronous shell over the render-tested
// view in src/components/public/privacy.tsx.

export default function PrivacyPage() {
  return <Privacy />;
}
