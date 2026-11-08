import * as React from "react";
import { SettingsIndex } from "@/components/settings/settings-index";
import type { Metadata } from "next";

// The page title (review fix G8, WCAG 2.4.2): "%s · Warthog" via the root template.
export const metadata: Metadata = { title: "Settings" };

// E18-S15 — the Settings index. A thin loader inside the already-guarded
// `(protected)` group (whose layout delegates the admit/redirect to
// `requireSession` and wraps the page in PortalChrome): it mounts the propless,
// render-tested <SettingsIndex>, which lists every settings screen from the
// navigation IA as a labelled, described link. No per-request data to load here.
export default function SettingsPage() {
  return <SettingsIndex />;
}
