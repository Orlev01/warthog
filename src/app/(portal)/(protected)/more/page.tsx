import * as React from "react";
import { MoreMenu } from "@/components/more/more-menu";

// E18-S14 — the mobile "More" menu. A thin loader inside the already-guarded
// `(protected)` group (whose layout delegates the admit/redirect to
// `requireSession` and wraps the page in PortalChrome): it mounts the propless,
// render-tested <MoreMenu>, which lists every "More" child from the navigation IA
// as a full-width link. No per-request data, so nothing to load here.
export default function MorePage() {
  return <MoreMenu />;
}
